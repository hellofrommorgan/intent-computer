/**
 * heartbeat.ts — commitment-driven autonomy engine
 *
 * Runs on a schedule (launchd every 15 min). Reads commitment state,
 * evaluates vault conditions, and writes morning-brief.md with findings.
 *
 * Autonomy levels:
 *   5a: Read + evaluate commitments/conditions
 *   5b: Trigger aligned queue tasks through a configured runner command
 *   5c: Trigger threshold-based actions
 *   6: Generate morning brief via Claude synthesis
 *   7: Update working memory via Claude synthesis
 *
 * Uses Claude CLI for autonomous inference tasks.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from "fs";
import { basename, dirname, join } from "path";
import { execSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import type {
  MaintenanceThresholds,
  CommitmentState,
  PipelinePhase,
  PipelineQueueFile,
  PipelineTask,
  RepairContext,
  StateTransition,
  AdvancementSignal,
  OutcomePattern,
  DriftSnapshot,
} from "@intent-computer/architecture";
import {
  emitCommitmentEvaluated,
  emitEvaluationRun,
  emitHeartbeatRun,
  emitRepairQueued,
  emitTaskExecuted,
  emitTaskFailed,
  countUnprocessedMineableSessions,
  loadMaintenanceThresholds,
  withCommitmentLock,
  readQueue,
  readFirstExisting,
  scanVaultGraph,
  withQueueLock,
  writeQueue,
  writeCommitmentsAtomic,
  scoreAllThoughts,
  writeEvaluationRecord,
} from "@intent-computer/architecture";
import type { EvaluationRecord } from "@intent-computer/architecture";
import { runClaude, runSkillTask } from "./runner.js";
import { createXFeedSource } from "./x-feed.js";
import { runPerceptionPhase } from "./perception-runtime.js";
import type { PerceptionSummary } from "@intent-computer/architecture";
import { filterAndReorderTasks } from "./commitment-filter.js";
import type { FilterResult, DeferredTask } from "./commitment-filter.js";
import {
  evaluateCommitmentAdvancement,
  buildRecentActivity,
} from "./commitment-evaluator.js";
import type { CommitmentEvaluationResult } from "./commitment-evaluator.js";
import { detectDrift } from "./drift-detector.js";
import type { DriftReport } from "./drift-detector.js";

// ─── Commitment store schema ──────────────────────────────────────────────────

export interface StoredCommitment {
  id: string;
  label: string;
  state: CommitmentState;
  priority: number;
  horizon: "session" | "week" | "quarter" | "long";
  desireClass?: "thick" | "thin" | "unknown";
  frictionClass?: "constitutive" | "incidental" | "unknown";
  source: string;
  lastAdvancedAt: string;
  evidence: string[];
  // Phase 1: commitment engine extensions
  createdAt?: string;
  stateHistory?: StateTransition[];
  advancementSignals?: AdvancementSignal[];
  outcomePattern?: OutcomePattern;
  driftSnapshots?: DriftSnapshot[];
  desireClassRationale?: string;
}

export interface CommitmentStore {
  version: number;
  commitments: StoredCommitment[];
  lastEvaluatedAt: string;
}

// ─── Commitment state machine ────────────────────────────────────────────────

const VALID_STATE_TRANSITIONS: Record<CommitmentState, CommitmentState[]> = {
  candidate: ["active"],
  active: ["paused", "satisfied", "abandoned"],
  paused: ["active", "abandoned"],
  satisfied: [],
  abandoned: [],
};

export function recordStateTransition(
  commitment: StoredCommitment,
  targetState: CommitmentState,
  reason: string,
  proposedBy: "engine" | "human",
): StoredCommitment {
  const allowed = VALID_STATE_TRANSITIONS[commitment.state] ?? [];
  if (!allowed.includes(targetState)) {
    throw new Error(
      `Invalid state transition: ${commitment.state} → ${targetState} (allowed: ${allowed.join(", ") || "none"})`,
    );
  }

  const transition: StateTransition = {
    from: commitment.state,
    to: targetState,
    at: new Date().toISOString(),
    reason,
    proposedBy,
    accepted: true,
  };

  if (!commitment.stateHistory) {
    commitment.stateHistory = [];
  }
  commitment.stateHistory.push(transition);
  commitment.state = targetState;

  return commitment;
}

export function recordAdvancementSignal(
  commitment: StoredCommitment,
  action: string,
  relevanceScore: number,
  method: "direct" | "inferred",
): StoredCommitment {
  const signal: AdvancementSignal = {
    at: new Date().toISOString(),
    action,
    relevanceScore,
    method,
  };

  if (!commitment.advancementSignals) {
    commitment.advancementSignals = [];
  }
  commitment.advancementSignals.push(signal);

  if (relevanceScore > 0.5) {
    commitment.lastAdvancedAt = signal.at;
  }

  return commitment;
}

// ─── Queue schema ─────────────────────────────────────────────────────────────

// ─── Vault condition checks ───────────────────────────────────────────────────

interface VaultCondition {
  key: string;
  count: number;
  threshold: number;
  exceeded: boolean;
  dir: string;
}

type ConditionResults = VaultCondition[];

const MAX_HEARTBEAT_DEPTH = 2;
const MORNING_BRIEF_STALE_MS = 12 * 60 * 60 * 1000;
const MAX_REPAIR_ATTEMPTS = 2;

// ─── Error recovery helpers ──────────────────────────────────────────────────

function readFileStateSafe(filePath: string): string | undefined {
  try {
    if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
  } catch {
    // Best-effort file read for error context
  }
  return undefined;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`;
}

function resolveAbsoluteSourcePath(
  vaultRoot: string,
  sourcePath: string,
  target: string,
): string {
  if (sourcePath) {
    return sourcePath.startsWith("/") ? sourcePath : join(vaultRoot, sourcePath);
  }
  if (!target) return "";
  return target.startsWith("/") ? target : join(vaultRoot, target);
}

function buildQueueExcerpt(queue: PipelineQueueFile, maxTasks = 12): string {
  if (queue.tasks.length === 0) return "Queue is empty.";
  const lines = queue.tasks.slice(0, maxTasks).map((task) => {
    const status = task.status ?? "pending";
    return `- ${task.taskId} [${status}] ${task.phase} ${task.target}`;
  });
  if (queue.tasks.length > maxTasks) {
    lines.push(`- ... ${queue.tasks.length - maxTasks} more task(s)`);
  }
  return [`Total tasks: ${queue.tasks.length}`, ...lines].join("\n");
}

function readQueueExcerptSafe(vaultRoot: string): string {
  try {
    return buildQueueExcerpt(readQueue(vaultRoot));
  } catch {
    return "Queue excerpt unavailable.";
  }
}

function cloneQueue(queue: PipelineQueueFile): PipelineQueueFile {
  return JSON.parse(JSON.stringify(queue)) as PipelineQueueFile;
}

interface QueueMutationDelta {
  baselineById: Map<string, PipelineTask>;
  updatedById: Map<string, PipelineTask>;
  addedTasks: PipelineTask[];
}

function computeQueueMutationDelta(
  baseline: PipelineQueueFile,
  mutated: PipelineQueueFile,
): QueueMutationDelta {
  const baselineById = new Map(baseline.tasks.map((task) => [task.taskId, task]));
  const updatedById = new Map<string, PipelineTask>();
  const addedTasks: PipelineTask[] = [];

  for (const task of mutated.tasks) {
    const original = baselineById.get(task.taskId);
    if (!original) {
      addedTasks.push(task);
      continue;
    }
    if (JSON.stringify(original) !== JSON.stringify(task)) {
      updatedById.set(task.taskId, task);
    }
  }

  return { baselineById, updatedById, addedTasks };
}

function mergeQueueWithDelta(
  fresh: PipelineQueueFile,
  delta: QueueMutationDelta,
): PipelineQueueFile {
  const merged: PipelineQueueFile = {
    ...fresh,
    tasks: [...fresh.tasks],
  };
  const indexById = new Map(merged.tasks.map((task, index) => [task.taskId, index]));

  for (const [taskId, updatedTask] of delta.updatedById.entries()) {
    const index = indexById.get(taskId);
    if (index === undefined) continue;

    const baselineTask = delta.baselineById.get(taskId);
    const freshTask = merged.tasks[index];
    const baselineUpdatedAt = baselineTask?.updatedAt ?? baselineTask?.createdAt ?? "";
    const freshUpdatedAt = freshTask.updatedAt ?? freshTask.createdAt ?? "";

    // Preserve concurrent writes: if task changed since our baseline, skip overwrite.
    if (baselineUpdatedAt && freshUpdatedAt && baselineUpdatedAt !== freshUpdatedAt) {
      continue;
    }

    merged.tasks[index] = { ...freshTask, ...updatedTask };
  }

  for (const task of delta.addedTasks) {
    if (indexById.has(task.taskId)) continue;
    if (task.repair_context) {
      const { kind, target } = task.repair_context.original_task;
      if (hasPendingRepairForOriginal({ ...merged, tasks: merged.tasks }, kind, target)) {
        continue;
      }
    }
    merged.tasks.push(task);
    indexById.set(task.taskId, merged.tasks.length - 1);
  }

  merged.lastUpdated = new Date().toISOString();
  return merged;
}

function readGitDiffSafe(vaultRoot: string, filePath: string): string | null {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const escapedVault = vaultRoot.replace(/"/g, '\\"');
    const escapedPath = filePath.replace(/"/g, '\\"');
    const diff = execSync(`git -C "${escapedVault}" diff -- "${escapedPath}"`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return diff ? truncate(diff, 4000) : null;
  } catch {
    return null;
  }
}

function expectedOutputContractFor(commandOrSkill: string, phase: string): string {
  const lower = commandOrSkill.toLowerCase();
  if (lower.includes("reduce") || phase === "surface") {
    return "Produce or update extracted notes with valid frontmatter and queue progress updates.";
  }
  if (lower.includes("reflect")) {
    return "Update notes with concrete wiki links and relevant topic map changes.";
  }
  if (lower.includes("reweave") || phase === "revisit") {
    return "Apply backward-pass updates to older notes and preserve schema validity.";
  }
  if (lower.includes("verify")) {
    return "Run quality verification and report specific failures with actionable fixes.";
  }
  if (lower.includes("rethink")) {
    return "Triage or resolve operational observations/tensions and persist status updates.";
  }
  return "Diagnose the failure, apply a concrete fix in the vault, and summarize changed files.";
}

interface BuildRepairTaskOptions {
  vaultRoot?: string;
  stackTrace?: string;
  commandOrSkill?: string;
  expectedOutputContract?: string;
  phase?: string;
  lastStdout?: string;
  lastStderr?: string;
  queueExcerpt?: string;
}

function buildRepairTask(
  originalTask: PipelineTask,
  error: string,
  options: BuildRepairTaskOptions = {},
): PipelineTask {
  const existingRepair = originalTask.repair_context;
  const attemptCount = (existingRepair?.attempt_count ?? 0) + 1;
  const vaultRoot = options.vaultRoot ?? existingRepair?.vault_root ?? originalTask.vaultId;
  const absoluteSourcePath = resolveAbsoluteSourcePath(
    vaultRoot,
    originalTask.sourcePath || existingRepair?.absolute_source_path || "",
    originalTask.target,
  );

  const fileState: Record<string, string> = {};
  if (absoluteSourcePath && existsSync(absoluteSourcePath)) {
    const content = readFileStateSafe(absoluteSourcePath);
    if (content) fileState[absoluteSourcePath] = truncate(content, 4000);
  }

  const gitDiff = readGitDiffSafe(vaultRoot, absoluteSourcePath);
  const relevantFileDiffs = [
    ...(existingRepair?.relevant_file_diffs ?? []),
    ...(gitDiff ? [{ path: absoluteSourcePath, diff: gitDiff }] : []),
  ];
  const commandOrSkill =
    options.commandOrSkill ??
    existingRepair?.command_or_skill ??
    existingRepair?.original_task.kind ??
    originalTask.phase;
  const phase = options.phase ?? existingRepair?.phase ?? originalTask.phase;
  const queueExcerpt = options.queueExcerpt ?? existingRepair?.queue_excerpt ?? readQueueExcerptSafe(vaultRoot);
  const expectedOutputContract =
    options.expectedOutputContract ??
    existingRepair?.expected_output_contract ??
    expectedOutputContractFor(commandOrSkill, phase);
  const lastStderr = options.lastStderr ?? existingRepair?.last_stderr ?? error;
  const lastStdout = options.lastStdout ?? existingRepair?.last_stdout ?? "";

  const repairContext: RepairContext = {
    original_task: {
      kind: existingRepair?.original_task.kind ?? originalTask.phase,
      target: originalTask.target,
    },
    error_message: error,
    vault_root: vaultRoot,
    absolute_source_path: absoluteSourcePath,
    expected_output_contract: expectedOutputContract,
    phase,
    command_or_skill: commandOrSkill,
    last_stderr: lastStderr,
    last_stdout: lastStdout,
    queue_excerpt: queueExcerpt,
    relevant_file_diffs: relevantFileDiffs,
    stack_trace: options.stackTrace ?? existingRepair?.stack_trace,
    file_state: Object.keys(fileState).length > 0 ? fileState : undefined,
    attempted_at: new Date().toISOString(),
    attempt_count: attemptCount,
  };

  return {
    taskId: randomUUID(),
    vaultId: originalTask.vaultId,
    target: originalTask.target,
    sourcePath: absoluteSourcePath,
    phase: originalTask.phase,
    status: "pending",
    executionMode: "orchestrated",
    type: originalTask.type,
    batch: originalTask.batch,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 3,
    completedPhases: originalTask.completedPhases,
    repair_context: repairContext,
  };
}

function buildRepairPrompt(task: PipelineTask): string {
  const rc = task.repair_context!;
  const lines: string[] = [
    `You are repairing a failed intent-computer task in vault: ${rc.vault_root}`,
    "",
    "=== FAILURE SUMMARY ===",
    `Task kind: ${rc.original_task.kind}`,
    `Task target: ${rc.original_task.target}`,
    `Phase: ${rc.phase}`,
    `Command/skill: ${rc.command_or_skill}`,
    `Attempt: ${rc.attempt_count}`,
    `Failure time: ${rc.attempted_at}`,
    `Error: ${rc.error_message}`,
    "",
    "=== EXECUTION CONTEXT ===",
    `Source path: ${rc.absolute_source_path || "(none provided)"}`,
    `Expected output contract: ${rc.expected_output_contract}`,
    "",
    "=== LAST PROCESS OUTPUT ===",
    "STDERR:",
    rc.last_stderr || "(empty)",
    "",
    "STDOUT:",
    rc.last_stdout || "(empty)",
    "",
    "=== QUEUE EXCERPT ===",
    rc.queue_excerpt || "(queue excerpt unavailable)",
  ];

  if (rc.stack_trace) {
    lines.push("", "=== STACK TRACE ===", truncate(rc.stack_trace, 4000));
  }

  if (rc.file_state && Object.keys(rc.file_state).length > 0) {
    lines.push("", "=== FILE SNAPSHOT ===");
    for (const [path, content] of Object.entries(rc.file_state)) {
      lines.push(`--- ${path} ---`, content, "--- end ---");
    }
  }

  if (rc.relevant_file_diffs.length > 0) {
    lines.push("", "=== RELEVANT FILE DIFFS ===");
    for (const entry of rc.relevant_file_diffs.slice(0, 5)) {
      lines.push(`--- ${entry.path} ---`, entry.diff, "--- end diff ---");
    }
  }

  lines.push(
    "",
    "=== REPAIR TASK ===",
    "1. Diagnose root cause from the context above.",
    "2. Apply concrete file changes in the vault.",
    "3. Re-run or validate the failing step.",
    "4. Return a concise report with changed file paths and validation evidence.",
    "Output only the repair report.",
  );

  return lines.join("\n");
}

function checkDepth(): boolean {
  const depth = parseInt(process.env.INTENT_HEARTBEAT_DEPTH ?? "0", 10);
  if (depth >= MAX_HEARTBEAT_DEPTH) {
    console.log(`[heartbeat] Depth limit reached (${depth}/${MAX_HEARTBEAT_DEPTH}), skipping`);
    return false;
  }
  return true;
}

function shouldResetDepth(vaultRoot: string): boolean {
  const markerPath = join(vaultRoot, "ops", ".heartbeat-marker");
  if (!existsSync(markerPath)) return false;

  const thoughtsDir = join(vaultRoot, "thoughts");
  if (!existsSync(thoughtsDir)) return false;

  let markerTime = 0;
  try {
    markerTime = statSync(markerPath).mtimeMs;
  } catch {
    return false;
  }

  try {
    const entries = readdirSync(thoughtsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const thoughtPath = join(thoughtsDir, entry.name);
      if (statSync(thoughtPath).mtimeMs > markerTime) return true;
    }
  } catch {
    return false;
  }

  return false;
}

function countMdFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(name => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function checkVaultConditions(
  vaultRoot: string,
  thresholds: MaintenanceThresholds,
): VaultCondition[] {
  const conditions: VaultCondition[] = [
    {
      key: "inbox",
      dir: join(vaultRoot, "inbox"),
      count: 0,
      threshold: thresholds.inbox,
      exceeded: false,
    },
    {
      key: "observations",
      dir: join(vaultRoot, "ops", "observations"),
      count: 0,
      threshold: thresholds.observation,
      exceeded: false,
    },
    {
      key: "tensions",
      dir: join(vaultRoot, "ops", "tensions"),
      count: 0,
      threshold: thresholds.tension,
      exceeded: false,
    },
    {
      key: "sessions",
      dir: join(vaultRoot, "ops", "sessions"),
      count: 0,
      threshold: thresholds.sessions,
      exceeded: false,
    },
  ];

  for (const c of conditions) {
    c.count = c.key === "sessions"
      ? countUnprocessedMineableSessions(c.dir)
      : countMdFiles(c.dir);
    c.exceeded = c.count >= c.threshold;
  }

  return conditions;
}

// ─── Commitment evaluation ────────────────────────────────────────────────────

function migrateCommitments(store: CommitmentStore): CommitmentStore {
  for (const c of store.commitments) {
    if (!c.stateHistory) c.stateHistory = [];
    if (!c.advancementSignals) c.advancementSignals = [];
  }
  return store;
}

function loadCommitments(vaultRoot: string): CommitmentStore {
  const path = join(vaultRoot, "ops", "commitments.json");
  if (!existsSync(path)) {
    return { version: 1, commitments: [], lastEvaluatedAt: "" };
  }
  try {
    return migrateCommitments(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { version: 1, commitments: [], lastEvaluatedAt: "" };
  }
}

function hasPendingRepairForOriginal(
  queue: PipelineQueueFile,
  kind: string,
  target: string,
  excludeTaskId?: string,
): boolean {
  return queue.tasks.some((task) => {
    if (excludeTaskId && task.taskId === excludeTaskId) return false;
    const status = task.status ?? "pending";
    if (status === "done" || status === "archived") return false;
    const rc = task.repair_context;
    if (!rc) return false;
    return rc.original_task.kind === kind && rc.original_task.target === target;
  });
}

interface CommitmentEvaluation {
  commitment: StoredCommitment;
  stale: boolean;
  alignedTasks: number;
  staleDays: number;
}

function evaluateCommitments(
  store: CommitmentStore,
  queue: PipelineQueueFile,
): CommitmentEvaluation[] {
  const now = Date.now();
  const results: CommitmentEvaluation[] = [];

  for (const c of store.commitments) {
    // Backward compatibility: initialize stateHistory if missing
    if (!c.stateHistory) {
      c.stateHistory = [];
    }
    if (!c.advancementSignals) {
      c.advancementSignals = [];
    }

    if (c.state !== "active") continue;

    // Check staleness based on horizon
    const lastAdvanced = c.lastAdvancedAt ? new Date(c.lastAdvancedAt).getTime() : 0;
    const staleDays = Math.floor((now - lastAdvanced) / (24 * 60 * 60 * 1000));

    const staleThresholds: Record<string, number> = {
      session: 1,  // stale after 1 day without progress
      week: 3,     // stale after 3 days
      quarter: 14, // stale after 2 weeks
      long: 30,    // stale after a month
    };

    const threshold = staleThresholds[c.horizon] ?? 7;
    const stale = staleDays > threshold;

    // Count aligned queue tasks
    const labelLower = c.label.toLowerCase();
    const alignedTasks = queue.tasks.filter(t => {
      const target = t.target.toLowerCase();
      const source = t.sourcePath.toLowerCase();
      const status = t.status ?? "pending";
      if (status === "done" || status === "archived") return false;
      return target.includes(labelLower) || source.includes(labelLower);
    }).length;

    // Record advancement signal when aligned tasks indicate active work
    if (alignedTasks > 0) {
      recordAdvancementSignal(
        c,
        `${alignedTasks} aligned queue task(s) detected`,
        0.3, // below 0.5 threshold — presence of tasks is weak signal, not actual progress
        "inferred",
      );
    }

    results.push({ commitment: c, stale, alignedTasks, staleDays });
  }

  return results;
}

// ─── Morning brief generation ─────────────────────────────────────────────────

export interface PipelineTriggerResult {
  triggered: number;
  tasks: PipelineTask[];
}

export interface TriggerExecutionResult {
  taskId: string;
  phase: PipelinePhase;
  success: boolean;
  executed: boolean;
  executionMode?: "executed" | "advisory";
  detail: string;
  deferralReason?: "thin-desire" | "constitutive-friction" | "repair-policy" | "dry-run";
  stdout?: string;
  stderr?: string;
  commandOrSkill?: string;
  expectedOutputContract?: string;
}

export interface TaskRunnerContext {
  vaultRoot: string;
  runnerCommand?: string;
  timeoutMs: number;
}

export type HeartbeatTaskSelection = "queue-first" | "aligned-first";
export type HeartbeatRepairMode = "queue-only" | "execute";
export type HeartbeatThresholdMode = "queue-only" | "execute";
export type HeartbeatRunSlot = "morning" | "evening" | "overnight" | "manual";

export type HeartbeatTaskRunner = (
  task: PipelineTask,
  context: TaskRunnerContext,
) => TriggerExecutionResult;

/** Valid heartbeat phase identifiers for selective execution. */
export type HeartbeatPhase = "4a" | "5a" | "5b" | "5c" | "6" | "7";

export interface HeartbeatOptions {
  /** Run only these phases instead of all. Omit or pass undefined for full heartbeat. */
  phases?: HeartbeatPhase[];
  /** @deprecated Legacy toggle; defaults to true when omitted. */
  executeAlignedTasks?: boolean;
  dryRun?: boolean;
  /** @deprecated Use maxActionsPerRun. */
  maxTriggeredTasks?: number;
  maxActionsPerRun?: number;
  runnerCommand?: string;
  runnerTimeoutMs?: number;
  taskRunner?: HeartbeatTaskRunner;
  taskSelection?: HeartbeatTaskSelection;
  repairMode?: HeartbeatRepairMode;
  thresholdMode?: HeartbeatThresholdMode;
  configPath?: string;
  runSlot?: HeartbeatRunSlot;
}

export interface HeartbeatResult {
  conditions: VaultCondition[];
  evaluations: CommitmentEvaluation[];
  queueDepth: number;
  queueDepthBefore: number;
  queueDepthAfter: number;
  recommendations: string[];
  briefWritten: boolean;
  alignedTasks: PipelineTask[];
  triggered: TriggerExecutionResult[];
  executedActions: number;
  advisoryActions: number;
  repairsQueued: number;
  repairsSkipped: number;
  thresholdActionsRun: number;
  perceptionSummary?: PerceptionSummary;
  thinDeferredActions: number;
  constitutiveDeferredActions: number;
}

function collectAlignedTasks(
  vaultRoot: string,
  store: CommitmentStore,
  queue: PipelineQueueFile,
): PipelineTask[] {
  const activeLabels = store.commitments
    .filter((c) => c.state === "active")
    .map((c) => c.label.toLowerCase());

  return queue.tasks.filter((task) => {
    const status = task.status ?? "pending";
    if (status === "done" || status === "archived") return false;
    const target = task.target.toLowerCase();
    const source = task.sourcePath.toLowerCase();
    return activeLabels.some(
      (label) => target.includes(label) || source.includes(label),
    );
  }).map((task) => ({
    ...task,
    vaultId: vaultRoot,
  }));
}

function isTaskAligned(task: PipelineTask, activeLabels: string[]): boolean {
  const target = task.target.toLowerCase();
  const source = task.sourcePath.toLowerCase();
  return activeLabels.some((label) => target.includes(label) || source.includes(label));
}

interface TaskPolicyTags {
  aligned: boolean;
  thinOnly: boolean;
  constitutiveOnly: boolean;
}

function resolveTaskPolicyTags(
  task: PipelineTask,
  activeCommitments: StoredCommitment[],
): TaskPolicyTags {
  const target = task.target.toLowerCase();
  const source = task.sourcePath.toLowerCase();
  const aligned = activeCommitments.filter((commitment) => {
    const label = commitment.label.toLowerCase();
    return target.includes(label) || source.includes(label);
  });

  if (aligned.length === 0) {
    return { aligned: false, thinOnly: false, constitutiveOnly: false };
  }

  const thinOnly = aligned.every((commitment) => commitment.desireClass === "thin");
  const constitutiveOnly = aligned.every(
    (commitment) => commitment.frictionClass === "constitutive",
  );

  return { aligned: true, thinOnly, constitutiveOnly };
}

function taskAgeMs(task: PipelineTask): number {
  const reference = task.createdAt ?? task.updatedAt;
  if (!reference) return Number.MAX_SAFE_INTEGER;
  const parsed = new Date(reference).getTime();
  if (Number.isNaN(parsed)) return Number.MAX_SAFE_INTEGER;
  return parsed;
}

function selectQueueTasks(
  vaultRoot: string,
  store: CommitmentStore,
  queue: PipelineQueueFile,
  options: HeartbeatOptions,
): PipelineTask[] {
  const activeCommitments = store.commitments.filter((commitment) => commitment.state === "active");
  const activeLabels = activeCommitments.map((commitment) => commitment.label.toLowerCase());
  const selection = options.taskSelection ?? "queue-first";

  const candidates = queue.tasks
    .filter((task) => (task.status ?? "pending") === "pending")
    .map((task) => ({
      task,
      aligned: isTaskAligned(task, activeLabels),
      tags: resolveTaskPolicyTags(task, activeCommitments),
    }))
    .filter(({ task, aligned, tags }) => {
      if (selection === "aligned-first") return aligned || tags.aligned;
      return true;
    });

  const sorted = [...candidates].sort((left, right) => {
    const leftRepair = left.task.repair_context ? 1 : 0;
    const rightRepair = right.task.repair_context ? 1 : 0;
    if (leftRepair !== rightRepair) return leftRepair - rightRepair;

    if (left.aligned !== right.aligned) return left.aligned ? -1 : 1;

    return taskAgeMs(left.task) - taskAgeMs(right.task);
  });

  return sorted.map(({ task }) => ({ ...task, vaultId: vaultRoot }));
}

function phaseSequence(_type?: string): PipelinePhase[] {
  return ["surface", "reflect", "revisit", "verify"];
}

function nextPhase(current: PipelinePhase, type?: string): PipelinePhase | null {
  const order = phaseSequence(type);
  const idx = order.indexOf(current);
  if (idx === -1) return null;
  return order[idx + 1] ?? null;
}

function phaseToSkill(phase: PipelinePhase): string {
  switch (phase) {
    case "surface":
      return "reduce";
    case "reflect":
      return "reflect";
    case "revisit":
      return "reweave";
    case "verify":
      return "verify";
    default:
      return "reduce";
  }
}

function buildTaskContext(task: PipelineTask, vaultRoot: string): string {
  const sourcePath = task.sourcePath.startsWith("/")
    ? task.sourcePath
    : join(vaultRoot, task.sourcePath);
  const sourceContent = readFileStateSafe(sourcePath);

  return [
    `Task ID: ${task.taskId}`,
    `Phase: ${task.phase}`,
    `Target: ${task.target}`,
    `Source: ${sourcePath}`,
    "",
    "Task instructions:",
    "- Execute the pipeline phase against the source material.",
    "- Persist file changes in the vault.",
    "- Return a concise completion summary with changed files.",
    "",
    "Source excerpt:",
    sourceContent ? truncate(sourceContent, 8000) : "(source file missing or unreadable)",
  ].join("\n");
}

function defaultTaskRunner(
  task: PipelineTask,
  context: TaskRunnerContext,
): TriggerExecutionResult {
  const command = context.runnerCommand || process.env.INTENT_HEARTBEAT_RUNNER;
  if (!command) {
    const skillName = phaseToSkill(task.phase);
    const taskContext = buildTaskContext(task, context.vaultRoot);
    const result = runSkillTask(skillName, taskContext, context.vaultRoot, { timeoutMs: context.timeoutMs });
    return {
      taskId: task.taskId,
      phase: task.phase,
      success: result.success,
      executed: true,
      executionMode: "executed",
      detail: result.success
        ? (result.output || `${skillName} completed`)
        : result.error ?? `${skillName} failed`,
      stdout: result.output,
      stderr: result.error,
      commandOrSkill: skillName,
      expectedOutputContract: expectedOutputContractFor(skillName, task.phase),
    };
  }

  const env = {
    ...process.env,
    INTENT_TASK_ID: task.taskId,
    INTENT_TASK_TARGET: task.target,
    INTENT_TASK_SOURCE: task.sourcePath,
    INTENT_TASK_PHASE: task.phase,
    INTENT_VAULT_ROOT: context.vaultRoot,
  } as NodeJS.ProcessEnv;
  delete env.CLAUDECODE;

  const result = spawnSync(command, {
    shell: true,
    cwd: context.vaultRoot,
    timeout: context.timeoutMs,
    encoding: "utf-8",
    env,
  });

  if (result.status === 0) {
    return {
      taskId: task.taskId,
      phase: task.phase,
      success: true,
      executed: true,
      executionMode: "executed",
      detail: (result.stdout ?? "").trim() || "runner completed",
      stdout: result.stdout ?? undefined,
      stderr: result.stderr ?? undefined,
      commandOrSkill: command,
      expectedOutputContract: expectedOutputContractFor(command, task.phase),
    };
  }

  return {
    taskId: task.taskId,
    phase: task.phase,
    success: false,
    executed: true,
    executionMode: "executed",
    detail: (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `runner exited with ${result.status}`,
    stdout: result.stdout ?? undefined,
    stderr: result.stderr ?? undefined,
    commandOrSkill: command,
    expectedOutputContract: expectedOutputContractFor(command, task.phase),
  };
}

interface TriggerBatchResult {
  triggered: TriggerExecutionResult[];
  executedActions: number;
  advisoryActions: number;
  repairsQueued: number;
  repairsSkipped: number;
  thinDeferredActions: number;
  constitutiveDeferredActions: number;
}

function triggerQueueTasks(
  queue: PipelineQueueFile,
  selectedTasks: PipelineTask[],
  store: CommitmentStore,
  vaultRoot: string,
  options: HeartbeatOptions,
): TriggerBatchResult {
  const executeTasks = options.executeAlignedTasks ?? true;
  const activeCommitments = store.commitments.filter((commitment) => commitment.state === "active");
  if (!executeTasks) {
    return {
      triggered: [],
      executedActions: 0,
      advisoryActions: 0,
      repairsQueued: 0,
      repairsSkipped: 0,
      thinDeferredActions: 0,
      constitutiveDeferredActions: 0,
    };
  }

  const dryRun = options.dryRun ?? false;
  const limit = Math.max(0, options.maxActionsPerRun ?? options.maxTriggeredTasks ?? 3);
  const runner = options.taskRunner ?? defaultTaskRunner;
  const timeoutMs = options.runnerTimeoutMs ?? 30 * 60 * 1000;
  const selected = selectedTasks.slice(0, limit);
  const repairMode = options.repairMode ?? "queue-only";
  const triggered: TriggerExecutionResult[] = [];
  let repairsQueued = 0;
  let repairsSkipped = 0;
  let advisoryActions = 0;
  let executedActions = 0;
  let thinDeferredActions = 0;
  let constitutiveDeferredActions = 0;

  for (const task of selected) {
    const index = queue.tasks.findIndex((t) => t.taskId === task.taskId);
    if (index === -1) continue;
    const queueTask = queue.tasks[index];

    if (dryRun) {
      triggered.push({
        taskId: queueTask.taskId,
        phase: queueTask.phase,
        success: false,
        executed: false,
        executionMode: "advisory",
        deferralReason: "dry-run",
        detail: "dry-run: skipped execution",
      });
      advisoryActions++;
      continue;
    }

    if (queueTask.repair_context && repairMode === "queue-only") {
      triggered.push({
        taskId: queueTask.taskId,
        phase: queueTask.phase,
        success: false,
        executed: false,
        executionMode: "advisory",
        deferralReason: "repair-policy",
        detail: "repair-mode=queue-only: deferred repair task execution",
      });
      advisoryActions++;
      continue;
    }

    const taskPolicyTags = resolveTaskPolicyTags(queueTask, activeCommitments);
    if (!queueTask.repair_context && taskPolicyTags.thinOnly) {
      triggered.push({
        taskId: queueTask.taskId,
        phase: queueTask.phase,
        success: false,
        executed: false,
        executionMode: "advisory",
        deferralReason: "thin-desire",
        detail: "thin-only commitment alignment: deferred to preserve conservative autonomy policy",
      });
      advisoryActions++;
      thinDeferredActions++;
      continue;
    }

    if (!queueTask.repair_context && taskPolicyTags.constitutiveOnly) {
      triggered.push({
        taskId: queueTask.taskId,
        phase: queueTask.phase,
        success: false,
        executed: false,
        executionMode: "advisory",
        deferralReason: "constitutive-friction",
        detail: "constitutive friction alignment: deferred to preserve pilgrimage-value friction",
      });
      advisoryActions++;
      constitutiveDeferredActions++;
      continue;
    }

    const startIso = new Date().toISOString();
    queueTask.status = "in-progress";
    queueTask.lockedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    queueTask.updatedAt = startIso;
    queue.lastUpdated = startIso;

    // Handle repair tasks: spawn claude with rich repair prompt
    let result: TriggerExecutionResult;
    if (queueTask.repair_context) {
      const repairPrompt = buildRepairPrompt(queueTask);
      const claudeResult = runClaude(repairPrompt, { timeoutMs });
      result = {
        taskId: queueTask.taskId,
        phase: queueTask.phase,
        success: claudeResult.success,
        executed: true,
        executionMode: "executed",
        detail: claudeResult.success
          ? `repair completed (${claudeResult.durationMs}ms)`
          : claudeResult.error ?? "repair failed",
        stdout: claudeResult.output,
        stderr: claudeResult.error,
        commandOrSkill: queueTask.repair_context.command_or_skill,
        expectedOutputContract: queueTask.repair_context.expected_output_contract,
      };
    } else {
      result = runner(queueTask, {
        vaultRoot,
        runnerCommand: options.runnerCommand,
        timeoutMs,
      });
    }

    triggered.push(result);
    if (result.executed) executedActions++;

    const endIso = new Date().toISOString();
    queueTask.updatedAt = endIso;
    queueTask.lockedUntil = undefined;
    queueTask.attempts = (queueTask.attempts ?? 0) + 1;
    queue.lastUpdated = endIso;

    if (result.success) {
      emitTaskExecuted(vaultRoot, {
        taskId: queueTask.taskId,
        phase: queueTask.phase,
        target: queueTask.target,
        isRepair: !!queueTask.repair_context,
      });

      const originalPhase = queueTask.phase;
      const completed = new Set(queueTask.completedPhases ?? []);
      completed.add(queueTask.phase);
      queueTask.completedPhases = [...completed];

      const next = nextPhase(queueTask.phase, queueTask.type);
      if (next) {
        queueTask.phase = next;
        queueTask.status = "pending";
      } else {
        queueTask.status = "done";
      }

      // The surface skill marks its own task "done" in the queue file during execution.
      // The delta-merge at run end gives the skill's write precedence over our phase
      // advancement above, silently bypassing the surface→reflect chain.
      // Fix: explicitly push a separate reflect task so the delta captures it as an
      // addition (additions always survive the merge).
      if (originalPhase === "surface" && !queueTask.repair_context) {
        const reflectId = `${queueTask.taskId}-reflect`;
        const alreadyQueued = queue.tasks.some(
          (t) =>
            t.taskId === reflectId ||
            (t.phase === "reflect" &&
              t.target === queueTask.target &&
              (t.status === "pending" || t.status === "in-progress")),
        );
        if (!alreadyQueued) {
          queue.tasks.push({
            taskId: reflectId,
            vaultId: queueTask.vaultId,
            target: queueTask.target,
            sourcePath: queueTask.sourcePath,
            phase: "reflect",
            status: "pending",
            executionMode: queueTask.executionMode,
            createdAt: endIso,
            updatedAt: endIso,
            attempts: 0,
            maxAttempts: queueTask.maxAttempts ?? 3,
            completedPhases: ["surface"],
          });
          queue.lastUpdated = endIso;
          console.log(`[heartbeat] Queued reflect task ${reflectId} after surface success`);
        }
      }
      if (originalPhase === "reflect" && !queueTask.repair_context) {
        const revisitId = `${queueTask.taskId}-revisit`;
        const alreadyQueued = queue.tasks.some(
          (t) =>
            t.taskId === revisitId ||
            (t.phase === "revisit" &&
              t.target === queueTask.target &&
              (t.status === "pending" || t.status === "in-progress")),
        );
        if (!alreadyQueued) {
          queue.tasks.push({
            taskId: revisitId,
            vaultId: queueTask.vaultId,
            target: queueTask.target,
            sourcePath: queueTask.sourcePath,
            phase: "revisit",
            status: "pending",
            executionMode: queueTask.executionMode,
            createdAt: endIso,
            updatedAt: endIso,
            attempts: 0,
            maxAttempts: queueTask.maxAttempts ?? 3,
            completedPhases: ["surface", "reflect"],
          });
          queue.lastUpdated = endIso;
          console.log(`[heartbeat] Queued revisit task ${revisitId} after reflect success`);
        }
      }
      if (originalPhase === "revisit" && !queueTask.repair_context) {
        const verifyId = `${queueTask.taskId}-verify`;
        const alreadyQueued = queue.tasks.some(
          (t) =>
            t.taskId === verifyId ||
            (t.phase === "verify" &&
              t.target === queueTask.target &&
              (t.status === "pending" || t.status === "in-progress")),
        );
        if (!alreadyQueued) {
          queue.tasks.push({
            taskId: verifyId,
            vaultId: queueTask.vaultId,
            target: queueTask.target,
            sourcePath: queueTask.sourcePath,
            phase: "verify",
            status: "pending",
            executionMode: queueTask.executionMode,
            createdAt: endIso,
            updatedAt: endIso,
            attempts: 0,
            maxAttempts: queueTask.maxAttempts ?? 3,
            completedPhases: ["surface", "reflect", "revisit"],
          });
          queue.lastUpdated = endIso;
          console.log(`[heartbeat] Queued verify task ${verifyId} after revisit success`);
        }
      }
    } else {
      emitTaskFailed(vaultRoot, {
        taskId: queueTask.taskId,
        phase: queueTask.phase,
        target: queueTask.target,
        error: result.detail,
        isRepair: !!queueTask.repair_context,
      });

      const maxAttempts = queueTask.maxAttempts ?? 3;
      queueTask.status = (queueTask.attempts ?? 0) >= maxAttempts ? "failed" : "pending";

      // Queue a repair task if under the repair attempt limit
      const currentRepairCount = queueTask.repair_context?.attempt_count ?? 0;
      if (
        currentRepairCount < MAX_REPAIR_ATTEMPTS &&
        !hasPendingRepairForOriginal(
          queue,
          queueTask.phase,
          queueTask.target,
          queueTask.taskId,
        )
      ) {
        const repairTask = buildRepairTask(queueTask, result.detail, {
          vaultRoot,
          phase: queueTask.phase,
          commandOrSkill:
            result.commandOrSkill ??
            queueTask.repair_context?.command_or_skill ??
            queueTask.phase,
          expectedOutputContract:
            result.expectedOutputContract ??
            queueTask.repair_context?.expected_output_contract,
          queueExcerpt: buildQueueExcerpt(queue),
          lastStderr: result.stderr ?? result.detail,
          lastStdout: result.stdout,
        });
        queue.tasks.push(repairTask);
        queue.lastUpdated = endIso;
        repairsQueued++;
        console.log(`[heartbeat] Queued repair task ${repairTask.taskId} for failed task ${queueTask.taskId} (attempt ${repairTask.repair_context!.attempt_count})`);

        emitRepairQueued(vaultRoot, {
          repairTaskId: repairTask.taskId,
          originalTaskId: queueTask.taskId,
          phase: queueTask.phase,
          target: queueTask.target,
          attemptCount: repairTask.repair_context!.attempt_count,
          error: result.detail,
        });
      } else {
        repairsSkipped++;
      }
    }
  }

  return {
    triggered,
    executedActions,
    advisoryActions,
    repairsQueued,
    repairsSkipped,
    thinDeferredActions,
    constitutiveDeferredActions,
  };
}

interface ThresholdAction {
  condition: string;
  threshold: number;
  current: number;
  action: string;
  skillName: string;
  taskContext: string;
  targetPath?: string;
}

function evaluateThresholds(
  vaultRoot: string,
  thresholds: MaintenanceThresholds,
): ThresholdAction[] {
  const actions: ThresholdAction[] = [];

  // Inbox pressure — handled separately by seedInboxItems() in Phase 5c.
  const inboxDir = join(vaultRoot, "inbox");
  const inboxFiles = existsSync(inboxDir)
    ? readdirSync(inboxDir).filter((f) => f.endsWith(".md"))
    : [];
  const inboxCount = inboxFiles.length;
  if (inboxCount >= thresholds.inbox) {
    actions.push({
      condition: "inbox-pressure",
      threshold: thresholds.inbox,
      current: inboxCount,
      action: "auto-seed-inbox",
      skillName: "reduce",
      taskContext: `${inboxCount} inbox items detected. Auto-seeding handled by seedInboxItems().`,
      targetPath: inboxDir,
    });
  }

  // Observation backlog
  const obsDir = join(vaultRoot, "ops", "observations");
  const obsFiles = existsSync(obsDir)
    ? readdirSync(obsDir).filter((f) => f.endsWith(".md"))
    : [];
  const obsCount = obsFiles.length;
  const obsTargetPath = obsFiles.length > 0 ? join(obsDir, obsFiles[0]) : obsDir;
  if (obsCount >= thresholds.observation) {
    actions.push({
      condition: "observation-backlog",
      threshold: thresholds.observation,
      current: obsCount,
      action: "triage-observations",
      skillName: "rethink",
      taskContext: `Triage ${obsCount} pending observations in ${obsDir}. Promote patterns to thoughts, resolve addressed items.`,
      targetPath: obsTargetPath,
    });
  }

  // Orphan graph entities
  const graphScan = scanVaultGraph(vaultRoot, {
    entityDirs: ["thoughts", "self"],
    excludeCodeBlocks: true,
  });
  const orphanCount = graphScan.orphanCount;
  const firstOrphanPath = graphScan.orphanEntities[0]?.path;
  const fallbackGraphRoot = join(vaultRoot, "thoughts");
  if (orphanCount >= thresholds.orphan) {
    actions.push({
      condition: "orphan-pressure",
      threshold: thresholds.orphan,
      current: orphanCount,
      action: "connect-orphans",
      skillName: "reflect",
      taskContext: `Connect ${orphanCount} orphan graph entities. Find relationships and add wiki links.`,
      targetPath: firstOrphanPath ?? fallbackGraphRoot,
    });
  }

  return actions;
}

function thresholdActionPhase(skillName: string): PipelinePhase {
  if (skillName === "reflect") return "reflect";
  if (skillName === "reweave") return "revisit";
  if (skillName === "verify") return "verify";
  return "surface";
}

function hasPendingThresholdTask(queue: PipelineQueueFile, condition: string, sourcePath?: string): boolean {
  return queue.tasks.some((task) => {
    const status = task.status ?? "pending";
    if (status === "done" || status === "archived") return false;
    if (task.target === condition) return true;
    if (sourcePath && task.sourcePath === sourcePath) return true;
    return false;
  });
}

// ─── Autonomous inbox seeding ────────────────────────────────────────────────

interface SeedResult {
  file: string;
  slug: string;
  archivePath: string;
  taskId: string;
}

/**
 * Seed inbox items into the pipeline queue without Claude invocation.
 *
 * 1. Creates archive folder at ops/queue/archive/{date}-{slug}/
 * 2. Moves inbox file to archive
 * 3. Creates a surface-phase queue task pointing at the archived file
 *
 * Skips files that already have a pending/in-progress task in the queue.
 */
function seedInboxItems(
  vaultRoot: string,
  queue: PipelineQueueFile,
  maxPerCycle = 3,
): SeedResult[] {
  const inboxDir = join(vaultRoot, "inbox");
  if (!existsSync(inboxDir)) return [];

  const inboxFiles = readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
  if (inboxFiles.length === 0) return [];

  const results: SeedResult[] = [];
  const archiveBase = join(vaultRoot, "ops", "queue", "archive");
  const datePrefix = new Date().toISOString().slice(0, 10);

  for (const file of inboxFiles.slice(0, maxPerCycle)) {
    const filePath = join(inboxDir, file);
    const slug = basename(file, ".md")
      .replace(/\s+/g, "-")
      .toLowerCase();

    const archiveDir = join(archiveBase, `${datePrefix}-${slug}`);
    const archivedPath = join(archiveDir, file);
    const alreadyQueued = queue.tasks.some((task) => {
      const status = task.status ?? "pending";
      if (status === "done" || status === "archived") return false;
      return (
        task.sourcePath === filePath ||
        task.sourcePath === archivedPath ||
        task.target === `inbox-item:${slug}`
      );
    });
    if (alreadyQueued) {
      console.log(`[heartbeat:seed] Skipping ${file} — already queued`);
      continue;
    }

    try {
      mkdirSync(archiveDir, { recursive: true });
    } catch (err) {
      console.error(`[heartbeat:seed] Failed to create archive dir ${archiveDir}:`, err);
      continue;
    }

    try {
      renameSync(filePath, archivedPath);
    } catch (err) {
      console.error(`[heartbeat:seed] Failed to move ${filePath} to ${archivedPath}:`, err);
      continue;
    }

    const taskId = randomUUID();
    const now = new Date().toISOString();
    const task: PipelineTask = {
      taskId,
      vaultId: vaultRoot,
      target: `inbox-item:${slug}`,
      sourcePath: archivedPath,
      phase: "surface",
      status: "pending",
      executionMode: "orchestrated",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      maxAttempts: 3,
    };
    queue.tasks.push(task);
    queue.lastUpdated = now;

    results.push({ file, slug, archivePath: archivedPath, taskId });
    console.log(`[heartbeat:seed] Seeded ${file} → ${archivedPath} (task ${taskId})`);
  }

  return results;
}

// ─── Curiosity advisory: graph topology analysis ─────────────────────────────

interface MapProfile {
  name: string;
  thoughtCount: number;
  incomingLinks: number;
  outgoingLinks: number;
  openQuestions: string[];
}

interface ConfidenceDistribution {
  felt: number;
  observed: number;
  tested: number;
  unspecified: number;
}

interface CuriosityContext {
  totalThoughts: number;
  totalMaps: number;
  maps: MapProfile[];
  thinMaps: MapProfile[];
  confidenceDistribution: ConfidenceDistribution;
  sinkNodes: string[];
  orphanCount: number;
}

function gatherCuriosityContext(vaultRoot: string): string {
  const thoughtsDir = join(vaultRoot, "thoughts");
  if (!existsSync(thoughtsDir)) return "No thoughts directory found.";

  // Read all thought files once
  const thoughtFiles: Array<{ name: string; content: string; isMap: boolean }> = [];
  try {
    for (const file of readdirSync(thoughtsDir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = readFileSync(join(thoughtsDir, file), "utf-8");
        const isMap = /^type:\s*map/m.test(content);
        thoughtFiles.push({ name: file.replace(/\.md$/, ""), content, isMap });
      } catch { continue; }
    }
  } catch { return "Could not read thoughts directory."; }

  const maps = thoughtFiles.filter((f) => f.isMap);
  const thoughts = thoughtFiles.filter((f) => !f.isMap);

  // Count topics (backlinks) per map
  const mapProfiles: MapProfile[] = [];
  for (const map of maps) {
    const mapKey = map.name.toLowerCase();
    let thoughtCount = 0;
    for (const thought of thoughts) {
      // Check if thought lists this map in its topics
      if (thought.content.toLowerCase().includes(`[[${mapKey}]]`)) {
        thoughtCount++;
      }
    }

    // Count outgoing wiki links from the map itself
    const outgoing = (map.content.match(/\[\[[^\]]+\]\]/g) ?? []).length;

    // Extract open questions
    const openQs: string[] = [];
    const oqMatch = map.content.match(/## Open Questions[\s\S]*?(?=\n## |\n---|\Z)/);
    if (oqMatch) {
      const lines = oqMatch[0].split("\n").filter((l) => l.startsWith("- "));
      openQs.push(...lines.map((l) => l.replace(/^- /, "").trim()).slice(0, 5));
    }

    mapProfiles.push({
      name: map.name,
      thoughtCount,
      incomingLinks: 0, // filled below
      outgoingLinks: outgoing,
      openQuestions: openQs,
    });
  }

  // Find thin maps (fewer than 5 thoughts)
  const thinMaps = mapProfiles.filter((m) => m.thoughtCount < 5);

  // Confidence distribution
  const conf: ConfidenceDistribution = { felt: 0, observed: 0, tested: 0, unspecified: 0 };
  for (const thought of thoughts) {
    const confMatch = thought.content.match(/^confidence:\s*(\w+)/m);
    if (!confMatch) { conf.unspecified++; continue; }
    const val = confMatch[1].toLowerCase();
    if (val === "felt") conf.felt++;
    else if (val === "observed") conf.observed++;
    else if (val === "tested") conf.tested++;
    else conf.unspecified++;
  }

  // Find sink nodes: thoughts with many incoming links but zero outgoing
  const sinkNodes: string[] = [];
  for (const thought of thoughts) {
    const outgoing = (thought.content.match(/\[\[[^\]]+\]\]/g) ?? []).length;
    // Exclude frontmatter topic links from "outgoing" count — we want body links
    const bodyStart = thought.content.indexOf("---", thought.content.indexOf("---") + 1);
    const body = bodyStart > 0 ? thought.content.slice(bodyStart + 3) : thought.content;
    const bodyLinks = (body.match(/\[\[[^\]]+\]\]/g) ?? []).length;
    if (bodyLinks <= 1 && thought.name.length > 20) {
      // Check if other thoughts link TO this one
      const key = thought.name.toLowerCase();
      let incoming = 0;
      for (const other of thoughtFiles) {
        if (other.name === thought.name) continue;
        if (other.content.toLowerCase().includes(`[[${key}]]`)) incoming++;
      }
      if (incoming >= 3 && bodyLinks <= 1) {
        sinkNodes.push(thought.name);
      }
    }
  }

  // Build the summary
  const lines: string[] = [
    `Total: ${thoughts.length} thoughts, ${maps.length} maps`,
    "",
    "### Map Sizes (thoughts per map)",
    ...mapProfiles
      .sort((a, b) => b.thoughtCount - a.thoughtCount)
      .map((m) => `- ${m.name}: ${m.thoughtCount} thoughts, ${m.outgoingLinks} outgoing links`),
    "",
  ];

  if (thinMaps.length > 0) {
    lines.push(
      "### Thin Maps (< 5 thoughts — areas that may need feeding)",
      ...thinMaps.map((m) => `- ${m.name}: ${m.thoughtCount} thoughts`),
      "",
    );
  }

  const mapsWithQuestions = mapProfiles.filter((m) => m.openQuestions.length > 0);
  if (mapsWithQuestions.length > 0) {
    lines.push("### Open Questions (from maps)");
    for (const m of mapsWithQuestions) {
      lines.push(`**${m.name}:**`);
      for (const q of m.openQuestions) lines.push(`  - ${q}`);
    }
    lines.push("");
  }

  lines.push(
    "### Confidence Distribution",
    `- felt: ${conf.felt}, observed: ${conf.observed}, tested: ${conf.tested}, unspecified: ${conf.unspecified}`,
    "",
  );

  if (sinkNodes.length > 0) {
    lines.push(
      "### Sink Nodes (≥3 incoming links but ≤1 outgoing — absorb attention but don't generate connections)",
      ...sinkNodes.slice(0, 10).map((n) => `- ${n}`),
      "",
    );
  }

  return lines.join("\n");
}

function shouldGenerateMorningBrief(vaultRoot: string): boolean {
  const briefPath = join(vaultRoot, "ops", "morning-brief.md");
  if (!existsSync(briefPath)) return true;
  try {
    return Date.now() - statSync(briefPath).mtimeMs >= MORNING_BRIEF_STALE_MS;
  } catch {
    return true;
  }
}

function buildCommitmentSummary(
  store: CommitmentStore,
  evaluations: CommitmentEvaluation[],
): string {
  const active = store.commitments.filter((c) => c.state === "active");
  if (active.length === 0) return "No active commitments.";

  const lines = active.map((commitment) => {
    const evaluation = evaluations.find((e) => e.commitment.id === commitment.id);
    const staleLabel = evaluation?.stale ? `, stale ${evaluation.staleDays}d` : "";
    const alignedLabel = evaluation?.alignedTasks
      ? `, ${evaluation.alignedTasks} aligned tasks`
      : "";
    return `- [${commitment.horizon}] ${commitment.label} (priority ${commitment.priority}${staleLabel}${alignedLabel})`;
  });
  return lines.join("\n");
}

interface HeartbeatSynthesisMetrics {
  executedActions: number;
  advisoryActions: number;
  queueDepthBefore: number;
  queueDepthAfter: number;
  repairsQueued: number;
  repairsSkipped: number;
  thresholdActionsRun: number;
  thinDeferredActions: number;
  constitutiveDeferredActions: number;
  perceptionSummary?: PerceptionSummary;
  evaluationRecord?: EvaluationRecord;
}

function writeTemplateMorningBrief(
  briefPath: string,
  conditions: ConditionResults,
  commitmentSummary: string,
): void {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toTimeString().slice(0, 5);
  const lines: string[] = [
    "# Morning Brief",
    "",
    `Generated: ${dateStr} ${timeStr}`,
    "",
  ];

  const exceeded = conditions.filter((condition) => condition.exceeded);
  if (exceeded.length > 0) {
    lines.push("## Attention Needed", "");
    for (const condition of exceeded) {
      lines.push(`- **${condition.key}**: ${condition.count} items (threshold: ${condition.threshold})`);
    }
    lines.push("");
  }

  lines.push("## Active Commitments", "", commitmentSummary || "No active commitments.", "");
  lines.push("## Recommendations", "", "- Start with the single highest-impact pending action.", "");
  writeFileSync(briefPath, lines.join("\n").trim() + "\n", "utf-8");
}

function generateMorningBrief(
  vaultRoot: string,
  conditions: ConditionResults,
  commitmentSummary: string,
  metrics: HeartbeatSynthesisMetrics,
): boolean {
  const briefPath = join(vaultRoot, "ops", "morning-brief.md");
  const briefDir = dirname(briefPath);
  if (!existsSync(briefDir)) {
    mkdirSync(briefDir, { recursive: true });
  }

  const goalsContent = readFirstExisting([
    join(vaultRoot, "self", "goals.md"),
    join(vaultRoot, "ops", "goals.md"),
  ]) ?? "No goals found.";

  const workingMemory = readFirstExisting([
    join(vaultRoot, "self", "working-memory.md"),
    join(vaultRoot, "ops", "working-memory.md"),
  ]) ?? "No working memory.";

  const curiosityContext = gatherCuriosityContext(vaultRoot);

  const prompt = `You are generating a morning brief for a knowledge vault at ${vaultRoot}.

Current date: ${new Date().toISOString().split("T")[0]}

## Vault Conditions
${JSON.stringify(conditions, null, 2)}

## Active Commitments
${commitmentSummary}

## Execution Metrics
${JSON.stringify(metrics, null, 2)}

## Current Goals
${goalsContent}

## Recent Working Memory
${workingMemory.split("\n").slice(-30).join("\n")}

## Graph Topology
${curiosityContext}

## Perception Feeds
${metrics.perceptionSummary ? JSON.stringify(metrics.perceptionSummary, null, 2) : "No perception data this cycle."}

## Thought Impact Evaluation
${metrics.evaluationRecord ? `Thoughts scored: ${metrics.evaluationRecord.thoughtsScored}
Average impact: ${metrics.evaluationRecord.avgImpactScore}
Orphan rate: ${(metrics.evaluationRecord.orphanRate * 100).toFixed(1)}%
Top 3 by impact: ${metrics.evaluationRecord.topThoughts.slice(0, 3).map((t) => `"${t.title}" (impact: ${t.impactScore}, links: ${t.incomingLinks}, maps: ${t.mapMemberships})`).join("; ")}
Orphan thoughts: ${metrics.evaluationRecord.orphanThoughts.length}` : "No evaluation data this cycle."}

## Your Task
Write a morning brief (300-500 words) that:
1. Summarizes what's active and what needs attention
2. Highlights any condition thresholds that are breached
3. Suggests the single most valuable next action
4. Notes any commitments that are going stale
5. Cites concrete runtime counters (actions executed vs advisory, queue depth change, repairs)
6. Calls out thin-desire and constitutive-friction deferrals when present
7. If perception data is present, include a "## Perception" section summarizing what the feeds surfaced and which items were admitted to inbox
8. If thought evaluation data is present, include a "## Thought Impact" section noting top thoughts by impact, orphan count and rate, and average impact score
9. Write a "## Curiosity Advisory" section (3-5 bullet points) that:
   - Identifies thin maps or topic areas that could benefit from more research
   - Flags open questions from maps that have gone unanswered
   - Notes areas where confidence is mostly "felt" and could use external evidence
   - Highlights sink nodes (thoughts many others reference but that don't link outward — dead ends worth expanding)
   - Suggests specific research directions based on graph gaps vs active commitments
   Be honest about where the graph is thin or weak. This is about finding where curiosity should pull next.

Write in a warm, direct voice. Use markdown. Start with "# Morning Brief — [date]".
Output ONLY the brief content, no preamble.`;

  const result = runClaude(prompt, { timeoutMs: 60_000 });

  if (result.success && result.output.length > 50) {
    writeFileSync(briefPath, result.output, "utf-8");
    console.log(`[heartbeat:6] Morning brief generated (${result.output.length} chars, ${result.durationMs}ms)`);
    return true;
  }

  console.log(`[heartbeat:6] Morning brief generation failed: ${result.error ?? "output too short"}`);
  writeTemplateMorningBrief(briefPath, conditions, commitmentSummary);
  console.log("[heartbeat:6] Wrote template fallback brief");
  return true;
}

function updateWorkingMemory(vaultRoot: string, actionsPerformed: string[]): void {
  const wmPaths = [
    join(vaultRoot, "self", "working-memory.md"),
    join(vaultRoot, "ops", "working-memory.md"),
  ];

  let wmPath = wmPaths[0];
  for (const path of wmPaths) {
    if (existsSync(path)) {
      wmPath = path;
      break;
    }
  }

  const existingWm = existsSync(wmPath) ? readFileSync(wmPath, "utf-8") : "";

  const prompt = `You are updating the working memory for a knowledge vault.

Current working memory:
${existingWm.split("\n").slice(-80).join("\n")}

Actions performed this heartbeat cycle:
${actionsPerformed.map((action) => `- ${action}`).join("\n")}

Current time: ${new Date().toISOString()}

## Your Task
Write an updated working memory entry (3-5 lines) that:
1. Notes what was done in this cycle
2. Carries forward any important context from the existing memory
3. Flags anything that needs human attention

Output ONLY the entry lines (no headers, no preamble). These will be appended to the existing working memory.`;

  const result = runClaude(prompt, { timeoutMs: 30_000 });

  if (result.success && result.output.length > 10) {
    const existing = existingWm.split("\n").filter((line) => line.trim());
    const newLines = result.output.split("\n");
    const bounded = [...existing.slice(-200), "", ...newLines];
    const dir = dirname(wmPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(wmPath, bounded.join("\n").trim() + "\n", "utf-8");
    console.log(`[heartbeat:7] Working memory updated (${newLines.length} new lines)`);
  } else {
    console.log(`[heartbeat:7] Working memory update failed: ${result.error ?? "output too short"}`);
  }
}

function writeHeartbeatMarker(vaultRoot: string): void {
  const markerPath = join(vaultRoot, "ops", ".heartbeat-marker");
  const markerDir = dirname(markerPath);
  if (!existsSync(markerDir)) {
    mkdirSync(markerDir, { recursive: true });
  }
  writeFileSync(markerPath, new Date().toISOString(), "utf-8");
}

export async function runHeartbeat(
  vaultRoot: string,
  options: HeartbeatOptions = {},
): Promise<HeartbeatResult> {
  if (shouldResetDepth(vaultRoot)) {
    process.env.INTENT_HEARTBEAT_DEPTH = "0";
    console.log("[heartbeat] Human activity detected; reset recursion depth");
  }

  // Phase gating: when options.phases is set, only run the specified phases.
  // When omitted, run all phases (default / backward-compatible behavior).
  const activePhases = options.phases;
  const shouldRunPhase = (phase: HeartbeatPhase): boolean =>
    activePhases == null || activePhases.includes(phase);

  if (activePhases) {
    console.log(`[heartbeat] Selective execution: phases ${activePhases.join(", ")}`);
  }

  try {
    if (!checkDepth()) {
      return {
        conditions: [],
        evaluations: [],
        queueDepth: 0,
        queueDepthBefore: 0,
        queueDepthAfter: 0,
        recommendations: ["Heartbeat skipped because recursion depth limit was reached."],
        briefWritten: false,
        alignedTasks: [],
        triggered: [],
        executedActions: 0,
        advisoryActions: 0,
        repairsQueued: 0,
        repairsSkipped: 0,
        thresholdActionsRun: 0,
        thinDeferredActions: 0,
        constitutiveDeferredActions: 0,
      };
    }

    const now = new Date();
    const heartbeatStartIso = now.toISOString();
    const thresholds = loadMaintenanceThresholds(vaultRoot, options.configPath);
    const conditions = checkVaultConditions(vaultRoot, thresholds);
    const store = loadCommitments(vaultRoot);
    const queue = readQueue(vaultRoot);
    const initialQueue = cloneQueue(queue);
    const queueDepthBefore = queue.tasks.filter((task) => (task.status ?? "pending") === "pending").length;

    emitHeartbeatRun(vaultRoot, {
      phase: "start",
      queueDepth: queueDepthBefore,
      conditionsChecked: conditions.length,
      selectivePhases: activePhases ?? "all",
      runSlot: options.runSlot ?? "manual",
    });

    const recommendations: string[] = [];
    const actionsPerformed: string[] = [];
    let evaluations: CommitmentEvaluation[] = [];
    let alignedTasks: PipelineTask[] = [];
    let triggered: TriggerExecutionResult[] = [];
    let briefWritten = false;
    let thresholdActionsCount = 0;
    let executedActions = 0;
    let advisoryActions = 0;
    let repairsQueued = 0;
    let repairsSkipped = 0;
    let thinDeferredActions = 0;
    let constitutiveDeferredActions = 0;
    let perceptionSummary: PerceptionSummary | undefined;

    // Phase 4a: Perception — poll feed sources and admit high-signal items.
    if (shouldRunPhase("4a")) {
      try {
        const perceptionStartMs = Date.now();
        const xFeedSource = createXFeedSource(vaultRoot);
        const feedSources = xFeedSource.enabled ? [xFeedSource] : [];

        if (feedSources.length > 0) {
          perceptionSummary = await runPerceptionPhase(vaultRoot, feedSources);
          const perceptionDurationMs = Date.now() - perceptionStartMs;
          console.log(`[heartbeat:4a] Perception phase completed in ${perceptionDurationMs}ms (health: ${perceptionSummary.health})`);

          // Add perception findings to recommendations
          for (const channel of perceptionSummary.channels) {
            if (channel.admitted > 0) {
              recommendations.push(
                `Perception: ${channel.summaryLine}`,
              );
            }
          }

          // Surface noise alerts as recommendations
          if (perceptionSummary.noiseAlerts) {
            for (const alert of perceptionSummary.noiseAlerts) {
              recommendations.push(
                `Noise alert: ${alert.recommendation}`,
              );
            }
          }
        } else {
          console.log("[heartbeat:4a] No feed sources configured; skipping perception phase");
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[heartbeat:4a] Perception phase failed (non-blocking): ${msg}`);
      }
    }

    // Phase 5a: evaluate conditions and commitments.
    if (shouldRunPhase("5a")) {
      evaluations = evaluateCommitments(store, queue);

      for (const condition of conditions) {
        if (!condition.exceeded) continue;
        const actions: Record<string, string> = {
          inbox: "Inbox items auto-seeded into pipeline queue",
          observations: "Triage observations: /rethink",
          tensions: "Resolve tensions: /rethink",
          sessions: "Mine session transcripts: /remember --mine-sessions",
        };
        recommendations.push(
          `${condition.key} pressure (${condition.count}/${condition.threshold}): ${actions[condition.key] ?? "address backlog"}`,
        );
      }

      for (const evaluation of evaluations) {
        emitCommitmentEvaluated(vaultRoot, {
          commitmentId: evaluation.commitment.id,
          label: evaluation.commitment.label,
          stale: evaluation.stale,
          staleDays: evaluation.staleDays,
          alignedTasks: evaluation.alignedTasks,
          horizon: evaluation.commitment.horizon,
        });

        if (evaluation.stale) {
          recommendations.push(
            `Stale commitment: "${evaluation.commitment.label}" — ${evaluation.staleDays} days without progress (${evaluation.commitment.horizon} horizon)`,
          );
        }
        if (evaluation.alignedTasks > 0) {
          recommendations.push(
            `${evaluation.alignedTasks} queue task(s) aligned with "${evaluation.commitment.label}" — ready for /process`,
          );
        }
      }

      // Phase 5a (continued): semantic advancement evaluation + drift detection
      const recentActivity = buildRecentActivity(vaultRoot, 7);
      const activeCommitments = store.commitments.filter((c) => c.state === "active");

      // Evaluate each active commitment's advancement
      const advancementEvals: CommitmentEvaluationResult[] = [];
      for (const commitment of activeCommitments) {
        const evalResult = evaluateCommitmentAdvancement(commitment, recentActivity);
        advancementEvals.push(evalResult);

        // Add advancement summaries to recommendations for morning brief
        if (evalResult.status === "drifting") {
          recommendations.push(`Drifting: ${evalResult.briefSummary}`);
        } else if (evalResult.status === "stalled") {
          recommendations.push(`Stalled: ${evalResult.briefSummary}`);
        }

        // Surface proposed transitions
        if (evalResult.proposedTransition) {
          recommendations.push(
            `Lifecycle proposal: "${commitment.label}" → ${evalResult.proposedTransition.to} (${evalResult.proposedTransition.reason})`,
          );
        }
      }

      // Run drift detection across all active commitments
      const driftReport: DriftReport = detectDrift(store.commitments, recentActivity);

      // Record DriftSnapshots on commitments with high drift
      for (const drift of driftReport.commitmentDrifts) {
        if (drift.driftScore > 0.7) {
          const commitment = store.commitments.find((c) => c.id === drift.commitmentId);
          if (commitment) {
            if (!commitment.driftSnapshots) {
              commitment.driftSnapshots = [];
            }
            commitment.driftSnapshots.push({
              at: new Date().toISOString(),
              score: drift.driftScore,
              summary: drift.summary,
              windowDays: recentActivity.daysCovered,
            });
            recommendations.push(`Drift alert: ${drift.summary}`);
          }
        }
      }

      // Surface priority inversions
      for (const inversion of driftReport.priorityInversions) {
        recommendations.push(`Priority inversion: ${inversion.summary}`);
      }

      // Surface sprawl warning
      if (driftReport.sprawlWarning) {
        recommendations.push(`Commitment sprawl: ${driftReport.sprawlWarning}`);
      }

      // Overall drift summary for morning brief
      if (driftReport.overallDriftScore > 0.5) {
        recommendations.push(
          `Overall drift score: ${driftReport.overallDriftScore.toFixed(2)} — activity is misaligned with commitments`,
        );
      }
    }

    // Phase 5b: trigger queue tasks (queue-first by default, with commitment boost).
    if (shouldRunPhase("5b")) {
      alignedTasks = collectAlignedTasks(vaultRoot, store, queue);
      const selectedTasks = selectQueueTasks(vaultRoot, store, queue, options);

      // Commitment-aware filtering: if commitments exist, reorder and defer
      // tasks based on commitment relevance. Falls back to original order
      // when no commitments are present.
      const activeCommitmentsForFilter = store.commitments.filter(
        (c) => c.state === "active" || c.state === "paused",
      );
      let tasksToExecute: PipelineTask[];
      let commitmentDeferred: DeferredTask[] = [];

      if (activeCommitmentsForFilter.length > 0) {
        const filterResult: FilterResult = filterAndReorderTasks(
          selectedTasks,
          store.commitments,
        );
        tasksToExecute = filterResult.prioritized;
        commitmentDeferred = filterResult.deferred;

        // Log deferred tasks
        for (const d of commitmentDeferred) {
          recommendations.push(`${d.reason} [${d.task.taskId}]`);
        }
      } else {
        tasksToExecute = selectedTasks;
      }

      const batch = triggerQueueTasks(queue, tasksToExecute, store, vaultRoot, options);
      triggered = batch.triggered;
      executedActions += batch.executedActions;
      advisoryActions += batch.advisoryActions;
      repairsQueued += batch.repairsQueued;
      repairsSkipped += batch.repairsSkipped;
      thinDeferredActions += batch.thinDeferredActions;
      constitutiveDeferredActions += batch.constitutiveDeferredActions;

      const executeTasks = options.executeAlignedTasks ?? true;
      if (!executeTasks) {
        recommendations.push("Heartbeat execution disabled by option; queue tasks were not run.");
      } else if (options.dryRun) {
        recommendations.push(`Heartbeat dry-run: ${triggered.length} queue task(s) selected.`);
      } else if (triggered.length === 0 && commitmentDeferred.length === 0) {
        recommendations.push("Heartbeat execution enabled, but no queue tasks were eligible.");
      } else {
        for (const result of triggered) {
          const status = result.executed
            ? (result.success ? "Triggered" : "Failed")
            : "Deferred";
          recommendations.push(
            `${status} task ${result.taskId} [${result.phase}]: ${result.detail}`,
          );
          if (result.executed) {
            actionsPerformed.push(
              `${result.success ? "Executed" : "Failed"} queue task ${result.taskId} (${result.phase}): ${result.detail}`,
            );
          }
        }
      }
    }

    // Phase 5c: autonomous inbox seeding + threshold-triggered actions.
    if (shouldRunPhase("5c")) {
      // Auto-seed inbox items into the pipeline queue (mechanical, no Claude).
      // Overnight slot processes all inbox items; daytime caps at 3 per cycle.
      const runSlot = options.runSlot ?? "manual";
      const seedLimit = runSlot === "overnight" ? Infinity : 3;
      const thresholdMode = options.thresholdMode ?? "queue-only";
      if (!options.dryRun && thresholdMode !== "queue-only") {
        const seeded = seedInboxItems(vaultRoot, queue, seedLimit);
        if (seeded.length > 0) {
          advisoryActions += seeded.length;
          for (const item of seeded) {
            actionsPerformed.push(`Auto-seeded inbox item: ${item.file} → ${item.archivePath}`);
            recommendations.push(
              `Seeded inbox item "${item.slug}" into pipeline queue (task ${item.taskId.slice(0, 8)}…)`,
            );
          }
        }
      }

      const thresholdActions = evaluateThresholds(vaultRoot, thresholds);
      thresholdActionsCount = thresholdActions.length;
      if (thresholdActions.length > 2) {
        console.warn(`[heartbeat:5c] ${thresholdActions.length} threshold actions triggered this cycle — capping at 2 to prevent vault write flooding`);
        thresholdActions.splice(2);
        thresholdActionsCount = 2;
      }
      for (const action of thresholdActions) {
        // Inbox seeding is handled by seedInboxItems() above — skip execution if we are in execute mode.
        if (action.action === "auto-seed-inbox" && thresholdMode !== "queue-only") {
          console.log(`[heartbeat:5c] Inbox pressure noted (${action.current}/${action.threshold}) — seeding handled above`);
          continue;
        }

        console.log(`[heartbeat:5c] Executing threshold action: ${action.action} (condition: ${action.condition} at ${action.current}/${action.threshold})`);
        if (options.dryRun) {
          recommendations.push(
            `Dry-run threshold action: ${action.action} (${action.condition} ${action.current}/${action.threshold})`,
          );
          actionsPerformed.push(`Dry-run threshold action ${action.action} (${action.condition})`);
          advisoryActions++;
          continue;
        }

        if (thresholdMode === "queue-only") {
          if (hasPendingThresholdTask(queue, action.condition, action.targetPath)) {
            repairsSkipped++;
            recommendations.push(
              `Threshold action queued already: ${action.action} (${action.condition})`,
            );
            continue;
          }

          const queuedTask: PipelineTask = {
            taskId: randomUUID(),
            vaultId: vaultRoot,
            target: action.condition,
            sourcePath: action.targetPath ?? "",
            phase: thresholdActionPhase(action.skillName),
            status: "pending",
            executionMode: "orchestrated",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attempts: 0,
            maxAttempts: 3,
          };
          queue.tasks.push(queuedTask);
          queue.lastUpdated = new Date().toISOString();
          advisoryActions++;
          recommendations.push(
            `Threshold action queued: ${action.action} (${action.condition} ${action.current}/${action.threshold})`,
          );
          actionsPerformed.push(
            `Queued threshold action ${action.action} (${action.condition})`,
          );
          continue;
        }

        const result = runSkillTask(action.skillName, action.taskContext, vaultRoot, { timeoutMs: 1_800_000 });
        executedActions++;
        if (result.success) {
          console.log(`[heartbeat:5c] ${action.action} completed in ${result.durationMs}ms`);
          recommendations.push(
            `Threshold action completed: ${action.action} (${action.condition} ${action.current}/${action.threshold})`,
          );
          actionsPerformed.push(
            `Completed threshold action ${action.action} via /${action.skillName} (${result.durationMs}ms)`,
          );

          emitTaskExecuted(vaultRoot, {
            source: "threshold",
            action: action.action,
            condition: action.condition,
            skillName: action.skillName,
            durationMs: result.durationMs,
          });
        } else {
          console.log(`[heartbeat:5c] ${action.action} failed: ${result.error}`);
          recommendations.push(
            `Threshold action failed: ${action.action} (${action.condition}) - ${result.error ?? "unknown error"}`,
          );
          actionsPerformed.push(
            `Failed threshold action ${action.action} via /${action.skillName}: ${result.error ?? "unknown error"}`,
          );

          emitTaskFailed(vaultRoot, {
            source: "threshold",
            action: action.action,
            condition: action.condition,
            skillName: action.skillName,
            error: result.error ?? "unknown error",
          });
          continue;
        }
      }
    }

    const pendingQueueDepth = queue.tasks
      .filter((task) => (task.status ?? "pending") === "pending")
      .length;
    if (pendingQueueDepth > 0) {
      recommendations.push(
        `Queue has ${pendingQueueDepth} pending task(s). Run /process to advance.`,
      );
    }

    // Phase 5d: Evaluation — score thoughts by graph impact.
    let evaluationRecord: EvaluationRecord | undefined;
    if (shouldRunPhase("5a")) {
      try {
        const graph = scanVaultGraph(vaultRoot);
        const thoughtsPath = join(vaultRoot, "thoughts");
        evaluationRecord = scoreAllThoughts(graph, thoughtsPath);
        writeEvaluationRecord(vaultRoot, evaluationRecord);

        emitEvaluationRun(vaultRoot, {
          evaluationId: evaluationRecord.id,
          thoughtsScored: evaluationRecord.thoughtsScored,
          avgImpactScore: evaluationRecord.avgImpactScore,
          orphanRate: evaluationRecord.orphanRate,
        });

        console.log(
          `[heartbeat:5d] Evaluation: ${evaluationRecord.thoughtsScored} thoughts scored, ` +
          `avg impact ${evaluationRecord.avgImpactScore}, ` +
          `orphan rate ${(evaluationRecord.orphanRate * 100).toFixed(1)}%`,
        );

        // Add evaluation insights to recommendations
        if (evaluationRecord.topThoughts.length > 0) {
          const top3 = evaluationRecord.topThoughts.slice(0, 3);
          recommendations.push(
            `Top impact thoughts: ${top3.map((t) => `"${t.title}" (${t.impactScore})`).join(", ")}`,
          );
        }

        if (evaluationRecord.orphanThoughts.length > 0) {
          recommendations.push(
            `${evaluationRecord.orphanThoughts.length} orphan thought(s) (${(evaluationRecord.orphanRate * 100).toFixed(1)}% orphan rate) — run /reflect to connect them`,
          );
        }

        recommendations.push(
          `Average thought impact: ${evaluationRecord.avgImpactScore}`,
        );
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[heartbeat:5d] Evaluation failed (non-blocking): ${msg}`);
      }
    }

    // Phase 6: morning brief synthesis via Claude.
    if (shouldRunPhase("6")) {
      const runSlot = options.runSlot ?? "manual";
      if (runSlot === "evening" || runSlot === "overnight") {
        console.log(`[heartbeat:6] ${runSlot} slot configured; morning brief generation skipped by policy`);
      } else if (executedActions > 0 || advisoryActions > 0 || shouldGenerateMorningBrief(vaultRoot)) {
        const commitmentSummary = buildCommitmentSummary(store, evaluations);
        briefWritten = generateMorningBrief(vaultRoot, conditions, commitmentSummary, {
          executedActions,
          advisoryActions,
          queueDepthBefore,
          queueDepthAfter: pendingQueueDepth,
          repairsQueued,
          repairsSkipped,
          thresholdActionsRun: thresholdActionsCount,
          thinDeferredActions,
          constitutiveDeferredActions,
          perceptionSummary,
          evaluationRecord,
        });
      } else {
        console.log("[heartbeat:6] Morning brief is fresh (<12h), skipping generation");
      }
    }

    // Phase 7: working memory update via Claude.
    if (shouldRunPhase("7")) {
      if (actionsPerformed.length === 0) {
        actionsPerformed.push("No queue or threshold actions were executed this cycle.");
      }
      updateWorkingMemory(vaultRoot, actionsPerformed);
    }

    store.lastEvaluatedAt = now.toISOString();
    const opsDir = join(vaultRoot, "ops");
    if (!existsSync(opsDir)) {
      mkdirSync(opsDir, { recursive: true });
    }

    await withCommitmentLock(vaultRoot, async () => {
      const latestStore = loadCommitments(vaultRoot);
      latestStore.lastEvaluatedAt = store.lastEvaluatedAt;
      writeCommitmentsAtomic(vaultRoot, latestStore);
    });

    const queueDelta = computeQueueMutationDelta(initialQueue, queue);
    await withQueueLock(vaultRoot, async () => {
      const freshQueue = readQueue(vaultRoot);
      const mergedQueue = mergeQueueWithDelta(freshQueue, queueDelta);
      // Prune tasks that have been done for more than 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      mergedQueue.tasks = mergedQueue.tasks.filter((task) => {
        if (task.status !== "done") return true;
        const updatedAt = task.updatedAt ?? task.createdAt ?? "";
        return updatedAt > sevenDaysAgo;
      });
      writeQueue(vaultRoot, mergedQueue);
    });

    // Prune old runtime cycle files (keep last 30 days)
    try {
      const cyclesDir = join(vaultRoot, "ops", "runtime", "cycles");
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      if (existsSync(cyclesDir)) {
        for (const f of readdirSync(cyclesDir)) {
          const fp = join(cyclesDir, f);
          try {
            if (statSync(fp).mtimeMs < thirtyDaysAgo) unlinkSync(fp);
          } catch { }
        }
      }
    } catch { }

    // Prune old session stub files (keep last 30 days)
    try {
      const sessionsDir = join(vaultRoot, "ops", "sessions");
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      if (existsSync(sessionsDir)) {
        for (const f of readdirSync(sessionsDir)) {
          if (!f.endsWith(".json")) continue;
          const fp = join(sessionsDir, f);
          try {
            if (statSync(fp).mtimeMs < thirtyDaysAgo) unlinkSync(fp);
          } catch { }
        }
      }
    } catch { }

    const exceededConditions = conditions.filter((c) => c.exceeded).map((c) => c.key);
    const staleCommitments = evaluations.filter((e) => e.stale).map((e) => e.commitment.label);

    emitHeartbeatRun(vaultRoot, {
      phase: "end",
      startedAt: heartbeatStartIso,
      selectivePhases: activePhases ?? "all",
      runSlot: options.runSlot ?? "manual",
      queueDepth: pendingQueueDepth,
      queueDepthBefore,
      queueDepthAfter: pendingQueueDepth,
      conditionsExceeded: exceededConditions,
      staleCommitments,
      tasksTriggered: triggered.length,
      tasksSucceeded: triggered.filter((t) => t.executed && t.success).length,
      tasksFailed: triggered.filter((t) => t.executed && !t.success).length,
      thresholdActionsRun: thresholdActionsCount,
      briefWritten,
      actionsPerformed: actionsPerformed.length,
      executedActions,
      advisoryActions,
      repairsQueued,
      repairsSkipped,
      thinDeferredActions,
      constitutiveDeferredActions,
    });

    return {
      conditions,
      evaluations,
      queueDepth: pendingQueueDepth,
      queueDepthBefore,
      queueDepthAfter: pendingQueueDepth,
      recommendations,
      briefWritten,
      alignedTasks,
      triggered,
      executedActions,
      advisoryActions,
      repairsQueued,
      repairsSkipped,
      thresholdActionsRun: thresholdActionsCount,
      perceptionSummary,
      thinDeferredActions,
      constitutiveDeferredActions,
    };
  } finally {
    writeHeartbeatMarker(vaultRoot);
  }
}

export function findAlignedTasks(
  vaultRoot: string,
): PipelineTriggerResult {
  const store = loadCommitments(vaultRoot);
  const queue = readQueue(vaultRoot);
  const tasks = collectAlignedTasks(vaultRoot, store, queue);
  return { triggered: tasks.length, tasks };
}
