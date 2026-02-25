#!/usr/bin/env npx tsx
/**
 * install.ts — Generate Claude Code hooks configuration
 *
 * Reads existing .claude/settings.json (if any), merges in the hook
 * definitions, and writes the result. Can be run from the install-claude-code
 * CLI script or standalone.
 *
 * Usage:
 *   npx tsx install.ts [--vault /path/to/vault] [--project /path/to/project]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { resolveVaultRoot } from "./vault.js";

interface HookEntry {
  type: "command";
  command: string;
  timeout: number;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface HooksConfig {
  hooks: {
    SessionStart?: HookMatcher[];
    PreToolUse?: HookMatcher[];
    PostToolUse?: HookMatcher[];
    Stop?: HookMatcher[];
    SessionEnd?: HookMatcher[];
  };
}

function parseArgs(): { vault?: string; project?: string } {
  const args = process.argv.slice(2);
  const result: { vault?: string; project?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      result.vault = resolve(args[++i]);
    } else if (args[i] === "--project" && args[i + 1]) {
      result.project = resolve(args[++i]);
    }
  }
  return result;
}

export function generateHooksConfig(adapterDir: string, vaultPath?: string): HooksConfig {
  // Build the command prefix. We set INTENT_COMPUTER_VAULT if provided.
  const envPrefix = vaultPath ? `INTENT_COMPUTER_VAULT=${vaultPath} ` : "";

  return {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `${envPrefix}npx tsx ${join(adapterDir, "session-start.ts")}`,
              timeout: 30,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [
            {
              type: "command",
              command: `${envPrefix}npx tsx ${join(adapterDir, "post-tool-use.ts")}`,
              timeout: 15,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `${envPrefix}npx tsx ${join(adapterDir, "session-end.ts")}`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
}

export function mergeSettings(
  existing: Record<string, unknown>,
  hooksConfig: HooksConfig,
): Record<string, unknown> {
  return {
    ...existing,
    hooks: {
      ...((existing.hooks as Record<string, unknown>) ?? {}),
      ...hooksConfig.hooks,
    },
  };
}

function main(): void {
  const args = parseArgs();

  // Resolve vault
  if (args.vault) {
    process.env.INTENT_COMPUTER_VAULT = args.vault;
  }
  const vaultRoot = args.vault ?? resolveVaultRoot();
  if (!vaultRoot) {
    console.error("Could not detect vault. Pass --vault /path/to/vault or set INTENT_COMPUTER_VAULT.");
    process.exit(1);
  }

  // Resolve project directory (where .claude/settings.json lives)
  const projectDir = args.project ?? process.cwd();

  // The adapter source directory (where the hook scripts live)
  const adapterDir = dirname(new URL(import.meta.url).pathname);

  const hooksConfig = generateHooksConfig(adapterDir, vaultRoot);

  // Read existing settings
  const settingsPath = join(projectDir, ".claude", "settings.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.warn(`Warning: could not parse existing ${settingsPath}, overwriting hooks section.`);
    }
  }

  const merged = mergeSettings(existing, hooksConfig);

  // Write
  const settingsDir = dirname(settingsPath);
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  console.log(`Intent Computer hooks installed to ${settingsPath}`);
  console.log(`  Vault: ${vaultRoot}`);
  console.log(`  Hooks:`);
  console.log(`    SessionStart  -> session-start.ts`);
  console.log(`    PostToolUse   -> post-tool-use.ts (Write|Edit)`);
  console.log(`    SessionEnd    -> session-end.ts`);
  console.log(`\nRestart Claude Code to activate.`);
}

// Run if executed directly
if (import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, "") ?? "")) {
  main();
}

export { main as install };
