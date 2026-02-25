/**
 * session-continuity.ts
 *
 * Stop hook equivalent. Generates updated working memory from session artifacts.
 * Equivalent to ars-contexta's session-continuity.sh.
 *
 * On session end:
 *   - Finds .md files changed since session start (thoughts/, inbox/, self/, ops/)
 *   - Calls LLM via opencode client to generate updated working-memory.md
 *   - Commits the result
 *
 * Fires async (void) — does not block the session.deleted event handler.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { PluginInput } from "@opencode-ai/plugin";

// ─── Logging ─────────────────────────────────────────────────────────────────

function logToFile(vaultRoot: string, logPath: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} ${message}\n`;
  try {
    appendFileSync(logPath, line, "utf-8");
  } catch {
    // Log writes are best-effort — never let them break the hook
  }
}

function logError(vaultRoot: string, errorsLog: string, context: string, err: unknown): void {
  const errLine = JSON.stringify({
    ts: new Date().toISOString(),
    hook: "session-continuity",
    context,
    error: String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  try {
    appendFileSync(errorsLog, errLine + "\n", "utf-8");
  } catch {
    // Best-effort
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function sessionContinuity(
  vaultRoot: string,
  client: PluginInput["client"],
  $: PluginInput["$"],
  sessionStart: Date,
  sessionId?: string
): Promise<void> {
  const initLog = join(vaultRoot, "ops", "runtime", "plugin-init.log");
  const errorsLog = join(vaultRoot, "ops", "runtime", "intent-loop-errors.log");

  const sid = sessionId ?? "unknown";
  logToFile(vaultRoot, initLog, `session-continuity: started for session ${sid}`);

  try {
    // Guard: verify client has session API
    if (!client?.session?.create) {
      logToFile(vaultRoot, initLog, `session-continuity: skipped — client.session.create unavailable (sid=${sid})`);
      return;
    }

    const changed = findChangedFiles(vaultRoot, sessionStart);
    if (changed.length === 0) {
      logToFile(vaultRoot, initLog, `session-continuity: skipped — no .md files changed since ${sessionStart.toISOString()} (sid=${sid})`);
      return;
    }

    logToFile(vaultRoot, initLog, `session-continuity: ${changed.length} files changed, building prompt (sid=${sid})`);

    const changeContext = buildChangeContext(changed);

    const goalsPaths = [join(vaultRoot, "self", "goals.md"), join(vaultRoot, "ops", "goals.md")];
    const goals = tryRead(goalsPaths) ?? "";

    const wmPaths = [
      join(vaultRoot, "self", "working-memory.md"),
      join(vaultRoot, "ops", "working-memory.md"),
    ];
    const previousWM = tryRead(wmPaths) ?? "";

    const today = new Date().toISOString().slice(0, 10);
    const activeThread = extractActiveThread(goals);
    const prompt = buildPrompt(changed.length, changeContext, goals, previousWM, today, activeThread);

    logToFile(vaultRoot, initLog, `session-continuity: calling LLM (sid=${sid})`);

    const result = await callLLM(prompt, vaultRoot, client, errorsLog, sid);
    if (!result) {
      logToFile(vaultRoot, initLog, `session-continuity: LLM returned no result (sid=${sid})`);
      return;
    }

    // Write to the first existing wm path, or self/ default
    const wmOut =
      wmPaths.find((p) => existsSync(p)) ??
      (() => {
        mkdirSync(join(vaultRoot, "self"), { recursive: true });
        return join(vaultRoot, "self", "working-memory.md");
      })();

    writeFileSync(wmOut, result + "\n", "utf-8");

    await commit(vaultRoot, wmOut, $, errorsLog, sid);

    logToFile(vaultRoot, initLog, `session-continuity: completed, committed ${changed.length} files (sid=${sid})`);
  } catch (err) {
    logError(vaultRoot, errorsLog, "top-level", err);
    logToFile(vaultRoot, initLog, `session-continuity: failed with error — see intent-loop-errors.log (sid=${sid})`);
  }
}

// ─── File scanning ────────────────────────────────────────────────────────────

function findChangedFiles(vaultRoot: string, since: Date): string[] {
  const sinceMs = since.getTime();
  const acc: string[] = [];
  for (const dir of ["thoughts", "inbox", "self", "ops"]) {
    if (acc.length >= 30) break;
    collectChanged(join(vaultRoot, dir), sinceMs, acc);
  }
  return acc.slice(0, 30);
}

function collectChanged(dir: string, sinceMs: number, acc: string[]): void {
  if (acc.length >= 30 || !existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (acc.length >= 30) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectChanged(full, sinceMs, acc);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          if (statSync(full).mtimeMs > sinceMs) acc.push(full);
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

function buildChangeContext(files: string[]): string {
  return files
    .map((f) => {
      const name = f.split("/").pop()?.replace(/\.md$/, "") ?? f;
      const raw = safeRead(f);
      const desc = raw?.match(/^description:\s*(.+)$/m)?.[1] ?? "";
      return desc ? `- ${name}: ${desc}` : `- ${name}`;
    })
    .join("\n");
}

// ─── LLM call ────────────────────────────────────────────────────────────────

const LLM_TIMEOUT_MS = 120_000;

class ContinuityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`session-continuity LLM call timed out after ${timeoutMs}ms`);
    this.name = "ContinuityTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ContinuityTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callLLM(
  prompt: string,
  vaultRoot: string,
  client: PluginInput["client"],
  errorsLog: string,
  sid: string
): Promise<string | null> {
  let sessionID: string | null = null;
  try {
    const created = (
      await client.session.create({
        query: { directory: vaultRoot },
        body: { title: "intent-continuity" },
      })
    ).data;
    if (!created?.id) {
      logError(vaultRoot, errorsLog, "callLLM:create — no id in response", { created });
      return null;
    }
    sessionID = created.id;

    const response = await withTimeout(
      client.session.prompt({
        query: { directory: vaultRoot },
        path: { id: sessionID },
        body: {
          system:
            "You generate working memory documents for a personal knowledge companion. Return only the document, no preamble or explanation.",
          parts: [{ type: "text", text: prompt }],
        },
      }),
      LLM_TIMEOUT_MS
    );

    const data = (response as { data?: { parts?: unknown[] } } | undefined)?.data;
    const text = (data?.parts ?? [])
      .filter((p: unknown) => (p as { type?: string }).type === "text")
      .map((p: unknown) => ("text" in (p as object) ? ((p as { text?: string }).text ?? "") : ""))
      .join("")
      .trim();

    return text || null;
  } catch (err) {
    logError(vaultRoot, errorsLog, "callLLM", err);
    return null;
  } finally {
    if (sessionID) {
      try {
        await client.session.delete({
          query: { directory: vaultRoot },
          path: { id: sessionID },
        });
      } catch { /* swallow */ }
    }
  }
}

// ─── Git commit ───────────────────────────────────────────────────────────────

async function commit(
  vaultRoot: string,
  wmPath: string,
  $: PluginInput["$"],
  errorsLog: string,
  sid: string
): Promise<void> {
  try {
    await $`git -C ${vaultRoot} rev-parse --git-dir`.quiet();
    await $`git -C ${vaultRoot} add ${wmPath}`.quiet();
    const staged = await $`git -C ${vaultRoot} diff --cached --name-only`.text();
    if (!staged.trim()) return;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
    await $`git -C ${vaultRoot} commit -m "continuity: working-memory ${ts}" --no-verify`.quiet();
  } catch (err) {
    logError(vaultRoot, errorsLog, "commit", err);
  }
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(
  count: number,
  changeContext: string,
  goals: string,
  previousWM: string,
  today: string,
  activeThread: string
): string {
  return [
    "You are updating the companion's working memory after a session with the user.",
    "",
    `FILES CHANGED THIS SESSION (${count} files):`,
    changeContext,
    "",
    "CURRENT GOALS:",
    goals ? goals.slice(0, 2000) : "(none)",
    "",
    "PREVIOUS WORKING MEMORY:",
    previousWM ? previousWM.slice(0, 3000) : "(none)",
    "",
    `ACTIVE RESEARCH THREAD: ${activeThread}`,
    "",
    "This session was likely part of the above thread. Write an updated working memory document that:",
    "1. Identifies which research thread this session primarily served based on the files changed",
    "2. Tracks what this session contributed to the active thread",
    "3. Notes thread momentum (is it advancing, stalling, shifting?)",
    "4. Identifies the specific next step within the thread",
    "5. Preserves all other active threads even if untouched this session",
    "A thread is a multi-session research or building arc — sessions are episodes within threads.",
    "",
    "Format exactly as:",
    "---",
    `updated: ${today}`,
    "updated_by: session",
    "---",
    "",
    "## Active Threads",
    "- **thread name** — description. Momentum: high/medium/low. Last: what just happened. Implicit next: what should follow.",
    "",
    "## Thread State",
    `Current thread: [thread name from goals.md]`,
    "Session contribution: [what this session added to the thread]",
    "Thread momentum: high/medium/low",
    "Thread next: [specific next step for this thread]",
    "Remaining open: [what's still unresolved in this thread]",
    "",
    "## Unresolved",
    "- Open questions, deferred decisions",
    "",
    "## Forming Patterns",
    "- Connections noticed but not yet named as thoughts",
    "",
    "## Next Move",
    "What the companion believes should happen in the next session. Be specific.",
    "",
    "## Temperature",
    "One word for the session's emotional/energy tone.",
    "",
    "Be specific and concise. Preserve important context from previous working memory — don't drop active threads just because they weren't touched this session.",
  ].join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryRead(paths: string[]): string | null {
  for (const p of paths) {
    const content = safeRead(p);
    if (content !== null) return content;
  }
  return null;
}

function safeRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8").trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extract the most active research thread from goals.md content.
 * Returns "<name>: <description>" for the first entry under "## Active Threads".
 * The user orders threads by priority, so first = most active.
 */
function extractActiveThread(goals: string): string {
  const threadsSection = goals.match(/## Active Threads\n([\s\S]*?)(?=\n##|$)/)?.[1] ?? "";
  const firstThread = threadsSection.match(/^- \*\*(.+?)\*\* — (.+?)(?:\n|$)/m);
  if (!firstThread) return "(no active thread detected)";
  return `${firstThread[1]}: ${firstThread[2]}`;
}
