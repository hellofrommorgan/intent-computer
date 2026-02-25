import type {
  CommitmentPlan,
  ExecutionOutcome,
  ExecutionPlan,
  IdentityState,
  IntentLoopResult,
  IntentRequest,
  MemoryContext,
  PerceptionSnapshot,
  PipelinePhase,
  PipelinePhaseResult,
  PipelineTask,
  SessionFrame,
} from "./domain.js";

export interface PerceptionInput {
  session: SessionFrame;
  intent: IntentRequest;
}

export interface IdentityResolutionInput {
  session: SessionFrame;
  intent: IntentRequest;
  perception: PerceptionSnapshot;
}

export interface CommitmentPlanningInput {
  session: SessionFrame;
  intent: IntentRequest;
  perception: PerceptionSnapshot;
  identity: IdentityState;
}

export interface MemoryHydrationInput {
  session: SessionFrame;
  intent: IntentRequest;
  perception: PerceptionSnapshot;
  identity: IdentityState;
  commitment: CommitmentPlan;
}

export interface ExecutionPlanningInput {
  session: SessionFrame;
  intent: IntentRequest;
  identity: IdentityState;
  commitment: CommitmentPlan;
  memory: MemoryContext;
}

export interface ExecutionRunInput {
  session: SessionFrame;
  intent: IntentRequest;
  plan: ExecutionPlan;
}

export interface MemoryWriteEnvelope {
  session: SessionFrame;
  intent: IntentRequest;
  perception: PerceptionSnapshot;
  identity: IdentityState;
  commitment: CommitmentPlan;
  memory: MemoryContext;
  plan: ExecutionPlan;
  outcome: ExecutionOutcome;
}

export interface CommitmentOutcomeInput {
  session: SessionFrame;
  intent: IntentRequest;
  commitment: CommitmentPlan;
  plan: ExecutionPlan;
  outcome: ExecutionOutcome;
}

export interface PerceptionPort {
  capture(input: PerceptionInput): Promise<PerceptionSnapshot>;
}

export interface IdentityPort {
  resolve(input: IdentityResolutionInput): Promise<IdentityState>;
}

export interface CommitmentPort {
  plan(input: CommitmentPlanningInput): Promise<CommitmentPlan>;
  recordOutcome?(input: CommitmentOutcomeInput): Promise<void>;
}

export interface MemoryPort {
  hydrate(input: MemoryHydrationInput): Promise<MemoryContext>;
  record(envelope: MemoryWriteEnvelope): Promise<void>;
}

export interface ExecutionPort {
  propose(input: ExecutionPlanningInput): Promise<ExecutionPlan>;
  execute(input: ExecutionRunInput): Promise<ExecutionOutcome>;
}

export interface IntentComputerLayers {
  perception: PerceptionPort;
  identity: IdentityPort;
  commitment: CommitmentPort;
  memory: MemoryPort;
  execution: ExecutionPort;
}

export interface LifecycleHooksPort {
  onSessionStart?(session: SessionFrame): Promise<void>;
  onIntentCycle?(result: IntentLoopResult): Promise<void>;
  onSessionEnd?(session: SessionFrame, lastCycle?: IntentLoopResult): Promise<void>;
}

export interface PipelinePort {
  runPhase(task: PipelineTask, phase: PipelinePhase): Promise<PipelinePhaseResult>;
}
