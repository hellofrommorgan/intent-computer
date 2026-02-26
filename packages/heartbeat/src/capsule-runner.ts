/**
 * capsule-runner.ts — execute capsule skills via the heartbeat
 *
 * Bridges the capsule trigger evaluator to the runner infrastructure.
 * When the heartbeat detects a due capsule skill, this module:
 *   1. Builds the execution prompt from the skill content + context
 *   2. Runs it via Claude CLI or gateway (auto-detected)
 *   3. Records completion for trigger chaining
 *   4. Returns results in the heartbeat's TriggerExecutionResult format
 */

import { join, basename } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { DueSkill } from "./capsule-trigger.js";
import {
  evaluateTriggers,
  recordAndChain,
  loadCapsuleManifest,
  saveTriggerState,
  loadTriggerState,
  recordSkillRun,
} from "./capsule-trigger.js";
import { runClaude } from "./runner.js";
import { isGatewayEnv, runGatewayWithSystem } from "./gateway-runner.js";
import type { RunnerOptions, RunnerResult } from "./runner.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CapsuleExecutionResult {
  skillName: string;
  trigger: string;
  reason: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  chained: string[];
}

export interface CapsuleRunResult {
  capsuleSeed: string;
  executed: CapsuleExecutionResult[];
  skipped: string[];
  totalDurationMs: number;
}

// ─── Prompt building ─────────────────────────────────────────────────────────

function buildCapsuleSkillPrompt(
  skill: DueSkill,
  vaultRoot: string,
  capsuleIntent: string,
): { system: string; user: string } {
  const manifest = loadCapsuleManifest(vaultRoot);
  const identity = manifest?.identity
    ? loadIdentity(vaultRoot, manifest.identity)
    : "";

  const system = [
    `You are an autonomous agent operating in the vault at ${vaultRoot}.`,
    capsuleIntent ? `Your purpose: ${capsuleIntent}` : "",
    "",
    identity ? "=== IDENTITY ===" : "",
    identity,
    identity ? "=== END IDENTITY ===" : "",
    "",
    "=== SKILL INSTRUCTIONS ===",
    skill.content,
    "=== END SKILL ===",
    "",
    "Execute the skill instructions precisely. Write output files to the locations specified.",
    "Return a concise summary of what you did and what files you created or modified.",
  ]
    .filter(Boolean)
    .join("\n");

  const user = skill.context;

  return { system, user };
}

function loadIdentity(vaultRoot: string, identityPath: string): string {
  // Try vault-relative paths
  const candidates = [
    join(vaultRoot, "self", "identity.md"),
    join(vaultRoot, identityPath),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
  }
  return "";
}

// ─── Execution ───────────────────────────────────────────────────────────────

async function executeSkill(
  skill: DueSkill,
  vaultRoot: string,
  capsuleIntent: string,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  const { system, user } = buildCapsuleSkillPrompt(skill, vaultRoot, capsuleIntent);

  if (isGatewayEnv()) {
    return runGatewayWithSystem(system, user, options);
  }

  // CLI mode — combine system + user into a single prompt
  const prompt = `${system}\n\n${user}`;
  return runClaude(prompt, options);
}

// ─── Log writing ─────────────────────────────────────────────────────────────

function logExecution(
  vaultRoot: string,
  result: CapsuleExecutionResult,
): void {
  const logDir = join(vaultRoot, "ops", "capsule-log");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(logDir, `${timestamp}-${result.skillName}.md`);

  const lines = [
    `# ${result.skillName}`,
    "",
    `**Trigger:** ${result.trigger}`,
    `**Reason:** ${result.reason}`,
    `**Success:** ${result.success}`,
    `**Duration:** ${result.durationMs}ms`,
    "",
    "## Output",
    "",
    result.output || "(no output)",
  ];

  if (result.error) {
    lines.push("", "## Error", "", result.error);
  }

  if (result.chained.length > 0) {
    lines.push("", "## Chained Skills", "", ...result.chained.map((s) => `- ${s}`));
  }

  writeFileSync(logPath, lines.join("\n") + "\n", "utf-8");
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Run all due capsule skills for this heartbeat cycle.
 *
 * Call this from the heartbeat's run loop. It:
 *   1. Evaluates triggers against capsule.yaml
 *   2. Executes each due skill
 *   3. Chains "after" triggers
 *   4. Logs results
 *   5. Returns a summary
 */
export async function runCapsuleSkills(
  vaultRoot: string,
  options: RunnerOptions = {},
): Promise<CapsuleRunResult> {
  const start = Date.now();
  const manifest = loadCapsuleManifest(vaultRoot);

  if (!manifest) {
    return {
      capsuleSeed: "(none)",
      executed: [],
      skipped: [],
      totalDurationMs: Date.now() - start,
    };
  }

  const dueSkills = evaluateTriggers(vaultRoot);
  const executed: CapsuleExecutionResult[] = [];
  const skipped: string[] = [];

  // Execute due skills, then chain
  const toRun = [...dueSkills];
  const maxChainDepth = 5; // prevent infinite loops
  let chainDepth = 0;

  while (toRun.length > 0 && chainDepth < maxChainDepth) {
    const skill = toRun.shift()!;

    try {
      const result = await executeSkill(skill, vaultRoot, manifest.intent, options);

      // Record completion for chaining
      const chained = recordAndChain(vaultRoot, skill.skill.name);
      const chainedNames = chained.map((s) => s.skill.name);

      const execResult: CapsuleExecutionResult = {
        skillName: skill.skill.name,
        trigger: skill.skill.on,
        reason: skill.reason,
        success: result.success,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
        chained: chainedNames,
      };

      executed.push(execResult);
      logExecution(vaultRoot, execResult);

      // Add chained skills to the queue
      if (chained.length > 0) {
        toRun.push(...chained);
        chainDepth++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      executed.push({
        skillName: skill.skill.name,
        trigger: skill.skill.on,
        reason: skill.reason,
        success: false,
        output: "",
        error: errorMsg,
        durationMs: 0,
        chained: [],
      });
    }
  }

  // Report any skills that would have chained but hit depth limit
  if (toRun.length > 0) {
    skipped.push(...toRun.map((s) => `${s.skill.name} (chain depth limit)`));
  }

  return {
    capsuleSeed: manifest.seed,
    executed,
    skipped,
    totalDurationMs: Date.now() - start,
  };
}
