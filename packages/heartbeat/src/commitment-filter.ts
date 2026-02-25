/**
 * commitment-filter.ts — Commitment-aware task prioritization
 *
 * Replaces the binary pass/fail of resolveTaskPolicyTags() with:
 * - Relevance scoring (0-1) of each task against active commitments
 * - Priority reordering based on commitment importance
 * - Commitment-aware deferral with rationale
 * - Creative sprint protection (suppress maintenance during creative flow)
 */

import type { PipelineTask } from "@intent-computer/architecture";
import type { StoredCommitment } from "./heartbeat.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaskRelevanceScore {
  taskId: string;
  bestCommitmentId: string | null;
  bestCommitmentLabel: string | null;
  relevanceScore: number; // 0-1, keyword match
  commitmentPriority: number; // from commitment.priority
}

export interface FilterOptions {
  enableCreativeSprintProtection?: boolean; // default: true
  maintenanceActions?: string[]; // default: ["process-inbox", "connect-orphans", "triage-observations", "resolve-tensions"]
}

export interface FilterResult {
  prioritized: PipelineTask[]; // sorted by commitment relevance
  deferred: DeferredTask[]; // suppressed with rationale
}

export interface DeferredTask {
  task: PipelineTask;
  reason: string; // human-readable: "deferred: aligned with paused commitment 'X'"
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CREATIVE_KEYWORDS = ["write", "build", "design", "ship", "create"];

const DEFAULT_MAINTENANCE_ACTIONS = [
  "process-inbox",
  "connect-orphans",
  "triage-observations",
  "resolve-tensions",
];

// ─── Keyword relevance scoring ──────────────────────────────────────────────

/**
 * Tokenize a string into lowercase words, splitting on whitespace,
 * hyphens, underscores, slashes, and path separators.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/\\.,;:]+/)
    .filter((w) => w.length > 1);
}

/**
 * Compute keyword-overlap relevance between a task and a commitment label.
 * Returns a score in [0, 1] based on what fraction of the commitment's
 * label tokens appear in the task's combined target/sourcePath text.
 *
 * Also checks for substring containment (the original alignment method)
 * to ensure backward compatibility — if the full label appears as a
 * substring anywhere in the task text, score is at least 0.8.
 */
function computeRelevance(taskText: string, commitmentLabel: string): number {
  const lowerTask = taskText.toLowerCase();
  const lowerLabel = commitmentLabel.toLowerCase();

  // Substring containment — strong signal (backward compat with isTaskAligned)
  if (lowerTask.includes(lowerLabel)) {
    return 1.0;
  }

  // Token-level overlap
  const labelTokens = tokenize(lowerLabel);
  if (labelTokens.length === 0) return 0;

  const taskTokens = new Set(tokenize(lowerTask));
  let matches = 0;
  for (const token of labelTokens) {
    if (taskTokens.has(token)) {
      matches++;
    }
  }

  return matches / labelTokens.length;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Score a single task's relevance against all active commitments.
 * Returns the highest-scoring commitment match.
 */
export function scoreTaskRelevance(
  task: PipelineTask,
  commitments: StoredCommitment[],
): TaskRelevanceScore {
  const taskText = `${task.target} ${task.sourcePath}`;

  let bestScore = 0;
  let bestCommitment: StoredCommitment | null = null;

  for (const commitment of commitments) {
    const score = computeRelevance(taskText, commitment.label);
    if (score > bestScore) {
      bestScore = score;
      bestCommitment = commitment;
    }
  }

  return {
    taskId: task.taskId,
    bestCommitmentId: bestCommitment?.id ?? null,
    bestCommitmentLabel: bestCommitment?.label ?? null,
    relevanceScore: bestScore,
    commitmentPriority: bestCommitment?.priority ?? 0,
  };
}

/**
 * Filter and reorder tasks based on commitment state.
 *
 * Steps:
 * 1. Score each task against active commitments
 * 2. Suppress tasks aligned with paused commitments (deferral)
 * 3. Sort by: commitment priority (higher first), relevance (higher first),
 *    then original queue order
 * 4. If creative sprint protection is enabled and the highest-priority
 *    commitment looks like creative work, suppress pure maintenance tasks
 *
 * When no commitments exist, returns tasks in their original order
 * (identical to pre-filter behavior).
 */
export function filterAndReorderTasks(
  tasks: PipelineTask[],
  commitments: StoredCommitment[],
  options?: FilterOptions,
): FilterResult {
  // No commitments — passthrough, identical to legacy behavior
  if (commitments.length === 0) {
    return { prioritized: [...tasks], deferred: [] };
  }

  const enableCreativeSprint = options?.enableCreativeSprintProtection ?? true;
  const maintenanceActions =
    options?.maintenanceActions ?? DEFAULT_MAINTENANCE_ACTIONS;

  const activeCommitments = commitments.filter((c) => c.state === "active");
  const pausedCommitments = commitments.filter((c) => c.state === "paused");

  const deferred: DeferredTask[] = [];
  const scored: Array<{
    task: PipelineTask;
    score: TaskRelevanceScore;
    originalIndex: number;
  }> = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    // Check alignment with paused commitments — defer if matched
    const pausedMatch = findPausedMatch(task, pausedCommitments);
    if (pausedMatch) {
      deferred.push({
        task,
        reason: `deferred: aligned with paused commitment '${pausedMatch.label}'`,
      });
      continue;
    }

    const score = scoreTaskRelevance(task, activeCommitments);
    scored.push({ task, score, originalIndex: i });
  }

  // Determine if creative sprint protection should suppress maintenance
  const topCommitment = activeCommitments
    .slice()
    .sort((a, b) => b.priority - a.priority)[0];

  const isCreativeSprint =
    enableCreativeSprint &&
    topCommitment &&
    isCreativeCommitment(topCommitment);

  // Apply creative sprint protection
  const afterCreativeFilter: typeof scored = [];
  if (isCreativeSprint) {
    for (const entry of scored) {
      if (isMaintenanceTask(entry.task, maintenanceActions)) {
        deferred.push({
          task: entry.task,
          reason: `deferred: maintenance task suppressed during creative sprint '${topCommitment.label}'`,
        });
      } else {
        afterCreativeFilter.push(entry);
      }
    }
  } else {
    afterCreativeFilter.push(...scored);
  }

  // Sort: commitment priority desc, relevance desc, original order asc
  afterCreativeFilter.sort((a, b) => {
    // Higher priority first
    if (a.score.commitmentPriority !== b.score.commitmentPriority) {
      return b.score.commitmentPriority - a.score.commitmentPriority;
    }
    // Higher relevance first
    if (a.score.relevanceScore !== b.score.relevanceScore) {
      return b.score.relevanceScore - a.score.relevanceScore;
    }
    // Preserve original order as tiebreaker
    return a.originalIndex - b.originalIndex;
  });

  return {
    prioritized: afterCreativeFilter.map((entry) => entry.task),
    deferred,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findPausedMatch(
  task: PipelineTask,
  pausedCommitments: StoredCommitment[],
): StoredCommitment | null {
  const taskText = `${task.target} ${task.sourcePath}`.toLowerCase();
  for (const commitment of pausedCommitments) {
    if (taskText.includes(commitment.label.toLowerCase())) {
      return commitment;
    }
  }
  return null;
}

function isCreativeCommitment(commitment: StoredCommitment): boolean {
  const label = commitment.label.toLowerCase();
  return CREATIVE_KEYWORDS.some((kw) => label.includes(kw));
}

function isMaintenanceTask(
  task: PipelineTask,
  maintenanceActions: string[],
): boolean {
  const target = task.target.toLowerCase();
  return maintenanceActions.some(
    (action) =>
      target === action ||
      target.includes(action) ||
      target.replace(/[\s_]/g, "-").includes(action),
  );
}
