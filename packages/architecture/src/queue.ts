import { randomUUID } from "crypto";
import type {
  PipelinePhase,
  PipelineQueueFile,
  PipelineTask,
  PipelineTaskStatus,
  PipelineTaskType,
  QueueExecutionMode,
  RepairContext,
} from "./domain.js";

const PIPELINE_PHASES = new Set<PipelinePhase>([
  "surface",
  "reflect",
  "revisit",
  "verify",
]);

const PIPELINE_STATUS = new Set<PipelineTaskStatus>([
  "pending",
  "in-progress",
  "done",
  "failed",
  "archived",
]);

const PIPELINE_TYPES = new Set<PipelineTaskType>(["claim", "enrichment"]);
const EXECUTION_MODES = new Set<QueueExecutionMode>(["orchestrated", "interactive"]);

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  const raw = asString(value);
  if (!raw) return fallback;
  const ts = new Date(raw);
  if (Number.isNaN(ts.getTime())) return fallback;
  return ts.toISOString();
}

function normalizeRepairContext(
  rawRepair: unknown,
  input: {
    vaultId: string;
    target: string;
    sourcePath: string;
    phase: PipelinePhase;
    nowIso: string;
  },
): RepairContext | undefined {
  const raw = asObject(rawRepair);
  if (!raw) return undefined;

  const originalTask = asObject(raw.original_task) ?? {};
  const originalTaskKind = asString(originalTask.kind) || input.phase;
  const originalTaskTarget = asString(originalTask.target) || input.target;
  const absoluteSourcePath = asString(raw.absolute_source_path) || input.sourcePath || originalTaskTarget;
  const lastStderr = asString(raw.last_stderr) || asString(raw.error_message);
  const lastStdout = asString(raw.last_stdout);
  const queueExcerpt = asString(raw.queue_excerpt);
  const phase = asString(raw.phase) || input.phase;
  const commandOrSkill = asString(raw.command_or_skill) || originalTaskKind;
  const expectedOutputContract = asString(raw.expected_output_contract) || "Diagnose the failure and apply a concrete fix.";

  const fileStateRaw = asObject(raw.file_state);
  const file_state = fileStateRaw
    ? Object.fromEntries(
        Object.entries(fileStateRaw)
          .filter(([, value]) => typeof value === "string")
          .map(([key, value]) => [key, value as string]),
      )
    : undefined;

  const relevantDiffsRaw = Array.isArray(raw.relevant_file_diffs) ? raw.relevant_file_diffs : [];
  const relevant_file_diffs = relevantDiffsRaw
    .map((item) => {
      const obj = asObject(item);
      if (!obj) return null;
      const path = asString(obj.path);
      const diff = asString(obj.diff);
      if (!path || !diff) return null;
      return { path, diff };
    })
    .filter((entry): entry is { path: string; diff: string } => entry !== null);

  return {
    original_task: { kind: originalTaskKind, target: originalTaskTarget },
    error_message: asString(raw.error_message),
    vault_root: asString(raw.vault_root) || input.vaultId,
    absolute_source_path: absoluteSourcePath,
    expected_output_contract: expectedOutputContract,
    phase,
    command_or_skill: commandOrSkill,
    last_stderr: lastStderr,
    last_stdout: lastStdout,
    queue_excerpt: queueExcerpt,
    relevant_file_diffs,
    stack_trace: asString(raw.stack_trace) || undefined,
    file_state: file_state && Object.keys(file_state).length > 0 ? file_state : undefined,
    attempted_at: normalizeTimestamp(raw.attempted_at, input.nowIso),
    attempt_count: asNumber(raw.attempt_count) ?? 1,
  };
}

export function normalizePipelinePhase(value: unknown): PipelinePhase {
  const raw = asString(value).trim().toLowerCase();
  if (PIPELINE_PHASES.has(raw as PipelinePhase)) return raw as PipelinePhase;
  if (raw === "create" || raw === "extract" || raw === "enrich" || raw === "reduce") {
    return "surface";
  }
  if (raw === "reweave") return "revisit";
  return "surface";
}

export function normalizePipelineTaskStatus(value: unknown): PipelineTaskStatus {
  const raw = asString(value).trim().toLowerCase();
  if (PIPELINE_STATUS.has(raw as PipelineTaskStatus)) return raw as PipelineTaskStatus;
  if (raw === "in_progress") return "in-progress";
  if (raw === "complete" || raw === "completed") return "done";
  if (raw === "error") return "failed";
  return "pending";
}

export function normalizePipelineTaskType(value: unknown): PipelineTaskType | undefined {
  const raw = asString(value).trim().toLowerCase();
  if (PIPELINE_TYPES.has(raw as PipelineTaskType)) return raw as PipelineTaskType;
  return undefined;
}

export function normalizeQueueExecutionMode(value: unknown): QueueExecutionMode {
  const raw = asString(value).trim().toLowerCase();
  if (EXECUTION_MODES.has(raw as QueueExecutionMode)) return raw as QueueExecutionMode;
  return "interactive";
}

export function normalizePipelineTask(
  rawTask: unknown,
  vaultId: string,
  nowIso = new Date().toISOString(),
): PipelineTask {
  const task = asObject(rawTask) ?? {};
  const taskId = asString(task.taskId) || asString(task.id) || randomUUID();
  const target = asString(task.target) || asString(task.file) || taskId;
  const batch = asString(task.batch);
  const sourceFromTask = asString(task.sourcePath) || asString(task.source);
  const sourceFromLegacy = batch && asString(task.file)
    ? `archive/${batch}/${asString(task.file)}`
    : "";
  const sourcePath = sourceFromTask || sourceFromLegacy;
  const phase = normalizePipelinePhase(task.phase ?? task.current_phase ?? task.type);
  const status = normalizePipelineTaskStatus(task.status);
  const type = normalizePipelineTaskType(task.type);
  const executionMode = normalizeQueueExecutionMode(task.executionMode);
  const createdAt = normalizeTimestamp(task.createdAt, nowIso);
  const updatedAt = normalizeTimestamp(task.updatedAt ?? task.lastUpdated, createdAt);
  const lockedUntilRaw = asString(task.lockedUntil);
  const lockedUntil = lockedUntilRaw ? normalizeTimestamp(lockedUntilRaw, lockedUntilRaw) : undefined;
  const attempts = asNumber(task.attempts) ?? 0;
  const maxAttempts = asNumber(task.maxAttempts) ?? 3;
  const completedPhases = Array.isArray(task.completedPhases)
    ? task.completedPhases.map(normalizePipelinePhase)
    : Array.isArray(task.completed_phases)
      ? task.completed_phases.map(normalizePipelinePhase)
      : undefined;

  const repair_context = normalizeRepairContext(task.repair_context, {
    vaultId,
    target,
    sourcePath,
    phase,
    nowIso,
  });

  return {
    taskId,
    vaultId,
    target,
    sourcePath,
    phase,
    status,
    type,
    executionMode,
    batch: batch || undefined,
    createdAt,
    updatedAt,
    lockedUntil,
    attempts,
    maxAttempts,
    completedPhases,
    repair_context,
  };
}

export function normalizeQueueFile(
  rawQueue: unknown,
  vaultId: string,
  nowIso = new Date().toISOString(),
): PipelineQueueFile {
  const queueObj = asObject(rawQueue) ?? {};
  const rawTasks = Array.isArray(queueObj.tasks)
    ? queueObj.tasks
    : Array.isArray(rawQueue)
      ? rawQueue
      : [];

  const tasks = rawTasks.map((task) => normalizePipelineTask(task, vaultId, nowIso));
  const lastUpdated = normalizeTimestamp(queueObj.lastUpdated ?? queueObj.updatedAt, nowIso);

  return {
    version: 1,
    tasks,
    lastUpdated,
  };
}
