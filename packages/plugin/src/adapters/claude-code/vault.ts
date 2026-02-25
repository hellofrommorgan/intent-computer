/**
 * vault.ts — Vault detection for Claude Code hooks
 *
 * Resolves the vault root path from environment variable or auto-detection.
 * Standalone scripts can't rely on the plugin's runtime state, so each
 * hook handler calls this to find the vault.
 */

import { existsSync } from "fs";
import { join } from "path";

/**
 * Resolve the vault root. Priority:
 *   1. INTENT_COMPUTER_VAULT env var
 *   2. cwd passed from Claude Code hook stdin
 *   3. Canonical locations (~/{Mind,mind}, ~/Documents/Mind, ~/notes)
 *
 * Returns null if no vault is found.
 */
export function resolveVaultRoot(cwd?: string): string | null {
  // 1. Explicit env var
  const envVault = process.env.INTENT_COMPUTER_VAULT;
  if (envVault && isVaultDir(envVault)) return envVault;

  // 2. cwd from hook input
  if (cwd && isVaultDir(cwd)) return cwd;

  // 3. Canonical locations
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, "Mind"),
    join(home, "mind"),
    join(home, "Documents", "Mind"),
    join(home, "notes"),
  ];
  for (const candidate of candidates) {
    if (isVaultDir(candidate)) return candidate;
  }

  return null;
}

function isVaultDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  if (existsSync(join(dir, ".arscontexta"))) return true;
  if (existsSync(join(dir, "ops", "config.yaml"))) return true;
  if (existsSync(join(dir, ".claude", "hooks", "session-orient.sh"))) return true;
  return false;
}
