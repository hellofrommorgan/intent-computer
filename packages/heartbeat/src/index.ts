#!/usr/bin/env node
/**
 * @intent-computer/heartbeat
 *
 * Commitment-driven autonomy engine. Runs on a schedule (launchd),
 * reads commitment state from ops/commitments.json, and writes
 * morning-brief.md with vault state, commitment evaluations, and
 * actionable recommendations.
 *
 * Usage:
 *   node dist/index.js [--vault <path>] [--phases <phase-list>]
 *                      [--dry-run] [--task-selection <queue-first|aligned-first>]
 *                      [--max-actions <n>] [--repair-mode <queue-only|execute>]
 *                      [--threshold-mode <queue-only|execute>] [--runner-cmd "<command>"]
 *                      [--runner-timeout <ms>] [--config <path>]
 *                      [--slot <morning|evening|manual>]
 *
 * Schedule management:
 *   node dist/index.js --install-schedule [--vault <path>]
 *   node dist/index.js --uninstall-schedule
 *   node dist/index.js --schedule-status
 *
 * Options:
 *   --vault <path>         Vault root (default: ~/Mind)
 *   --phases <list>        Comma-separated phases to run (e.g. "5a,7"). Default: all
 *   --install-schedule     Install morning/evening launchd plists
 *   --uninstall-schedule   Remove launchd plists
 *   --schedule-status      Check if plists are installed and loaded
 *   --execute-aligned      Backward-compatible alias (execution defaults on)
 *   --dry-run              Preview queue execution without mutating queue state
 *   --task-selection       queue-first (default) or aligned-first
 *   --max-actions          Max queue tasks to execute per run (default: 3)
 *   --repair-mode          queue-only (default) or execute
 *   --threshold-mode       queue-only (default) or execute
 *   --runner-cmd           Shell command used for each triggered task
 *   --runner-timeout       Runner timeout in milliseconds (default: 1800000)
 *   --config               Optional path to ops/config.yaml
 *   --slot                 Run slot context for phase 6 policy (default: manual)
 */

import { join } from "path";
import { runHeartbeat, findAlignedTasks } from "./heartbeat.js";
import type { HeartbeatPhase } from "./heartbeat.js";
import type {
  HeartbeatRunSlot,
  HeartbeatRepairMode,
  HeartbeatTaskSelection,
  HeartbeatThresholdMode,
} from "./heartbeat.js";
import { installSchedule, uninstallSchedule, getScheduleStatus } from "./scheduler.js";

export { runHeartbeat, findAlignedTasks, recordStateTransition, recordAdvancementSignal } from "./heartbeat.js";
export type { HeartbeatPhase, HeartbeatOptions, HeartbeatResult, StoredCommitment, CommitmentStore } from "./heartbeat.js";
export { scoreTaskRelevance, filterAndReorderTasks } from "./commitment-filter.js";
export type { TaskRelevanceScore, FilterOptions, FilterResult, DeferredTask } from "./commitment-filter.js";
export { evaluateCommitmentAdvancement, buildRecentActivity } from "./commitment-evaluator.js";
export type { RecentActivity, CommitmentEvaluationResult } from "./commitment-evaluator.js";
export { detectDrift } from "./drift-detector.js";
export type { DriftReport, CommitmentDrift, PriorityInversion } from "./drift-detector.js";
export { installSchedule, uninstallSchedule, getScheduleStatus } from "./scheduler.js";
export type { ScheduleStatus, ScheduleJobStatus } from "./scheduler.js";
export * from "./runner.js";
export { pollXFeeds, extractCommitmentKeywords, createXFeedSource } from "./x-feed.js";
export type { XFeedOptions, XFeedSource, XFeedResult, CapturedTweet } from "./x-feed.js";
export { runPerceptionPhase, buildPerceptionContext } from "./perception-runtime.js";
export type { FeedSource } from "./perception-runtime.js";
export { applyAdmissionPolicy, scoreIdentityRelevance, trackNoiseRate, DEFAULT_ADMISSION_POLICY } from "./admission-policy.js";
export { readCursors, writeCursors, getCursor, updateCursor, pruneCursor } from "./cursor-store.js";
export {
  evaluateTriggers,
  recordAndChain,
  loadCapsuleManifest,
  loadTriggerState,
  saveTriggerState,
  matchesCron,
  parseTrigger,
} from "./capsule-trigger.js";
export type {
  CapsuleSkill,
  CapsuleManifest,
  DueSkill,
  TriggerState,
  ParsedTrigger,
  TriggerKind,
} from "./capsule-trigger.js";
export { runCapsuleSkills } from "./capsule-runner.js";
export type { CapsuleExecutionResult, CapsuleRunResult } from "./capsule-runner.js";
export type {
  Commitment,
  CommitmentState,
  PipelineTask,
  StateTransition,
  AdvancementSignal,
  DriftSnapshot,
  OutcomePattern,
} from "@intent-computer/architecture";

// ─── Phase parsing ───────────────────────────────────────────────────────────

const VALID_PHASES: HeartbeatPhase[] = ["4a", "5a", "5b", "5c", "6", "7"];

function parsePhases(raw: string): HeartbeatPhase[] | undefined {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;

  const valid: HeartbeatPhase[] = [];
  for (const p of parts) {
    if (VALID_PHASES.includes(p as HeartbeatPhase)) {
      valid.push(p as HeartbeatPhase);
    } else {
      console.error(`unknown phase: "${p}" (valid: ${VALID_PHASES.join(", ")})`);
      process.exit(1);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let vault = join(process.env.HOME ?? "/tmp", "Mind");
  let doInstallSchedule = false;
  let doUninstallSchedule = false;
  let doScheduleStatus = false;
  let phases: HeartbeatPhase[] | undefined;
  let executeAligned = true;
  let dryRun = false;
  let maxActions = 3;
  let taskSelection: HeartbeatTaskSelection = "queue-first";
  let repairMode: HeartbeatRepairMode = "queue-only";
  let thresholdMode: HeartbeatThresholdMode = "queue-only";
  let runnerCmd: string | undefined;
  let runnerTimeout = 1_800_000;
  let configPath: string | undefined;
  let slot: HeartbeatRunSlot = "manual";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      vault = args[++i];
    } else if (args[i] === "--phases" && args[i + 1]) {
      phases = parsePhases(args[++i]);
    } else if (args[i] === "--install-schedule") {
      doInstallSchedule = true;
    } else if (args[i] === "--uninstall-schedule") {
      doUninstallSchedule = true;
    } else if (args[i] === "--schedule-status") {
      doScheduleStatus = true;
    } else if (args[i] === "--execute-aligned") {
      executeAligned = true;
    } else if (args[i] === "--no-execute") {
      executeAligned = false;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--max-triggered" && args[i + 1]) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) maxActions = parsed;
    } else if (args[i] === "--max-actions" && args[i + 1]) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) maxActions = parsed;
    } else if (args[i] === "--task-selection" && args[i + 1]) {
      const value = args[++i];
      if (value === "queue-first" || value === "aligned-first") {
        taskSelection = value;
      } else {
        console.error(`unknown --task-selection value: "${value}"`);
        process.exit(1);
      }
    } else if (args[i] === "--repair-mode" && args[i + 1]) {
      const value = args[++i];
      if (value === "queue-only" || value === "execute") {
        repairMode = value;
      } else {
        console.error(`unknown --repair-mode value: "${value}"`);
        process.exit(1);
      }
    } else if (args[i] === "--threshold-mode" && args[i + 1]) {
      const value = args[++i];
      if (value === "queue-only" || value === "execute") {
        thresholdMode = value;
      } else {
        console.error(`unknown --threshold-mode value: "${value}"`);
        process.exit(1);
      }
    } else if (args[i] === "--runner-cmd" && args[i + 1]) {
      runnerCmd = args[++i];
    } else if (args[i] === "--runner-timeout" && args[i + 1]) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) runnerTimeout = parsed;
    } else if (args[i] === "--config" && args[i + 1]) {
      configPath = args[++i];
    } else if (args[i] === "--slot" && args[i + 1]) {
      const value = args[++i];
      if (value === "morning" || value === "evening" || value === "overnight" || value === "manual") {
        slot = value;
      } else {
        console.error(`unknown --slot value: "${value}"`);
        process.exit(1);
      }
    }
  }

  return {
    vault,
    doInstallSchedule,
    doUninstallSchedule,
    doScheduleStatus,
    phases,
    executeAligned,
    dryRun,
    maxActions,
    taskSelection,
    repairMode,
    thresholdMode,
    runnerCmd,
    runnerTimeout,
    configPath,
    slot,
  };
}

// ─── Resolve heartbeat entry point path ──────────────────────────────────────

function resolveHeartbeatPath(): string {
  // When running from dist/index.js, the heartbeat binary is this file itself.
  // import.meta.url gives us the file:// URL of the current module.
  const currentPath = new URL(import.meta.url).pathname;
  return currentPath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const isDirectExecution = process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts");

if (isDirectExecution) {
  void (async () => {
    const {
      vault,
      doInstallSchedule: shouldInstall,
      doUninstallSchedule: shouldUninstall,
      doScheduleStatus: shouldStatus,
      phases,
      executeAligned,
      dryRun,
      maxActions,
      taskSelection,
      repairMode,
      thresholdMode,
      runnerCmd,
      runnerTimeout,
      configPath,
      slot,
    } = parseArgs(process.argv);

    // ── Schedule management commands ─────────────────────────────────────

    if (shouldUninstall) {
      const ok = uninstallSchedule();
      process.exit(ok ? 0 : 1);
    }

    if (shouldStatus) {
      const status = getScheduleStatus();
      console.log("heartbeat schedule status:");
      console.log(`  platform: ${status.platform}`);
      console.log(`  healthy: ${status.healthy ? "yes" : "no"}`);
      console.log(`  morning (6:00 AM): ${status.morning.installed ? "active" : "not installed"}`);
      if (status.morning.plistPath) {
        console.log(`    plist: ${status.morning.plistPath}`);
      }
      console.log(`  evening (9:00 PM): ${status.evening.installed ? "active" : "not installed"}`);
      if (status.evening.plistPath) {
        console.log(`    plist: ${status.evening.plistPath}`);
      }
      console.log(`  overnight (11p-6a): ${status.overnight.installed ? "active" : "not installed"}`);
      if (status.overnight.plistPath) {
        console.log(`    plist: ${status.overnight.plistPath}`);
      }
      if (status.legacyArtifacts.length > 0) {
        console.log(`  legacy artifacts: ${status.legacyArtifacts.join(", ")}`);
      }
      process.exit(0);
    }

    if (shouldInstall) {
      const heartbeatPath = resolveHeartbeatPath();
      const ok = installSchedule(vault, heartbeatPath);
      process.exit(ok ? 0 : 1);
    }

    // ── Default: run heartbeat ───────────────────────────────────────────

    console.log(`heartbeat: ${vault}`);
    console.log(`timestamp: ${new Date().toISOString()}`);
    if (phases) {
      console.log(`phases: ${phases.join(", ")}`);
    }

    const result = await runHeartbeat(vault, {
      phases,
      executeAlignedTasks: executeAligned,
      dryRun,
      maxActionsPerRun: maxActions,
      taskSelection,
      repairMode,
      thresholdMode,
      runnerCommand: runnerCmd,
      runnerTimeoutMs: runnerTimeout,
      configPath,
      runSlot: slot,
    });

    // Report
    const exceeded = result.conditions.filter(c => c.exceeded);
    if (exceeded.length > 0) {
      console.log(`\nconditions exceeded:`);
      for (const c of exceeded) {
        console.log(`  [${c.key}] ${c.count}/${c.threshold}`);
      }
    } else {
      console.log("\nall conditions within thresholds");
    }

    if (result.evaluations.length > 0) {
      console.log(`\ncommitment evaluations:`);
      for (const e of result.evaluations) {
        const status = e.stale ? "STALE" : "ok";
        console.log(`  [${status}] "${e.commitment.label}" — ${e.staleDays}d since last advance`);
      }
    }

    if (result.alignedTasks.length > 0) {
      console.log(`\n${result.alignedTasks.length} queue task(s) aligned with active commitments:`);
      for (const t of result.alignedTasks) {
        console.log(`  [${t.phase}] ${t.target}`);
      }
      if (!executeAligned) {
        console.log("  -> recommend: /process in next session");
      }
    }

    if (result.triggered.length > 0) {
      console.log(`\ntriggered tasks:`);
      for (const t of result.triggered) {
        const mode = t.executed ? "executed" : "advisory";
        console.log(`  [${t.success ? "ok" : "fail"}][${mode}] ${t.taskId} (${t.phase}) - ${t.detail}`);
      }
    }

    if (result.recommendations.length > 0) {
      console.log(`\nrecommendations:`);
      for (const r of result.recommendations) {
        console.log(`  - ${r}`);
      }
    }

    console.log("\nexecution counters:");
    console.log(`  queue depth: ${result.queueDepthBefore} -> ${result.queueDepthAfter}`);
    console.log(`  executed actions: ${result.executedActions}`);
    console.log(`  advisory actions: ${result.advisoryActions}`);
    console.log(`  repairs queued/skipped: ${result.repairsQueued}/${result.repairsSkipped}`);
    console.log(
      `  thin/constitutive deferrals: ${result.thinDeferredActions}/${result.constitutiveDeferredActions}`,
    );

    console.log(`\nmorning-brief.md ${result.briefWritten ? "updated" : "left unchanged"}`);
  })().catch((error: unknown) => {
    console.error("heartbeat failed", error);
    process.exit(1);
  });
}
