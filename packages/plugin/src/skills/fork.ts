/**
 * fork.ts — Phase 4
 *
 * Fresh-context session architecture. Implements the `context: fork` semantics
 * from Claude Code's SKILL.md format.
 *
 * THE PROBLEM
 * -----------
 * In ars-contexta, every processing skill runs in a fresh context window via
 * `context: fork` in SKILL.md frontmatter. This prevents cross-contamination
 * between pipeline phases — reduce doesn't know what reflect saw. It also
 * enables ralph to run 5 skills concurrently without shared state.
 *
 * opencode has no equivalent primitive. Without isolation, skills run in the
 * current session's context, which accumulates across invocations. After a
 * long session, a /reduce call might be influenced by earlier /reflect context
 * or unrelated conversation — a quality problem at scale.
 *
 * THE APPROACH
 * ------------
 * Use `input.client` (the opencode SDK client from PluginInput) to spawn a new
 * session for each processing skill invocation:
 *
 *   1. Create a new opencode session via client.session.create()
 *   2. Send the skill instructions + task context as the first message
 *   3. Receive response (session executes tools, writes vault artifacts)
 *   4. Extract written artifacts from the vault (the session wrote to disk)
 *   5. Summarize what was produced, return to the originating session
 *   6. Clean up the spawned session
 *
 * The vault is the shared state channel. The forked session reads from and
 * writes to the same vault as the originating session. The originating session
 * never sees the forked session's LLM context — only its artifacts on disk.
 *
 * WHICH SKILLS USE FORK
 * ---------------------
 * Processing skills only (deep LLM work, high contamination risk):
 *   reduce, reflect, reweave, verify, learn
 *
 * In-session skills (fast, navigational, low contamination risk):
 *   stats, tasks, next, validate, seed, remember, rethink, refactor,
 *   ralph, pipeline, graph, help, setup
 *   (also all plugin-level skills)
 *
 * IMPLEMENTATION STATUS
 * ---------------------
 * Phase 4: client.session API is confirmed working (see session-continuity.ts).
 * Primary path: tryClientFork() using client.session.create/prompt/delete.
 * Fallback path: processFork() for environments where client API is unavailable.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";

export interface ForkOptions {
  skillName: string;
  skillInstructions: string;
  taskContext: string;         // File contents or task description passed to the forked session
  vaultRoot: string;
  timeoutMs?: number;          // Default: 300_000 (5 minutes)
}

export interface ForkResult {
  success: boolean;
  summary: string;             // What the forked session produced, for display in current session
  artifacts: string[];         // Paths of files written during the fork
  error?: string;
}

class ForkPromptTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly skillName: string;

  constructor(skillName: string, timeoutMs: number) {
    super(`Fork prompt timed out after ${timeoutMs}ms for "${skillName}"`);
    this.name = "ForkPromptTimeoutError";
    this.timeoutMs = timeoutMs;
    this.skillName = skillName;
  }
}

async function withPromptTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  skillName: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new ForkPromptTimeoutError(skillName, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Execute a skill in an isolated context window.
 *
 * Attempts client.session API first (proven via session-continuity.ts).
 * Falls back to process spawning if client API is unavailable.
 */
export async function forkSkill(
  options: ForkOptions,
  client: PluginInput["client"],
  $: PluginInput["$"]
): Promise<ForkResult> {
  // Primary: client-based isolation (proven working)
  const clientResult = await tryClientFork(options, client);
  if (clientResult !== null) return clientResult;

  // Fallback: process-based isolation
  return await processFork(options, $);
}

// ─── CLIENT-BASED FORK (primary) ──────────────────────────────────────────────

/**
 * Spawn an isolated opencode session for skill execution.
 *
 * Pattern mirrors session-continuity.ts callLLM(), which is proven working.
 * Returns null ONLY if session creation itself is unavailable (API not found).
 * All other errors return { success: false } so callers don't re-attempt.
 */
async function tryClientFork(
  options: ForkOptions,
  client: PluginInput["client"]
): Promise<ForkResult | null> {
  // Guard: verify client has session API before attempting
  if (!client?.session?.create) return null;

  let sessionID: string | null = null;
  try {
    // 1. Create isolated session
    const created = (
      await client.session.create({
        query: { directory: options.vaultRoot },
        body: { title: `intent-fork-${options.skillName}` },
      })
    ).data;
    if (!created?.id) return null;
    sessionID = created.id;

    // 2. Send skill instructions + task context as a single message
    const prompt = buildClientPrompt(options);
    const timeoutMs = options.timeoutMs ?? 300_000;
    const promptResponse = await withPromptTimeout<any>(
      client.session.prompt({
        query: { directory: options.vaultRoot },
        path: { id: sessionID },
        body: {
          system: buildForkSystem(options.skillName, options.vaultRoot),
          parts: [{ type: "text", text: prompt }],
        },
      }),
      timeoutMs,
      options.skillName,
    );
    const response = (promptResponse as { data?: { parts?: unknown[] } } | undefined)?.data;

    // 3. Extract text response (summary of what the forked session did)
    const parts = Array.isArray(response?.parts)
      ? (response.parts as Array<{ type?: string; text?: string }>)
      : [];
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    // 4. Opportunistically extract artifact paths from summary
    const artifacts = extractArtifactPaths(text, options.vaultRoot);

    return {
      success: true,
      summary: text || `${options.skillName} completed`,
      artifacts,
    };
  } catch (err) {
    // Session creation worked but execution failed — return error, don't fall back
    if (sessionID !== null) {
      const errorMessage = err instanceof ForkPromptTimeoutError
        ? `Fork prompt timed out after ${err.timeoutMs}ms (${err.skillName})`
        : err instanceof Error
          ? err.message
          : String(err);
      return {
        success: false,
        summary: "",
        artifacts: [],
        error: errorMessage,
      };
    }
    // Session creation itself failed — fall back to process
    return null;
  } finally {
    if (sessionID) {
      try {
        await client.session.delete({
          query: { directory: options.vaultRoot },
          path: { id: sessionID },
        });
      } catch { /* swallow */ }
    }
  }
}

function buildForkSystem(skillName: string, vaultRoot: string): string {
  return [
    `You are executing the "${skillName}" processing skill in an isolated context.`,
    ``,
    `Your vault root is: ${vaultRoot}`,
    ``,
    `Follow the skill instructions exactly. Write all outputs to the appropriate`,
    `vault locations. When done, provide a brief summary (3-5 sentences) of:`,
    `- What you processed`,
    `- What files you created or modified (full paths)`,
    `- Any notable connections or insights discovered`,
    ``,
    `Be direct and specific. Do not ask for confirmation.`,
  ].join("\n");
}

function buildClientPrompt(options: ForkOptions): string {
  return [
    `## Skill Instructions: ${options.skillName}`,
    ``,
    options.skillInstructions,
    ``,
    `## Task Context`,
    ``,
    options.taskContext,
  ].join("\n");
}

/**
 * Extract vault file paths mentioned in the forked session's summary.
 * Opportunistic — returns empty array if none found (callers handle this).
 */
function extractArtifactPaths(summary: string, vaultRoot: string): string[] {
  const artifacts: string[] = [];
  // Match absolute paths under vaultRoot
  const absolutePattern = new RegExp(`(${escapeRegex(vaultRoot)}/[^\\s,;'"\\)]+\\.md)`, "g");
  for (const match of summary.matchAll(absolutePattern)) {
    const p = match[1];
    if (existsSync(p) && !artifacts.includes(p)) artifacts.push(p);
  }
  // Match relative paths like thoughts/foo.md or Mind/thoughts/foo.md
  const relativePattern = /(?:thoughts|inbox|self|ops)\/[\w\-]+\.md/g;
  for (const match of summary.matchAll(relativePattern)) {
    const p = join(vaultRoot, match[0]);
    if (existsSync(p) && !artifacts.includes(p)) artifacts.push(p);
  }
  return artifacts;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── PROCESS-BASED FORK (fallback) ────────────────────────────────────────────

/**
 * Write skill instructions + context to a temp file, spawn opencode as a
 * child process with that prompt, wait for completion, read artifacts.
 *
 * Shared implementation layer with ralph (Phase 5). If ralph's process
 * architecture proves out, this becomes a thin wrapper over it.
 *
 * NOTE: The opencode CLI interface for non-interactive mode is unverified.
 * This fallback will fail until the correct invocation is confirmed.
 */
async function processFork(
  options: ForkOptions,
  _$: PluginInput["$"]
): Promise<ForkResult> {
  const tempDir = join(options.vaultRoot, "ops", "queue", "temp");
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  const forkId = randomUUID();
  const promptFile = join(tempDir, `fork-${forkId}.md`);
  const resultFile = join(tempDir, `fork-${forkId}-result.md`);

  const prompt = buildProcessPrompt(options, resultFile);
  writeFileSync(promptFile, prompt, "utf-8");

  try {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const variants = [
      ["run", "--prompt-file", promptFile, "--non-interactive"],
      ["--prompt-file", promptFile, "--non-interactive"],
    ];

    let executed = false;
    let lastError = "";
    for (const args of variants) {
      const result = spawnSync("opencode", args, {
        cwd: options.vaultRoot,
        encoding: "utf-8",
        timeout: timeoutMs,
      });
      if (result.status === 0) {
        executed = true;
        break;
      }
      lastError =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `opencode exited with status ${result.status}`;
    }
    if (!executed) {
      throw new Error(lastError || "opencode fallback invocation failed");
    }

    const summary = existsSync(resultFile)
      ? readFileSync(resultFile, "utf-8").trim()
      : `${options.skillName} completed (no summary written)`;

    return { success: true, summary, artifacts: [] };
  } catch (err) {
    return {
      success: false,
      summary: "",
      artifacts: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    for (const f of [promptFile, resultFile]) {
      if (existsSync(f)) {
        try { unlinkSync(f); } catch { /* swallow */ }
      }
    }
  }
}

function buildProcessPrompt(options: ForkOptions, resultFile: string): string {
  return [
    `# intent-computer fork: ${options.skillName}`,
    ``,
    `## Instructions`,
    ``,
    options.skillInstructions,
    ``,
    `## Task Context`,
    ``,
    options.taskContext,
    ``,
    `## After completing the task`,
    ``,
    `Write a brief summary (2-4 sentences) of what you produced to:`,
    `${resultFile}`,
    ``,
    `Format: plain text, no headers, just the summary.`,
  ].join("\n");
}
