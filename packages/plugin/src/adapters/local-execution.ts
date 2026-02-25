/**
 * local-execution.ts — ExecutionPort adapter
 *
 * Produces action proposals and can execute selected actions through configured
 * dispatch handlers. Execution policy is loaded from ops/runtime-policy.json.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type {
  ActionKey,
  ActionProposal,
  ActionResult,
  ExecutionOutcome,
  ExecutionPlan,
  ExecutionPlanningInput,
  ExecutionPort,
  ExecutionRunInput,
  PerceptionSignal,
} from "@intent-computer/architecture";

export interface LocalExecutionDispatch {
  processQueue?: () => Promise<string>;
  processInbox?: () => Promise<string>;
  connectOrphans?: () => Promise<string>;
  triageObservations?: () => Promise<string>;
  resolveTensions?: () => Promise<string>;
  mineSessions?: () => Promise<string>;
}

export interface LocalExecutionPolicy {
  version: number;
  maxActionsPerCycle: number;
  autoExecute: Record<string, boolean>;
}

export interface LocalExecutionOptions {
  dispatch?: LocalExecutionDispatch;
  policyPath?: string;
}

const DEFAULT_POLICY: LocalExecutionPolicy = {
  version: 1,
  maxActionsPerCycle: 2,
  autoExecute: {
    process_queue: true,
    process_inbox: true,
    connect_orphans: false,
    triage_observations: false,
    resolve_tensions: false,
    mine_sessions: false,
    advance_commitment: false,
    seed_knowledge: false,
    custom: false,
  },
};

export class LocalExecutionAdapter implements ExecutionPort {
  private readonly vaultRoot: string;
  private readonly dispatch: LocalExecutionDispatch;
  private readonly policyPath: string;

  constructor(vaultRoot: string, options: LocalExecutionOptions = {}) {
    this.vaultRoot = vaultRoot;
    this.dispatch = options.dispatch ?? {};
    this.policyPath = options.policyPath ?? join(vaultRoot, "ops", "runtime-policy.json");
  }

  async propose(input: ExecutionPlanningInput): Promise<ExecutionPlan> {
    const now = new Date().toISOString();
    const actions: ActionProposal[] = [];
    let priority = 0;
    const drift = input.identity.drift;

    if (drift?.detected) {
      priority++;
      actions.push({
        id: randomUUID(),
        label: "Identity warning: re-align current intent with active commitments",
        reason: drift.summary,
        authorityNeeded: "advisory",
        requiresPermission: true,
        priority,
        actionKey: "custom",
        payload: {
          driftEscalated: true,
        },
      });
    }

    for (const gap of input.commitment.protectedGaps) {
      priority++;
      actions.push(this.gapToAction(gap.label, gap.evidence, priority));
    }

    for (const commitment of input.commitment.activeCommitments) {
      if (commitment.horizon === "session") {
        priority++;
        actions.push({
          id: randomUUID(),
          label: `Advance: ${commitment.label}`,
          reason: `Session-horizon commitment at priority ${commitment.priority}`,
          authorityNeeded: "advisory",
          requiresPermission: false,
          priority,
          actionKey: "advance_commitment",
          payload: {
            commitmentId: commitment.id,
            commitmentLabel: commitment.label,
          },
        });
      }
    }

    if (input.memory.queueDepth && input.memory.queueDepth > 0) {
      priority++;
      actions.push({
        id: randomUUID(),
        label: "Process pipeline queue",
        reason: `${input.memory.queueDepth} task(s) in pipeline queue`,
        authorityNeeded: "advisory",
        requiresPermission: false,
        priority,
        actionKey: "process_queue",
      });
    }

    if (
      input.memory.propositions.length === 0 &&
      input.commitment.activeCommitments.length > 0
    ) {
      priority++;
      actions.push({
        id: randomUUID(),
        label: "Seed knowledge for active commitments",
        reason: "No existing thoughts found related to active commitments",
        authorityNeeded: "advisory",
        requiresPermission: false,
        priority,
        actionKey: "seed_knowledge",
      });
    }

    if (drift?.detected) {
      for (const action of actions) {
        const isCoreAlignmentAction =
          action.actionKey === "advance_commitment" || action.actionKey === "process_queue";
        if (isCoreAlignmentAction) continue;
        action.requiresPermission = true;
        action.payload = {
          ...(action.payload ?? {}),
          driftEscalated: true,
        };
      }
    }

    return {
      intentId: input.intent.id,
      authority: this.resolveAuthority(actions),
      actions,
      generatedAt: now,
    };
  }

  async execute(input: ExecutionRunInput): Promise<ExecutionOutcome> {
    const now = new Date().toISOString();
    const results: ActionResult[] = [];
    const policy = this.loadPolicy();
    let executed = 0;

    const ordered = [...input.plan.actions].sort((a, b) => a.priority - b.priority);
    for (const action of ordered) {
      const driftEscalated = action.payload?.driftEscalated === true;
      const shouldExecute =
        !driftEscalated &&
        executed < policy.maxActionsPerCycle &&
        Boolean(policy.autoExecute[action.actionKey ?? "custom"]);

      if (!shouldExecute) {
        results.push(this.asAdvisoryResult(action, driftEscalated ? "identity drift escalation" : "policy"));
        continue;
      }

      const result = await this.executeDispatchedAction(action);
      if (result.executed) executed++;
      results.push(result);
    }

    const executedResults = results.filter((result) => result.executed);
    const completed = executedResults.length === 0 || executedResults.every((result) => result.success);

    return {
      intentId: input.intent.id,
      executedAt: now,
      completed,
      results,
    };
  }

  private gapToAction(label: string, evidence: string[], priority: number): ActionProposal {
    const gapActions: Record<
      string,
      {
        label: string;
        authority: "advisory" | "delegated";
        key: ActionKey;
        requiresPermission?: boolean;
      }
    > = {
      "inbox-pressure": {
        label: "Seed inbox and process queue tasks",
        authority: "delegated",
        key: "process_inbox",
      },
      "orphan-pressure": {
        label: "Connect orphaned thoughts",
        authority: "delegated",
        key: "connect_orphans",
      },
      "observation-backlog": {
        label: "Triage pending observations",
        authority: "delegated",
        key: "triage_observations",
      },
      "tension-backlog": {
        label: "Resolve pending tensions",
        authority: "delegated",
        key: "resolve_tensions",
      },
      "session-backlog": {
        label: "Mine unprocessed sessions",
        authority: "delegated",
        key: "mine_sessions",
      },
      // Fix 4: New gap-to-action mappings
      "link-health": {
        label: "Fix dangling wiki links",
        authority: "advisory",
        key: "custom",
      },
      "schema-compliance": {
        label: "Fix thought schema violations",
        authority: "advisory",
        key: "custom",
      },
      "description-quality": {
        label: "Improve thought descriptions",
        authority: "advisory",
        key: "custom",
      },
    };

    const mapping = gapActions[label];
    return {
      id: randomUUID(),
      label: mapping?.label ?? `Address: ${label}`,
      reason: evidence.join("; "),
      authorityNeeded: mapping?.authority ?? "advisory",
      requiresPermission: mapping?.requiresPermission ?? false,
      priority,
      actionKey: mapping?.key ?? "custom",
    };
  }

  // Fix 3: Remove dead _suffix parameter
  private asAdvisoryResult(action: ActionProposal, reason: string): ActionResult {
    const detail = `Advisory (${reason}): ${action.label} — ${action.reason}`;
    return {
      actionId: action.id,
      actionKey: action.actionKey,
      success: false,
      executed: false,
      executionMode: "advisory",
      detail,
    };
  }

  private async executeDispatchedAction(action: ActionProposal): Promise<ActionResult> {
    const handler = this.resolveHandler(action.actionKey);
    if (!handler) {
      return {
        actionId: action.id,
        actionKey: action.actionKey,
        success: false,
        executed: false,
        executionMode: "advisory",
        detail: `No dispatcher configured for action "${action.actionKey ?? "custom"}"`,
      };
    }

    const emittedSignals: PerceptionSignal[] = [];
    try {
      const detail = await handler();
      emittedSignals.push({
        id: randomUUID(),
        observedAt: new Date().toISOString(),
        channel: "execution:dispatch",
        summary: `${action.actionKey ?? "custom"} completed`,
        confidence: "medium",
      });
      return {
        actionId: action.id,
        actionKey: action.actionKey,
        success: true,
        executed: true,
        executionMode: "executed",
        detail,
        emittedSignals,
      };
    } catch (error) {
      return {
        actionId: action.id,
        actionKey: action.actionKey,
        success: false,
        executed: true,
        executionMode: "executed",
        detail: error instanceof Error ? error.message : String(error),
        emittedSignals,
      };
    }
  }

  private resolveHandler(actionKey: ActionKey | undefined): (() => Promise<string>) | null {
    switch (actionKey) {
      case "process_queue":
        return this.dispatch.processQueue ?? null;
      case "process_inbox":
        return this.dispatch.processInbox ?? null;
      case "connect_orphans":
        return this.dispatch.connectOrphans ?? null;
      case "triage_observations":
        return this.dispatch.triageObservations ?? null;
      case "resolve_tensions":
        return this.dispatch.resolveTensions ?? null;
      case "mine_sessions":
        return this.dispatch.mineSessions ?? null;
      default:
        return null;
    }
  }

  private loadPolicy(): LocalExecutionPolicy {
    if (!existsSync(this.policyPath)) return DEFAULT_POLICY;

    try {
      const raw = JSON.parse(readFileSync(this.policyPath, "utf-8")) as Partial<LocalExecutionPolicy>;
      return {
        version: 1,
        maxActionsPerCycle:
          typeof raw.maxActionsPerCycle === "number" && raw.maxActionsPerCycle > 0
            ? raw.maxActionsPerCycle
            : DEFAULT_POLICY.maxActionsPerCycle,
        autoExecute: {
          ...DEFAULT_POLICY.autoExecute,
          ...(raw.autoExecute ?? {}),
        },
      };
    } catch {
      return DEFAULT_POLICY;
    }
  }

  private resolveAuthority(
    actions: ActionProposal[],
  ): "none" | "advisory" | "delegated" | "autonomous" {
    if (actions.length === 0) return "none";

    const levels = ["none", "advisory", "delegated", "autonomous"] as const;
    let maxLevel = 0;

    for (const action of actions) {
      const idx = levels.indexOf(action.authorityNeeded);
      if (idx > maxLevel) maxLevel = idx;
    }

    return levels[maxLevel];
  }
}
