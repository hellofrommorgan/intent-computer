/**
 * auto-commit.ts
 *
 * Async post-write commit. Stages and commits vault changes after every Write to a note path.
 * Equivalent to ars-contexta's auto-commit.sh (async: true).
 *
 * Runs non-blocking — caller does not await this. Failures are swallowed.
 *
 * Commit message format: "auto: update N note(s) — [filenames]"
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { join } from "path";
import { isNotePath, toAbsoluteVaultPath } from "../tools/vaultguard.js";

export async function autoCommit(
  vaultRoot: string,
  changedFile: string,
  $: PluginInput["$"]
): Promise<void> {
  if (!isNotePath(changedFile)) return;
  const absoluteChangedFile = toAbsoluteVaultPath(vaultRoot, changedFile);
  if (!absoluteChangedFile.startsWith(vaultRoot)) return;

  // Verify this is a git repo
  try {
    await $`git -C ${vaultRoot} rev-parse --git-dir`.quiet();
  } catch {
    return; // Not a git repo — skip silently
  }

  // Stage changed note plus key vault state files.
  const paths = [absoluteChangedFile, join(vaultRoot, "self"), join(vaultRoot, "ops"), join(vaultRoot, "inbox")];

  for (const p of paths) {
    try {
      await $`git -C ${vaultRoot} add ${p}`.quiet();
    } catch {
      // Path may not exist — fine
    }
  }

  // Check if there's anything to commit
  const status = await $`git -C ${vaultRoot} diff --cached --name-only`.text();
  if (!status.trim()) return;

  const changedFiles = status.trim().split("\n");
  const count = changedFiles.length;
  const names = changedFiles.slice(0, 3).map((f: string) => f.split("/").pop()).join(", ");
  const suffix = count > 3 ? ` +${count - 3} more` : "";
  const message = `auto: update ${count} note(s) — ${names}${suffix}`;

  try {
    await $`git -C ${vaultRoot} commit -m ${message} --no-verify`.quiet();
  } catch {
    // Commit failure (e.g. nothing staged, pre-commit hook failed) — swallow
  }
}
