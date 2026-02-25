#!/usr/bin/env npx tsx
/**
 * session-start.ts — Claude Code SessionStart hook handler
 *
 * Reads vault context (identity, goals, working-memory, morning-brief) and
 * outputs it as additionalContext so Claude starts the session oriented.
 *
 * This replaces the OpenCode `experimental.chat.system.transform` hook.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { readStdin } from "./stdin.js";
import { succeed, pass } from "./output.js";
import { resolveVaultRoot } from "./vault.js";
import type { SessionStartInput } from "./types.js";

function readFileSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8").trim() : null;
  } catch {
    return null;
  }
}

function countMdFiles(dir: string): number {
  try {
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")).length : 0;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const input = await readStdin<SessionStartInput>();
  const vaultRoot = resolveVaultRoot(input.cwd);
  if (!vaultRoot) pass();

  const sections: string[] = [];

  // Identity
  const identityPaths = [
    join(vaultRoot!, "self", "identity.md"),
    join(vaultRoot!, "ops", "identity.md"),
    join(vaultRoot!, "identity.md"),
  ];
  for (const p of identityPaths) {
    const content = readFileSafe(p);
    if (content) {
      sections.push(`## Identity\n\n${content}`);
      break;
    }
  }

  // Goals
  const goalsPaths = [
    join(vaultRoot!, "self", "goals.md"),
    join(vaultRoot!, "ops", "goals.md"),
  ];
  for (const p of goalsPaths) {
    const content = readFileSafe(p);
    if (content) {
      sections.push(`## Goals\n\n${content}`);
      break;
    }
  }

  // Working memory
  const wmPaths = [
    join(vaultRoot!, "self", "working-memory.md"),
    join(vaultRoot!, "ops", "working-memory.md"),
  ];
  for (const p of wmPaths) {
    const content = readFileSafe(p);
    if (content) {
      sections.push(`## Working Memory\n\n${content}`);
      break;
    }
  }

  // Morning brief
  const briefContent = readFileSafe(join(vaultRoot!, "ops", "morning-brief.md"));
  if (briefContent) {
    sections.push(`## Morning Brief\n\n${briefContent}`);
  }

  // Maintenance signals
  const signals: string[] = [];
  const inboxCount = countMdFiles(join(vaultRoot!, "inbox"));
  if (inboxCount >= 3) signals.push(`${inboxCount} inbox items waiting for processing`);

  const obsCount = countMdFiles(join(vaultRoot!, "ops", "observations"));
  if (obsCount >= 10) signals.push(`${obsCount} pending observations`);

  const tensionCount = countMdFiles(join(vaultRoot!, "ops", "tensions"));
  if (tensionCount >= 5) signals.push(`${tensionCount} pending tensions`);

  if (signals.length > 0) {
    sections.push(`## Maintenance Conditions\n\n${signals.map(s => `- CONDITION: ${s}`).join("\n")}`);
  }

  // Reminders
  const reminders = readFileSafe(join(vaultRoot!, "ops", "reminders.md"));
  if (reminders) {
    sections.push(`## Reminders\n\n${reminders}`);
  }

  if (sections.length === 0) pass();

  const context = `# Intent Computer — Vault Context\n\nVault: ${vaultRoot}\n\n${sections.join("\n\n---\n\n")}`;
  succeed(context);
}

main().catch((err) => {
  process.stderr.write(`session-start hook error: ${err}\n`);
  process.exit(0); // Don't block session on errors
});
