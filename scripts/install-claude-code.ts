#!/usr/bin/env npx tsx
/**
 * install-claude-code.ts — CLI entry point for installing Claude Code hooks
 *
 * Usage:
 *   npx tsx scripts/install-claude-code.ts [--vault /path/to/vault] [--project /path/to/project]
 *
 * Options:
 *   --vault    Path to the vault root (default: auto-detect from INTENT_COMPUTER_VAULT or canonical locations)
 *   --project  Path to the project where .claude/settings.json should be written (default: cwd)
 *
 * Example:
 *   npx tsx scripts/install-claude-code.ts --vault ~/Mind --project ~/Projects/my-project
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

// ─── Vault detection (inlined to keep the script self-contained) ─────────────

function isVaultDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  if (existsSync(join(dir, ".arscontexta"))) return true;
  if (existsSync(join(dir, "ops", "config.yaml"))) return true;
  if (existsSync(join(dir, ".claude", "hooks", "session-orient.sh"))) return true;
  return false;
}

function resolveVaultRoot(explicit?: string): string | null {
  if (explicit && isVaultDir(explicit)) return explicit;

  const envVault = process.env.INTENT_COMPUTER_VAULT;
  if (envVault && isVaultDir(envVault)) return envVault;

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

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(): { vault?: string; project?: string } {
  const args = process.argv.slice(2);
  const result: { vault?: string; project?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      result.vault = resolve(args[++i]);
    } else if (args[i] === "--project" && args[i + 1]) {
      result.project = resolve(args[++i]);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx scripts/install-claude-code.ts [--vault PATH] [--project PATH]");
      console.log("");
      console.log("Options:");
      console.log("  --vault    Path to vault root (default: auto-detect)");
      console.log("  --project  Path to project dir for .claude/settings.json (default: cwd)");
      process.exit(0);
    }
  }
  return result;
}

// ─── Hook configuration generation ──────────────────────────────────────────

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
  hooks: Record<string, HookMatcher[]>;
}

function generateHooksConfig(adapterDir: string, vaultPath: string): HooksConfig {
  const envPrefix = `INTENT_COMPUTER_VAULT=${vaultPath} `;

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

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs();

  const vaultRoot = resolveVaultRoot(args.vault);
  if (!vaultRoot) {
    console.error("Error: Could not detect vault.");
    console.error("  Pass --vault /path/to/vault or set INTENT_COMPUTER_VAULT env var.");
    console.error("");
    console.error("  The vault must have one of:");
    console.error("    - .arscontexta marker file");
    console.error("    - ops/config.yaml");
    console.error("    - .claude/hooks/session-orient.sh");
    process.exit(1);
  }

  const projectDir = args.project ?? process.cwd();

  // Resolve the adapter source directory relative to this script
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const adapterDir = join(scriptDir, "..", "packages", "plugin", "src", "adapters", "claude-code");

  // Verify the adapter directory exists
  if (!existsSync(adapterDir)) {
    console.error(`Error: Adapter directory not found at ${adapterDir}`);
    console.error("  Make sure you are running this from the intent-computer project root.");
    process.exit(1);
  }

  const hooksConfig = generateHooksConfig(adapterDir, vaultRoot);

  // Read existing settings.json
  const settingsPath = join(projectDir, ".claude", "settings.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (err) {
      console.warn(`Warning: could not parse existing ${settingsPath}: ${err}`);
      console.warn("  The hooks section will be overwritten.");
    }
  }

  // Merge: preserve all existing settings, replace hooks
  const merged = {
    ...existing,
    hooks: {
      ...((existing.hooks as Record<string, unknown>) ?? {}),
      ...hooksConfig.hooks,
    },
  };

  // Write
  const settingsDir = dirname(settingsPath);
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  // Success output
  console.log("");
  console.log("Intent Computer hooks installed for Claude Code.");
  console.log("");
  console.log(`  Settings: ${settingsPath}`);
  console.log(`  Vault:    ${vaultRoot}`);
  console.log("");
  console.log("  Hooks configured:");
  console.log("    SessionStart  -> Injects vault context (identity, goals, working-memory)");
  console.log("    PostToolUse   -> Write validation + auto-commit (Write|Edit tools)");
  console.log("    SessionEnd    -> Session capture (git commit artifacts)");
  console.log("");
  console.log("  Restart Claude Code to activate.");
  console.log("");
}

main();
