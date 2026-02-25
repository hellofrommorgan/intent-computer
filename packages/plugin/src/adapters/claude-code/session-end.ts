#!/usr/bin/env npx tsx
/**
 * session-end.ts — Claude Code SessionEnd hook handler
 *
 * Runs session capture: stages and commits session artifacts (observations,
 * goals, working-memory, methodology) to git.
 *
 * This replaces the OpenCode `session.deleted` event handler for session capture.
 * Note: session-continuity (LLM-based working memory update) is NOT included
 * here because Claude Code hooks don't have access to an LLM client. That
 * functionality would need a separate mechanism.
 */

import { existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { readStdin } from "./stdin.js";
import { pass } from "./output.js";
import { resolveVaultRoot } from "./vault.js";
import type { SessionEndInput } from "./types.js";

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

async function main(): Promise<void> {
  const input = await readStdin<SessionEndInput>();
  const vaultRoot = resolveVaultRoot(input.cwd);
  if (!vaultRoot) pass();

  sessionCapture(vaultRoot!);
  pass();
}

main().catch((err) => {
  process.stderr.write(`session-end hook error: ${err}\n`);
  process.exit(0); // Don't block on errors
});
