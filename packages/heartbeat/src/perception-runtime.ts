/**
 * perception-runtime.ts — Heartbeat phase 4a
 *
 * Orchestrates feed source polling, applies admission filtering,
 * writes admitted items to inbox, builds perception summary for morning brief.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import type {
  FeedCapture,
  PerceptionContext,
  PerceptionSummary,
  ChannelSummary,
  BriefItem,
  AdmissionPolicyConfig,
  NoiseAlert,
} from "@intent-computer/architecture";
import {
  applyAdmissionPolicy,
  trackNoiseRate,
  DEFAULT_ADMISSION_POLICY,
} from "./admission-policy.js";

// ─── FeedSource interface ───────────────────────────────────────────────────

export interface FeedSource {
  id: string;
  name: string;
  enabled: boolean;
  pollIntervalMinutes: number;
  maxItemsPerPoll: number;
  poll(vaultRoot: string, context: PerceptionContext): Promise<FeedCapture[]>;
  toInboxMarkdown(capture: FeedCapture): string;
}

// Re-export DEFAULT_ADMISSION_POLICY for backward compatibility
export { DEFAULT_ADMISSION_POLICY } from "./admission-policy.js";

// ─── Build perception context from vault state ──────────────────────────────

export function buildPerceptionContext(vaultRoot: string): PerceptionContext {
  const context: PerceptionContext = {
    commitmentLabels: [],
    identityThemes: [],
    vaultTopics: [],
    recentThoughts: [],
  };

  // Read commitment labels from commitments.json
  try {
    const commitmentsPath = join(vaultRoot, "ops", "commitments.json");
    if (existsSync(commitmentsPath)) {
      const raw = JSON.parse(readFileSync(commitmentsPath, "utf-8"));
      const commitments = raw?.commitments ?? [];
      context.commitmentLabels = commitments
        .filter((c: { state?: string }) => c.state === "active")
        .map((c: { label?: string }) => c.label ?? "")
        .filter(Boolean);
    }
  } catch {
    // Best effort — continue with empty labels
  }

  // Read identity themes from goals.md
  try {
    const goalsPaths = [
      join(vaultRoot, "self", "goals.md"),
      join(vaultRoot, "ops", "goals.md"),
    ];
    for (const goalsPath of goalsPaths) {
      if (existsSync(goalsPath)) {
        const content = readFileSync(goalsPath, "utf-8");
        // Extract themes: lines that start with ## or contain key phrases
        const themes = content
          .split("\n")
          .filter((line) => line.startsWith("## ") || line.startsWith("### "))
          .map((line) => line.replace(/^#+\s*/, "").trim())
          .filter(Boolean);
        context.identityThemes = themes;
        break;
      }
    }
  } catch {
    // Best effort
  }

  // List thought file names for dedup
  try {
    const thoughtsDir = join(vaultRoot, "thoughts");
    if (existsSync(thoughtsDir)) {
      context.recentThoughts = readdirSync(thoughtsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => basename(f, ".md"));
    }
  } catch {
    // Best effort
  }

  return context;
}

// ─── Sanitize filename ──────────────────────────────────────────────────────

function sanitizeFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80)
    .replace(/-+$/, "");
}

// ─── Poll a single source with timeout ──────────────────────────────────────

async function pollSourceWithTimeout(
  source: FeedSource,
  vaultRoot: string,
  context: PerceptionContext,
  timeoutMs: number,
): Promise<FeedCapture[]> {
  return new Promise<FeedCapture[]>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[perception] Source "${source.name}" timed out after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);

    source
      .poll(vaultRoot, context)
      .then((captures) => {
        clearTimeout(timer);
        resolve(captures);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[perception] Source "${source.name}" poll failed: ${msg}`);
        resolve([]);
      });
  });
}

// ─── Main perception phase entry point ──────────────────────────────────────

export async function runPerceptionPhase(
  vaultRoot: string,
  sources: FeedSource[],
  config?: Partial<AdmissionPolicyConfig>,
): Promise<PerceptionSummary> {
  const policy: AdmissionPolicyConfig = { ...DEFAULT_ADMISSION_POLICY, ...config };
  const startMs = Date.now();
  const channels: ChannelSummary[] = [];
  const noiseAlerts: NoiseAlert[] = [];
  let totalAdmitted = 0;
  let anyPolled = false;

  console.log(`[perception] Starting phase 4a with ${sources.length} source(s)`);

  // Build context from vault state
  const context = buildPerceptionContext(vaultRoot);

  // Ensure inbox directory exists
  const inboxDir = join(vaultRoot, "inbox");
  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
  }

  for (const source of sources) {
    if (!source.enabled) {
      console.log(`[perception] Skipping disabled source: ${source.name}`);
      continue;
    }

    const sourceStartMs = Date.now();

    // Poll with 30-second timeout
    const captures = await pollSourceWithTimeout(source, vaultRoot, context, 30_000);
    const sourceDurationMs = Date.now() - sourceStartMs;
    anyPolled = captures.length > 0 || anyPolled;

    console.log(
      `[perception] Source "${source.name}" returned ${captures.length} item(s) in ${sourceDurationMs}ms`,
    );

    // Apply admission policy: identity gating + relevance floor + budget enforcement
    const admissionResult = applyAdmissionPolicy(captures, context, policy);

    console.log(`[perception] Admission: ${admissionResult.reason}`);

    // Write admitted items to inbox
    const topItems: BriefItem[] = [];
    for (const capture of admissionResult.admitted) {
      const slug = sanitizeFilename(`feed-${source.id}-${capture.id.slice(-12)}`);
      const filePath = join(inboxDir, `${slug}.md`);

      if (existsSync(filePath)) {
        // Already written in a previous cycle — skip but still count
        continue;
      }

      const markdown = source.toInboxMarkdown(capture);
      writeFileSync(filePath, markdown, "utf-8");
      totalAdmitted++;
      console.log(`[perception] Admitted: ${capture.title.slice(0, 60)} → ${filePath}`);

      topItems.push({
        title: capture.title,
        relevanceScore: capture.rawRelevanceScore,
        reason: `Identity-gated admission from ${source.name}`,
        inboxPath: filePath,
      });
    }

    // Include surfaced items (high-relevance, for morning brief) even if already written
    for (const capture of admissionResult.surfaced) {
      if (
        capture.rawRelevanceScore >= policy.briefThreshold &&
        !topItems.some((t) => t.title === capture.title)
      ) {
        topItems.push({
          title: capture.title,
          relevanceScore: capture.rawRelevanceScore,
          reason: `High relevance (${capture.rawRelevanceScore.toFixed(2)}) from ${source.name}`,
          inboxPath: "",
        });
      }
    }

    // Track noise rate and collect alerts
    const noiseAlert = trackNoiseRate(
      source.id,
      admissionResult.admitted.length,
      captures.length,
      vaultRoot,
    );
    if (noiseAlert) {
      noiseAlerts.push(noiseAlert);
      console.warn(`[perception] Noise alert: ${noiseAlert.recommendation}`);
    }

    const summaryLine =
      admissionResult.admitted.length > 0
        ? `${admissionResult.admitted.length} item(s) admitted from ${source.name} (${admissionResult.filtered} filtered by identity+relevance)`
        : `No items admitted from ${source.name} (${captures.length} polled, ${admissionResult.filtered} filtered)`;

    channels.push({
      sourceId: source.id,
      sourceName: source.name,
      polled: captures.length,
      admitted: admissionResult.admitted.length,
      filtered: admissionResult.filtered,
      topItems,
      summaryLine,
    });
  }

  const totalDurationMs = Date.now() - startMs;
  const health: PerceptionSummary["health"] = anyPolled
    ? totalAdmitted > 0
      ? "active"
      : "silent"
    : sources.length > 0
      ? "degraded"
      : "silent";

  console.log(
    `[perception] Phase 4a complete: ${totalAdmitted} admitted, ${channels.length} channel(s), ${totalDurationMs}ms`,
  );

  return {
    at: new Date().toISOString(),
    channels,
    health,
    noiseAlerts: noiseAlerts.length > 0 ? noiseAlerts : undefined,
  };
}
