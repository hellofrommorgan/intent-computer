/**
 * session-orient handler — OpenClaw agent:bootstrap hook
 *
 * Injects vault context into the agent's bootstrap files so the agent
 * starts each session with warm context: identity, goals, working memory.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ─── Vault detection (mirrors vaultguard.ts logic) ──────────────────────────

function checkDir(dir: string): string | null {
  if (existsSync(join(dir, ".arscontexta"))) return dir;
  if (existsSync(join(dir, "ops", "config.yaml"))) return dir;
  if (existsSync(join(dir, ".claude", "hooks", "session-orient.sh"))) return dir;
  return null;
}

function resolveVault(workspaceDir?: string): string | null {
  // 1. Explicit env var
  const envVault = process.env.INTENT_COMPUTER_VAULT;
  if (envVault && existsSync(envVault)) {
    const found = checkDir(envVault);
    if (found) return found;
  }

  // 2. Workspace dir (if OpenClaw provides it)
  if (workspaceDir) {
    const found = checkDir(workspaceDir);
    if (found) return found;
  }

  // 3. Canonical and fallback locations
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

// ─── File reading ───────────────────────────────────────────────────────────

function safeRead(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface BootstrapFile {
  path: string;
  content: string;
}

interface OpenClawEvent {
  type: string;
  action: string;
  sessionKey?: string;
  timestamp?: string;
  messages: Array<{ role?: string; content?: string }>;
  context: {
    sessionEntry?: unknown;
    workspaceDir?: string;
    bootstrapFiles?: BootstrapFile[];
    cfg?: Record<string, unknown>;
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(event: OpenClawEvent): Promise<void> {
  const vaultRoot = resolveVault(event.context.workspaceDir);
  if (!vaultRoot) return;

  // Ensure bootstrapFiles array exists
  if (!event.context.bootstrapFiles) {
    event.context.bootstrapFiles = [];
  }

  // Core context files to inject, in reading order
  const contextFiles: Array<{ relativePath: string; label: string }> = [
    { relativePath: "self/identity.md", label: "Agent Identity" },
    { relativePath: "self/goals.md", label: "Current Goals" },
    { relativePath: "self/working-memory.md", label: "Working Memory" },
    { relativePath: "ops/morning-brief.md", label: "Morning Brief" },
    { relativePath: "ops/reminders.md", label: "Reminders" },
  ];

  for (const { relativePath, label } of contextFiles) {
    const fullPath = join(vaultRoot, relativePath);
    const content = safeRead(fullPath);
    if (content) {
      event.context.bootstrapFiles.push({
        path: fullPath,
        content: `<!-- ${label} -->\n${content}`,
      });
    }
  }

  // Also inject the CLAUDE.md / system context if it exists in the vault
  const systemContext = safeRead(join(vaultRoot, "CLAUDE.md"));
  if (systemContext) {
    event.context.bootstrapFiles.push({
      path: join(vaultRoot, "CLAUDE.md"),
      content: systemContext,
    });
  }

  // Surface a brief orient message
  const goalsContent = safeRead(join(vaultRoot, "self", "goals.md"));
  const activeThread = extractActiveThread(goalsContent ?? "");
  if (activeThread) {
    event.messages.push({
      role: "system",
      content: `[intent-computer] Session oriented. Vault: ${vaultRoot}. Active thread: ${activeThread}`,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractActiveThread(goals: string): string | null {
  const threadsSection = goals.match(/## Active Threads\n([\s\S]*?)(?=\n##|$)/)?.[1] ?? "";
  const firstThread = threadsSection.match(/^- \*\*(.+?)\*\* — (.+?)(?:\n|$)/m);
  if (!firstThread) return null;
  return `${firstThread[1]}: ${firstThread[2]}`;
}
