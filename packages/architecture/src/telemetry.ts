/**
 * telemetry.ts — structured telemetry for signal-to-action-to-outcome chains
 *
 * Lightweight, append-only JSONL telemetry. Every emission is fire-and-forget:
 * telemetry must NEVER throw or block the calling code path.
 */

import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export type TelemetryEventType =
  | "intent_cycle"
  | "heartbeat_run"
  | "task_executed"
  | "task_failed"
  | "repair_queued"
  | "signal_fired"
  | "action_proposed"
  | "action_executed"
  | "commitment_evaluated"
  | "skill_invoked"
  | "session_started"
  | "session_ended";

type TelemetryData = unknown;

interface TelemetryEventBase<T extends TelemetryEventType, D extends TelemetryData> {
  timestamp: string;
  type: T;
  data: D;
}

interface SessionTelemetryEventBase<T extends TelemetryEventType, D extends TelemetryData>
  extends TelemetryEventBase<T, D> {
  sessionId: string;
}

interface NonSessionTelemetryEventBase<T extends TelemetryEventType, D extends TelemetryData>
  extends TelemetryEventBase<T, D> {
  sessionId?: string;
}

export interface IntentCycleTelemetryData {
  cycleId: string;
  signalsCount: number;
  gapsCount: number;
  actionsProposed: number;
  authority: string;
  completed: boolean;
}

export interface HeartbeatRunTelemetryData {
  phase: "start" | "end";
  queueDepth: number;
  selectivePhases: string[] | "all";
  runSlot?: "morning" | "evening" | "overnight" | "manual";
  conditionsChecked?: number;
  startedAt?: string;
  conditionsExceeded?: string[];
  staleCommitments?: string[];
  tasksTriggered?: number;
  tasksSucceeded?: number;
  tasksFailed?: number;
  thresholdActionsRun?: number;
  briefWritten?: boolean;
  actionsPerformed?: number;
  executedActions?: number;
  advisoryActions?: number;
  queueDepthBefore?: number;
  queueDepthAfter?: number;
  repairsQueued?: number;
  repairsSkipped?: number;
  thinDeferredActions?: number;
  constitutiveDeferredActions?: number;
}

export interface TaskExecutedTelemetryData {
  taskId?: string;
  phase?: string;
  target?: string;
  isRepair?: boolean;
  source?: string;
  action?: string;
  condition?: string;
  skillName?: string;
  durationMs?: number;
  actionKind?: string;
  detail?: string;
}

export interface TaskFailedTelemetryData {
  taskId?: string;
  phase?: string;
  target?: string;
  error: string;
  isRepair?: boolean;
  source?: string;
  action?: string;
  condition?: string;
  skillName?: string;
  actionKind?: string;
}

export interface RepairQueuedTelemetryData {
  repairTaskId: string;
  originalTaskId?: string;
  phase?: string;
  target?: string;
  attemptCount?: number;
  error?: string;
  source?: string;
  action?: string;
  condition?: string;
  actionKind?: string;
}

export interface SignalFiredTelemetryData {
  signalId: string;
  channel: string;
  summary: string;
  confidence: string;
}

export interface ActionProposedTelemetryData {
  actionId: string;
  label: string;
  actionKey?: string;
  authorityNeeded: string;
  priority: number;
}

export interface ActionExecutedTelemetryData {
  actionId: string;
  success: boolean;
  executed?: boolean;
  executionMode?: "executed" | "advisory";
  actionKey?: string;
  detail: string;
}

export interface CommitmentEvaluatedTelemetryData {
  commitmentId: string;
  label: string;
  stale: boolean;
  staleDays: number;
  alignedTasks: number;
  horizon: string;
}

export interface SkillInvokedTelemetryData {
  skillName: string;
  isOrchestrator: boolean;
}

export interface SessionStartedTelemetryData {
  actorId: string;
  worktree: string;
}

export interface SessionEndedTelemetryData {
  actorId: string;
  lastCycleId: string | null;
}

export type IntentCycleTelemetryEvent = SessionTelemetryEventBase<
  "intent_cycle",
  IntentCycleTelemetryData
>;
export type HeartbeatRunTelemetryEvent = NonSessionTelemetryEventBase<
  "heartbeat_run",
  HeartbeatRunTelemetryData
>;
export type TaskExecutedTelemetryEvent = NonSessionTelemetryEventBase<
  "task_executed",
  TaskExecutedTelemetryData
>;
export type TaskFailedTelemetryEvent = NonSessionTelemetryEventBase<
  "task_failed",
  TaskFailedTelemetryData
>;
export type RepairQueuedTelemetryEvent = NonSessionTelemetryEventBase<
  "repair_queued",
  RepairQueuedTelemetryData
>;
export type SignalFiredTelemetryEvent = SessionTelemetryEventBase<
  "signal_fired",
  SignalFiredTelemetryData
>;
export type ActionProposedTelemetryEvent = SessionTelemetryEventBase<
  "action_proposed",
  ActionProposedTelemetryData
>;
export type ActionExecutedTelemetryEvent = SessionTelemetryEventBase<
  "action_executed",
  ActionExecutedTelemetryData
>;
export type CommitmentEvaluatedTelemetryEvent = NonSessionTelemetryEventBase<
  "commitment_evaluated",
  CommitmentEvaluatedTelemetryData
>;
export type SkillInvokedTelemetryEvent = NonSessionTelemetryEventBase<
  "skill_invoked",
  SkillInvokedTelemetryData
>;
export type SessionStartedTelemetryEvent = SessionTelemetryEventBase<
  "session_started",
  SessionStartedTelemetryData
>;
export type SessionEndedTelemetryEvent = SessionTelemetryEventBase<
  "session_ended",
  SessionEndedTelemetryData
>;

export type TelemetryEvent =
  | IntentCycleTelemetryEvent
  | HeartbeatRunTelemetryEvent
  | TaskExecutedTelemetryEvent
  | TaskFailedTelemetryEvent
  | RepairQueuedTelemetryEvent
  | SignalFiredTelemetryEvent
  | ActionProposedTelemetryEvent
  | ActionExecutedTelemetryEvent
  | CommitmentEvaluatedTelemetryEvent
  | SkillInvokedTelemetryEvent
  | SessionStartedTelemetryEvent
  | SessionEndedTelemetryEvent;

export type EmittableTelemetryEvent = Omit<TelemetryEvent, "timestamp">;

const ALL_EVENT_TYPES: ReadonlySet<TelemetryEventType> = new Set([
  "intent_cycle",
  "heartbeat_run",
  "task_executed",
  "task_failed",
  "repair_queued",
  "signal_fired",
  "action_proposed",
  "action_executed",
  "commitment_evaluated",
  "skill_invoked",
  "session_started",
  "session_ended",
]);

const SESSION_BOUND_TYPES: ReadonlySet<TelemetryEventType> = new Set([
  "intent_cycle",
  "signal_fired",
  "action_proposed",
  "action_executed",
  "session_started",
  "session_ended",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isTelemetryEventType(value: unknown): value is TelemetryEventType {
  return typeof value === "string" && ALL_EVENT_TYPES.has(value as TelemetryEventType);
}

export function telemetryPath(vaultRoot: string): string {
  return join(vaultRoot, "ops", "runtime", "telemetry.jsonl");
}

export function coerceTelemetryEvent(value: unknown): TelemetryEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.timestamp !== "string") return null;
  if (!isTelemetryEventType(value.type)) return null;
  if (!isRecord(value.data)) return null;

  const sessionId = value.sessionId;
  if (sessionId !== undefined && typeof sessionId !== "string") return null;
  if (SESSION_BOUND_TYPES.has(value.type) && typeof sessionId !== "string") return null;

  return value as unknown as TelemetryEvent;
}

export function emitTelemetry(
  vaultRoot: string,
  event: EmittableTelemetryEvent,
): void {
  try {
    const fullEvent: TelemetryEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    } as TelemetryEvent;
    const filePath = telemetryPath(vaultRoot);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(fullEvent) + "\n");
  } catch {
    // Telemetry must NEVER throw or block
  }
}

export function emitIntentCycle(
  vaultRoot: string,
  sessionId: string,
  data: IntentCycleTelemetryData,
): void {
  emitTelemetry(vaultRoot, { type: "intent_cycle", sessionId, data });
}

export function emitHeartbeatRun(vaultRoot: string, data: HeartbeatRunTelemetryData): void {
  emitTelemetry(vaultRoot, { type: "heartbeat_run", data });
}

export function emitTaskExecuted(vaultRoot: string, data: TaskExecutedTelemetryData): void {
  emitTelemetry(vaultRoot, { type: "task_executed", data });
}

export function emitTaskFailed(vaultRoot: string, data: TaskFailedTelemetryData): void {
  emitTelemetry(vaultRoot, { type: "task_failed", data });
}

export function emitRepairQueued(vaultRoot: string, data: RepairQueuedTelemetryData): void {
  emitTelemetry(vaultRoot, { type: "repair_queued", data });
}

export function emitSignalFired(
  vaultRoot: string,
  sessionId: string,
  data: SignalFiredTelemetryData,
): void {
  emitTelemetry(vaultRoot, { type: "signal_fired", sessionId, data });
}

export function emitActionProposed(
  vaultRoot: string,
  sessionId: string,
  data: ActionProposedTelemetryData,
): void {
  emitTelemetry(vaultRoot, { type: "action_proposed", sessionId, data });
}

export function emitActionExecuted(
  vaultRoot: string,
  sessionId: string,
  data: ActionExecutedTelemetryData,
): void {
  emitTelemetry(vaultRoot, { type: "action_executed", sessionId, data });
}

export function emitCommitmentEvaluated(
  vaultRoot: string,
  data: CommitmentEvaluatedTelemetryData,
): void {
  emitTelemetry(vaultRoot, { type: "commitment_evaluated", data });
}

export function emitSkillInvoked(vaultRoot: string, data: SkillInvokedTelemetryData, sessionId?: string): void {
  emitTelemetry(vaultRoot, { type: "skill_invoked", data, sessionId });
}

export function emitSessionStarted(
  vaultRoot: string,
  sessionId: string,
  data: SessionStartedTelemetryData,
): void {
  emitTelemetry(vaultRoot, { type: "session_started", sessionId, data });
}

export function emitSessionEnded(
  vaultRoot: string,
  sessionId: string,
  data: SessionEndedTelemetryData,
): void {
  emitTelemetry(vaultRoot, { type: "session_ended", sessionId, data });
}
