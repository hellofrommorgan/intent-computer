#!/usr/bin/env npx tsx
/**
 * session-end.ts — Claude Code SessionEnd hook handler
 *
 * Runs two things:
 *   1. Session capture (synchronous): stages and commits vault changes to git.
 *   2. Session synthesis (background): calls claude CLI to update working-memory.md
 *      with an LLM-generated summary of what happened this session.
 *
 * The synthesis is fire-and-forget — it runs as a detached child process so
 * the hook returns immediately without blocking session exit. If synthesis
 * fails for any reason, the session capture commit is still preserved.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execFileSync, spawn } from "child_process";
import { readStdin } from "./stdin.js";
import { pass } from "./output.js";
import { resolveVaultRoot } from "./vault.js";
import type { SessionEndInput } from "./types.js";

// ─── Session capture (synchronous) ───────────────────────────────────────────

function sessionCapture(vaultRoot: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Verify git repo
  try {
    execFileSync("git", ["-C", vaultRoot, "rev-parse", "--git-dir"], {
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    return; // Not a git repo
  }

  // Stage session artifacts
  const paths = [
    join(vaultRoot, "ops", "sessions"),
    join(vaultRoot, "ops", "observations"),
    join(vaultRoot, "ops", "methodology"),
    join(vaultRoot, "self", "goals.md"),
    join(vaultRoot, "self", "working-memory.md"),
    join(vaultRoot, "thoughts"),
    join(vaultRoot, "inbox"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        execFileSync("git", ["-C", vaultRoot, "add", p], {
          stdio: "pipe",
          timeout: 5000,
        });
      } catch {
        // Path may not exist
      }
    }
  }

  // Check if anything staged
  let status: string;
  try {
    status = execFileSync("git", ["-C", vaultRoot, "diff", "--cached", "--name-only"], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();
  } catch {
    return;
  }
  if (!status) return;

  try {
    execFileSync("git", ["-C", vaultRoot, "commit", "-m", `session: capture ${timestamp}`, "--no-verify"], {
      stdio: "pipe",
      timeout: 10000,
    });
  } catch {
    // Swallow commit failures
  }
}

// ─── Transcript extraction ────────────────────────────────────────────────────

const MAX_TRANSCRIPT_CHARS = 50_000;
const MAX_EXCHANGES = 100;

/**
 * Extract the last N exchanges from a JSONL transcript file.
 * Each line is a JSON object; we pull user/assistant message content.
 * Returns a truncated string safe to embed in a prompt.
 */
function extractTranscript(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return "";
  }

  // Parse lines, collect user/assistant turns
  const lines = raw.split("\n").filter(l => l.trim());
  const exchanges: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const type = entry.type as string | undefined;

      // Skip non-message entries (progress, queue-operation, etc.)
      if (type !== "user" && type !== "assistant") continue;

      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      const role = (msg.role as string | undefined) ?? type;
      const content = msg.content;

      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        // content blocks — extract text parts
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            text += b.text + " ";
          } else if (b.type === "tool_result" && Array.isArray(b.content)) {
            for (const inner of b.content as Record<string, unknown>[]) {
              if (inner.type === "text" && typeof inner.text === "string") {
                text += inner.text.slice(0, 500) + " ";
              }
            }
          }
        }
        text = text.trim();
      }

      if (text) {
        // Truncate individual turns to prevent one giant message from blowing the budget
        exchanges.push(`[${role.toUpperCase()}]: ${text.slice(0, 2000)}`);
      }
    } catch {
      // Malformed line — skip
    }
  }

  // Take only last MAX_EXCHANGES turns
  const recent = exchanges.slice(-MAX_EXCHANGES);
  const joined = recent.join("\n\n");

  // Hard cap at MAX_TRANSCRIPT_CHARS, keeping the tail (most recent)
  if (joined.length > MAX_TRANSCRIPT_CHARS) {
    return "...[truncated]\n\n" + joined.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return joined;
}

// ─── Synthesis prompt ─────────────────────────────────────────────────────────

function buildSynthesisPrompt(
  vaultRoot: string,
  transcriptExcerpt: string,
  currentWorkingMemory: string,
  currentGoals: string,
): string {
  return `You are updating the companion's working memory after a session with Morgan.

Your job: write a new working-memory.md that gives the next session a warm start.
The file must be concise (5-10 lines of structured bullet points), immediately actionable, and honest about what's unfinished.

WORKING MEMORY FILE: ${join(vaultRoot, "self", "working-memory.md")}

CURRENT WORKING MEMORY:
---
${currentWorkingMemory || "(empty)"}
---

CURRENT GOALS:
---
${currentGoals || "(empty)"}
---

SESSION TRANSCRIPT (recent exchanges):
---
${transcriptExcerpt || "(no transcript available)"}
---

INSTRUCTIONS:
1. Read the transcript to understand what actually happened this session.
2. Identify: (a) what was accomplished, (b) what's in-progress or blocked, (c) any new discoveries or decisions.
3. Write the new working-memory.md content.

The format must be:
\`\`\`
Working memory updated. [One sentence summary of this session's core thread.]

- **[Thread or topic name]** — [What happened; current state; what's next]
- **[Another thread]** — [State]
- **[Discovery/Decision]** — [What was learned or decided]

Next session opens with: [Specific, concrete first action — not vague guidance]
\`\`\`

Rules:
- 5-10 bullet points maximum. Quality over quantity.
- Each bullet must add real information — no filler.
- "Next session opens with" must be specific enough that the next Claude instance knows exactly what to do first.
- If nothing meaningful happened this session (no vault changes, short transcript), write a minimal update noting the session was brief.

Write ONLY the file content. No preamble. No explanation. Then write this exact line at the end:
WRITE_TO_FILE: ${join(vaultRoot, "self", "working-memory.md")}`;
}

// ─── Resolve claude binary (mirrors runner.ts pattern) ───────────────────────

function resolveClaudeBin(): string {
  if (process.env.INTENT_CLAUDE_PATH) return process.env.INTENT_CLAUDE_PATH;
  const home = process.env.HOME ?? "";
  const localBin = join(home, ".local", "bin", "claude");
  if (existsSync(localBin)) return localBin;
  return "claude"; // fallback to PATH
}

// ─── Background synthesis script writer ──────────────────────────────────────

/**
 * Write a self-contained synthesis script to a temp file and spawn it detached.
 * The script runs claude CLI, parses the WRITE_TO_FILE directive, writes the
 * updated working-memory.md, and commits it.
 *
 * Using a script file rather than inline args avoids shell quoting issues with
 * long prompts containing quotes, newlines, and special characters.
 */
function spawnSynthesisBackground(
  vaultRoot: string,
  prompt: string,
  claudeBin: string,
): void {
  // Write the prompt to a temp file the child script can read
  const promptFile = join(vaultRoot, "ops", ".synthesis-prompt.tmp");
  const scriptFile = join(vaultRoot, "ops", ".synthesis-runner.mjs");

  try {
    writeFileSync(promptFile, prompt, "utf-8");
  } catch {
    return; // Can't write temp files — skip synthesis
  }

  // Self-contained ESM script — no imports from the plugin package needed
  const script = `
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";

const VAULT_ROOT = ${JSON.stringify(vaultRoot)};
const CLAUDE_BIN = ${JSON.stringify(claudeBin)};
const PROMPT_FILE = ${JSON.stringify(promptFile)};
const WM_FILE = join(VAULT_ROOT, "self", "working-memory.md");

function cleanup() {
  try { rmSync(PROMPT_FILE); } catch {}
  try { rmSync(${JSON.stringify(scriptFile)}); } catch {}
}

async function main() {
  let prompt;
  try {
    prompt = readFileSync(PROMPT_FILE, "utf-8");
  } catch (e) {
    process.stderr.write("synthesis: could not read prompt file: " + e + "\\n");
    cleanup();
    return;
  }

  let output;
  try {
    const env = {
      ...process.env,
      INTENT_HEARTBEAT_DEPTH: String((parseInt(process.env.INTENT_HEARTBEAT_DEPTH ?? "0", 10) || 0) + 1),
    };
    delete env.CLAUDECODE;

    output = execFileSync(CLAUDE_BIN, [
      "--dangerously-skip-permissions",
      "-p",
      "--model", "sonnet",
      prompt,
    ], {
      encoding: "utf-8",
      timeout: 90_000,
      maxBuffer: 5 * 1024 * 1024,
      env,
    }).trim();
  } catch (e) {
    process.stderr.write("synthesis: claude CLI call failed: " + e + "\\n");
    cleanup();
    return;
  }

  // Parse the WRITE_TO_FILE directive
  const writeMarker = "WRITE_TO_FILE: " + WM_FILE;
  const markerIdx = output.indexOf(writeMarker);

  let content;
  if (markerIdx !== -1) {
    content = output.slice(0, markerIdx).trim();
  } else {
    // Fallback: use entire output if it looks like working memory content
    content = output.trim();
  }

  if (!content) {
    process.stderr.write("synthesis: empty output from claude — skipping write\\n");
    cleanup();
    return;
  }

  // Write working-memory.md
  try {
    writeFileSync(WM_FILE, content + "\\n", "utf-8");
  } catch (e) {
    process.stderr.write("synthesis: could not write working-memory.md: " + e + "\\n");
    cleanup();
    return;
  }

  // Commit the update
  try {
    execFileSync("git", ["-C", VAULT_ROOT, "add", WM_FILE], { stdio: "pipe", timeout: 5000 });
    const staged = execFileSync("git", ["-C", VAULT_ROOT, "diff", "--cached", "--name-only"], {
      encoding: "utf-8", stdio: "pipe", timeout: 5000,
    }).trim();
    if (staged) {
      execFileSync("git", ["-C", VAULT_ROOT, "commit", "-m", "session: synthesize working memory", "--no-verify"], {
        stdio: "pipe", timeout: 10000,
      });
    }
  } catch (e) {
    process.stderr.write("synthesis: git commit failed (non-fatal): " + e + "\\n");
  }

  cleanup();
  process.stderr.write("synthesis: working memory updated\\n");
}

main().catch(e => {
  process.stderr.write("synthesis: unhandled error: " + e + "\\n");
  cleanup();
});
`.trim();

  try {
    writeFileSync(scriptFile, script, "utf-8");
  } catch {
    try { writeFileSync(promptFile, ""); } catch {}
    return;
  }

  // Spawn detached — parent hook returns immediately
  try {
    const child = spawn(process.execPath, ["--input-type=module", scriptFile], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    // Spawn failed — non-fatal, capture commit already done
    try { writeFileSync(promptFile, ""); } catch {}
    try { writeFileSync(scriptFile, ""); } catch {}
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readStdin<SessionEndInput>();
  const vaultRoot = resolveVaultRoot(input.cwd);
  if (!vaultRoot) pass();

  // Phase 1: Git commit — always runs, must succeed
  sessionCapture(vaultRoot!);

  // Phase 2: Background synthesis — fire and forget
  try {
    const wmPath = join(vaultRoot!, "self", "working-memory.md");
    const goalsPath = join(vaultRoot!, "self", "goals.md");

    const currentWorkingMemory = existsSync(wmPath)
      ? readFileSync(wmPath, "utf-8").trim()
      : "";
    const currentGoals = existsSync(goalsPath)
      ? readFileSync(goalsPath, "utf-8").slice(0, 3000).trim()
      : "";

    const transcriptExcerpt = extractTranscript(input.transcript_path);

    // Only synthesize if there's something to work with
    if (transcriptExcerpt || currentWorkingMemory) {
      const prompt = buildSynthesisPrompt(
        vaultRoot!,
        transcriptExcerpt,
        currentWorkingMemory,
        currentGoals,
      );
      const claudeBin = resolveClaudeBin();
      spawnSynthesisBackground(vaultRoot!, prompt, claudeBin);
    }
  } catch {
    // Synthesis setup failed — non-fatal
  }

  pass();
}

main().catch((err) => {
  process.stderr.write(`session-end hook error: ${err}\n`);
  process.exit(0); // Don't block on errors
});
