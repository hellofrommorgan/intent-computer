import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RunnerOptions {
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

/**
 * Invoke Claude CLI with a prompt. Returns the model's response.
 * Uses --dangerously-skip-permissions for autonomous operation.
 * Uses -p (print mode) for non-interactive output.
 */
export function runClaude(prompt: string, options: RunnerOptions = {}): RunnerResult {
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const currentDepth = parseInt(process.env.INTENT_HEARTBEAT_DEPTH ?? "0", 10);

  const args = [
    "--dangerously-skip-permissions",
    "-p",
    "--model",
    model,
  ];

  if (typeof options.maxTokens === "number" && options.maxTokens > 0) {
    args.push("--max-tokens", String(options.maxTokens));
  }
  args.push(prompt);

  try {
    const env = {
      ...process.env,
      // Prevent recursive heartbeat spawning.
      INTENT_HEARTBEAT_DEPTH: String((Number.isFinite(currentDepth) ? currentDepth : 0) + 1),
    } as NodeJS.ProcessEnv;
    delete env.CLAUDECODE;

    // Resolve claude binary: prefer explicit env var, fall back to ~/.local/bin/claude
    // (bare "claude" fails in headless contexts where PATH doesn't include ~/.local/bin)
    const claudeBin =
      process.env.INTENT_CLAUDE_PATH ??
      join(process.env.HOME ?? "", ".local", "bin", "claude");

    const output = execFileSync(claudeBin, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env,
    });

    return {
      success: true,
      output: output.trim(),
      durationMs: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };

    return {
      success: false,
      output: asString(err.stdout).trim(),
      error: asString(err.stderr).trim() || err.message || "Unknown error",
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Run a skill-based task via Claude CLI.
 * Loads the SKILL.md for the given skill name and passes it along with the task context.
 */
export function runSkillTask(
  skillName: string,
  taskContext: string,
  vaultRoot: string,
  options: RunnerOptions = {},
): RunnerResult {
  const skillPaths = [
    join(
      __dirname,
      "..",
      "..",
      "..",
      "plugin",
      "src",
      "skill-sources",
      skillName,
      "SKILL.md",
    ),
    join(
      process.cwd(),
      "packages",
      "plugin",
      "src",
      "skill-sources",
      skillName,
      "SKILL.md",
    ),
    join(
      __dirname,
      "..",
      "..",
      "..",
      "plugin",
      "dist",
      "skill-sources",
      skillName,
      "SKILL.md",
    ),
  ];

  let skillContent = "";
  for (const path of skillPaths) {
    if (existsSync(path)) {
      skillContent = readFileSync(path, "utf-8");
      break;
    }
  }

  const prompt = skillContent
    ? `You are executing the /${skillName} skill in the vault at ${vaultRoot}.\n\n=== SKILL INSTRUCTIONS ===\n${skillContent}\n=== END SKILL ===\n\n=== TASK CONTEXT ===\n${taskContext}\n=== END TASK ===`
    : `You are working in the vault at ${vaultRoot}.\n\nTask: ${taskContext}`;

  return runClaude(prompt, options);
}
