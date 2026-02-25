/**
 * intent-loop-runner.ts — Lightweight intent loop for session-start
 *
 * Runs a time-budgeted version of the full intent loop. The session-start
 * hook has a hard 30-second timeout — this runner stays well under it by:
 *
 *   1. Running Perception → Identity → Commitment always (fast: filesystem reads)
 *   2. Running Memory hydration only if time budget allows (skip if > 8s elapsed)
 *   3. Running Execution proposal always (fast: deterministic from inputs)
 *   4. Skipping execution.execute() — session-start is advisory only
 *   5. Persisting the cycle result to ops/runtime/cycle-log.jsonl
 *
 * On any error the runner returns null so session-start can degrade gracefully.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type {
  IntentLoopResult,
  PerceptionSnapshot,
  IdentityState,
  CommitmentPlan,
  MemoryContext,
  ExecutionPlan,
  ExecutionOutcome,
  SessionFrame,
  IntentRequest,
} from "@intent-computer/architecture";
import { LocalPerceptionAdapter } from "../local-perception.js";
import { LocalIdentityAdapter } from "../local-identity.js";
import { LocalCommitmentAdapter } from "../local-commitment.js";
import { LocalMemoryAdapter } from "../local-memory.js";
import { LocalExecutionAdapter } from "../local-execution.js";

/** Time budget in ms — leave headroom under the 30s hook timeout. */
const TOTAL_BUDGET_MS = 12_000;
const MEMORY_SKIP_AFTER_MS = 8_000;

function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}

/**
 * Minimal no-op execution outcome used when we skip execution.execute().
 * Session-start is advisory — we only need the proposed actions list.
 */
function advisoryOutcome(intentId: string): ExecutionOutcome {
  return {
    intentId,
    executedAt: new Date().toISOString(),
    completed: true,
    results: [],
  };
}

/**
 * Empty memory context returned when memory hydration is skipped due to
 * time budget pressure.
 */
function emptyMemory(vaultRoot: string): MemoryContext {
  return {
    vaultId: vaultRoot,
    propositions: [],
    links: [],
    queueDepth: 0,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Persist the cycle result as a single JSONL line to ops/runtime/cycle-log.jsonl.
 * Matches the format written by LocalMemoryAdapter.record() so the heartbeat
 * and other systems can read it uniformly.
 */
function persistCycleResult(vaultRoot: string, result: IntentLoopResult): void {
  try {
    const runtimeDir = join(vaultRoot, "ops", "runtime");
    if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });

    const entry = {
      ts: result.finishedAt,
      cycleId: result.cycleId,
      source: "session-start",
      intent: result.intent.statement,
      commitments: result.commitment.activeCommitments.map((c) => c.label),
      protectedGaps: result.commitment.protectedGaps.map((g) => g.label),
      compressedGaps: result.commitment.compressedGaps.map((g) => g.label),
      actions: result.plan.actions.map((a) => a.label),
      driftDetected: result.identity.drift?.detected ?? false,
      driftScore: result.identity.drift?.score ?? 0,
      memorySkipped: result.memory.propositions.length === 0 && result.memory.queueDepth === 0,
    };

    appendFileSync(
      join(runtimeDir, "cycle-log.jsonl"),
      JSON.stringify(entry) + "\n",
      "utf-8",
    );
  } catch {
    // Never block on persistence — best-effort only
  }
}

/**
 * Log runner errors to ops/runtime/intent-loop-errors.log so failures are
 * visible across sessions without blocking the hook.
 */
function logError(vaultRoot: string, context: string, err: unknown): void {
  try {
    const runtimeDir = join(vaultRoot, "ops", "runtime");
    if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    appendFileSync(
      join(runtimeDir, "intent-loop-errors.log"),
      `${new Date().toISOString()} [session-start] ${context}\n${msg}\n${stack}\n---\n`,
      "utf-8",
    );
  } catch {
    // Swallow — we're in an error path already
  }
}

/** Build a minimal SessionFrame from the session-start hook input. */
export function buildSessionFrame(sessionId: string, cwd: string): SessionFrame {
  const actorId =
    process.env.INTENT_ACTOR_ID ||
    process.env.USER ||
    process.env.LOGNAME ||
    "intent-user";
  return {
    sessionId,
    actorId,
    startedAt: new Date().toISOString(),
    worktree: cwd,
  };
}

/** Build a minimal orient intent for session-start. */
export function buildOrientIntent(actorId: string): IntentRequest {
  return {
    id: randomUUID(),
    actorId,
    statement: "session orient — ambient perception",
    source: "inferred",
    requestedAt: new Date().toISOString(),
  };
}

/**
 * Run a time-budgeted intent loop for session-start.
 *
 * Returns the full IntentLoopResult on success, or null if the run fails
 * or the vault root is not available. Never throws.
 */
export async function runSessionStartLoop(
  vaultRoot: string,
  sessionId: string,
): Promise<IntentLoopResult | null> {
  const startMs = Date.now();

  const session = buildSessionFrame(sessionId, vaultRoot);
  const intent = buildOrientIntent(session.actorId);

  try {
    // ─── Perception ───────────────────────────────────────────────────────
    const perceptionAdapter = new LocalPerceptionAdapter(vaultRoot);
    let perception: PerceptionSnapshot;
    try {
      perception = await Promise.race([
        perceptionAdapter.capture({ session, intent }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("perception timeout")), 5_000),
        ),
      ]);
    } catch (err) {
      logError(vaultRoot, "perception.capture", err);
      // Return null — perception is foundational; without it the rest is noise
      return null;
    }

    if (elapsedMs(startMs) > TOTAL_BUDGET_MS) {
      logError(vaultRoot, "budget-exceeded", new Error("total budget exceeded after perception"));
      return null;
    }

    // ─── Identity ─────────────────────────────────────────────────────────
    const identityAdapter = new LocalIdentityAdapter(vaultRoot);
    let identity: IdentityState;
    try {
      identity = await Promise.race([
        identityAdapter.resolve({ session, intent, perception }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("identity timeout")), 3_000),
        ),
      ]);
    } catch (err) {
      logError(vaultRoot, "identity.resolve", err);
      return null;
    }

    if (elapsedMs(startMs) > TOTAL_BUDGET_MS) {
      logError(vaultRoot, "budget-exceeded", new Error("total budget exceeded after identity"));
      return null;
    }

    // ─── Commitment ───────────────────────────────────────────────────────
    const commitmentAdapter = new LocalCommitmentAdapter(vaultRoot);
    let commitment: CommitmentPlan;
    try {
      commitment = await Promise.race([
        commitmentAdapter.plan({ session, intent, perception, identity }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("commitment timeout")), 4_000),
        ),
      ]);
    } catch (err) {
      logError(vaultRoot, "commitment.plan", err);
      return null;
    }

    if (elapsedMs(startMs) > TOTAL_BUDGET_MS) {
      logError(vaultRoot, "budget-exceeded", new Error("total budget exceeded after commitment"));
      return null;
    }

    // ─── Memory (optional — skip if time budget is tight) ─────────────────
    let memory: MemoryContext;
    const elapsed = elapsedMs(startMs);
    if (elapsed < MEMORY_SKIP_AFTER_MS) {
      const memoryAdapter = new LocalMemoryAdapter(vaultRoot);
      try {
        memory = await Promise.race([
          memoryAdapter.hydrate({ session, intent, perception, identity, commitment }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("memory timeout")), MEMORY_SKIP_AFTER_MS - elapsed),
          ),
        ]);
      } catch {
        // Memory is optional — fall back to empty context
        memory = emptyMemory(vaultRoot);
      }
    } else {
      memory = emptyMemory(vaultRoot);
    }

    // ─── Execution (propose only — no execute()) ──────────────────────────
    const executionAdapter = new LocalExecutionAdapter(vaultRoot);
    let plan: ExecutionPlan;
    try {
      plan = await Promise.race([
        executionAdapter.propose({ session, intent, identity, commitment, memory }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("execution timeout")), 2_000),
        ),
      ]);
    } catch (err) {
      logError(vaultRoot, "execution.propose", err);
      return null;
    }

    // Advisory outcome — no actions are actually executed at session-start
    const outcome = advisoryOutcome(intent.id);

    const result: IntentLoopResult = {
      cycleId: randomUUID(),
      startedAt: new Date(startMs).toISOString(),
      finishedAt: new Date().toISOString(),
      session,
      intent,
      perception,
      identity,
      commitment,
      memory,
      plan,
      outcome,
    };

    persistCycleResult(vaultRoot, result);
    return result;
  } catch (err) {
    logError(vaultRoot, "runSessionStartLoop", err);
    return null;
  }
}
