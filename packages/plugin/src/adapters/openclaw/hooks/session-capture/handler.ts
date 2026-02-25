/**
 * session-capture handler — OpenClaw command:stop / command:reset hook
 *
 * On session end, stages and commits vault artifacts so nothing is lost.
 * Mirrors the logic in session-capture.ts but uses execSync instead of
 * the opencode $ shell helper.
 */

import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// ─── Vault detection (shared logic) ─────────────────────────────────────────

function checkDir(dir: string): string | null {
  if (existsSync(join(dir, ".arscontexta"))) return dir;
  if (existsSync(join(dir, "ops", "config.yaml"))) return dir;
  if (existsSync(join(dir, ".claude", "hooks", "session-orient.sh"))) return dir;
  return null;
}

function resolveVault(workspaceDir?: string): string | null {
  const envVault = process.env.INTENT_COMPUTER_VAULT;
  if (envVault && existsSync(envVault)) {
    const found = checkDir(envVault);
    if (found) return found;
  }
  if (workspaceDir) {
    const found = checkDir(workspaceDir);
    if (found) return found;
  }
  const home = process.env.HOME ?? "";
  for (const candidate of [
    join(home, "Mind"),
    join(home, "mind"),
    join(home, "Documents", "Mind"),
    join(home, "notes"),
  ]) {
    const found = checkDir(candidate);
    if (found) return found;
  }
  return null;
}

// ─── Git helpers ────────────────────────────────────────────────────────────

function isGitRepo(dir: string): boolean {
  try {
    execSync(`git -C "${dir}" rev-parse --git-dir`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitAdd(vaultRoot: string, path: string): void {
  try {
    execSync(`git -C "${vaultRoot}" add "${path}"`, { stdio: "ignore" });
  } catch {
    // Path may not exist -- fine
  }
}

function gitCommit(vaultRoot: string, message: string): boolean {
  try {
    const status = execSync(`git -C "${vaultRoot}" diff --cached --name-only`, {
      encoding: "utf-8",
    }).trim();
    if (!status) return false;

    execSync(`git -C "${vaultRoot}" commit -m "${message}" --no-verify`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface OpenClawEvent {
  type: string;
  action: string;
  sessionKey?: string;
  timestamp?: string;
  messages: Array<{ role?: string; content?: string }>;
  context: {
    sessionEntry?: unknown;
    workspaceDir?: string;
    bootstrapFiles?: Array<{ path: string; content: string }>;
    cfg?: Record<string, unknown>;
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(event: OpenClawEvent): Promise<void> {
  const vaultRoot = resolveVault(event.context.workspaceDir);
  if (!vaultRoot) return;
  if (!isGitRepo(vaultRoot)) return;

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

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
      gitAdd(vaultRoot, p);
    }
  }

  const committed = gitCommit(vaultRoot, `session: capture ${timestamp}`);

  if (committed) {
    event.messages.push({
      role: "system",
      content: `[intent-computer] Session captured and committed at ${timestamp}`,
    });
  }
}
