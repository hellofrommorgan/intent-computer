#!/usr/bin/env npx tsx
/**
 * post-tool-use.ts — Claude Code PostToolUse hook handler
 *
 * Runs after Write|Edit tools. Performs:
 *   1. Write validation (schema checks on vault thoughts)
 *   2. Auto-commit (stages and commits vault changes)
 *
 * Returns validation warnings as additionalContext.
 */

import { existsSync } from "fs";
import { join, isAbsolute, normalize } from "path";
import { execFileSync } from "child_process";
import { readStdin } from "./stdin.js";
import { succeed, pass } from "./output.js";
import { resolveVaultRoot } from "./vault.js";
import { writeValidate } from "../../hooks/write-validate.js";
import type { PostToolUseInput } from "./types.js";

/** Extract the file path from Write or Edit tool_input. */
function extractFilePath(toolInput: Record<string, unknown>): string | null {
  // Write tool uses "file_path", Edit tool uses "file_path"
  const filePath = toolInput.file_path ?? toolInput.filePath ?? toolInput.path;
  return typeof filePath === "string" ? filePath : null;
}

/** Check if a file path is inside the vault. */
function isInVault(filePath: string, vaultRoot: string): boolean {
  const normalized = isAbsolute(filePath) ? normalize(filePath) : normalize(join(process.cwd(), filePath));
  return normalized.startsWith(vaultRoot);
}

/** Check if the file is in a note directory (thoughts/, inbox/, etc.) */
function isNotePath(filePath: string): boolean {
  const normalized = normalize(filePath).replaceAll("\\", "/");
  return ["/thoughts/", "/inbox/", "/notes/", "/thinking/", "/claims/"].some(
    (segment) => normalized.includes(segment),
  );
}

/** Simple auto-commit: stage and commit vault changes. */
function autoCommit(vaultRoot: string, filePath: string): void {
  try {
    // Verify git repo
    execFileSync("git", ["-C", vaultRoot, "rev-parse", "--git-dir"], {
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    return; // Not a git repo
  }

  // Stage the changed file plus key vault state dirs
  const paths = [filePath, join(vaultRoot, "self"), join(vaultRoot, "ops"), join(vaultRoot, "inbox")];
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        execFileSync("git", ["-C", vaultRoot, "add", p], {
          stdio: "pipe",
          timeout: 5000,
        });
      }
    } catch {
      // Path may not exist
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

  const changedFiles = status.split("\n");
  const count = changedFiles.length;
  const names = changedFiles.slice(0, 3).map(f => f.split("/").pop()).join(", ");
  const suffix = count > 3 ? ` +${count - 3} more` : "";
  const message = `auto: update ${count} note(s) -- ${names}${suffix}`;

  try {
    execFileSync("git", ["-C", vaultRoot, "commit", "-m", message, "--no-verify"], {
      stdio: "pipe",
      timeout: 10000,
    });
  } catch {
    // Swallow commit failures
  }
}

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseInput>();
  const vaultRoot = resolveVaultRoot(input.cwd);
  if (!vaultRoot) pass();

  const filePath = extractFilePath(input.tool_input);
  if (!filePath) pass();

  const absolutePath = isAbsolute(filePath!)
    ? filePath!
    : normalize(join(input.cwd, filePath!));

  if (!isInVault(absolutePath, vaultRoot!)) pass();

  // 1. Write validation (only for note paths ending in .md)
  let warnings: string | null = null;
  if (absolutePath.endsWith(".md") && isNotePath(absolutePath)) {
    warnings = await writeValidate(absolutePath);
  }

  // 2. Auto-commit (for any vault file that's a note)
  if (isNotePath(absolutePath)) {
    autoCommit(vaultRoot!, absolutePath);
  }

  if (warnings) {
    succeed(warnings);
  } else {
    pass();
  }
}

main().catch((err) => {
  process.stderr.write(`post-tool-use hook error: ${err}\n`);
  process.exit(0); // Don't block on errors
});
