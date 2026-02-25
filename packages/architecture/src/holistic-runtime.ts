import type {
  IntentLoopInput,
  IntentLoopResult,
  PipelinePhase,
  PipelinePhaseResult,
  PipelineRunResult,
  PipelineTask,
  SessionFrame,
} from "./domain.js";
import { IntentLoop } from "./intent-loop.js";
import type { IntentComputerLayers, LifecycleHooksPort, PipelinePort } from "./ports.js";

export interface HolisticRuntimeOptions {
  layers: IntentComputerLayers;
  hooks?: LifecycleHooksPort;
  pipeline?: PipelinePort;
}

export interface BackgroundPipelineInput {
  task: PipelineTask;
  phases?: PipelinePhase[];
}

export class HolisticIntentComputerRuntime {
  private readonly loop: IntentLoop;
  private readonly hooks?: LifecycleHooksPort;
  private readonly pipeline?: PipelinePort;
  private readonly sessionState = new Map<string, IntentLoopResult>();

  constructor(options: HolisticRuntimeOptions) {
    this.loop = new IntentLoop(options.layers, options.hooks);
    this.hooks = options.hooks;
    this.pipeline = options.pipeline;
  }

  async startSession(session: SessionFrame): Promise<void> {
    if (this.hooks?.onSessionStart) {
      await this.hooks.onSessionStart(session);
    }
  }

  async processIntent(input: IntentLoopInput): Promise<IntentLoopResult> {
    const result = await this.loop.run(input);
    this.sessionState.set(input.session.sessionId, result);
    return result;
  }

  async endSession(session: SessionFrame): Promise<void> {
    const lastCycle = this.sessionState.get(session.sessionId);
    if (this.hooks?.onSessionEnd) {
      await this.hooks.onSessionEnd(session, lastCycle);
    }
    this.sessionState.delete(session.sessionId);
  }

  async runBackgroundPipeline(input: BackgroundPipelineInput): Promise<PipelineRunResult> {
    if (!this.pipeline) {
      throw new Error("Pipeline port is not configured for this runtime");
    }

    const startedAt = new Date().toISOString();
    const phases = input.phases ?? ["surface", "reflect", "revisit", "verify"];
    const results: PipelinePhaseResult[] = [];

    for (const phase of phases) {
      const result = await this.pipeline.runPhase(input.task, phase);
      results.push(result);
      if (!result.success) break;
    }

    return {
      taskId: input.task.taskId,
      startedAt,
      finishedAt: new Date().toISOString(),
      completed: results.every((phase) => phase.success),
      phases: results,
    };
  }
}

