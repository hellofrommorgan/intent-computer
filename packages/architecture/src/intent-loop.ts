import { randomUUID } from "crypto";
import type { IntentLoopInput, IntentLoopResult } from "./domain.js";
import type { IntentComputerLayers, LifecycleHooksPort } from "./ports.js";

export class IntentLoop {
  private readonly layers: IntentComputerLayers;
  private readonly hooks?: LifecycleHooksPort;

  constructor(layers: IntentComputerLayers, hooks?: LifecycleHooksPort) {
    this.layers = layers;
    this.hooks = hooks;
  }

  async run(input: IntentLoopInput): Promise<IntentLoopResult> {
    const startedAt = new Date().toISOString();

    const perception = await this.layers.perception.capture({
      session: input.session,
      intent: input.intent,
    });

    const identity = await this.layers.identity.resolve({
      session: input.session,
      intent: input.intent,
      perception,
    });

    const commitment = await this.layers.commitment.plan({
      session: input.session,
      intent: input.intent,
      perception,
      identity,
    });

    const memory = await this.layers.memory.hydrate({
      session: input.session,
      intent: input.intent,
      perception,
      identity,
      commitment,
    });

    const plan = await this.layers.execution.propose({
      session: input.session,
      intent: input.intent,
      identity,
      commitment,
      memory,
    });

    const outcome = await this.layers.execution.execute({
      session: input.session,
      intent: input.intent,
      plan,
    });

    await this.layers.memory.record({
      session: input.session,
      intent: input.intent,
      perception,
      identity,
      commitment,
      memory,
      plan,
      outcome,
    });

    if (this.layers.commitment.recordOutcome) {
      await this.layers.commitment.recordOutcome({
        session: input.session,
        intent: input.intent,
        commitment,
        plan,
        outcome,
      });
    }

    const result: IntentLoopResult = {
      cycleId: randomUUID(),
      startedAt,
      finishedAt: new Date().toISOString(),
      session: input.session,
      intent: input.intent,
      perception,
      identity,
      commitment,
      memory,
      plan,
      outcome,
    };

    if (this.hooks?.onIntentCycle) {
      await this.hooks.onIntentCycle(result);
    }

    return result;
  }
}
