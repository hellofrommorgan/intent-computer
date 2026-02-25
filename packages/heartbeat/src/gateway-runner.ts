/**
 * gateway-runner.ts — Direct LLM gateway runner for exe.dev
 *
 * Calls the Anthropic Messages API via exe.dev's LLM gateway at the
 * link-local metadata address. No Claude CLI dependency. No API keys needed.
 *
 * Detection: set EXE_DEV=1 or INTENT_USE_GATEWAY=true in the environment,
 * or call isGatewayAvailable() to probe the link-local address directly.
 *
 * This module exports the same RunnerResult interface as runner.ts so it
 * can be swapped in as a drop-in replacement.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { RunnerOptions, RunnerResult } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ──────────────────────────────────────────────────────────────

const GATEWAY_BASE = "http://169.254.169.252/gateway/llm/anthropic";
const GATEWAY_URL = `${GATEWAY_BASE}/v1/messages`;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 min (direct API is faster than CLI)
const DEFAULT_MAX_TOKENS = 8192;

// ─── exe.dev detection ──────────────────────────────────────────────────────

/**
 * Check environment variables for gateway mode.
 * Returns true if EXE_DEV=1 or INTENT_USE_GATEWAY=true is set.
 */
export function isGatewayEnv(): boolean {
  return (
    process.env.EXE_DEV === "1" ||
    process.env.INTENT_USE_GATEWAY === "true"
  );
}

/**
 * Probe the link-local gateway to see if it's reachable.
 * Uses a short timeout (2s) to avoid blocking when not on exe.dev.
 */
export async function isGatewayAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    // A simple GET to the base URL — we just care if it responds at all.
    const response = await fetch(GATEWAY_BASE, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // Any response (even 404) means the gateway host is up.
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Determine whether to use the gateway runner.
 * Checks env vars first (fast), then optionally probes the network.
 */
export async function shouldUseGateway(): Promise<boolean> {
  if (isGatewayEnv()) return true;
  return isGatewayAvailable();
}

// ─── Gateway runner ─────────────────────────────────────────────────────────

/**
 * Call the Anthropic Messages API directly via the exe.dev LLM gateway.
 * Drop-in async replacement for runClaude() from runner.ts.
 *
 * Differences from runClaude():
 *   - Async (returns Promise<RunnerResult>)
 *   - Uses HTTP fetch instead of spawning Claude CLI
 *   - No API key needed (gateway handles auth)
 *   - Default timeout is 5 min instead of 30 min (no CLI overhead)
 */
export async function runGateway(
  prompt: string,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "(unreadable body)");
      return {
        success: false,
        output: "",
        error: `Gateway error ${response.status}: ${errText}`,
        durationMs: Date.now() - start,
      };
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    return {
      success: true,
      output: text,
      durationMs: Date.now() - start,
    };
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Unknown gateway error";
    const isTimeout = msg.includes("abort");
    return {
      success: false,
      output: "",
      error: isTimeout ? `Gateway timeout after ${timeoutMs}ms` : msg,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Call the gateway with a system prompt and user message.
 * Useful for skill-based tasks where the skill instructions are the system prompt.
 */
export async function runGatewayWithSystem(
  systemPrompt: string,
  userMessage: string,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "(unreadable body)");
      return {
        success: false,
        output: "",
        error: `Gateway error ${response.status}: ${errText}`,
        durationMs: Date.now() - start,
      };
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    return {
      success: true,
      output: text,
      durationMs: Date.now() - start,
    };
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Unknown gateway error";
    const isTimeout = msg.includes("abort");
    return {
      success: false,
      output: "",
      error: isTimeout ? `Gateway timeout after ${timeoutMs}ms` : msg,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Run a skill-based task via the gateway.
 * Loads the SKILL.md for the given skill name and passes it as a system prompt
 * with the task context as the user message.
 *
 * Drop-in async replacement for runSkillTask() from runner.ts.
 */
export async function runGatewaySkillTask(
  skillName: string,
  taskContext: string,
  vaultRoot: string,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
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

  if (skillContent) {
    const systemPrompt = `You are executing the /${skillName} skill in the vault at ${vaultRoot}.\n\n${skillContent}`;
    return runGatewayWithSystem(systemPrompt, taskContext, options);
  }

  // No skill file found — fall back to a single user message (same as runner.ts)
  const prompt = `You are working in the vault at ${vaultRoot}.\n\nTask: ${taskContext}`;
  return runGateway(prompt, options);
}
