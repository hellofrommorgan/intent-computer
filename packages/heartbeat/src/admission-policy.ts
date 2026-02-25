/**
 * admission-policy.ts — Prevents unbounded perception from degrading the vault
 *
 * Enforces the umwelt budget: max 3 specific signals per channel + 1 summary.
 * Gates all feed items through identity alignment before admission to inbox.
 * Tracks noise rates per source to detect degraded feeds.
 *
 * Key vault insight: "unbounded perception signals compound into system prompt
 * bloat that degrades agent quality at scale"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type {
  FeedCapture,
  PerceptionContext,
  AdmissionPolicyConfig,
  AdmissionResult,
  NoiseAlert,
  NoiseTracker,
} from "@intent-computer/architecture";

// ─── Default admission policy ───────────────────────────────────────────────

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicyConfig = {
  maxSignalsPerChannel: 3,
  umweltBudgetLines: 50,
  relevanceFloor: 0.3,
  briefThreshold: 0.6,
  maxInboxWritesPerCycle: 10,
};

// ─── Tokenization ───────────────────────────────────────────────────────────

/**
 * Normalize and tokenize a string into lowercase words for keyword matching.
 * Strips punctuation, splits on whitespace and hyphens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2); // drop very short tokens
}

// ─── Identity relevance scoring ─────────────────────────────────────────────

/**
 * Compute identity relevance for a single capture against the perception context.
 * Uses keyword/token overlap only — no embeddings, no LLM calls.
 *
 * Weights:
 *   - commitmentLabels: 0.5
 *   - identityThemes:   0.3
 *   - vaultTopics:      0.2
 *
 * Returns a score from 0 to 1.
 */
export function scoreIdentityRelevance(
  capture: FeedCapture,
  context: PerceptionContext,
): number {
  const captureTokens = new Set([
    ...tokenize(capture.title),
    ...tokenize(capture.content),
  ]);

  if (captureTokens.size === 0) return 0;

  const commitmentScore = computeOverlap(captureTokens, context.commitmentLabels);
  const themeScore = computeOverlap(captureTokens, context.identityThemes);
  const topicScore = computeOverlap(captureTokens, context.vaultTopics);

  return Math.min(1, commitmentScore * 0.5 + themeScore * 0.3 + topicScore * 0.2);
}

/**
 * Compute overlap ratio between capture tokens and a list of context phrases.
 * Returns 0-1 based on what fraction of context phrases have at least one token match.
 */
function computeOverlap(captureTokens: Set<string>, contextPhrases: string[]): number {
  if (contextPhrases.length === 0) return 0;

  let matchedPhrases = 0;
  for (const phrase of contextPhrases) {
    const phraseTokens = tokenize(phrase);
    const hasMatch = phraseTokens.some((t) => captureTokens.has(t));
    if (hasMatch) matchedPhrases++;
  }

  return matchedPhrases / contextPhrases.length;
}

// ─── Main admission policy ──────────────────────────────────────────────────

/**
 * Apply admission policy to a batch of feed captures.
 *
 * 1. Identity gate: filter items with zero relevance across all context dimensions
 * 2. Relevance floor: filter items below config.relevanceFloor
 * 3. Self-tuning: detect if the floor is miscalibrated
 * 4. Budget enforcement: cap by maxInboxWritesPerCycle and maxSignalsPerChannel
 */
export function applyAdmissionPolicy(
  captures: FeedCapture[],
  context: PerceptionContext,
  config: AdmissionPolicyConfig,
): AdmissionResult {
  if (captures.length === 0) {
    return {
      admitted: [],
      surfaced: [],
      filtered: 0,
      reason: "No captures to evaluate.",
    };
  }

  // Score all captures
  const scored = captures.map((c) => ({
    capture: c,
    identityScore: scoreIdentityRelevance(c, context),
  }));

  // Identity gate: zero overlap across all dimensions → immediate filter
  const identityGated = scored.filter((s) => s.identityScore > 0);
  const identityFiltered = scored.length - identityGated.length;

  // Relevance floor: combine identity score with raw relevance
  // Use identity score as the primary gate since raw relevance comes from the source
  const aboveFloor = identityGated.filter(
    (s) => s.identityScore >= config.relevanceFloor,
  );
  const floorFiltered = identityGated.length - aboveFloor.length;
  const totalFiltered = identityFiltered + floorFiltered;

  // Self-tuning analysis
  const filterRate = totalFiltered / scored.length;
  let tuningNote = "";
  if (filterRate > 0.8) {
    tuningNote = ` Self-tuning: ${(filterRate * 100).toFixed(0)}% filtered — relevance floor (${config.relevanceFloor}) may be too high.`;
  } else if (filterRate < 0.2) {
    tuningNote = ` Self-tuning: ${(filterRate * 100).toFixed(0)}% filtered — relevance floor (${config.relevanceFloor}) may be too low.`;
  }

  // Sort by identity score descending
  aboveFloor.sort((a, b) => b.identityScore - a.identityScore);

  // Budget enforcement: global cap
  const budgetCapped = aboveFloor.slice(0, config.maxInboxWritesPerCycle);

  // Per-channel cap for surfaced items (morning brief)
  const surfacedBySource = new Map<string, typeof budgetCapped>();
  for (const item of budgetCapped) {
    const sourceId = item.capture.sourceId;
    if (!surfacedBySource.has(sourceId)) {
      surfacedBySource.set(sourceId, []);
    }
    surfacedBySource.get(sourceId)!.push(item);
  }

  const surfaced: FeedCapture[] = [];
  for (const [, items] of surfacedBySource) {
    for (const item of items.slice(0, config.maxSignalsPerChannel)) {
      surfaced.push(item.capture);
    }
  }

  // All budget-capped items are admitted to inbox
  const admitted = budgetCapped.map((s) => s.capture);

  const reason =
    `${captures.length} evaluated: ${identityFiltered} identity-gated, ${floorFiltered} below floor (${config.relevanceFloor}), ${admitted.length} admitted, ${surfaced.length} surfaced.` +
    tuningNote;

  return {
    admitted,
    surfaced,
    filtered: totalFiltered,
    reason,
  };
}

// ─── Noise rate tracking ────────────────────────────────────────────────────

const NOISE_TRACKER_PATH = "ops/runtime/perception-noise.json";
const NOISE_ALERT_THRESHOLD = 0.9;
const NOISE_ALERT_CONSECUTIVE_DAYS = 7;

function readNoiseTracker(vaultRoot: string): NoiseTracker {
  const filePath = join(vaultRoot, NOISE_TRACKER_PATH);
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8")) as NoiseTracker;
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { sources: {}, lastUpdated: new Date().toISOString() };
}

function writeNoiseTracker(vaultRoot: string, tracker: NoiseTracker): void {
  const filePath = join(vaultRoot, NOISE_TRACKER_PATH);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(tracker, null, 2), "utf-8");
}

/**
 * Track filter rates per source. Returns an alert if a source has been
 * >90% noise for 7+ consecutive days.
 */
export function trackNoiseRate(
  sourceId: string,
  admitted: number,
  total: number,
  vaultRoot: string,
): NoiseAlert | null {
  if (total === 0) return null;

  const tracker = readNoiseTracker(vaultRoot);
  const today = new Date().toISOString().slice(0, 10);
  const rate = total > 0 ? 1 - admitted / total : 0;

  // Initialize source history if needed
  if (!tracker.sources[sourceId]) {
    tracker.sources[sourceId] = { dailyRates: [] };
  }

  const history = tracker.sources[sourceId];

  // Update or append today's entry
  const todayEntry = history.dailyRates.find((d) => d.date === today);
  if (todayEntry) {
    // Merge with existing today entry (multiple cycles per day)
    todayEntry.admitted += admitted;
    todayEntry.total += total;
    todayEntry.rate = todayEntry.total > 0 ? 1 - todayEntry.admitted / todayEntry.total : 0;
  } else {
    history.dailyRates.push({ date: today, admitted, total, rate });
  }

  // Keep only last 30 days of history
  history.dailyRates = history.dailyRates
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);

  tracker.lastUpdated = new Date().toISOString();
  writeNoiseTracker(vaultRoot, tracker);

  // Check for consecutive high-noise days
  const sorted = [...history.dailyRates].sort((a, b) => b.date.localeCompare(a.date));
  let consecutiveDays = 0;
  for (const entry of sorted) {
    if (entry.rate >= NOISE_ALERT_THRESHOLD) {
      consecutiveDays++;
    } else {
      break;
    }
  }

  if (consecutiveDays >= NOISE_ALERT_CONSECUTIVE_DAYS) {
    const avgRate = sorted
      .slice(0, consecutiveDays)
      .reduce((sum, e) => sum + e.rate, 0) / consecutiveDays;

    return {
      sourceId,
      filterRate: Math.round(avgRate * 100) / 100,
      consecutiveDays,
      recommendation: `${sourceId} feed has been ${Math.round(avgRate * 100)}% noise for ${consecutiveDays} days. Consider disabling.`,
    };
  }

  return null;
}
