/**
 * vaultguard.ts
 *
 * Vault detection utility. All hooks short-circuit immediately in non-vault contexts.
 * Equivalent to ars-contexta's vaultguard.sh.
 *
 * Detection logic (in priority order):
 *   1. .arscontexta marker file at worktree root
 *   2. ops/config.yaml exists (auto-migration from old vaults)
 *   3. .claude/hooks/session-orient.sh exists (legacy Claude Code vault)
 *
 * Returns the vault root path if a vault is detected, null otherwise.
 */

import { existsSync } from "fs";
import { isAbsolute, join, normalize, resolve } from "path";

function checkDir(dir: string): string | null {
  if (existsSync(join(dir, ".arscontexta"))) return dir;
  if (existsSync(join(dir, "ops", "config.yaml"))) return dir;
  if (existsSync(join(dir, ".claude", "hooks", "session-orient.sh"))) return dir;
  return null;
}

export async function isVault(worktree: string): Promise<string | null> {
  // Primary: check the current project worktree
  const fromWorktree = checkDir(worktree);
  if (fromWorktree) return fromWorktree;

  // Fallback: check canonical vault locations regardless of current project.
  // The vault (~/Mind) is global — it should activate in any opencode session.
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, "Mind"),
    join(home, "mind"),
    join(home, "Documents", "Mind"),
    join(home, "notes"),
  ];
  for (const candidate of candidates) {
    const found = checkDir(candidate);
    if (found) return found;
  }

  return null;
}

export function isNotePath(filePath: string): boolean {
  const normalized = normalize(filePath).replaceAll("\\", "/");
  return ["/thoughts/", "/inbox/", "/notes/", "/thinking/", "/claims/"].some((segment) =>
    normalized.includes(segment)
  );
}

export function toAbsoluteVaultPath(vaultRoot: string, filePath: string): string {
  if (isAbsolute(filePath)) return normalize(filePath);
  return resolve(vaultRoot, filePath);
}
