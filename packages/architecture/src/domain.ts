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
  | "fix_triggers"
  | "fix_regressions"
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

// ─── Commitment Engine Types (Phase 1) ──────────────────────────────────────

export interface StateTransition {
  from: CommitmentState;
  to: CommitmentState;
  at: ISODateTime;
  reason: string;
  proposedBy: "engine" | "human";
  accepted: boolean;
}

export interface AdvancementSignal {
  at: ISODateTime;
  action: string;
  relevanceScore: number; // 0-1
  method: "direct" | "inferred";
}

export interface DriftSnapshot {
  at: ISODateTime;
  score: number; // 0-1
  summary: string;
  windowDays: number;
}

export interface OutcomePattern {
  state: "satisfied" | "abandoned";
  at: ISODateTime;
  actionSequence: string[];
  totalDays: number;
  lessonsLearned?: string;
}

// ─── Perception Feed Types ──────────────────────────────────────────────────

export interface FeedCapture {
  id: string;
  sourceId: string;
  capturedAt: ISODateTime;
  title: string;
  content: string;
  urls: string[];
  metadata: Record<string, unknown>;
  rawRelevanceScore: number; // 0-1
}

export interface PerceptionContext {
  commitmentLabels: string[];
  identityThemes: string[];
  vaultTopics: string[];
  recentThoughts: string[];
}

export interface AdmissionPolicyConfig {
  maxSignalsPerChannel: number; // Default: 3
  umweltBudgetLines: number; // Default: 50
  relevanceFloor: number; // Default: 0.3
  briefThreshold: number; // Default: 0.6
  maxInboxWritesPerCycle: number; // Default: 10
}

export interface AdmissionResult {
  admitted: FeedCapture[];
  surfaced: FeedCapture[];
  filtered: number;
  reason: string;
}

export interface PerceptionSummary {
  at: ISODateTime;
  channels: ChannelSummary[];
  health: "active" | "degraded" | "silent";
  noiseAlerts?: NoiseAlert[];
}

export interface NoiseAlert {
  sourceId: string;
  filterRate: number;
  consecutiveDays: number;
  recommendation: string;
}

export interface NoiseTracker {
  sources: Record<string, SourceNoiseHistory>;
  lastUpdated: string;
}

export interface SourceNoiseHistory {
  dailyRates: Array<{ date: string; admitted: number; total: number; rate: number }>;
}

export interface ChannelSummary {
  sourceId: string;
  sourceName: string;
  polled: number;
  admitted: number;
  filtered: number;
  topItems: BriefItem[];
  summaryLine: string;
}

export interface BriefItem {
  title: string;
  relevanceScore: number;
  reason: string;
  inboxPath: string;
}

export type SourceCursor =
  | { type: "id-set"; seenIds: string[]; maxRetained: number }
  | { type: "token"; value: string }
  | { type: "timestamp"; lastSeen: ISODateTime }
  | { type: "delta"; deltaLink: string };

export interface CursorStoreData {
  cursors: Record<string, SourceCursor>;
  lastUpdated: ISODateTime;
}

// ─── Evaluation types (Phase 1) ──────────────────────────────────────────────

export interface ThoughtScore {
  path: string;
  title: string;
  incomingLinks: number;
  mapMemberships: number;
  ageDays: number;
  daysSinceLastLink: number;
  impactScore: number;
}

export interface EvaluationRecord {
  id: string;
  evaluatedAt: ISODateTime;
  thoughtsScored: number;
  avgImpactScore: number;
  topThoughts: ThoughtScore[];      // top 10 by impact
  orphanThoughts: ThoughtScore[];   // score <= 0, age > 7 days
  orphanRate: number;               // 0-1
}

// ─── Quality Triggers ──────────────────────────────────────────────────────

export type TriggerScope = "unit" | "integration" | "regression";
export type TriggerSeverity = "pass" | "warn" | "fail";

export interface TriggerResult {
  id: string;
  scope: TriggerScope;
  name: string;
  severity: TriggerSeverity;
  message: string;
  /** File path for unit triggers, undefined for integration */
  target?: string;
}

export interface TriggerTrend {
  triggerId: string;
  passRates: number[]; // last N runs, most recent last
  direction: "improving" | "stable" | "degrading";
}

export interface TriggerRegression {
  triggerId: string;
  target?: string;
  firstFailed: string; // ISO date
  lastPassed: string;  // ISO date
  message: string;
}

export interface TriggerReport {
  timestamp: string;
  results: TriggerResult[];
  passRate: number; // 0-1
  trends: TriggerTrend[];
  regressions: TriggerRegression[];
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
  };
}

// ─── Metabolic Rate ──────────────────────────────────────────────────────────

export type VaultSpace = "self" | "thoughts" | "ops";
export type MetabolicAnomaly = "identity-churn" | "pipeline-stall" | "system-disuse" | "ops-silence";

export interface SpaceMetabolism {
  space: VaultSpace;
  /** Files changed in last 7 days */
  changesWeek: number;
  /** Files changed in last 30 days */
  changesMonth: number;
  /** Whether current rate is within healthy range */
  healthy: boolean;
  /** If unhealthy, why */
  anomaly?: MetabolicAnomaly;
}

export interface MetabolicReport {
  timestamp: string;
  spaces: SpaceMetabolism[];
  anomalies: MetabolicAnomaly[];
  /** Overall: all spaces healthy */
  systemHealthy: boolean;
}

// ─── Desired State Gap Report ────────────────────────────────────────────────

export interface DesiredStateMetric {
  name: string;
  actual: number;
  target: number;
  /** How far off: (actual - target) / target, negative means below target */
  delta: number;
  met: boolean;
}

export interface DesiredStateReport {
  timestamp: string;
  metrics: DesiredStateMetric[];
  overallScore: number; // 0-1, fraction of metrics met
}
