/**
 * ralph.ts
 *
 * Queue orchestrator for pipeline tasks. Reads a normalized queue format,
 * runs phases in isolated forks, and advances phase/state after completion.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { basename, join } from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import type {
  PipelinePhase,
  PipelineTask,
} from "@intent-computer/architecture";
import {
  queuePath,
  readQueue,
  scanVaultGraph,
  writeQueue,
  withQueueLock,
} from "@intent-computer/architecture";
import { forkSkill } from "./fork.js";
import { loadSkillInstructions } from "./injector.js";

const PHASE_SKILL_MAP: Record<PipelinePhase, string> = {
  surface: "reduce",
  reflect: "reflect",
  revisit: "reweave",
  verify: "verify",
};

const PHASE_ORDER: PipelinePhase[] = ["surface", "reflect", "revisit", "verify"];

export interface RalphOptions {
  concurrency?: number;
  dryRun?: boolean;
  batchFilter?: string;
}

export async function runRalph(
  vaultRoot: string,
  client: PluginInput["client"],
  $: PluginInput["$"],
  options: RalphOptions = {},
): Promise<string> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 5));
  const queueFile = queuePath(vaultRoot);
  if (!existsSync(queueFile)) {
    return "Queue is empty — nothing to process. Run /seed [file] to queue source material.";
  }

  const batchStartMs = Date.now();
  const startIso = new Date(batchStartMs).toISOString();
  const lockUntil = new Date(batchStartMs + 5 * 60 * 1000).toISOString();

  const selection = await withQueueLock(vaultRoot, async () => {
    const queue = readQueue(vaultRoot);
    const pending = queue.tasks.filter((task) => {
      const status = task.status ?? "pending";
      if (status !== "pending") return false;
      if (options.batchFilter && task.batch !== options.batchFilter) return false;
      return true;
    });

    const selected = pending.slice(0, concurrency).map((task) => ({ ...task }));
    if (!options.dryRun) {
      for (const selectedTask of selected) {
        const task = queue.tasks.find((candidate) => candidate.taskId === selectedTask.taskId);
        if (!task) continue;
        task.status = "in-progress";
        task.lockedUntil = lockUntil;
        task.updatedAt = startIso;
      }
      queue.lastUpdated = startIso;
      writeQueue(vaultRoot, queue);
    }

    return {
      pendingCount: pending.length,
      selected,
    };
  });

  if (selection.pendingCount === 0) {
    return "No pending tasks in queue. Run /tasks to inspect queue state.";
  }

  if (options.dryRun) {
    const preview = selection.selected
      .map((task) => `  ${task.taskId} [${task.phase}] — "${task.target}"`)
      .join("\n");
    return `Dry run — would process ${Math.min(selection.pendingCount, concurrency)} of ${selection.pendingCount} tasks:\n${preview}`;
  }

  const batch = selection.selected;

  const taskResults = await Promise.all(
    batch.map(async (task) => {
      const result = await processTask(task, vaultRoot, client, $);
      return { taskId: task.taskId, phase: task.phase, ...result };
    }),
  );

  const lines: string[] = [];
  let successCount = 0;
  let failureCount = 0;
  const finalize = await withQueueLock(vaultRoot, async () => {
    const queue = readQueue(vaultRoot);
    let conflictCount = 0;

    for (const result of taskResults) {
      const task = queue.tasks.find((candidate) => candidate.taskId === result.taskId);
      if (!task) {
        conflictCount++;
        lines.push(`  SKIP ${result.taskId} [${result.phase}] — task disappeared before commit`);
        continue;
      }

      const taskUpdatedAt = task.updatedAt ?? "";
      if (taskUpdatedAt && taskUpdatedAt !== startIso) {
        conflictCount++;
        lines.push(`  SKIP ${task.taskId} [${result.phase}] — concurrently modified; preserving newer queue state`);
        continue;
      }

      task.lockedUntil = undefined;
      task.updatedAt = new Date().toISOString();
      task.attempts = (task.attempts ?? 0) + 1;

      if (result.success) {
        successCount++;
        const completed = new Set(task.completedPhases ?? []);
        completed.add(task.phase);
        task.completedPhases = [...completed];

        const next = nextPhase(task.phase);
        if (next) {
          task.phase = next;
          task.status = "pending";
        } else {
          task.status = "done";
        }
      } else {
        failureCount++;
        const maxAttempts = task.maxAttempts ?? 3;
        task.status = (task.attempts ?? 0) >= maxAttempts ? "failed" : "pending";
      }

      const status = result.success ? "OK" : "FAIL";
      const reason = result.error ? ` (${result.error})` : "";
      lines.push(`  ${status} ${task.taskId} [${result.phase}] — "${task.target}"${reason}`);
    }

    queue.lastUpdated = new Date().toISOString();
    writeQueue(vaultRoot, queue);

    return {
      remainingPending: queue.tasks.filter((task) => (task.status ?? "pending") === "pending").length,
      conflictCount,
    };
  });

  const remainingPending = finalize.remainingPending;
  const summary: string[] = [
    `Ralph processed ${batch.length} task(s): ${successCount} succeeded, ${failureCount} failed.`,
    "",
    ...lines,
  ];

  if (finalize.conflictCount > 0) {
    summary.push("", `${finalize.conflictCount} task update(s) were skipped due to concurrent queue writes.`);
  }

  if (remainingPending > 0) {
    summary.push("", `${remainingPending} task(s) remaining in queue. Run /process to continue.`);
  } else {
    summary.push("", "Queue has no pending tasks.");
  }

  const warnings = crossConnectValidation(vaultRoot, batchStartMs);
  if (warnings.length > 0) {
    summary.push("", "Cross-connect warnings:", ...warnings);
  }

  return summary.join("\n");
}

function nextPhase(current: PipelinePhase): PipelinePhase | null {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1) return null;
  return PHASE_ORDER[idx + 1] ?? null;
}

async function processTask(
  task: PipelineTask,
  vaultRoot: string,
  client: PluginInput["client"],
  $: PluginInput["$"],
): Promise<{ success: boolean; error?: string }> {
  const skill = PHASE_SKILL_MAP[task.phase];
  if (!skill) {
    return { success: false, error: `Unknown phase: ${task.phase}` };
  }

  const skillInstructions = await loadSkillInstructions(skill, vaultRoot);
  if (!skillInstructions) {
    return { success: false, error: `Skill not found: ${skill} (no SKILL.md)` };
  }

  const sourcePath = task.sourcePath.startsWith("/")
    ? task.sourcePath
    : join(vaultRoot, task.sourcePath);

  const taskContext = existsSync(sourcePath)
    ? readFileSync(sourcePath, "utf-8")
    : `Target: "${task.target}"\nTask ID: ${task.taskId}\nSource path not found: ${task.sourcePath}`;

  const result = await forkSkill(
    {
      skillName: skill,
      skillInstructions,
      taskContext,
      vaultRoot,
      timeoutMs: 300_000,
    },
    client,
    $,
  );

  return { success: result.success, error: result.error };
}

function crossConnectValidation(vaultRoot: string, batchStartMs: number): string[] {
  const warnings: string[] = [];
  const thoughtsDir = join(vaultRoot, "thoughts");
  if (!existsSync(thoughtsDir)) return warnings;

  const recentThoughts: string[] = [];
  try {
    for (const entry of readdirSync(thoughtsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const fullPath = join(thoughtsDir, entry.name);
      try {
        if (statSync(fullPath).mtimeMs > batchStartMs) {
          recentThoughts.push(fullPath);
        }
      } catch {
        // Skip malformed entries
      }
    }
  } catch {
    return warnings;
  }

  for (const thoughtPath of recentThoughts) {
    const content = safeRead(thoughtPath);
    if (!content) continue;
    const name = basename(thoughtPath, ".md");

    if (!/^topics:/m.test(content)) {
      warnings.push(`  WARN [[${name}]] missing topics field`);
    }
  }

  const recentSet = new Set(recentThoughts);
  const graph = scanVaultGraph(vaultRoot, {
    entityDirs: ["thoughts", "self"],
    excludeCodeBlocks: true,
  });
  for (const dangling of graph.danglingLinks) {
    if (!recentSet.has(dangling.sourcePath)) continue;
    const sourceName = basename(dangling.sourcePath, ".md");
    warnings.push(`  WARN [[${sourceName}]] -> [[${dangling.target}]] dangling link`);
  }

  return warnings;
}

function safeRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}
