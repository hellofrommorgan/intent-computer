#!/usr/bin/env npx tsx
/**
 * install-pi.ts — Install intent-computer as a pi.dev extension.
 *
 * Usage:
 *   npx tsx scripts/install-pi.ts [--global | --project]
 *
 * Flags:
 *   --global   Install to ~/.pi/agent/extensions/intent-computer/ (default)
 *   --project  Install to .pi/extensions/intent-computer/ in the current directory
 *
 * What it does:
 *   1. Detects the vault path (~/Mind or other canonical locations)
 *   2. Creates the extension directory
 *   3. Writes an index.ts wrapper that imports from the package source
 *   4. Prints success message with next steps
 */

import { existsSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";

// ─── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isProject = args.includes("--project");
const isGlobal = args.includes("--global") || !isProject;

// ─── Vault detection ─────────────────────────────────────────────────────────

function detectVault(): string | null {
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, "Mind"),
    join(home, "mind"),
    join(home, "Documents", "Mind"),
    join(home, "notes"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, ".arscontexta"))) return candidate;
    if (existsSync(join(candidate, "ops", "config.yaml"))) return candidate;
  }

  return null;
}

// ─── Resolve paths ───────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const ADAPTER_SOURCE = join(
  PACKAGE_ROOT,
  "packages",
  "plugin",
  "src",
  "adapters",
  "pi-dev",
  "index.ts",
);

const home = process.env.HOME ?? "";
const targetDir = isGlobal
  ? join(home, ".pi", "agent", "extensions", "intent-computer")
  : join(process.cwd(), ".pi", "extensions", "intent-computer");

// ─── Verify source exists ────────────────────────────────────────────────────

if (!existsSync(ADAPTER_SOURCE)) {
  console.error(
    `Error: Adapter source not found at ${ADAPTER_SOURCE}`,
  );
  console.error(
    "Make sure you're running this from the intent-computer project root.",
  );
  process.exit(1);
}

// ─── Create extension directory ──────────────────────────────────────────────

mkdirSync(targetDir, { recursive: true });

// ─── Strategy: symlink the adapter source ────────────────────────────────────
// pi.dev loads extensions via jiti which handles TypeScript natively.
// We symlink the source file so updates to the package propagate automatically.

const targetIndex = join(targetDir, "index.ts");

// Write a thin wrapper that re-exports from the symlinked source.
// This approach is more robust than a raw symlink because it handles
// the case where the extension directory needs its own package.json
// or additional configuration later.

const wrapperContent = `/**
 * intent-computer pi.dev extension — auto-generated wrapper.
 *
 * This file re-exports the pi.dev adapter from the intent-computer package.
 * Do not edit — it will be overwritten by \`npx tsx scripts/install-pi.ts\`.
 *
 * Source: ${ADAPTER_SOURCE}
 * Generated: ${new Date().toISOString()}
 */

// jiti resolves TypeScript imports natively — no build step needed.
export { default } from "${ADAPTER_SOURCE}";
`;

writeFileSync(targetIndex, wrapperContent, "utf-8");

// ─── Vault detection results ─────────────────────────────────────────────────

const vaultPath = detectVault();

// ─── Success output ──────────────────────────────────────────────────────────

console.log("");
console.log("intent-computer pi.dev extension installed successfully.");
console.log("");
console.log(`  Extension: ${targetIndex}`);
console.log(`  Source:    ${ADAPTER_SOURCE}`);
console.log(`  Mode:      ${isGlobal ? "global (~/.pi/agent/extensions/)" : "project (.pi/extensions/)"}`);

if (vaultPath) {
  console.log(`  Vault:     ${vaultPath}`);
} else {
  console.log(`  Vault:     not detected — run /setup in pi.dev to initialize`);
}

console.log("");
console.log("Next steps:");
console.log("  1. Start pi.dev — the extension loads automatically");
console.log("  2. Use /help to see available commands");
if (!vaultPath) {
  console.log("  3. Use /setup to initialize your knowledge vault");
}
console.log("");
