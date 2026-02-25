/**
 * commitment-evaluator.ts — Semantic advancement assessment and lifecycle proposals
 *
 * Replaces the pure staleness check in evaluateCommitments() with:
 * - Advancement scoring based on evidence trails and session activity
 * - Proposed state transitions based on observed patterns
 * - Integration with DriftDetector for intention-behavior gap analysis
 *
 * Runs during heartbeat phase 5a.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { CommitmentState, AdvancementSignal } from "@intent-computer/architecture";
import type { StoredCommitment } from "./heartbeat.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecentActivity {
  sessionSummaries: string[]; // brief descriptions of recent session work
  queueTasksCompleted: string[]; // completed task targets
  thoughtsCreated: string[]; // recent thought titles
  daysCovered: number;
}

export interface CommitmentEvaluationResult {
  commitmentId: string;
  status: "advancing" | "stalled" | "drifting";
  advancementScore: number; // 0-1
  proposedTransition?: {
    to: CommitmentState;
    reason: string;
  };
  briefSummary: string; // human-readable for morning brief
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Horizon windows in days — how far back to look for advancement signals. */
const HORIZON_WINDOW_DAYS: Record<string, number> = {
  session: 1,
  week: 7,
  quarter: 90,
  long: 180,
};

/** How many multiples of the horizon window without signals before proposing abandoned. */
const ABANDONED_MULTIPLIER = 2;

/** Minimum mentions of a candidate commitment before proposing active. */
const CANDIDATE_PROMOTION_THRESHOLD = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Tokenize a string into lowercase words, splitting on whitespace,
 * hyphens, underscores, slashes, and common punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/\\.,;:]+/)
    .filter((w) => w.length > 1);
}

/**
 * Filter advancement signals to those within a time window ending at `now`.
 */
function signalsInWindow(
  signals: AdvancementSignal[],
  windowDays: number,
  now: number,
): AdvancementSignal[] {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  return signals.filter((s) => new Date(s.at).getTime() >= cutoff);
}

/**
 * Count how many of the activity strings contain tokens from the commitment label.
 */
function countMentions(label: string, activityStrings: string[]): number {
  const labelTokens = new Set(tokenize(label));
  if (labelTokens.size === 0) return 0;

  let mentions = 0;
  for (const text of activityStrings) {
    const textTokens = new Set(tokenize(text));
    let overlap = 0;
    for (const token of labelTokens) {
      if (textTokens.has(token)) overlap++;
    }
    // Consider it a mention if at least half the label tokens appear
    if (overlap >= Math.ceil(labelTokens.size / 2)) {
      mentions++;
    }
  }
  return mentions;
}

/**
 * Check whether recent activity contains outcome-like signals for a commitment.
 * Looks for words like "done", "shipped", "complete", "finished", "launched"
 * in activity strings that also mention the commitment.
 */
function hasOutcomeSignals(label: string, activityStrings: string[]): boolean {
  const outcomeWords = ["done", "shipped", "complete", "completed", "finished", "launched", "resolved", "satisfied"];
  const labelTokens = new Set(tokenize(label));
  if (labelTokens.size === 0) return false;

  for (const text of activityStrings) {
    const textTokens = tokenize(text);
    const textTokenSet = new Set(textTokens);

    // Check if this activity mentions the commitment
    let overlap = 0;
    for (const token of labelTokens) {
      if (textTokenSet.has(token)) overlap++;
    }
    if (overlap < Math.ceil(labelTokens.size / 2)) continue;

    // Check if it also contains outcome words
    if (textTokens.some((t) => outcomeWords.includes(t))) {
      return true;
    }
  }
  return false;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Evaluate a single commitment's advancement status and propose lifecycle transitions.
 *
 * Pure function: given a commitment and recent activity, returns an evaluation.
 * No LLM calls — uses deterministic heuristics based on advancement signals
 * and token overlap with recent activity.
 */
export function evaluateCommitmentAdvancement(
  commitment: StoredCommitment,
  recentActivity: RecentActivity,
): CommitmentEvaluationResult {
  const now = Date.now();
  const windowDays = HORIZON_WINDOW_DAYS[commitment.horizon] ?? 7;
  const signals = commitment.advancementSignals ?? [];
  const recentSignals = signalsInWindow(signals, windowDays, now);

  // ── Score advancement based on signals in the horizon window ──────────
  let status: "advancing" | "stalled" | "drifting";
  let advancementScore: number;

  const highRelevanceSignals = recentSignals.filter((s) => s.relevanceScore > 0.5);
  const allActivityStrings = [
    ...recentActivity.sessionSummaries,
    ...recentActivity.queueTasksCompleted,
    ...recentActivity.thoughtsCreated,
  ];
  const activityMentions = countMentions(commitment.label, allActivityStrings);

  if (highRelevanceSignals.length > 0) {
    // Strong signals present — advancing
    status = "advancing";
    // Score: ratio of high-relevance signals to window days, capped at 1
    advancementScore = Math.min(1, highRelevanceSignals.length / Math.max(1, windowDays));
    // Boost from activity mentions
    if (activityMentions > 0) {
      advancementScore = Math.min(1, advancementScore + 0.1 * activityMentions);
    }
  } else if (recentSignals.length > 0) {
    // Signals exist but all low relevance — stalled
    status = "stalled";
    // Average relevance of available signals
    const avgRelevance =
      recentSignals.reduce((sum, s) => sum + s.relevanceScore, 0) / recentSignals.length;
    advancementScore = avgRelevance * 0.5; // Cap at 0.5 since none are high-relevance
  } else {
    // No signals in window — check activity mentions as fallback
    if (activityMentions > 0) {
      status = "stalled";
      advancementScore = Math.min(0.4, 0.1 * activityMentions);
    } else {
      status = "drifting";
      advancementScore = 0;
    }
  }

  // ── Propose state transitions based on observed patterns ──────────────
  let proposedTransition: CommitmentEvaluationResult["proposedTransition"] | undefined;

  if (commitment.state === "candidate") {
    // Candidate with enough mentions → propose active
    const totalMentions = activityMentions + signals.length;
    if (totalMentions >= CANDIDATE_PROMOTION_THRESHOLD) {
      proposedTransition = {
        to: "active",
        reason: `${totalMentions} mentions/signals detected — ready to promote from candidate`,
      };
    }
  } else if (commitment.state === "active") {
    // Active with no signals in 2x horizon → propose abandoned
    const extendedWindowSignals = signalsInWindow(
      signals,
      windowDays * ABANDONED_MULTIPLIER,
      now,
    );
    if (extendedWindowSignals.length === 0 && activityMentions === 0) {
      proposedTransition = {
        to: "abandoned",
        reason: `No advancement signals in ${windowDays * ABANDONED_MULTIPLIER} days (2x ${commitment.horizon} horizon)`,
      };
    }

    // Active with high advancement + outcome signals → propose satisfied
    if (
      advancementScore > 0.7 &&
      hasOutcomeSignals(commitment.label, allActivityStrings)
    ) {
      proposedTransition = {
        to: "satisfied",
        reason: `High advancement (${advancementScore.toFixed(2)}) with outcome signals detected`,
      };
    }
  }

  // ── Build human-readable summary ──────────────────────────────────────
  const parts: string[] = [];
  parts.push(`"${commitment.label}": ${status}`);
  parts.push(`score=${advancementScore.toFixed(2)}`);
  if (recentSignals.length > 0) {
    parts.push(`${recentSignals.length} signal(s) in ${windowDays}d window`);
  }
  if (activityMentions > 0) {
    parts.push(`${activityMentions} activity mention(s)`);
  }
  if (proposedTransition) {
    parts.push(`→ propose ${proposedTransition.to}: ${proposedTransition.reason}`);
  }

  return {
    commitmentId: commitment.id,
    status,
    advancementScore,
    proposedTransition,
    briefSummary: parts.join(" | "),
  };
}

/**
 * Build a RecentActivity snapshot from the vault filesystem.
 *
 * Reads:
 * - ops/sessions/ for recent session transcript files (extracts first line as summary)
 * - ops/queue.json for completed tasks
 * - thoughts/ for recently created files (by mtime)
 *
 * Lightweight — no LLM calls, just file names and basic content scanning.
 */
export function buildRecentActivity(
  vaultRoot: string,
  daysCovered: number,
): RecentActivity {
  const now = Date.now();
  const cutoff = now - daysCovered * 24 * 60 * 60 * 1000;

  const sessionSummaries: string[] = [];
  const queueTasksCompleted: string[] = [];
  const thoughtsCreated: string[] = [];

  // ── Read session summaries ────────────────────────────────────────────
  const sessionsDir = join(vaultRoot, "ops", "sessions");
  if (existsSync(sessionsDir)) {
    try {
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const filePath = join(sessionsDir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;

          // Extract summary: first non-empty, non-heading line, or the heading itself
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n").filter((l) => l.trim().length > 0);
          const summary = lines.length > 0 ? lines[0].replace(/^#+\s*/, "").trim() : file;
          if (summary.length > 0) {
            sessionSummaries.push(summary);
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Sessions directory unreadable
    }
  }

  // ── Read completed queue tasks ────────────────────────────────────────
  const queuePath = join(vaultRoot, "ops", "queue.json");
  if (existsSync(queuePath)) {
    try {
      const raw = readFileSync(queuePath, "utf-8");
      const queue = JSON.parse(raw) as { tasks?: Array<{ target?: string; status?: string; updatedAt?: string }> };
      if (Array.isArray(queue.tasks)) {
        for (const task of queue.tasks) {
          if (task.status !== "done") continue;
          if (task.updatedAt) {
            const updatedTime = new Date(task.updatedAt).getTime();
            if (updatedTime < cutoff) continue;
          }
          if (task.target) {
            queueTasksCompleted.push(task.target);
          }
        }
      }
    } catch {
      // Queue file unreadable or malformed
    }
  }

  // ── Read recently created thoughts ────────────────────────────────────
  const thoughtsDir = join(vaultRoot, "thoughts");
  if (existsSync(thoughtsDir)) {
    try {
      const files = readdirSync(thoughtsDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const filePath = join(thoughtsDir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;
          // Use filename (without extension) as the thought title
          const title = file.replace(/\.md$/, "");
          thoughtsCreated.push(title);
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Thoughts directory unreadable
    }
  }

  return {
    sessionSummaries,
    queueTasksCompleted,
    thoughtsCreated,
    daysCovered,
  };
}
