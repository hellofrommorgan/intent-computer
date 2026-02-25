#!/usr/bin/env npx tsx
/**
 * install.ts — Unified installer CLI for the intent-computer project.
 *
 * Detects or accepts the target platform and runs the appropriate installation.
 *
 * Usage:
 *   npx intent-computer install [options]
 *   npx tsx scripts/install.ts [options]
 *
 * Options:
 *   --opencode       Install as OpenCode plugin
 *   --claude-code    Install as Claude Code hooks
 *   --pi             Install as pi.dev extension
 *   --openclaw       Install as OpenClaw hook pack
 *   --vault <path>   Path to vault (default: ~/Mind)
 *   --detect         Auto-detect installed platforms
 *   --help           Show this help message
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

const HOME = homedir();

type Platform = "opencode" | "claude-code" | "pi" | "openclaw";

interface CLIOptions {
  platforms: Platform[];
  vault: string;
  detect: boolean;
  help: boolean;
}

// ---------------------------------------------------------------------------
// Arg parsing (zero dependencies)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    platforms: [],
    vault: join(HOME, "Mind"),
    detect: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--opencode":
        opts.platforms.push("opencode");
        break;
      case "--claude-code":
        opts.platforms.push("claude-code");
        break;
      case "--pi":
        opts.platforms.push("pi");
        break;
      case "--openclaw":
        opts.platforms.push("openclaw");
        break;
      case "--vault":
        i++;
        if (!argv[i]) {
          fatal("--vault requires a path argument");
        }
        opts.vault = argv[i].replace(/^~/, HOME);
        break;
      case "--detect":
        opts.detect = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "install":
        // Ignore the subcommand word itself (from `npx intent-computer install`)
        break;
      default:
        fatal(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function binaryExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectPlatforms(): Platform[] {
  const detected: Platform[] = [];

  // OpenCode: binary or opencode.json in cwd
  if (binaryExists("opencode") || existsSync(join(process.cwd(), "opencode.json"))) {
    detected.push("opencode");
  }

  // Claude Code: binary or .claude/ directory in cwd
  if (binaryExists("claude") || existsSync(join(process.cwd(), ".claude"))) {
    detected.push("claude-code");
  }

  // pi.dev: binary or .pi/ directory in cwd
  if (binaryExists("pi") || existsSync(join(process.cwd(), ".pi"))) {
    detected.push("pi");
  }

  // OpenClaw: binary or .openclaw/ in home
  if (binaryExists("openclaw") || existsSync(join(HOME, ".openclaw"))) {
    detected.push("openclaw");
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function run(cmd: string, opts?: ExecSyncOptions) {
  execSync(cmd, { stdio: "inherit", cwd: PROJECT_ROOT, ...opts });
}

function ensureBuilt() {
  const marker = join(PROJECT_ROOT, "packages", "plugin", "dist", "index.js");
  if (!existsSync(marker)) {
    info("Building project (first-time setup)...");
    run("pnpm install && pnpm run build");
  }
}

// -- OpenCode ---------------------------------------------------------------

function installOpenCode(vault: string) {
  info("Installing for OpenCode...");
  ensureBuilt();

  const configDir = join(process.cwd(), ".opencode");
  ensureDir(configDir);

  const config = {
    name: "intent-computer",
    description: "Intent Computer cognitive architecture plugin",
    vault,
    plugin: join(PROJECT_ROOT, "packages", "plugin", "dist", "index.js"),
    hooks: {
      "session:start": join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "session-capture.js"),
      "write:validate": join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "write-validate.js"),
    },
  };

  const configPath = join(configDir, "intent-computer.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  success("OpenCode plugin installed");
  next([
    `Config written to ${configPath}`,
    `Vault path: ${vault}`,
    "Restart OpenCode to activate the plugin.",
  ]);
}

// -- Claude Code ------------------------------------------------------------

function installClaudeCode(vault: string) {
  info("Installing for Claude Code...");
  ensureBuilt();

  const claudeDir = join(process.cwd(), ".claude");
  const hooksDir = join(claudeDir, "hooks");
  ensureDir(hooksDir);

  // Write hook entry points
  const sessionStartHook = `#!/usr/bin/env bash
# Intent Computer — session start hook
export INTENT_COMPUTER_VAULT="${vault}"
exec node "${join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "session-capture.js")}" "$@"
`;

  const writeValidateHook = `#!/usr/bin/env bash
# Intent Computer — write validation hook
export INTENT_COMPUTER_VAULT="${vault}"
exec node "${join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "write-validate.js")}" "$@"
`;

  const sessionContinuityHook = `#!/usr/bin/env bash
# Intent Computer — session continuity hook
export INTENT_COMPUTER_VAULT="${vault}"
exec node "${join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "session-continuity.js")}" "$@"
`;

  const hooks: Record<string, string> = {
    "session-start.sh": sessionStartHook,
    "write-validate.sh": writeValidateHook,
    "session-continuity.sh": sessionContinuityHook,
  };

  for (const [name, content] of Object.entries(hooks)) {
    const hookPath = join(hooksDir, name);
    writeFileSync(hookPath, content);
    chmodSync(hookPath, 0o755);
  }

  // Write settings if not present
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    const settings = {
      hooks: {
        SessionStart: [join(hooksDir, "session-start.sh")],
        PostToolUse: [join(hooksDir, "write-validate.sh")],
        Stop: [join(hooksDir, "session-continuity.sh")],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  success("Claude Code hooks installed");
  next([
    `Hooks written to ${hooksDir}`,
    `Vault path: ${vault}`,
    "Restart Claude Code to activate hooks.",
  ]);
}

// -- pi.dev -----------------------------------------------------------------

function installPi(vault: string) {
  info("Installing for pi.dev...");
  ensureBuilt();

  const piDir = join(process.cwd(), ".pi");
  const extDir = join(piDir, "extensions");
  ensureDir(extDir);

  const manifest = {
    name: "intent-computer",
    version: "0.1.0",
    description: "Intent Computer cognitive architecture extension",
    vault,
    entrypoint: join(PROJECT_ROOT, "packages", "plugin", "dist", "index.js"),
    capabilities: ["session-capture", "write-validate", "session-continuity"],
  };

  const manifestPath = join(extDir, "intent-computer.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  success("pi.dev extension installed");
  next([
    `Manifest written to ${manifestPath}`,
    `Vault path: ${vault}`,
    "Restart pi to load the extension.",
  ]);
}

// -- OpenClaw ---------------------------------------------------------------

function installOpenClaw(vault: string) {
  info("Installing for OpenClaw...");
  ensureBuilt();

  const openclawDir = join(HOME, ".openclaw", "hooks");
  ensureDir(openclawDir);

  const hookPack = {
    name: "intent-computer",
    version: "0.1.0",
    description: "Intent Computer cognitive architecture hook pack",
    vault,
    hooks: {
      "pre-session": join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "session-capture.js"),
      "post-write": join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "write-validate.js"),
      "post-session": join(PROJECT_ROOT, "packages", "plugin", "dist", "hooks", "session-continuity.js"),
    },
  };

  const packPath = join(openclawDir, "intent-computer.json");
  writeFileSync(packPath, JSON.stringify(hookPack, null, 2) + "\n");

  success("OpenClaw hook pack installed");
  next([
    `Hook pack written to ${packPath}`,
    `Vault path: ${vault}`,
    "Restart OpenClaw to load hooks.",
  ]);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function info(msg: string) {
  console.log(`\n  \x1b[36m>\x1b[0m ${msg}`);
}

function success(msg: string) {
  console.log(`  \x1b[32m+\x1b[0m ${msg}`);
}

function warn(msg: string) {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

function fatal(msg: string): never {
  console.error(`\n  \x1b[31mError:\x1b[0m ${msg}\n`);
  process.exit(1);
}

function next(steps: string[]) {
  console.log("\n  Next steps:");
  for (const step of steps) {
    console.log(`    - ${step}`);
  }
  console.log();
}

function printUsage() {
  console.log(`
  intent-computer install — Unified installer CLI

  Usage:
    npx intent-computer install [options]
    npx tsx scripts/install.ts [options]

  Options:
    --opencode       Install as OpenCode plugin
    --claude-code    Install as Claude Code hooks
    --pi             Install as pi.dev extension
    --openclaw       Install as OpenClaw hook pack
    --vault <path>   Path to vault (default: ~/Mind)
    --detect         Auto-detect installed platforms
    --help           Show this help message

  Examples:
    npx tsx scripts/install.ts --claude-code
    npx tsx scripts/install.ts --detect --vault ~/my-vault
    npx tsx scripts/install.ts --opencode --claude-code
`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const INSTALLERS: Record<Platform, (vault: string) => void> = {
  opencode: installOpenCode,
  "claude-code": installClaudeCode,
  pi: installPi,
  openclaw: installOpenClaw,
};

function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  // Auto-detect if requested or if no platforms specified
  if (opts.detect || opts.platforms.length === 0) {
    const detected = detectPlatforms();

    if (opts.detect) {
      info("Detected platforms:");
      if (detected.length === 0) {
        warn("No supported platforms detected.");
        console.log("    Use an explicit flag: --opencode, --claude-code, --pi, or --openclaw\n");
        process.exit(0);
      }
      for (const p of detected) {
        console.log(`    - ${p}`);
      }
      console.log();

      // If --detect was the only flag (no explicit platforms), use detected ones
      if (opts.platforms.length === 0) {
        opts.platforms = detected;
      }
    } else {
      // No flags at all — detect silently, or show help
      if (detected.length === 0) {
        printUsage();
        process.exit(0);
      }
      opts.platforms = detected;
      info(`Auto-detected: ${detected.join(", ")}`);
    }
  }

  // Deduplicate
  opts.platforms = [...new Set(opts.platforms)];

  // Run installers
  for (const platform of opts.platforms) {
    const installer = INSTALLERS[platform];
    if (!installer) {
      fatal(`No installer for platform: ${platform}`);
    }
    installer(opts.vault);
  }

  if (opts.platforms.length > 1) {
    success(`Installed for ${opts.platforms.length} platforms: ${opts.platforms.join(", ")}`);
  }
}

main();
