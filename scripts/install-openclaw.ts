#!/usr/bin/env npx tsx
/**
 * install-openclaw.ts
 *
 * CLI installer for intent-computer OpenClaw hooks.
 *
 * Usage:
 *   npx tsx scripts/install-openclaw.ts [--vault /path/to/vault]
 *
 * What it does:
 *   1. Detects the vault path (env var, flag, or auto-detection)
 *   2. Copies hook directories to ~/.openclaw/hooks/
 *   3. Prints success message with activation instructions
 */

import { existsSync, mkdirSync, cpSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ──────────────────────────────────────────────────────────────

const HOOK_NAMES = ["session-orient", "write-validate", "session-capture"];
const OPENCLAW_HOOKS_DIR = join(process.env.HOME ?? "", ".openclaw", "hooks");

// Source hooks live relative to this script
const HOOKS_SOURCE = resolve(
  __dirname,
  "..",
  "packages",
  "plugin",
  "src",
  "adapters",
  "openclaw",
  "hooks"
);

// ─── Vault detection ────────────────────────────────────────────────────────

function checkDir(dir: string): string | null {
  if (existsSync(join(dir, ".arscontexta"))) return dir;
  if (existsSync(join(dir, "ops", "config.yaml"))) return dir;
  if (existsSync(join(dir, ".claude", "hooks", "session-orient.sh"))) return dir;
  return null;
}

function resolveVault(explicit?: string): string | null {
  // 1. Explicit flag
  if (explicit) {
    const resolved = resolve(explicit);
    if (existsSync(resolved)) {
      const found = checkDir(resolved);
      if (found) return found;
    }
    // Even if not a vault yet, trust the user
    if (existsSync(resolved)) return resolved;
  }

  // 2. Env var
  const envVault = process.env.INTENT_COMPUTER_VAULT;
  if (envVault && existsSync(envVault)) {
    const found = checkDir(envVault);
    if (found) return found;
  }

  // 3. Auto-detect
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

// ─── CLI arg parsing ────────────────────────────────────────────────────────

function parseArgs(): { vault?: string; help: boolean } {
  const args = process.argv.slice(2);
  let vault: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      vault = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      help = true;
    }
  }

  return { vault, help };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const { vault: vaultFlag, help } = parseArgs();

  if (help) {
    console.log(`
intent-computer OpenClaw Hook Installer

Usage:
  npx tsx scripts/install-openclaw.ts [--vault /path/to/vault]

Options:
  --vault PATH    Explicit vault path (default: auto-detect)
  --help, -h      Show this help

Environment:
  INTENT_COMPUTER_VAULT    Vault path override

The installer copies hook directories to ~/.openclaw/hooks/ and
configures them to work with your vault.
`);
    process.exit(0);
  }

  // Verify source hooks exist
  if (!existsSync(HOOKS_SOURCE)) {
    console.error(`Error: Hook source directory not found at ${HOOKS_SOURCE}`);
    console.error("Make sure you're running this from the intent-computer project root.");
    process.exit(1);
  }

  // Detect vault
  const vaultRoot = resolveVault(vaultFlag);
  if (!vaultRoot) {
    console.error("Error: Could not detect a vault.");
    console.error("Either:");
    console.error("  - Set INTENT_COMPUTER_VAULT environment variable");
    console.error("  - Pass --vault /path/to/vault");
    console.error("  - Ensure ~/Mind/ exists with a .arscontexta marker");
    process.exit(1);
  }

  console.log(`Vault detected: ${vaultRoot}`);
  console.log(`Installing hooks to: ${OPENCLAW_HOOKS_DIR}`);
  console.log();

  // Ensure target directory exists
  mkdirSync(OPENCLAW_HOOKS_DIR, { recursive: true });

  // Copy each hook
  let installed = 0;
  for (const hookName of HOOK_NAMES) {
    const src = join(HOOKS_SOURCE, hookName);
    const dest = join(OPENCLAW_HOOKS_DIR, `intent-computer-${hookName}`);

    if (!existsSync(src)) {
      console.warn(`  Warning: source hook not found: ${src}`);
      continue;
    }

    // Remove existing if present
    if (existsSync(dest)) {
      cpSync(src, dest, { recursive: true, force: true });
      console.log(`  Updated: ${hookName} -> ${dest}`);
    } else {
      cpSync(src, dest, { recursive: true });
      console.log(`  Installed: ${hookName} -> ${dest}`);
    }
    installed++;
  }

  console.log();

  if (installed === 0) {
    console.error("No hooks were installed. Check the source directory.");
    process.exit(1);
  }

  console.log(`Done. ${installed} hook(s) installed.`);
  console.log();
  console.log("To configure vault path, set in your shell profile:");
  console.log(`  export INTENT_COMPUTER_VAULT="${vaultRoot}"`);
  console.log();
  console.log("Hooks will activate on next OpenClaw session.");
  console.log();
  console.log("Installed hooks:");
  console.log("  session-orient   -- injects vault context on agent bootstrap");
  console.log("  write-validate   -- validates frontmatter + auto-commits after writes");
  console.log("  session-capture  -- commits vault state on session end");
}

main();
