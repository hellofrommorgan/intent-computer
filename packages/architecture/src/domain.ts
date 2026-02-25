export type ID = string;
export type ISODateTime = string;

export type IntentSource = "explicit" | "inferred";
export type GapClass = "incidental" | "constitutive";
export type ConfidenceBand = "low" | "medium" | "high";
export type DesireClass = "thick" | "thin" | "unknown";
export type FrictionClass = "constitutive" | "incidental" | "unknown";
export type CommitmentState =
  | "candidate"
  | "active"
  | "paused"
  | "satisfied"
  | "abandoned";
export type ActionAuthority = "none" | "advisory" | "delegated" | "autonomous";
export type ActionKey =
  | "process_inbox"
  | "process_queue"
  | "connect_orphans"
  | "triage_observations"
  | "resolve_tensions"
  | "mine_sessions"
  | "advance_commitment"
  | "seed_knowledge"
  | "custom";
export type PipelinePhase = "surface" | "reflect" | "revisit" | "verify";
export type PipelineTaskStatus =
  | "pending"
  | "in-progress"
  | "done"
  | "failed"
  | "archived";
export type PipelineTaskType = "claim" | "enrichment";
export type QueueExecutionMode = "orchestrated" | "interactive";

export interface IntentRequest {
  id: ID;
  actorId: ID;
  statement: string;
  source: IntentSource;
  requestedAt: ISODateTime;
  domain?: string;
  desiredOutcome?: string;
}

export interface SessionFrame {
  sessionId: ID;
  actorId: ID;
  startedAt: ISODateTime;
  worktree: string;
  model?: string;
}

export interface PerceptionSignal {
  id: ID;
  observedAt: ISODateTime;
  channel: string;
  summary: string;
  confidence: ConfidenceBand;
  metadata?: Record<string, string | number | boolean>;
}

export interface DetectedGap {
  id: ID;
  intentId: ID;
  label: string;
  gapClass: GapClass;
  evidence: string[];
  confidence: ConfidenceBand;
}

export interface PerceptionSnapshot {
  observedAt: ISODateTime;
  signals: PerceptionSignal[];
  gaps: DetectedGap[];
}

export interface Commitment {
  id: ID;
  label: string;
  description?: string;
  state: CommitmentState;
  priority: number;
  horizon: "session" | "week" | "quarter" | "long";
  desireClass?: DesireClass;
  frictionClass?: FrictionClass;
}

export interface IdentityDriftState {
  detected: boolean;
  score: number;
  summary: string;
  alignedCommitmentIds: ID[];
  comparedAt: ISODateTime;
}

export interface IdentityState {
  actorId: ID;
  selfModel: string;
  umwelt: string[];
  priorities: string[];
  commitments: Commitment[];
  drift?: IdentityDriftState;
  updatedAt: ISODateTime;
}

export interface CommitmentPlan {
  intentId: ID;
  activeCommitments: Commitment[];
  protectedGaps: DetectedGap[];
  compressedGaps: DetectedGap[];
  rationale: string;
  updatedAt: ISODateTime;
}

export interface Proposition {
  id: ID;
  vaultId: ID;
  title: string;
  description: string;
  topics: string[];
  confidence?: number;
  sourceRefs?: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface PropositionLink {
  id: ID;
  sourceId: ID;
  targetId: ID;
  relation: string;
  context?: string;
  confidence?: number;
}

export interface MemoryContext {
  vaultId: ID;
  propositions: Proposition[];
  links: PropositionLink[];
  queueDepth?: number;
  loadedAt: ISODateTime;
}

export interface ActionProposal {
  id: ID;
  label: string;
  reason: string;
  authorityNeeded: ActionAuthority;
  requiresPermission: boolean;
  priority: number;
  actionKey?: ActionKey;
  payload?: Record<string, string | number | boolean>;
}

export interface ExecutionPlan {
  intentId: ID;
  authority: ActionAuthority;
  actions: ActionProposal[];
  generatedAt: ISODateTime;
}

export interface ActionResult {
  actionId: ID;
  success: boolean;
  executed: boolean;
  executionMode?: "executed" | "advisory";
  detail: string;
  actionKey?: ActionKey;
  emittedSignals?: PerceptionSignal[];
}

export interface ExecutionOutcome {
  intentId: ID;
  executedAt: ISODateTime;
  completed: boolean;
  results: ActionResult[];
}

export interface IntentLoopInput {
  session: SessionFrame;
  intent: IntentRequest;
  authority: ActionAuthority;
}

export interface IntentLoopResult {
  cycleId: ID;
  startedAt: ISODateTime;
  finishedAt: ISODateTime;
  session: SessionFrame;
  intent: IntentRequest;
  perception: PerceptionSnapshot;
  identity: IdentityState;
  commitment: CommitmentPlan;
  memory: MemoryContext;
  plan: ExecutionPlan;
  outcome: ExecutionOutcome;
}

export interface RepairContext {
  original_task: { kind: string; target: string };
  error_message: string;
  vault_root: string;
  absolute_source_path: string;
  expected_output_contract: string;
  phase: string;
  command_or_skill: string;
  last_stderr: string;
  last_stdout: string;
  queue_excerpt: string;
  relevant_file_diffs: Array<{ path: string; diff: string }>;
  stack_trace?: string;
  file_state?: Record<string, string>;
  attempted_at: string;
  attempt_count: number;
}

export interface PipelineTask {
  taskId: ID;
  vaultId: ID;
  target: string;
  sourcePath: string;
  phase: PipelinePhase;
  status?: PipelineTaskStatus;
  type?: PipelineTaskType;
  executionMode?: QueueExecutionMode;
  batch?: string;
  createdAt?: ISODateTime;
  updatedAt?: ISODateTime;
  lockedUntil?: ISODateTime;
  attempts?: number;
  maxAttempts?: number;
  completedPhases?: PipelinePhase[];
  repair_context?: RepairContext;
}

export interface PipelineQueueFile {
  version: number;
  tasks: PipelineTask[];
  lastUpdated: ISODateTime;
}

export interface PipelinePhaseResult {
  phase: PipelinePhase;
  success: boolean;
  summary: string;
  artifacts: string[];
}

export interface PipelineRunResult {
  taskId: ID;
  startedAt: ISODateTime;
  finishedAt: ISODateTime;
  completed: boolean;
  phases: PipelinePhaseResult[];
}
