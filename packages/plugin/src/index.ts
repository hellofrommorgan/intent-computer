/**
 * index.ts — intent-computer opencode plugin
 *
 * Thin adapter mapping opencode events to the HolisticIntentComputerRuntime.
 *
 * The intent loop fires at session bookends:
 *   - system.transform (first call): startSession + processIntent → system prompt
 *   - session.deleted: endSession → persist state
 *
 * Skills (router + injector + orchestrators) operate within the session,
 * outside the intent loop — fire-and-forget execution.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { execSync } from "child_process";
import type {
  IntentRequest,
  SessionFrame,
  IntentLoopResult,
  ActionAuthority,
  LifecycleHooksPort,
  RepairContext,
  PipelineTask,
} from "@intent-computer/architecture";
import {
  HolisticIntentComputerRuntime,
  emitActionExecuted,
  emitActionProposed,
  emitIntentCycle,
  emitRepairQueued,
  emitSessionEnded,
  emitSessionStarted,
  emitSignalFired,
  emitSkillInvoked,
  emitTaskExecuted,
  emitTaskFailed,
  readQueue,
  toKebabCase,
  writeQueue,
  withQueueLock,
} from "@intent-computer/architecture";
import {
  LocalPerceptionAdapter,
  LocalIdentityAdapter,
  LocalCommitmentAdapter,
  LocalMemoryAdapter,
  LocalExecutionAdapter,
  LocalPipelineAdapter,
} from "./adapters/index.js";
import { autoCommit } from "./hooks/auto-commit.js";
import { sessionCapture } from "./hooks/session-capture.js";
import { sessionContinuity } from "./hooks/session-continuity.js";
import { writeValidate } from "./hooks/write-validate.js";
import { forkSkill } from "./skills/fork.js";
import { createInjector, loadSkillInstructions } from "./skills/injector.js";
import { runRalph } from "./skills/ralph.js";
import { createRouter } from "./skills/router.js";
import { isNotePath, isVault, toAbsoluteVaultPath } from "./tools/vaultguard.js";

// Part type from @opencode-ai/sdk — inlined to avoid SDK module resolution issues
type TextPart = { type: "text"; text: string };
type Part = TextPart | { type: string; [key: string]: unknown };

// ─── Orchestrator skills — programmatically executed, not LLM-driven ──────────
const ORCHESTRATOR_SKILLS = new Set(["process"]);

function parseProcessArgs(raw: string): Parameters<typeof runRalph>[3] {
  const options: { concurrency?: number; dryRun?: boolean; batchFilter?: string } = {};
  if (/--dry-run\b/.test(raw)) options.dryRun = true;
  const batchMatch = raw.match(/--batch\s+(\S+)/);
  if (batchMatch) options.batchFilter = batchMatch[1];
  const numMatch = raw.match(/(?:\/process|process)\s+(\d+)/i);
  if (numMatch) options.concurrency = Math.min(parseInt(numMatch[1], 10), 5);
  return options;
}

function resolveActorId(): string {
  return process.env.INTENT_ACTOR_ID || process.env.USER || process.env.LOGNAME || "intent-user";
}

function normalizeIntentStatement(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "session orient — ambient perception";
  return normalized.slice(0, 800);
}

function createIntent(actorId: string, statement: string, source: "explicit" | "inferred"): IntentRequest {
  return {
    id: randomUUID(),
    actorId,
    statement: normalizeIntentStatement(statement),
    source,
    requestedAt: new Date().toISOString(),
  };
}

function extractMessageText(output: { parts?: Part[]; message?: Record<string, unknown> }): string {
  const textParts = (output.parts ?? []).filter(
    (p: Part): p is Extract<Part, { type: "text" }> => (p as { type: string }).type === "text",
  );
  const partsText = textParts.map((part) => part.text).join(" ").trim();
  const message = output.message ?? {};
  const messageText = typeof message.text === "string" ? message.text : "";
  const systemText = typeof message.system === "string" ? message.system : "";
  return (partsText || messageText || systemText || "").trim();
}

function nextInboxSource(vaultRoot: string): string | null {
  const inboxDir = join(vaultRoot, "inbox");
  if (!existsSync(inboxDir)) return null;
  const files = readdirSync(inboxDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  if (files.length === 0) return null;
  return join(inboxDir, files[0]);
}

interface SeedQueueResult {
  seeded: boolean;
  taskId: string;
  target: string;
  batch: string;
  sourcePath: string;
}

async function seedInboxSourceIntoQueue(
  vaultRoot: string,
  sourcePath: string,
): Promise<SeedQueueResult> {
  const absoluteSourcePath = sourcePath.startsWith("/") ? sourcePath : join(vaultRoot, sourcePath);
  const base = basename(absoluteSourcePath, ".md");
  const target = toKebabCase(base) || base.toLowerCase();
  const batch = target;

  return withQueueLock(vaultRoot, async () => {
    const queue = readQueue(vaultRoot);
    const existing = queue.tasks.find((task) => {
      const status = task.status ?? "pending";
      if (status === "done" || status === "archived") return false;
      const taskSource = resolveAbsoluteSourcePath(vaultRoot, task.sourcePath, task.target);
      return taskSource === absoluteSourcePath;
    });

    if (existing) {
      return {
        seeded: false,
        taskId: existing.taskId,
        target: existing.target,
        batch: existing.batch ?? batch,
        sourcePath: absoluteSourcePath,
      };
    }

    const now = new Date().toISOString();
    const taskId = randomUUID();
    queue.tasks.push({
      taskId,
      vaultId: vaultRoot,
      target,
      sourcePath: absoluteSourcePath,
      phase: "surface",
      status: "pending",
      executionMode: "orchestrated",
      batch,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      maxAttempts: 3,
      completedPhases: [],
    });
    queue.lastUpdated = now;
    writeQueue(vaultRoot, queue);

    return {
      seeded: true,
      taskId,
      target,
      batch,
      sourcePath: absoluteSourcePath,
    };
  });
}

const MAX_REPAIR_ATTEMPTS = 2;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`;
}

function resolveAbsoluteSourcePath(vaultRoot: string, sourcePath: string | undefined, target: string): string {
  if (sourcePath) {
    return sourcePath.startsWith("/") ? sourcePath : join(vaultRoot, sourcePath);
  }
  if (!target) return "";
  return target.startsWith("/") ? target : join(vaultRoot, target);
}

function readFileStateSafe(path: string): string | undefined {
  try {
    if (path && existsSync(path)) return truncate(readFileSync(path, "utf-8"), 4000);
  } catch {
    // Best-effort context snapshot.
  }
  return undefined;
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

function summarizeQueue(queue: { tasks: PipelineTask[] }): string {
  if (queue.tasks.length === 0) return "Queue is empty.";
  const preview = queue.tasks.slice(0, 12).map((task) => {
    const status = task.status ?? "pending";
    return `- ${task.taskId} [${status}] ${task.phase} ${task.target}`;
  });
  if (queue.tasks.length > 12) {
    preview.push(`- ... ${queue.tasks.length - 12} more task(s)`);
  }
  return [`Total tasks: ${queue.tasks.length}`, ...preview].join("\n");
}

function expectedOutputContractForAction(actionKind: string): string {
  switch (actionKind) {
    case "processQueue":
      return "Advance queue tasks by executing the next pipeline phase and persist queue state updates.";
    case "processInbox":
      return "Seed inbox source material into the queue and process queue tasks through /process.";
    case "connectOrphans":
      return "Add meaningful links for orphan thoughts and update relevant map references.";
    case "triageObservations":
      return "Triage pending observations with clear promote/resolve/defer outcomes.";
    case "resolveTensions":
      return "Resolve or synthesize tensions and persist status updates with rationale.";
    case "mineSessions":
      return "Extract durable insights from sessions and create/update thoughts accordingly.";
    default:
      return "Diagnose and fix the failing task with concrete file-level changes.";
  }
}

interface QueueRepairOptions {
  sourcePath?: string;
  phase?: string;
  commandOrSkill?: string;
  expectedOutputContract?: string;
  lastStdout?: string;
  lastStderr?: string;
  stackTrace?: string;
}

async function queueRepairTask(
  vaultRoot: string,
  actionKind: string,
  target: string,
  error: string,
  options: QueueRepairOptions = {},
): Promise<void> {
  try {
    const absoluteSourcePath = resolveAbsoluteSourcePath(vaultRoot, options.sourcePath, target);
    const fileState = readFileStateSafe(absoluteSourcePath);
    const gitDiff = readGitDiffSafe(vaultRoot, absoluteSourcePath);
    const repairTask: PipelineTask = {
      taskId: randomUUID(),
      vaultId: vaultRoot,
      target,
      sourcePath: absoluteSourcePath,
      phase: "surface",
      status: "pending",
      executionMode: "orchestrated",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
      maxAttempts: 3,
    };

    await withQueueLock(vaultRoot, async () => {
      const queue = readQueue(vaultRoot);

      // Check if we already have too many repair attempts for this target
      const existingRepairs = queue.tasks.filter(
        (t) => t.repair_context && t.repair_context.original_task.target === target,
      );
      if (existingRepairs.length >= MAX_REPAIR_ATTEMPTS) return;

      const repairContext: RepairContext = {
        original_task: { kind: actionKind, target },
        error_message: error,
        vault_root: vaultRoot,
        absolute_source_path: absoluteSourcePath,
        expected_output_contract: options.expectedOutputContract ?? expectedOutputContractForAction(actionKind),
        phase: options.phase ?? "surface",
        command_or_skill: options.commandOrSkill ?? actionKind,
        last_stderr: options.lastStderr ?? error,
        last_stdout: options.lastStdout ?? "",
        queue_excerpt: summarizeQueue(queue),
        relevant_file_diffs: gitDiff ? [{ path: absoluteSourcePath, diff: gitDiff }] : [],
        stack_trace: options.stackTrace,
        file_state: fileState ? { [absoluteSourcePath]: fileState } : undefined,
        attempted_at: new Date().toISOString(),
        attempt_count: 1,
      };
      repairTask.repair_context = repairContext;
      queue.tasks.push(repairTask);
      queue.lastUpdated = new Date().toISOString();
      writeQueue(vaultRoot, queue);
    });

    emitRepairQueued(vaultRoot, {
      repairTaskId: repairTask.taskId,
      actionKind,
      target,
      error,
    });
  } catch {
    // Repair queueing is best-effort — never block the caller
  }
}

function appendRuntimeEvent(vaultRoot: string, event: Record<string, unknown>): void {
  try {
    const runtimeDir = join(vaultRoot, "ops", "runtime");
    if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
    const eventPath = join(runtimeDir, "session-events.jsonl");
    writeFileSync(eventPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf-8",
      flag: "a",
    });
  } catch {
    // Runtime logs are best-effort.
  }
}

function createRuntimeHooks(vaultRoot: string): LifecycleHooksPort {
  return {
    async onSessionStart(session) {
      appendRuntimeEvent(vaultRoot, {
        ts: new Date().toISOString(),
        type: "session-start",
        sessionId: session.sessionId,
        actorId: session.actorId,
      });

      emitSessionStarted(vaultRoot, session.sessionId, {
        actorId: session.actorId,
        worktree: session.worktree,
      });
    },

    async onIntentCycle(result) {
      try {
        const cyclesDir = join(vaultRoot, "ops", "runtime", "cycles");
        if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });

        const timestamp = result.finishedAt.replace(/[:.]/g, "-");
        const path = join(cyclesDir, `${timestamp}-${result.cycleId}.json`);
        writeFileSync(
          path,
          JSON.stringify(
            {
              cycleId: result.cycleId,
              startedAt: result.startedAt,
              finishedAt: result.finishedAt,
              sessionId: result.session.sessionId,
              actorId: result.session.actorId,
              intent: result.intent,
              gapCount: result.perception.gaps.length,
              actionCount: result.plan.actions.length,
              outcome: result.outcome,
            },
            null,
            2,
          ),
          "utf-8",
        );
      } catch {
        // Runtime logs are best-effort.
      }

      emitIntentCycle(vaultRoot, result.session.sessionId, {
        cycleId: result.cycleId,
        signalsCount: result.perception.signals.length,
        gapsCount: result.perception.gaps.length,
        actionsProposed: result.plan.actions.length,
        authority: result.plan.authority,
        completed: result.outcome.completed,
      });

      // Emit signal_fired for each perception signal
      for (const signal of result.perception.signals) {
        emitSignalFired(vaultRoot, result.session.sessionId, {
          signalId: signal.id,
          channel: signal.channel,
          summary: signal.summary,
          confidence: signal.confidence,
        });
      }

      // Emit action_proposed for each action in the plan
      for (const action of result.plan.actions) {
        emitActionProposed(vaultRoot, result.session.sessionId, {
          actionId: action.id,
          label: action.label,
          actionKey: action.actionKey,
          authorityNeeded: action.authorityNeeded,
          priority: action.priority,
        });
      }

      // Emit action_executed for each action result
      for (const actionResult of result.outcome.results) {
        emitActionExecuted(vaultRoot, result.session.sessionId, {
          actionId: actionResult.actionId,
          success: actionResult.success,
          executed: actionResult.executed,
          executionMode: actionResult.executionMode ?? (actionResult.executed ? "executed" : "advisory"),
          actionKey: actionResult.actionKey,
          detail: actionResult.detail.slice(0, 200),
        });
      }
    },

    async onSessionEnd(session, lastCycle) {
      appendRuntimeEvent(vaultRoot, {
        ts: new Date().toISOString(),
        type: "session-end",
        sessionId: session.sessionId,
        actorId: session.actorId,
        lastCycleId: lastCycle?.cycleId ?? null,
      });

      emitSessionEnded(vaultRoot, session.sessionId, {
        actorId: session.actorId,
        lastCycleId: lastCycle?.cycleId ?? null,
      });
    },
  };
}

// ─── Build system prompt from intent loop result ──────────────────────────────

function buildSystemPrompt(result: IntentLoopResult): string {
  const sections: string[] = [];

  // Perception signals
  if (result.perception.signals.length > 0) {
    const signalLines = result.perception.signals
      .map(s => `- [${s.channel}] ${s.summary}`)
      .join("\n");
    sections.push(`## Vault State\n${signalLines}`);
  }

  // Detected gaps → maintenance conditions
  if (result.perception.gaps.length > 0) {
    const gapLines = result.perception.gaps
      .map(g => `- CONDITION: ${g.label} (${g.gapClass})`)
      .join("\n");
    sections.push(gapLines);
  }

  // Identity
  if (result.identity.selfModel) {
    sections.push(`--- Identity ---\n${result.identity.selfModel}`);
  }

  if (result.identity.drift?.detected) {
    sections.push(
      `--- Identity Warning ---\n${result.identity.drift.summary}\nDrift score: ${result.identity.drift.score}`,
    );
  }

  // Umwelt (working context)
  if (result.identity.umwelt.length > 0) {
    sections.push(`--- Working Memory ---\n${result.identity.umwelt.join("\n")}`);
  }

  // Priorities
  if (result.identity.priorities.length > 0) {
    sections.push(`--- Priorities ---\n${result.identity.priorities.map(p => `- ${p}`).join("\n")}`);
  }

  // Active commitments
  if (result.commitment.activeCommitments.length > 0) {
    const commitmentLines = result.commitment.activeCommitments
      .map(c => {
        const header = `- [${c.state}/${c.horizon}] ${c.label} (priority ${c.priority})`;
        if (!c.description) return header;
        const desc = c.description.length > 200 ? c.description.slice(0, 197) + "..." : c.description;
        return `${header}\n  ${desc}`;
      })
      .join("\n");
    sections.push(`--- Active Commitments ---\n${commitmentLines}`);
  }

  // Commitment rationale
  if (result.commitment.rationale) {
    sections.push(`--- Session Focus ---\n${result.commitment.rationale}`);
  }

  // Execution proposals (advisory actions for the LLM)
  const advisoryActions = result.plan.actions.filter(a => a.authorityNeeded === "advisory");
  if (advisoryActions.length > 0) {
    const actionLines = advisoryActions
      .map(a => `- ${a.label}: ${a.reason}`)
      .join("\n");
    sections.push(`--- Suggested Actions ---\n${actionLines}`);
  }

  const executedActions = result.outcome.results.filter(
    (actionResult) => actionResult.executed,
  );
  if (executedActions.length > 0) {
    const lines = executedActions
      .map((actionResult) => `- ${actionResult.success ? "OK" : "FAIL"} ${actionResult.detail}`)
      .join("\n");
    sections.push(`--- Executed Actions ---\n${lines}`);
  }

  // Relevant memory (propositions loaded for context)
  if (result.memory.propositions.length > 0) {
    const memLines = result.memory.propositions
      .slice(0, 10) // cap at 10 to avoid bloating
      .map(p => `- [[${p.title}]]: ${p.description}`)
      .join("\n");
    sections.push(`--- Relevant Thoughts ---\n${memLines}`);
  }

  return sections.join("\n\n---\n");
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

const IntentComputer: Plugin = async (input: PluginInput) => {
  const vaultRoot = await isVault(input.worktree);
  const actorId = resolveActorId();
  const capturedSessionIDs = new Set<string>();
  const sessionFrames = new Map<string, SessionFrame>();
  const pendingIntents = new Map<string, IntentRequest>();
  const lastProcessedIntentId = new Map<string, string>();

  // Router and injector are only instantiated when a vault is present.
  const router = vaultRoot ? await createRouter(vaultRoot) : null;
  const injector = vaultRoot ? createInjector() : null;
  const runtimeHooks = vaultRoot ? createRuntimeHooks(vaultRoot) : undefined;

  // Wrap a dispatch action with error recovery: on failure, queue a repair task
  function withRepairRecovery(
    actionKind: string,
    target: string,
    fn: () => Promise<string>,
    repairMeta?: QueueRepairOptions | (() => QueueRepairOptions),
  ): () => Promise<string> {
    return async () => {
      try {
        const result = await fn();
        emitTaskExecuted(vaultRoot!, {
          source: "dispatch",
          actionKind,
          target,
          detail: result.slice(0, 200),
        });
        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const stackTrace = err instanceof Error ? err.stack : undefined;
        const meta = typeof repairMeta === "function" ? repairMeta() : repairMeta;
        emitTaskFailed(vaultRoot!, {
          actionKind,
          target,
          error: errorMsg,
        });
        await queueRepairTask(vaultRoot!, actionKind, target, errorMsg, {
          ...meta,
          lastStderr: meta?.lastStderr ?? errorMsg,
          stackTrace: meta?.stackTrace ?? stackTrace,
        });
        throw new Error(`${actionKind} failed (repair task queued): ${errorMsg}`);
      }
    };
  }

  const executionDispatch = vaultRoot
    ? {
        processQueue: withRepairRecovery("processQueue", "queue", async () =>
          runRalph(vaultRoot, input.client, input.$, { concurrency: 1 }),
          {
            sourcePath: join(vaultRoot, "ops", "queue", "queue.json"),
            phase: "surface",
            commandOrSkill: "/process",
            expectedOutputContract: "Advance pending queue tasks and persist queue task status transitions.",
          },
        ),
        processInbox: withRepairRecovery("processInbox", "inbox", async () => {
          const source = nextInboxSource(vaultRoot);
          if (!source) return "No inbox items available.";
          const seeded = await seedInboxSourceIntoQueue(vaultRoot, source);
          const processSummary = await runRalph(vaultRoot, input.client, input.$, {
            concurrency: 1,
            batchFilter: seeded.batch,
          });
          if (seeded.seeded) {
            return `Seeded inbox source (${seeded.target}) and processed 1 queue task.\n${processSummary}`;
          }
          return `Inbox source already queued (${seeded.target}); processed queue.\n${processSummary}`;
        }, () => ({
          sourcePath: nextInboxSource(vaultRoot) ?? join(vaultRoot, "inbox"),
          phase: "surface",
          commandOrSkill: "/process",
          expectedOutputContract: "Seed inbox source into the queue and process with /process.",
        })),
        connectOrphans: withRepairRecovery("connectOrphans", "orphan-thoughts", async () => {
          const skillInstructions = await loadSkillInstructions("reflect", vaultRoot);
          if (!skillInstructions) return "Reflect skill not found — cannot connect orphans.";

          // Build task context: list orphan thoughts
          const orphanDir = join(vaultRoot, "thoughts");
          const allThoughts = readdirSync(orphanDir).filter((f) => f.endsWith(".md"));
          const orphans: string[] = [];
          for (const file of allThoughts) {
            const name = file.replace(/\.md$/, "");
            // Check if any other file links to this one
            try {
              const result = await input
                .$`grep -rl "\\[\\[${name}\\]\\]" ${join(vaultRoot, "thoughts")} ${join(vaultRoot, "self")}`
                .text();
              if (!result.trim()) orphans.push(name);
            } catch {
              orphans.push(name); // grep returns non-zero when no matches
            }
          }

          if (orphans.length === 0) return "No orphan thoughts found.";

          const taskContext = [
            "# Orphan Connection Task",
            "",
            `Found ${orphans.length} orphan thoughts (no incoming wiki links).`,
            "Your job: find connections between these orphans and existing thoughts.",
            "For each orphan, either:",
            "1. Add wiki links FROM existing thoughts TO the orphan (update the existing thought)",
            "2. Add the orphan to a relevant map's topic list",
            "3. If truly unconnectable, note it for review",
            "",
            "Orphans to connect:",
            ...orphans.slice(0, 10).map((o) => `- [[${o}]]`),
            orphans.length > 10 ? `\n...and ${orphans.length - 10} more` : "",
            "",
            `Vault root: ${vaultRoot}`,
            `Thoughts directory: ${join(vaultRoot, "thoughts")}`,
          ].join("\n");

          const result = await forkSkill(
            { skillName: "reflect", skillInstructions, taskContext, vaultRoot, timeoutMs: 300_000 },
            input.client,
            input.$,
          );

          return result.success
            ? `Connected orphans: ${result.artifacts?.length ?? 0} files modified`
            : `Orphan connection failed: ${result.error ?? "unknown error"}`;
        }, {
          sourcePath: join(vaultRoot, "thoughts"),
          phase: "reflect",
          commandOrSkill: "reflect",
          expectedOutputContract: "Connect orphan thoughts with concrete incoming links and map updates.",
        }),
        triageObservations: withRepairRecovery("triageObservations", "observations", async () => {
          const skillInstructions = await loadSkillInstructions("rethink", vaultRoot);
          if (!skillInstructions) return "Rethink skill not found — cannot triage observations.";

          const obsDir = join(vaultRoot, "ops", "observations");
          const obsFiles = existsSync(obsDir)
            ? readdirSync(obsDir).filter((f) => f.endsWith(".md"))
            : [];

          if (obsFiles.length === 0) return "No pending observations to triage.";

          // Read first 10 observations for context
          const previews = obsFiles.slice(0, 10).map((f) => {
            const content = readFileSync(join(obsDir, f), "utf-8");
            const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("---")) ?? f;
            return `- ${f}: ${firstLine.slice(0, 100)}`;
          });

          const taskContext = [
            "# Observation Triage Task",
            "",
            `Found ${obsFiles.length} pending observations in ops/observations/.`,
            "Your job: review each observation and decide:",
            "1. PROMOTE — if it reveals a pattern worth capturing as a thought, create the thought",
            "2. RESOLVE — if it's been addressed, mark status: resolved in frontmatter",
            "3. DEFER — if it needs more evidence, leave as-is",
            "",
            "Observations to triage:",
            ...previews,
            obsFiles.length > 10 ? `\n...and ${obsFiles.length - 10} more` : "",
            "",
            `Vault root: ${vaultRoot}`,
            `Observations directory: ${obsDir}`,
          ].join("\n");

          const result = await forkSkill(
            { skillName: "rethink", skillInstructions, taskContext, vaultRoot, timeoutMs: 300_000 },
            input.client,
            input.$,
          );

          return result.success
            ? `Triaged observations: ${result.artifacts?.length ?? 0} files modified`
            : `Observation triage failed: ${result.error ?? "unknown error"}`;
        }, {
          sourcePath: join(vaultRoot, "ops", "observations"),
          phase: "reflect",
          commandOrSkill: "rethink",
          expectedOutputContract: "Triage observations into promote/resolve/defer outcomes with persisted file changes.",
        }),
        resolveTensions: withRepairRecovery("resolveTensions", "tensions", async () => {
          const skillInstructions = await loadSkillInstructions("rethink", vaultRoot);
          if (!skillInstructions) return "Rethink skill not found — cannot resolve tensions.";

          const tensionDir = join(vaultRoot, "ops", "tensions");
          const tensionFiles = existsSync(tensionDir)
            ? readdirSync(tensionDir).filter((f) => f.endsWith(".md"))
            : [];

          if (tensionFiles.length === 0) return "No pending tensions to resolve.";

          const previews = tensionFiles.slice(0, 10).map((f) => {
            const content = readFileSync(join(tensionDir, f), "utf-8");
            const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("---")) ?? f;
            return `- ${f}: ${firstLine.slice(0, 100)}`;
          });

          const taskContext = [
            "# Tension Resolution Task",
            "",
            `Found ${tensionFiles.length} pending tensions in ops/tensions/.`,
            "Tensions are contradictions between thoughts or between implementation and methodology.",
            "Your job: for each tension, decide:",
            "1. RESOLVE — if one side is clearly right, update the weaker thought and mark tension resolved",
            "2. SYNTHESIZE — if both sides have merit, create a new thought that reconciles them",
            "3. DISSOLVE — if the contradiction is apparent (different contexts), note why and mark dissolved",
            "",
            "Tensions to resolve:",
            ...previews,
            tensionFiles.length > 10 ? `\n...and ${tensionFiles.length - 10} more` : "",
            "",
            `Vault root: ${vaultRoot}`,
            `Tensions directory: ${tensionDir}`,
          ].join("\n");

          const result = await forkSkill(
            { skillName: "rethink", skillInstructions, taskContext, vaultRoot, timeoutMs: 300_000 },
            input.client,
            input.$,
          );

          return result.success
            ? `Resolved tensions: ${result.artifacts?.length ?? 0} files modified`
            : `Tension resolution failed: ${result.error ?? "unknown error"}`;
        }, {
          sourcePath: join(vaultRoot, "ops", "tensions"),
          phase: "revisit",
          commandOrSkill: "rethink",
          expectedOutputContract: "Resolve or synthesize tensions and persist updated status with rationale.",
        }),
        mineSessions: withRepairRecovery("mineSessions", "sessions", async () => {
          const skillInstructions = await loadSkillInstructions("remember", vaultRoot);
          if (!skillInstructions) return "Remember skill not found — cannot mine sessions.";

          const sessDir = join(vaultRoot, "ops", "sessions");
          const sessionFiles = existsSync(sessDir)
            ? readdirSync(sessDir)
                .filter((f) => f.endsWith(".json") || f.endsWith(".md"))
                .sort()
                .reverse()
            : [];

          if (sessionFiles.length === 0) return "No unprocessed sessions to mine.";

          // Take the 3 most recent sessions
          const recentSessions = sessionFiles.slice(0, 3);
          const sessionPreviews = recentSessions.map((f) => {
            const content = readFileSync(join(sessDir, f), "utf-8");
            return `### ${f}\n${content.slice(0, 500)}...\n`;
          });

          const taskContext = [
            "# Session Mining Task",
            "",
            `Found ${sessionFiles.length} unprocessed session transcripts in ops/sessions/.`,
            "Your job: scan these transcripts for insights worth capturing as thoughts.",
            "Look for:",
            "1. Explicit insights the user stated but weren't captured",
            "2. Patterns across multiple sessions",
            "3. Decisions made that should be recorded",
            "4. Methodology learnings (how the system worked or didn't)",
            "",
            "For each insight found, create a thought in thoughts/ following the vault schema.",
            "After mining, you may move processed session files to ops/sessions/archive/.",
            "",
            `Processing ${recentSessions.length} most recent sessions:`,
            "",
            ...sessionPreviews,
            "",
            `Vault root: ${vaultRoot}`,
            `Sessions directory: ${sessDir}`,
          ].join("\n");

          const result = await forkSkill(
            { skillName: "remember", skillInstructions, taskContext, vaultRoot, timeoutMs: 300_000 },
            input.client,
            input.$,
          );

          return result.success
            ? `Mined sessions: ${result.artifacts?.length ?? 0} files modified`
            : `Session mining failed: ${result.error ?? "unknown error"}`;
        }, {
          sourcePath: join(vaultRoot, "ops", "sessions"),
          phase: "surface",
          commandOrSkill: "remember",
          expectedOutputContract: "Extract durable insights from sessions and write/update thought files.",
        }),
      }
    : undefined;

  // ─── Construct Runtime with local adapters ────────────────────────────────
  const runtime = vaultRoot
    ? new HolisticIntentComputerRuntime({
        layers: {
          perception: new LocalPerceptionAdapter(vaultRoot),
          identity: new LocalIdentityAdapter(vaultRoot),
          commitment: new LocalCommitmentAdapter(vaultRoot),
          memory: new LocalMemoryAdapter(vaultRoot),
          execution: new LocalExecutionAdapter(vaultRoot, {
            dispatch: executionDispatch,
          }),
        },
        hooks: runtimeHooks,
        pipeline: new LocalPipelineAdapter(vaultRoot, input.client, input.$),
      })
    : null;

  return {
    event: async ({ event }) => {
      if (!vaultRoot) return;
      if (event.type !== "session.deleted") return;

      const properties = (event as { properties?: { info?: { id?: string; title?: string; summary?: { additions?: number; deletions?: number; files?: number }; time?: { created?: number; updated?: number } } } }).properties;
      const sessionInfo = properties?.info;
      const sessionID = sessionInfo?.id;
      if (sessionID && capturedSessionIDs.has(sessionID)) return;

      await sessionCapture(vaultRoot, input.$, { eventType: event.type, sessionID, sessionInfo });
      if (sessionID) capturedSessionIDs.add(sessionID);

      // End the intent loop session
      // Recover frame from disk if plugin reloaded since session started
      let frame = sessionID ? sessionFrames.get(sessionID) : undefined;
      if (!frame && sessionID) {
        try {
          const framePath = join(vaultRoot, "ops", "runtime", "active-sessions", `${sessionID}.json`);
          if (existsSync(framePath)) {
            frame = JSON.parse(readFileSync(framePath, "utf-8")) as SessionFrame;
          }
        } catch {
          // Frame recovery is best-effort
        }
      }
      if (frame && runtime) {
        try {
          await runtime.endSession(frame);
        } catch {
          // endSession is best-effort — don't block session cleanup
        }
        sessionFrames.delete(sessionID!);
        pendingIntents.delete(sessionID!);
        lastProcessedIntentId.delete(sessionID!);
      }
      // Clean up persisted frame file regardless
      if (sessionID) {
        try {
          const framePath = join(vaultRoot, "ops", "runtime", "active-sessions", `${sessionID}.json`);
          if (existsSync(framePath)) unlinkSync(framePath);
        } catch {
          // Cleanup is best-effort
        }
      }

      // Always fire session-continuity — even if no frame (plugin reloaded mid-session).
      // Fall back to 2-hour lookback when session start time is unknown.
      {
        const sessionStart = frame
          ? new Date(frame.startedAt)
          : new Date(Date.now() - 2 * 60 * 60 * 1000);
        void sessionContinuity(vaultRoot, input.client, input.$, sessionStart, sessionID ?? undefined);
      }

      if (sessionID) {
        pendingIntents.delete(sessionID);
        lastProcessedIntentId.delete(sessionID);
      }
    },

    // Detect slash command invocations
    "command.execute.before": async (hookInput, _output) => {
      if (!vaultRoot || !router) return;

      const commandText = `/${hookInput.command}`;
      const detected = router.detect(commandText);
      if (detected) {
        const rawInput = (hookInput as { input?: string }).input ?? commandText;
        router.setActive(detected, rawInput);
        const sessionID = (hookInput as { sessionID?: string }).sessionID;
        if (sessionID) {
          pendingIntents.set(
            sessionID,
            createIntent(actorId, rawInput, "explicit"),
          );
        }
      }
    },

    // Capture per-turn intent and detect natural language skill invocations.
    "chat.message": async (hookInput, output) => {
      if (!vaultRoot || !router) return;

      const messageText = extractMessageText(output);
      if (!messageText) return;

      const role = (() => {
        const outputRole = (output.message as { role?: unknown })?.role;
        if (typeof outputRole === "string") return outputRole.toLowerCase();
        const hookRole = (hookInput as { role?: unknown })?.role;
        if (typeof hookRole === "string") return hookRole.toLowerCase();
        return "";
      })();

      const sessionID = (hookInput as { sessionID?: string }).sessionID;
      const isUserMessage = role ? role === "user" : true;
      if (sessionID && isUserMessage) {
        pendingIntents.set(sessionID, createIntent(actorId, messageText, "explicit"));
      }

      const detected = router.detect(messageText);
      if (detected) {
        router.setActive(detected, messageText);
      }
    },

    "tool.execute.after": async (hookInput, output) => {
      if (!vaultRoot) return;
      if (hookInput.tool !== "write") return;

      const args = hookInput.args as Record<string, string>;
      const filePath: string = args?.filePath ?? args?.path ?? "";
      if (!isNotePath(filePath)) return;
      const absolutePath = toAbsoluteVaultPath(vaultRoot, filePath);
      if (!absolutePath.startsWith(vaultRoot)) return;

      const warnings = await writeValidate(absolutePath);
      if (warnings) output.output = `${output.output ?? ""}\n\n${warnings}`;

      void autoCommit(vaultRoot, absolutePath, input.$);
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!vaultRoot) return;

      const sid = hookInput.sessionID;

      if (sid && runtime) {
        let frame = sessionFrames.get(sid);
        if (!frame) {
          frame = {
            sessionId: sid,
            actorId,
            startedAt: new Date().toISOString(),
            worktree: vaultRoot,
          };
          sessionFrames.set(sid, frame);
          // Persist frame to disk so it survives plugin reloads
          try {
            const framesDir = join(vaultRoot, "ops", "runtime", "active-sessions");
            if (!existsSync(framesDir)) mkdirSync(framesDir, { recursive: true });
            writeFileSync(join(framesDir, `${sid}.json`), JSON.stringify(frame), "utf-8");
          } catch {
            // Frame persistence is best-effort
          }
          try {
            await runtime.startSession(frame);
          } catch {
            // Best-effort session start
          }
        }

        const pendingIntent = pendingIntents.get(sid);
        const lastIntentId = lastProcessedIntentId.get(sid);
        const inferredOrientIntent = !lastIntentId
          ? createIntent(actorId, "session orient — ambient perception", "inferred")
          : null;
        const intentToProcess =
          pendingIntent && pendingIntent.id !== lastIntentId
            ? pendingIntent
            : inferredOrientIntent;

        if (intentToProcess) {
          try {
            const loopResult = await runtime.processIntent({
              session: frame,
              intent: intentToProcess,
              authority: "advisory" as ActionAuthority,
            });

            lastProcessedIntentId.set(sid, intentToProcess.id);
            if (pendingIntent?.id === intentToProcess.id) {
              pendingIntents.delete(sid);
            }

            const runtimeContext = buildSystemPrompt(loopResult);
            if (runtimeContext) {
              output.system = [runtimeContext, ...(output.system ?? [])];
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? (err.stack ?? "") : "";
            output.system = [
              `[intent-loop error: ${msg}]`,
              ...(output.system ?? []),
            ];
            // Write error to disk so failures are visible across sessions
            try {
              const runtimeDir = join(vaultRoot, "ops", "runtime");
              if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
              appendFileSync(
                join(runtimeDir, "intent-loop-errors.log"),
                `${new Date().toISOString()} sid=${sid ?? "unknown"}\n${msg}\n${stack}\n---\n`,
              );
            } catch {
              // Never block on logging
            }
          }
        }
      }

      // ─── Skill dispatch — unchanged from pre-runtime ──────────────────
      if (router && injector) {
        const activeSkill = router.getActive();
        if (activeSkill) {
          const rawArgs = router.getActiveArgs();
          router.clearActive();

          emitSkillInvoked(
            vaultRoot,
            { skillName: activeSkill, isOrchestrator: ORCHESTRATOR_SKILLS.has(activeSkill) },
            sid,
          );

          if (ORCHESTRATOR_SKILLS.has(activeSkill)) {
            let executionResult: string;
            let orchestratorSourcePath = "";
            let expectedOutputContract = "";
            try {
              orchestratorSourcePath = join(vaultRoot, "ops", "queue", "queue.json");
              expectedOutputContract = "Process pending queue tasks and persist phase/status transitions.";
              executionResult = await runRalph(
                vaultRoot,
                input.client,
                input.$,
                parseProcessArgs(rawArgs),
              );
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              executionResult = `Error running /${activeSkill}: ${errorMsg}`;

              // Queue repair for orchestrator skill failures
              void queueRepairTask(vaultRoot, `skill:${activeSkill}`, activeSkill, errorMsg, {
                sourcePath: orchestratorSourcePath,
                phase: "surface",
                commandOrSkill: `/${activeSkill}`,
                expectedOutputContract,
                lastStderr: errorMsg,
                stackTrace: err instanceof Error ? err.stack : undefined,
              });
            }
            output.system = [
              ...(output.system ?? []),
              `=== /${activeSkill} RESULT ===\n\n${executionResult}\n\n=== END RESULT ===\n\nPresent this result to the user. Summarize what happened in plain language.`,
            ];
          } else {
            const skillContent = await injector.load(activeSkill, vaultRoot);
            if (skillContent) {
              output.system = [...(output.system ?? []), skillContent];
            }
          }
        }
      }

    },

    "experimental.session.compacting": async (hookInput, output) => {
      if (!vaultRoot || !runtime) return;

      // Re-run the intent loop on compaction to keep context fresh
      const compactingSessionId = (hookInput as { sessionID?: string }).sessionID;
      const frame = compactingSessionId
        ? sessionFrames.get(compactingSessionId)
        : [...sessionFrames.values()].at(-1);
      if (!frame) return;

      try {
        const loopResult = await runtime.processIntent({
          session: frame,
          intent: {
            id: randomUUID(),
            actorId,
            statement: "context compaction — refresh awareness",
            source: "inferred",
            requestedAt: new Date().toISOString(),
          },
          authority: "advisory" as ActionAuthority,
        });

        const runtimeContext = buildSystemPrompt(loopResult);
        if (runtimeContext) {
          output.context = [runtimeContext, ...(output.context ?? [])];
        }
      } catch {
        // Best-effort — don't block compaction
      }
    },
  };
};

export { IntentComputer };
export default IntentComputer;
