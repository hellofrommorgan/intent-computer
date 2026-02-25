/**
 * drift-detector.ts — Intention-behavior gap analysis
 *
 * Compares what the user committed to against what they actually did.
 * Produces drift scores and human-readable summaries.
 *
 * All functions are pure (given inputs, return outputs). No LLM calls —
 * drift detection uses token overlap, not embedding similarity.
 */

import type { StoredCommitment } from "./heartbeat.js";
import type { RecentActivity } from "./commitment-evaluator.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DriftReport {
  commitmentDrifts: CommitmentDrift[];
  priorityInversions: PriorityInversion[];
  sprawlWarning?: string;
  overallDriftScore: number; // 0-1, average across commitments
}

export interface CommitmentDrift {
  commitmentId: string;
  commitmentLabel: string;
  driftScore: number; // 0=aligned, 1=total drift
  activityOverlap: number; // fraction of activity related to this commitment
  summary: string; // "No sessions touched 'ship the site' in 5 days"
}

export interface PriorityInversion {
  higherPriority: { id: string; label: string; activity: number };
  lowerPriority: { id: string; label: string; activity: number };
  summary: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of active commitments before triggering a sprawl warning. */
const MAX_ACTIVE_COMMITMENTS = 3;

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
 * Compute the fraction of activity strings that contain tokens from the label.
 * Returns a value in [0, 1].
 */
function computeActivityOverlap(
  label: string,
  activityStrings: string[],
): number {
  if (activityStrings.length === 0) return 0;

  const labelTokens = new Set(tokenize(label));
  if (labelTokens.size === 0) return 0;

  let matchingActivities = 0;

  for (const text of activityStrings) {
    const textTokens = new Set(tokenize(text));
    let overlap = 0;
    for (const token of labelTokens) {
      if (textTokens.has(token)) overlap++;
    }
    // Consider it a match if at least one label token appears,
    // or if the full label appears as a substring
    if (overlap > 0 || text.toLowerCase().includes(label.toLowerCase())) {
      matchingActivities++;
    }
  }

  return matchingActivities / activityStrings.length;
}

/**
 * Count total activity items that relate to a given commitment label.
 * Returns an absolute count (not a fraction).
 */
function countRelatedActivity(
  label: string,
  activityStrings: string[],
): number {
  const labelTokens = new Set(tokenize(label));
  if (labelTokens.size === 0) return 0;

  let count = 0;
  for (const text of activityStrings) {
    const textTokens = new Set(tokenize(text));
    let overlap = 0;
    for (const token of labelTokens) {
      if (textTokens.has(token)) overlap++;
    }
    if (overlap > 0 || text.toLowerCase().includes(label.toLowerCase())) {
      count++;
    }
  }
  return count;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect drift between commitments and actual activity.
 *
 * For each active commitment:
 * - Compares commitment label tokens against recent activity
 * - Computes overlap score (higher = more aligned)
 * - Drift score = 1 - overlap (0 = perfect alignment, 1 = total drift)
 *
 * Also detects:
 * - Priority inversions: lower-priority commitment getting more activity
 * - Commitment sprawl: more than MAX_ACTIVE_COMMITMENTS active
 *
 * Pure function — no side effects, no LLM calls.
 */
export function detectDrift(
  commitments: StoredCommitment[],
  activity: RecentActivity,
): DriftReport {
  const activeCommitments = commitments.filter((c) => c.state === "active");

  // Combine all activity strings for overlap analysis
  const allActivityStrings = [
    ...activity.sessionSummaries,
    ...activity.queueTasksCompleted,
    ...activity.thoughtsCreated,
  ];

  // ── Per-commitment drift analysis ─────────────────────────────────────
  const commitmentDrifts: CommitmentDrift[] = [];

  for (const commitment of activeCommitments) {
    const overlap = computeActivityOverlap(commitment.label, allActivityStrings);
    const driftScore = 1 - overlap;

    // Build human-readable summary
    let summary: string;
    if (overlap === 0 && allActivityStrings.length > 0) {
      summary = `No activity touched "${commitment.label}" in ${activity.daysCovered} days`;
    } else if (overlap === 0 && allActivityStrings.length === 0) {
      summary = `No recent activity recorded (${activity.daysCovered}d window)`;
    } else if (overlap < 0.2) {
      const relatedCount = countRelatedActivity(commitment.label, allActivityStrings);
      summary = `Minimal activity on "${commitment.label}": ${relatedCount} of ${allActivityStrings.length} items related`;
    } else if (overlap > 0.5) {
      summary = `"${commitment.label}" is well-represented in recent activity (${Math.round(overlap * 100)}% overlap)`;
    } else {
      summary = `"${commitment.label}" has moderate activity overlap (${Math.round(overlap * 100)}%)`;
    }

    commitmentDrifts.push({
      commitmentId: commitment.id,
      commitmentLabel: commitment.label,
      driftScore,
      activityOverlap: overlap,
      summary,
    });
  }

  // ── Priority inversion detection ──────────────────────────────────────
  const priorityInversions: PriorityInversion[] = [];

  // Sort active commitments by priority (highest first)
  const sortedByPriority = [...activeCommitments].sort(
    (a, b) => b.priority - a.priority,
  );

  // Compare each pair: if a lower-priority commitment has more activity
  // than a higher-priority one, flag it
  for (let i = 0; i < sortedByPriority.length; i++) {
    for (let j = i + 1; j < sortedByPriority.length; j++) {
      const higher = sortedByPriority[i];
      const lower = sortedByPriority[j];

      // Skip if same priority
      if (higher.priority === lower.priority) continue;

      const higherActivity = countRelatedActivity(higher.label, allActivityStrings);
      const lowerActivity = countRelatedActivity(lower.label, allActivityStrings);

      // Only flag if the lower-priority commitment has strictly more activity
      if (lowerActivity > higherActivity && lowerActivity > 0) {
        priorityInversions.push({
          higherPriority: {
            id: higher.id,
            label: higher.label,
            activity: higherActivity,
          },
          lowerPriority: {
            id: lower.id,
            label: lower.label,
            activity: lowerActivity,
          },
          summary: `"${lower.label}" (priority ${lower.priority}) has more activity (${lowerActivity}) than "${higher.label}" (priority ${higher.priority}, activity ${higherActivity})`,
        });
      }
    }
  }

  // ── Commitment sprawl detection ───────────────────────────────────────
  let sprawlWarning: string | undefined;
  if (activeCommitments.length > MAX_ACTIVE_COMMITMENTS) {
    sprawlWarning = `${activeCommitments.length} active commitments (recommended max: ${MAX_ACTIVE_COMMITMENTS}). Consider pausing or satisfying lower-priority commitments to reduce context switching.`;
  }

  // ── Overall drift score ───────────────────────────────────────────────
  const overallDriftScore =
    commitmentDrifts.length > 0
      ? commitmentDrifts.reduce((sum, d) => sum + d.driftScore, 0) /
        commitmentDrifts.length
      : 0;

  return {
    commitmentDrifts,
    priorityInversions,
    sprawlWarning,
    overallDriftScore,
  };
}
