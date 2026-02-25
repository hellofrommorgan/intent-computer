/**
 * test-runtime.ts
 *
 * Integration checks for runtime behavior:
 * - commitment feedback updates ops/commitments.json
 * - advisory-only outcomes do not advance commitments
 * - heartbeat queue-first execution path (including dry-run and cap)
 * - threshold queue-only behavior and config-driven conditions
 * - MCP queue migration writes canonical queue schema
 * - execution adapter dispatches real handlers when policy allows
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { LocalCommitmentAdapter } from "../packages/plugin/src/adapters/local-commitment.js";
import { runHeartbeat } from "../packages/heartbeat/src/heartbeat.js";
import { LocalMcpAdapter } from "../packages/mcp-server/src/local-adapter.js";
import { LocalExecutionAdapter } from "../packages/plugin/src/adapters/local-execution.js";
import {
  emitActionExecuted,
  emitActionProposed,
  emitSessionEnded,
  emitSessionStarted,
  emitSignalFired,
  readQueue,
  telemetryPath,
  withQueueLock,
  writeQueue,
} from "../packages/architecture/src/index.js";
import { analyze, readTelemetry } from "./controller.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function createTempVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "intent-computer-runtime-"));
  mkdirSync(join(vault, "ops", "queue"), { recursive: true });
  mkdirSync(join(vault, "inbox"), { recursive: true });
  mkdirSync(join(vault, "thoughts"), { recursive: true });
  return vault;
}

function withFakeClaudeScript(scriptBody: string): { restore: () => void; captureDir: string } {
  const runtimeDir = mkdtempSync(join(tmpdir(), "intent-computer-runtime-claude-"));
  const binDir = join(runtimeDir, "bin");
  const captureDir = join(runtimeDir, "captures");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });

  const scriptPath = join(binDir, "claude");
  writeFileSync(scriptPath, scriptBody, "utf-8");
  chmodSync(scriptPath, 0o755);

  const previousPath = process.env.PATH ?? "";
  const previousCapture = process.env.CAPTURE_DIR;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.CAPTURE_DIR = captureDir;

  return {
    captureDir,
    restore: () => {
      process.env.PATH = previousPath;
      if (previousCapture === undefined) {
        delete process.env.CAPTURE_DIR;
      } else {
        process.env.CAPTURE_DIR = previousCapture;
      }
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

function writeActiveCommitment(
  vault: string,
  label: string,
  options: { desireClass?: "thick" | "thin" | "unknown"; frictionClass?: "constitutive" | "incidental" | "unknown" } = {},
): void {
  const now = new Date().toISOString();
  writeFileSync(
    join(vault, "ops", "commitments.json"),
    JSON.stringify(
      {
        version: 1,
        commitments: [
          {
            id: "c1",
            label,
            state: "active",
            priority: 1,
            horizon: "week",
            desireClass: options.desireClass ?? "unknown",
            frictionClass: options.frictionClass ?? "unknown",
            source: "test",
            lastAdvancedAt: now,
            evidence: [],
          },
        ],
        lastEvaluatedAt: now,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function readHeartbeatTelemetryEnd(vault: string): Record<string, unknown> | null {
  const filePath = telemetryPath(vault);
  if (!existsSync(filePath)) return null;
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i] ?? "") as { type?: string; data?: { phase?: string } };
      if (parsed.type === "heartbeat_run" && parsed.data?.phase === "end") {
        return parsed.data as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed telemetry lines in tests.
    }
  }

  return null;
}

async function testCommitmentFeedbackLoop(): Promise<void> {
  const vault = createTempVault();
  try {
    const now = new Date().toISOString();
    writeFileSync(
      join(vault, "ops", "commitments.json"),
      JSON.stringify(
        {
          version: 1,
          commitments: [
            {
              id: "c1",
              label: "Vector reliability",
              state: "active",
              priority: 1,
              horizon: "week",
              source: "test",
              lastAdvancedAt: "2020-01-01T00:00:00.000Z",
              evidence: [],
            },
          ],
          lastEvaluatedAt: now,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const adapter = new LocalCommitmentAdapter(vault);
    await adapter.recordOutcome?.({
      session: {
        sessionId: "s1",
        actorId: "test-user",
        startedAt: now,
        worktree: vault,
      },
      intent: {
        id: "i1",
        actorId: "test-user",
        statement: "Improve vector reliability",
        source: "explicit",
        requestedAt: now,
      },
      commitment: {
        intentId: "i1",
        activeCommitments: [
          {
            id: "c1",
            label: "Vector reliability",
            state: "active",
            priority: 1,
            horizon: "week",
          },
        ],
        protectedGaps: [],
        compressedGaps: [],
        rationale: "",
        updatedAt: now,
      },
      plan: {
        intentId: "i1",
        authority: "advisory",
        actions: [
          {
            id: "a1",
            label: "Advance: Vector reliability",
            reason: "focus thread",
            authorityNeeded: "advisory",
            requiresPermission: false,
            priority: 1,
            actionKey: "advance_commitment",
            payload: { commitmentId: "c1" },
          },
        ],
        generatedAt: now,
      },
      outcome: {
        intentId: "i1",
        executedAt: now,
        completed: true,
        results: [
          {
            actionId: "a1",
            success: true,
            executed: true,
            detail: "advanced",
          },
        ],
      },
    });

    const updated = JSON.parse(readFileSync(join(vault, "ops", "commitments.json"), "utf-8"));
    const commitment = updated.commitments.find(
      (entry: { id: string; label: string }) => entry.label.toLowerCase() === "vector reliability",
    );
    assert(commitment !== undefined, "commitment should still exist");
    assert(
      commitment.lastAdvancedAt !== "2020-01-01T00:00:00.000Z",
      "lastAdvancedAt should be refreshed after successful outcome",
    );
    assert(
      Array.isArray(commitment.evidence) && commitment.evidence.length === 1,
      "commitment evidence should include new runtime entry",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testCommitmentIgnoresAdvisoryOutcomes(): Promise<void> {
  const vault = createTempVault();
  try {
    const original = "2020-01-01T00:00:00.000Z";
    const now = new Date().toISOString();
    writeFileSync(
      join(vault, "ops", "commitments.json"),
      JSON.stringify(
        {
          version: 1,
          commitments: [
            {
              id: "c1",
              label: "Vector reliability",
              state: "active",
              priority: 1,
              horizon: "week",
              source: "test",
              lastAdvancedAt: original,
              evidence: [],
            },
          ],
          lastEvaluatedAt: now,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const adapter = new LocalCommitmentAdapter(vault);
    await adapter.recordOutcome?.({
      session: {
        sessionId: "s1",
        actorId: "test-user",
        startedAt: now,
        worktree: vault,
      },
      intent: {
        id: "i1",
        actorId: "test-user",
        statement: "Improve vector reliability",
        source: "explicit",
        requestedAt: now,
      },
      commitment: {
        intentId: "i1",
        activeCommitments: [
          {
            id: "c1",
            label: "Vector reliability",
            state: "active",
            priority: 1,
            horizon: "week",
          },
        ],
        protectedGaps: [],
        compressedGaps: [],
        rationale: "",
        updatedAt: now,
      },
      plan: {
        intentId: "i1",
        authority: "advisory",
        actions: [
          {
            id: "a1",
            label: "Advance: Vector reliability",
            reason: "focus thread",
            authorityNeeded: "advisory",
            requiresPermission: false,
            priority: 1,
            actionKey: "advance_commitment",
            payload: { commitmentId: "c1" },
          },
        ],
        generatedAt: now,
      },
      outcome: {
        intentId: "i1",
        executedAt: now,
        completed: true,
        results: [
          {
            actionId: "a1",
            success: true,
            executed: false,
            detail: "Suggest: Advance vector reliability",
          },
        ],
      },
    });

    const updated = JSON.parse(readFileSync(join(vault, "ops", "commitments.json"), "utf-8"));
    const commitment = updated.commitments.find(
      (entry: { id: string; label: string }) => entry.label.toLowerCase() === "vector reliability",
    );
    assert(commitment !== undefined, "commitment should still exist");
    assert(commitment.lastAdvancedAt === original, "advisory outcomes must not advance commitment timestamps");
    assert(Array.isArray(commitment.evidence) && commitment.evidence.length === 0, "advisory outcomes must not append evidence");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatAlignedExecutionDryRun(): Promise<void> {
  const vault = createTempVault();
  try {
    const now = new Date().toISOString();
    writeFileSync(
      join(vault, "ops", "commitments.json"),
      JSON.stringify(
        {
          version: 1,
          commitments: [
            {
              id: "c1",
              label: "vector",
              state: "active",
              priority: 1,
              horizon: "week",
              source: "test",
              lastAdvancedAt: now,
              evidence: [],
            },
          ],
          lastEvaluatedAt: now,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          schema_version: 3,
          tasks: [
            {
              id: "legacy-1",
              target: "vector warmup",
              source: "inbox/vector.md",
              type: "create",
              status: "pending",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await runHeartbeat(vault, {
      executeAlignedTasks: true,
      dryRun: true,
      maxTriggeredTasks: 1,
    });
    assert(result.alignedTasks.length === 1, "heartbeat should find one aligned task");
    assert(result.triggered.length === 1, "heartbeat dry-run should list one trigger");
    assert(
      result.triggered[0]?.detail.includes("dry-run"),
      "trigger detail should indicate dry-run",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatQueueFirstExecutionWithoutAlignment(): Promise<void> {
  const vault = createTempVault();
  try {
    writeActiveCommitment(vault, "different-label");
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: new Date().toISOString(),
          tasks: [
            {
              taskId: "q1",
              vaultId: vault,
              target: "unrelated-target",
              sourcePath: join(vault, "inbox", "source.md"),
              phase: "surface",
              status: "pending",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(vault, "inbox", "source.md"), "source", "utf-8");

    let called = 0;
    const result = await runHeartbeat(vault, {
      phases: ["5b"],
      maxActionsPerRun: 3,
      taskSelection: "queue-first",
      taskRunner: () => {
        called += 1;
        return {
          taskId: "q1",
          phase: "surface",
          success: true,
          executed: true,
          detail: "ok",
        };
      },
    });

    assert(called === 1, "queue-first should execute pending queue work even when not commitment-aligned");
    assert(result.triggered.length === 1, "queue-first run should report one triggered task");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatThinDesireTasksAreDeferred(): Promise<void> {
  const vault = createTempVault();
  try {
    writeActiveCommitment(vault, "thin-thread", { desireClass: "thin" });
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: new Date().toISOString(),
          tasks: [
            {
              taskId: "thin-1",
              vaultId: vault,
              target: "thin-thread follow-up",
              sourcePath: join(vault, "inbox", "thin.md"),
              phase: "surface",
              status: "pending",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(vault, "inbox", "thin.md"), "thin", "utf-8");

    let calls = 0;
    const result = await runHeartbeat(vault, {
      phases: ["5b"],
      taskSelection: "queue-first",
      maxActionsPerRun: 3,
      taskRunner: () => {
        calls += 1;
        return {
          taskId: "thin-1",
          phase: "surface",
          success: true,
          executed: true,
          detail: "should-not-run",
        };
      },
    });

    assert(calls === 0, "thin-only aligned tasks should be deferred, not executed");
    assert(result.executedActions === 0, "thin-only deferrals should not increment executed actions");
    assert(result.advisoryActions >= 1, "thin-only deferrals should increment advisory actions");
    assert(result.thinDeferredActions >= 1, "thin-only deferrals should increment thin deferred counters");
    assert(
      result.triggered.some((entry) => entry.deferralReason === "thin-desire"),
      "triggered results should include thin-desire deferral reason",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatMaxActionsCap(): Promise<void> {
  const vault = createTempVault();
  try {
    writeActiveCommitment(vault, "anything");
    const tasks = Array.from({ length: 5 }, (_, idx) => ({
      taskId: `task-${idx + 1}`,
      vaultId: vault,
      target: `target-${idx + 1}`,
      sourcePath: join(vault, "inbox", `source-${idx + 1}.md`),
      phase: "surface" as const,
      status: "pending" as const,
      createdAt: new Date(Date.now() - (idx + 1) * 1000).toISOString(),
      updatedAt: new Date(Date.now() - (idx + 1) * 1000).toISOString(),
    }));
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: new Date().toISOString(),
          tasks,
        },
        null,
        2,
      ),
      "utf-8",
    );

    let calls = 0;
    await runHeartbeat(vault, {
      phases: ["5b"],
      maxActionsPerRun: 3,
      taskRunner: (task) => {
        calls += 1;
        return {
          taskId: task.taskId,
          phase: task.phase,
          success: true,
          executed: true,
          detail: "ok",
        };
      },
    });

    assert(calls === 3, "heartbeat must enforce maxActionsPerRun cap");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatThresholdQueueOnlyMode(): Promise<void> {
  const vault = createTempVault();
  try {
    writeFileSync(join(vault, "inbox", "one.md"), "one", "utf-8");
    writeFileSync(join(vault, "inbox", "two.md"), "two", "utf-8");
    writeFileSync(join(vault, "inbox", "three.md"), "three", "utf-8");
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify({ version: 1, lastUpdated: new Date().toISOString(), tasks: [] }, null, 2),
      "utf-8",
    );

    const result = await runHeartbeat(vault, {
      phases: ["5c"],
      thresholdMode: "queue-only",
    });

    const queue = readQueue(vault);
    assert(
      queue.tasks.some((task) => task.target === "inbox-pressure"),
      "threshold queue-only mode should enqueue inbox pressure task instead of executing directly",
    );
    assert(result.advisoryActions >= 1, "queue-only threshold handling should be counted as advisory");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatTelemetrySuccessMathTracksExecutedOnly(): Promise<void> {
  const vault = createTempVault();
  try {
    writeActiveCommitment(vault, "thin-thread", { desireClass: "thin" });
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: new Date().toISOString(),
          tasks: [
            {
              taskId: "thin-telemetry",
              vaultId: vault,
              target: "thin-thread telemetry",
              sourcePath: join(vault, "inbox", "thin-telemetry.md"),
              phase: "surface",
              status: "pending",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(vault, "inbox", "thin-telemetry.md"), "thin", "utf-8");

    await runHeartbeat(vault, {
      phases: ["5b"],
      taskSelection: "queue-first",
      maxActionsPerRun: 1,
    });

    const endTelemetry = readHeartbeatTelemetryEnd(vault);
    assert(endTelemetry !== null, "heartbeat end telemetry should be emitted");
    assert(
      endTelemetry?.tasksSucceeded === 0,
      "heartbeat tasksSucceeded must count executed successes only",
    );
    assert(
      endTelemetry?.tasksFailed === 0,
      "heartbeat tasksFailed must count executed failures only",
    );
    assert(
      Number(endTelemetry?.advisoryActions ?? 0) >= 1,
      "heartbeat telemetry should preserve advisory action counts",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatUsesConfigThresholdsAndMineableSessions(): Promise<void> {
  const vault = createTempVault();
  try {
    mkdirSync(join(vault, "ops", "sessions"), { recursive: true });
    writeFileSync(
      join(vault, "ops", "config.yaml"),
      [
        "maintenance:",
        "  conditions:",
        "    inbox_threshold: 1",
        "    unprocessed_sessions: 1",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(vault, "inbox", "item.md"), "inbox", "utf-8");
    writeFileSync(
      join(vault, "ops", "sessions", "stub.json"),
      JSON.stringify({ session_id: "s1", timestamp: new Date().toISOString(), status: "no-content", mined: false }),
      "utf-8",
    );

    const result = await runHeartbeat(vault, { phases: ["5a"] });
    const inbox = result.conditions.find((condition) => condition.key === "inbox");
    const sessions = result.conditions.find((condition) => condition.key === "sessions");
    assert(inbox?.threshold === 1, "inbox threshold should be read from ops/config.yaml");
    assert(inbox?.exceeded === true, "inbox threshold from config should apply");
    assert(sessions?.count === 0, "metadata-only session stubs should not count as mineable backlog");
    assert(sessions?.exceeded === false, "non-mineable stubs should not breach session condition");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatMorningBriefSlotPolicy(): Promise<void> {
  const vault = createTempVault();
  try {
    const briefPath = join(vault, "ops", "morning-brief.md");
    await runHeartbeat(vault, {
      phases: ["6"],
      runSlot: "evening",
    });
    assert(!existsSync(briefPath), "evening slot should not generate morning brief");

    await runHeartbeat(vault, {
      phases: ["6"],
      runSlot: "morning",
    });
    assert(existsSync(briefPath), "morning slot should generate morning brief");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatQueuesRichRepairContext(): Promise<void> {
  const vault = createTempVault();
  try {
    writeActiveCommitment(vault, "repair");
    const sourcePath = join(vault, "inbox", "repair-source.md");
    writeFileSync(sourcePath, "---\ndescription: repair test\ntopics: [[ops]]\n---\nbody\n", "utf-8");
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: new Date().toISOString(),
          tasks: [
            {
              taskId: "task-1",
              vaultId: vault,
              target: "repair-target",
              sourcePath,
              phase: "surface",
              status: "pending",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await runHeartbeat(vault, {
      phases: ["5b"],
      executeAlignedTasks: true,
      maxTriggeredTasks: 1,
      taskRunner: () => ({
        taskId: "task-1",
        phase: "surface",
        success: false,
        executed: true,
        detail: "simulated failure",
      }),
    });
    assert(result.triggered.length === 1, "failed queue task should be reported in heartbeat results");
    assert(result.triggered[0]?.executed === true, "failed queue task should still be marked executed");
    assert(result.triggered[0]?.success === false, "failed queue task should never be reported as success");

    const queue = JSON.parse(readFileSync(join(vault, "ops", "queue", "queue.json"), "utf-8"));
    const repair = queue.tasks.find((task: { repair_context?: unknown }) => !!task.repair_context) as {
      repair_context?: {
        absolute_source_path?: string;
        queue_excerpt?: string;
        file_state?: Record<string, string>;
        relevant_file_diffs?: Array<{ path: string; diff: string }>;
      };
    };
    assert(repair?.repair_context !== undefined, "heartbeat should queue a repair task with repair_context");
    assert(
      typeof repair.repair_context?.absolute_source_path === "string" &&
        repair.repair_context.absolute_source_path.length > 0,
      "repair context should include absolute source path",
    );
    assert(
      typeof repair.repair_context?.queue_excerpt === "string" &&
        repair.repair_context.queue_excerpt.includes("Total tasks"),
      "repair context should include queue excerpt",
    );
    assert(
      repair.repair_context?.file_state &&
        Object.keys(repair.repair_context.file_state).length > 0,
      "repair context should include file snapshot",
    );
    assert(
      Array.isArray(repair.repair_context?.relevant_file_diffs),
      "repair context should include relevant_file_diffs array",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatRepairPromptStructure(): Promise<void> {
  const vault = createTempVault();
  const { restore, captureDir } = withFakeClaudeScript(
    `#!/bin/sh
last=""
for arg in "$@"; do
  last="$arg"
done
out="$CAPTURE_DIR/prompt-$(date +%s%N).txt"
printf '%s\n' "$last" > "$out"
echo "ok"
`,
  );

  try {
    writeActiveCommitment(vault, "repair");
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: new Date().toISOString(),
          tasks: [
            {
              taskId: "repair-1",
              vaultId: vault,
              target: "repair-task",
              sourcePath: join(vault, "inbox", "repair.md"),
              phase: "surface",
              status: "pending",
              repair_context: {
                original_task: { kind: "reduce", target: "repair-task" },
                error_message: "bad frontmatter",
                attempted_at: new Date().toISOString(),
                attempt_count: 1,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(vault, "inbox", "repair.md"), "---\ndescription: x\n---\n", "utf-8");

    await runHeartbeat(vault, {
      phases: ["5b"],
      executeAlignedTasks: true,
      maxTriggeredTasks: 1,
      repairMode: "execute",
      dryRun: false,
    });

    const captures = readdirSync(captureDir).filter((name) => name.endsWith(".txt"));
    assert(captures.length > 0, "repair execution should capture at least one Claude prompt");
    const latest = captures.sort().at(-1);
    assert(latest !== undefined, "captured prompt file should exist");
    const prompt = readFileSync(join(captureDir, latest!), "utf-8");
    assert(
      prompt.includes("=== FAILURE SUMMARY ==="),
      "repair prompt should include structured failure summary section",
    );
    assert(
      prompt.includes("=== QUEUE EXCERPT ==="),
      "repair prompt should include structured queue excerpt section",
    );
    assert(
      prompt.includes("=== REPAIR TASK ==="),
      "repair prompt should include structured repair task section",
    );
  } finally {
    restore();
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHeartbeatPreservesConcurrentQueueWrites(): Promise<void> {
  const vault = createTempVault();
  const { restore } = withFakeClaudeScript(
    `#!/bin/sh
sleep 2
echo "ok"
`,
  );

  try {
    writeActiveCommitment(vault, "repair");
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: new Date().toISOString(),
          tasks: [
            {
              taskId: "repair-1",
              vaultId: vault,
              target: "repair-task",
              sourcePath: join(vault, "inbox", "repair.md"),
              phase: "surface",
              status: "pending",
              repair_context: {
                original_task: { kind: "reduce", target: "repair-task" },
                error_message: "failing task",
                attempted_at: new Date().toISOString(),
                attempt_count: 1,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(vault, "inbox", "repair.md"), "repair", "utf-8");

    const childScript = `
      import { runHeartbeat } from "./packages/heartbeat/src/heartbeat.ts";
      await runHeartbeat(${JSON.stringify(vault)}, {
        phases: ["5b"],
        executeAlignedTasks: true,
        maxTriggeredTasks: 1,
        repairMode: "execute",
        dryRun: false,
      });
    `;
    const child = spawn("pnpm", ["-s", "tsx"], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(childScript);
    child.stdin.end();

    await new Promise((resolve) => setTimeout(resolve, 400));
    await withQueueLock(vault, async () => {
      const queue = readQueue(vault);
      queue.tasks.push({
        taskId: "external-addition",
        vaultId: vault,
        target: "concurrent-task",
        sourcePath: join(vault, "inbox", "external.md"),
        phase: "surface",
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      queue.lastUpdated = new Date().toISOString();
      writeQueue(vault, queue);
    });

    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`heartbeat child exited with ${code}`));
      });
    });

    const finalQueue = JSON.parse(readFileSync(join(vault, "ops", "queue", "queue.json"), "utf-8"));
    const targets = finalQueue.tasks.map((task: { target: string }) => task.target);
    assert(
      targets.includes("concurrent-task"),
      "heartbeat should preserve queue tasks added concurrently by other writers",
    );
  } finally {
    restore();
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testMcpQueueMigration(): Promise<void> {
  const vault = createTempVault();
  try {
    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          schema_version: 3,
          tasks: [
            {
              id: "legacy-task-1",
              target: "legacy task",
              source: "inbox/legacy.md",
              current_phase: "reflect",
              status: "pending",
              batch: "legacy",
              file: "legacy.md",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const adapter = new LocalMcpAdapter(vault);
    await adapter.queuePush({
      vaultId: "local",
      target: "new queue task",
      sourcePath: "inbox/new.md",
      phase: "surface",
    });

    const queueRaw = JSON.parse(readFileSync(join(vault, "ops", "queue", "queue.json"), "utf-8"));
    assert(queueRaw.version === 1, "queue should be migrated to canonical version 1");
    assert(Array.isArray(queueRaw.tasks), "queue tasks should be an array");
    assert(
      queueRaw.tasks.every((task: { taskId?: string }) => typeof task.taskId === "string"),
      "all queue tasks should have canonical taskId fields",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testCommitmentIdMigrationScript(): Promise<void> {
  const vault = createTempVault();
  try {
    const now = new Date().toISOString();
    writeFileSync(
      join(vault, "ops", "commitments.json"),
      JSON.stringify(
        {
          version: 1,
          commitments: [
            {
              id: "goal-thread-1",
              label: "Alpha Thread",
              state: "active",
              priority: 1,
              horizon: "week",
              source: "test",
              lastAdvancedAt: now,
              evidence: [],
            },
            {
              id: "goal-thread-1",
              label: "Alpha Thread",
              state: "active",
              priority: 2,
              horizon: "week",
              source: "test",
              lastAdvancedAt: now,
              evidence: [],
            },
          ],
          lastEvaluatedAt: now,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const first = spawnSync(
      "pnpm",
      ["-s", "tsx", "scripts/migrate-commitment-ids.ts", "--vault", vault],
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    assert(first.status === 0, `migration script should succeed: ${first.stderr || first.stdout}`);

    const migrated = JSON.parse(readFileSync(join(vault, "ops", "commitments.json"), "utf-8")) as {
      commitments: Array<{ id: string }>;
    };
    const ids = migrated.commitments.map((entry) => entry.id);
    assert(new Set(ids).size === ids.length, "migration should produce unique commitment IDs");

    const second = spawnSync(
      "pnpm",
      ["-s", "tsx", "scripts/migrate-commitment-ids.ts", "--vault", vault],
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    assert(second.status === 0, `second migration run should succeed: ${second.stderr || second.stdout}`);
    assert(
      second.stdout.includes("no changes required"),
      "second migration run should be idempotent",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testExecutionDispatch(): Promise<void> {
  const vault = createTempVault();
  try {
    let processQueueCalled = false;
    const adapter = new LocalExecutionAdapter(vault, {
      dispatch: {
        processQueue: async () => {
          processQueueCalled = true;
          return "queue processed";
        },
      },
    });

    const now = new Date().toISOString();
    const plan = await adapter.propose({
      session: {
        sessionId: "s1",
        actorId: "test-user",
        startedAt: now,
        worktree: vault,
      },
      intent: {
        id: "i1",
        actorId: "test-user",
        statement: "process queue",
        source: "explicit",
        requestedAt: now,
      },
      identity: {
        actorId: "test-user",
        selfModel: "",
        umwelt: [],
        priorities: [],
        commitments: [],
        updatedAt: now,
      },
      commitment: {
        intentId: "i1",
        activeCommitments: [],
        protectedGaps: [],
        compressedGaps: [],
        rationale: "",
        updatedAt: now,
      },
      memory: {
        vaultId: vault,
        propositions: [],
        links: [],
        queueDepth: 1,
        loadedAt: now,
      },
    });

    const outcome = await adapter.execute({
      session: {
        sessionId: "s1",
        actorId: "test-user",
        startedAt: now,
        worktree: vault,
      },
      intent: {
        id: "i1",
        actorId: "test-user",
        statement: "process queue",
        source: "explicit",
        requestedAt: now,
      },
      plan,
    });

    assert(processQueueCalled, "execution adapter should call dispatch.processQueue");
    assert(outcome.results.length > 0, "execution should produce action results");
    assert(
      outcome.results.some((result) => result.detail.includes("queue processed")),
      "execution result should include dispatcher output",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testExecutionDispatchFailureTruth(): Promise<void> {
  const vault = createTempVault();
  try {
    const adapter = new LocalExecutionAdapter(vault, {
      dispatch: {
        processQueue: async () => {
          throw new Error("queue dispatch failed");
        },
      },
    });

    const now = new Date().toISOString();
    const plan = await adapter.propose({
      session: {
        sessionId: "s1",
        actorId: "test-user",
        startedAt: now,
        worktree: vault,
      },
      intent: {
        id: "i1",
        actorId: "test-user",
        statement: "process queue",
        source: "explicit",
        requestedAt: now,
      },
      identity: {
        actorId: "test-user",
        selfModel: "",
        umwelt: [],
        priorities: [],
        commitments: [],
        updatedAt: now,
      },
      commitment: {
        intentId: "i1",
        activeCommitments: [],
        protectedGaps: [],
        compressedGaps: [],
        rationale: "",
        updatedAt: now,
      },
      memory: {
        vaultId: vault,
        propositions: [],
        links: [],
        queueDepth: 1,
        loadedAt: now,
      },
    });

    const outcome = await adapter.execute({
      session: {
        sessionId: "s1",
        actorId: "test-user",
        startedAt: now,
        worktree: vault,
      },
      intent: {
        id: "i1",
        actorId: "test-user",
        statement: "process queue",
        source: "explicit",
        requestedAt: now,
      },
      plan,
    });

    const failed = outcome.results.find((result) => result.actionKey === "process_queue");
    assert(failed !== undefined, "dispatch failure should produce process_queue result");
    assert(failed?.executed === true, "dispatch failure should still mark action as executed");
    assert(failed?.success === false, "dispatch failure should report success=false");
    assert(outcome.completed === false, "dispatch failure should mark outcome as incomplete");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testTelemetryCorrelationChain(): Promise<void> {
  const vault = createTempVault();
  try {
    const since = new Date(Date.now() - 60_000);
    const sessionId = "session-correlation-1";

    emitSessionStarted(vault, sessionId, { actorId: "test-user", worktree: vault });
    emitSignalFired(vault, sessionId, {
      signalId: "sig-inbox-pressure",
      channel: "perception",
      summary: "Inbox threshold exceeded",
      confidence: "high",
    });
    emitActionProposed(vault, sessionId, {
      actionId: "action-1",
      label: "Process inbox items through pipeline",
      actionKey: "process_inbox",
      authorityNeeded: "delegated",
      priority: 1,
    });
    emitActionExecuted(vault, sessionId, {
      actionId: "action-1",
      success: true,
      actionKey: "process_inbox",
      detail: "processed 3 inbox notes",
    });
    emitSessionEnded(vault, sessionId, { actorId: "test-user", lastCycleId: "cycle-1" });

    const events = readTelemetry(vault, since);
    const analysis = analyze(events);

    assert(analysis.sessions.totalSessions === 1, "controller should count the started session");
    const signalStats = analysis.signals["sig-inbox-pressure"];
    assert(signalStats?.fired === 1, "controller should preserve signalId from signal_fired event");
    assert(signalStats?.ledToAction === 1, "controller should correlate signal to action_proposed in-session");
    assert(signalStats?.actionExecuted === 1, "controller should correlate signal to action_executed in-session");
    assert(
      analysis.sessions.sessionStartSignals["sig-inbox-pressure"] === 1,
      "controller should preserve session-start signal correlation by signalId",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function main() {
  await testCommitmentFeedbackLoop();
  await testCommitmentIgnoresAdvisoryOutcomes();
  await testHeartbeatAlignedExecutionDryRun();
  await testHeartbeatQueueFirstExecutionWithoutAlignment();
  await testHeartbeatThinDesireTasksAreDeferred();
  await testHeartbeatMaxActionsCap();
  await testHeartbeatThresholdQueueOnlyMode();
  await testHeartbeatTelemetrySuccessMathTracksExecutedOnly();
  await testHeartbeatUsesConfigThresholdsAndMineableSessions();
  await testHeartbeatMorningBriefSlotPolicy();
  await testHeartbeatQueuesRichRepairContext();
  await testHeartbeatRepairPromptStructure();
  await testHeartbeatPreservesConcurrentQueueWrites();
  await testMcpQueueMigration();
  await testCommitmentIdMigrationScript();
  await testExecutionDispatch();
  await testExecutionDispatchFailureTruth();
  await testTelemetryCorrelationChain();
  console.log("Runtime integration checks passed: 18/18");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
