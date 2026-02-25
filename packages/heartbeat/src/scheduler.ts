/**
 * scheduler.ts — launchd integration for event-driven heartbeat
 *
 * Instead of constant polling, uses two calendar-based launchd jobs:
 *   - Morning (6:00 AM): Full heartbeat — phases 5a,5b,5c,6,7
 *   - Evening (9:00 PM): Full heartbeat — phases 5a,5b,5c,6,7
 *
 * Session-end processing is handled separately by the plugin.
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// ─── Labels ──────────────────────────────────────────────────────────────────

const LABEL_MORNING = "com.intent-computer.heartbeat.morning";
const LABEL_EVENING = "com.intent-computer.heartbeat.evening";
const LEGACY_LABELS = [
  "com.intent-computer.inbox-trigger",
  "com.intent-computer.session-trigger",
  "com.intent-computer.condition-check",
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScheduleJobStatus {
  label: string;
  installed: boolean;
  plistPath: string;
}

export interface ScheduleStatus {
  morning: ScheduleJobStatus;
  evening: ScheduleJobStatus;
  platform: string;
  legacyArtifacts: string[];
  healthy: boolean;
}

// ─── Plist generation ────────────────────────────────────────────────────────

function generatePlist(options: {
  label: string;
  programArguments: string[];
  hour: number;
  stdoutLog: string;
  stderrLog: string;
}): string {
  const argsXml = options.programArguments
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${options.hour}</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(options.stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(options.stderrLog)}</string>
</dict>
</plist>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Plist path helpers ──────────────────────────────────────────────────────

function getLaunchAgentsDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("$HOME is not set");
  return join(home, "Library", "LaunchAgents");
}

function getPlistPath(label: string): string {
  return join(getLaunchAgentsDir(), `${label}.plist`);
}

// ─── launchctl helpers ───────────────────────────────────────────────────────

function launchctlLoad(plistPath: string): void {
  execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
}

function launchctlUnload(plistPath: string): void {
  execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { stdio: "pipe" });
}

function isJobLoaded(label: string): boolean {
  try {
    const output = execSync(`launchctl list 2>/dev/null`, { encoding: "utf-8" });
    return output.includes(label);
  } catch {
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Install two macOS launchd plists for the heartbeat schedule:
 *   - Morning at 6:00 AM (full heartbeat profile: phases 5a,5b,5c,6,7)
 *   - Evening at 9:00 PM (full heartbeat profile: phases 5a,5b,5c,6,7)
 *
 * @param vaultRoot    Path to the vault (e.g. ~/Mind)
 * @param heartbeatPath  Path to the heartbeat entry point (dist/index.js)
 * @returns true if both plists were installed successfully
 */
export function installSchedule(vaultRoot: string, heartbeatPath: string): boolean {
  if (process.platform !== "darwin") {
    console.error("launchd scheduling is macOS-only");
    return false;
  }

  const launchAgentsDir = getLaunchAgentsDir();
  if (!existsSync(launchAgentsDir)) {
    mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Decommission legacy jobs to prevent split-brain runtime scheduling.
  for (const legacyLabel of LEGACY_LABELS) {
    try {
      const legacyPath = getPlistPath(legacyLabel);
      if (existsSync(legacyPath)) {
        launchctlUnload(legacyPath);
        unlinkSync(legacyPath);
        console.log(`removed legacy job: ${legacyLabel}`);
      }
    } catch {
      // Best-effort decommission.
    }
  }

  // Ensure log directory exists
  const logDir = join(vaultRoot, "ops", "runtime");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Resolve node binary — use the one running this process for reliability
  const nodeBin = process.execPath;

  // ── Morning plist (6:00 AM, full heartbeat) ──────────────────────────────

  const morningPlistPath = getPlistPath(LABEL_MORNING);
  const fullPhaseProfile = "5a,5b,5c,6,7";

  const morningPlist = generatePlist({
    label: LABEL_MORNING,
    programArguments: [
      nodeBin,
      heartbeatPath,
      "--vault",
      vaultRoot,
      "--phases",
      fullPhaseProfile,
      "--slot",
      "morning",
    ],
    hour: 6,
    stdoutLog: join(logDir, "heartbeat-morning.log"),
    stderrLog: join(logDir, "heartbeat-morning.log"),
  });

  // ── Evening plist (9:00 PM, full phase profile) ─────────────────────────

  const eveningPlistPath = getPlistPath(LABEL_EVENING);
  const eveningPlist = generatePlist({
    label: LABEL_EVENING,
    programArguments: [
      nodeBin,
      heartbeatPath,
      "--vault",
      vaultRoot,
      "--phases",
      fullPhaseProfile,
      "--slot",
      "evening",
    ],
    hour: 21,
    stdoutLog: join(logDir, "heartbeat-evening.log"),
    stderrLog: join(logDir, "heartbeat-evening.log"),
  });

  // ── Write and load ───────────────────────────────────────────────────────

  let success = true;

  for (const { label, path, content } of [
    { label: LABEL_MORNING, path: morningPlistPath, content: morningPlist },
    { label: LABEL_EVENING, path: eveningPlistPath, content: eveningPlist },
  ]) {
    // Unload existing if present
    if (existsSync(path)) {
      try {
        launchctlUnload(path);
      } catch {
        // Ignore — may not be loaded
      }
    }

    writeFileSync(path, content, "utf-8");
    console.log(`wrote: ${path}`);

    try {
      launchctlLoad(path);
      console.log(`loaded: ${label}`);
    } catch (err) {
      console.error(`failed to load ${label}: ${err instanceof Error ? err.message : String(err)}`);
      success = false;
    }
  }

  if (success) {
    console.log("\nheartbeat schedule installed:");
    console.log("  morning (6:00 AM) — full profile: 5a,5b,5c,6,7");
    console.log("  evening (9:00 PM) — full profile: 5a,5b,5c,6,7");
    console.log(`  logs: ${logDir}/heartbeat-{morning,evening}.log`);
  }

  return success;
}

/**
 * Unload and remove both heartbeat launchd plists.
 * @returns true if both were successfully removed (or didn't exist)
 */
export function uninstallSchedule(): boolean {
  if (process.platform !== "darwin") {
    console.error("launchd scheduling is macOS-only");
    return false;
  }

  let success = true;

  for (const label of [LABEL_MORNING, LABEL_EVENING, ...LEGACY_LABELS]) {
    let plistPath: string;
    try {
      plistPath = getPlistPath(label);
    } catch {
      console.error(`$HOME is not set, cannot locate plist for ${label}`);
      success = false;
      continue;
    }

    if (!existsSync(plistPath)) {
      console.log(`${label} is not installed`);
      continue;
    }

    try {
      launchctlUnload(plistPath);
      console.log(`unloaded: ${label}`);
    } catch (err) {
      console.error(`failed to unload ${label}: ${err instanceof Error ? err.message : String(err)}`);
      success = false;
    }

    try {
      unlinkSync(plistPath);
      console.log(`removed: ${plistPath}`);
    } catch (err) {
      console.error(`failed to remove ${plistPath}: ${err instanceof Error ? err.message : String(err)}`);
      success = false;
    }
  }

  if (success) {
    console.log("\nheartbeat schedule uninstalled");
  }

  return success;
}

/**
 * Check whether the heartbeat plists are installed and loaded.
 */
export function getScheduleStatus(): ScheduleStatus {
  const morning: ScheduleJobStatus = {
    label: LABEL_MORNING,
    installed: false,
    plistPath: "",
  };

  const evening: ScheduleJobStatus = {
    label: LABEL_EVENING,
    installed: false,
    plistPath: "",
  };

  if (process.platform !== "darwin") {
    return {
      morning,
      evening,
      platform: process.platform,
      legacyArtifacts: [],
      healthy: false,
    };
  }

  try {
    const morningPath = getPlistPath(LABEL_MORNING);
    morning.plistPath = morningPath;
    morning.installed = existsSync(morningPath) && isJobLoaded(LABEL_MORNING);
  } catch {
    // $HOME not set
  }

  try {
    const eveningPath = getPlistPath(LABEL_EVENING);
    evening.plistPath = eveningPath;
    evening.installed = existsSync(eveningPath) && isJobLoaded(LABEL_EVENING);
  } catch {
    // $HOME not set
  }

  const legacyArtifacts: string[] = [];
  for (const label of LEGACY_LABELS) {
    try {
      const path = getPlistPath(label);
      if (existsSync(path) || isJobLoaded(label)) {
        legacyArtifacts.push(label);
      }
    } catch {
      // Ignore individual lookup failures.
    }
  }

  const healthy = morning.installed && evening.installed && legacyArtifacts.length === 0;
  return { morning, evening, platform: process.platform, legacyArtifacts, healthy };
}
