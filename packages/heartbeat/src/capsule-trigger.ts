/**
 * capsule-trigger.ts — evaluate capsule skill triggers
 *
 * Reads capsule.yaml from the vault, evaluates which skills are due
 * based on their trigger conditions, and returns an execution plan.
 *
 * Trigger types:
 *   email     — skill runs when new file appears in inbox/ from email
 *   schedule  — cron expression, evaluated against current time
 *   after     — runs after another skill completes
 *   watch     — file matching glob is created/modified
 *   manual    — only runs when explicitly invoked
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, basename, extname } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CapsuleSkill {
  name: string;
  path: string;
  on: string;
  trigger: ParsedTrigger;
}

export interface CapsuleManifest {
  seed: string;
  version: string;
  intent: string;
  identity?: string;
  skills: CapsuleSkill[];
  schedule?: { heartbeat?: string };
}

export type TriggerKind = "email" | "schedule" | "after" | "watch" | "manual";

export interface ParsedTrigger {
  kind: TriggerKind;
  /** Cron expression for schedule triggers */
  cron?: string;
  /** Skill name for after triggers */
  after?: string;
  /** Glob pattern for watch triggers */
  glob?: string;
}

export interface DueSkill {
  skill: CapsuleSkill;
  reason: string;
  /** Full content of the SKILL.md file */
  content: string;
  /** Context to pass to the runner (e.g. the triggering file) */
  context: string;
}

export interface TriggerState {
  /** Last time each skill was run, keyed by skill name */
  lastRun: Record<string, string>;
  /** Skills that completed in the current heartbeat cycle (for "after" chaining) */
  justCompleted: string[];
}

// ─── Cron matching ───────────────────────────────────────────────────────────

/**
 * Match a single cron field against a value.
 * Supports: *, specific numbers, ranges (1-5), steps (*​/5), lists (1,3,5).
 */
function matchCronField(field: string, value: number, max: number): boolean {
  if (field === "*") return true;

  // Step: */n or range/n
  if (field.includes("/")) {
    const [range, stepStr] = field.split("/");
    const step = parseInt(stepStr, 10);
    if (!Number.isFinite(step) || step <= 0) return false;

    if (range === "*") {
      return value % step === 0;
    }
    // range/step like 1-30/5
    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      return value >= lo && value <= hi && (value - lo) % step === 0;
    }
    return false;
  }

  // List: 1,3,5
  if (field.includes(",")) {
    return field.split(",").map(Number).includes(value);
  }

  // Range: 1-5
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number);
    return value >= lo && value <= hi;
  }

  // Exact number
  return parseInt(field, 10) === value;
}

/**
 * Evaluate a 5-field cron expression against a Date.
 * Fields: minute hour day-of-month month day-of-week
 */
export function matchesCron(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  return (
    matchCronField(minute, date.getMinutes(), 59) &&
    matchCronField(hour, date.getHours(), 23) &&
    matchCronField(dayOfMonth, date.getDate(), 31) &&
    matchCronField(month, date.getMonth() + 1, 12) &&
    matchCronField(dayOfWeek, date.getDay(), 6)
  );
}

/**
 * Check if a cron-triggered skill is due, accounting for last run time.
 * A skill is due if:
 *   1. It has never run, OR
 *   2. The cron expression matches now AND enough time has passed since last run
 */
function isScheduleDue(
  cron: string,
  skillName: string,
  state: TriggerState,
  now: Date,
): boolean {
  if (!matchesCron(cron, now)) return false;

  const lastRun = state.lastRun[skillName];
  if (!lastRun) return true;

  // Don't re-run if already run in the same minute
  const lastDate = new Date(lastRun);
  return (
    lastDate.getFullYear() !== now.getFullYear() ||
    lastDate.getMonth() !== now.getMonth() ||
    lastDate.getDate() !== now.getDate() ||
    lastDate.getHours() !== now.getHours() ||
    lastDate.getMinutes() !== now.getMinutes()
  );
}

// ─── Trigger parsing ─────────────────────────────────────────────────────────

export function parseTrigger(on: string): ParsedTrigger {
  if (on === "email") return { kind: "email" };
  if (on === "manual") return { kind: "manual" };

  if (on.startsWith("schedule:")) {
    const cron = on.slice("schedule:".length).trim();
    return { kind: "schedule", cron };
  }

  if (on.startsWith("after:")) {
    const after = on.slice("after:".length).trim();
    return { kind: "after", after };
  }

  if (on.startsWith("watch:")) {
    const glob = on.slice("watch:".length).trim();
    return { kind: "watch", glob };
  }

  // Default to manual if trigger type is unrecognized
  return { kind: "manual" };
}

// ─── Manifest loading ────────────────────────────────────────────────────────

/**
 * Parse capsule.yaml. Uses a minimal YAML parser (no dependency) that handles
 * the subset of YAML used in capsule manifests.
 */
export function loadCapsuleManifest(vaultRoot: string): CapsuleManifest | null {
  const manifestPath = join(vaultRoot, "ops", "capsule.yaml");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return parseCapsuleYaml(raw);
  } catch {
    return null;
  }
}

/**
 * Minimal YAML parser for capsule manifests.
 * Handles the specific structure of capsule.yaml without requiring a YAML library.
 */
function parseCapsuleYaml(raw: string): CapsuleManifest {
  const lines = raw.split("\n");
  let seed = "";
  let version = "";
  let intent = "";
  let identity: string | undefined;
  const skills: CapsuleSkill[] = [];

  let inSkills = false;
  let currentSkill: { path?: string; on?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Top-level scalar fields
    if (/^seed:\s/.test(trimmed)) {
      seed = trimmed.slice(5).trim().replace(/^["']|["']$/g, "");
      inSkills = false;
      continue;
    }
    if (/^version:\s/.test(trimmed)) {
      version = trimmed.slice(8).trim().replace(/^["']|["']$/g, "");
      inSkills = false;
      continue;
    }
    if (/^intent:\s/.test(trimmed)) {
      intent = trimmed.slice(7).trim().replace(/^["']|["']$/g, "");
      inSkills = false;
      continue;
    }
    if (/^identity:\s/.test(trimmed)) {
      identity = trimmed.slice(9).trim().replace(/^["']|["']$/g, "");
      inSkills = false;
      continue;
    }

    // Skills array
    if (/^skills:/.test(trimmed)) {
      inSkills = true;
      continue;
    }

    // Exit skills block on next top-level key
    if (inSkills && /^\S/.test(trimmed) && !trimmed.startsWith("-") && !trimmed.startsWith(" ")) {
      if (currentSkill?.path && currentSkill.on) {
        const name = basename(currentSkill.path, extname(currentSkill.path));
        skills.push({
          name,
          path: currentSkill.path,
          on: currentSkill.on,
          trigger: parseTrigger(currentSkill.on),
        });
      }
      currentSkill = null;
      inSkills = false;
      continue;
    }

    if (inSkills) {
      const itemMatch = trimmed.match(/^\s*-\s*path:\s*(.+)/);
      if (itemMatch) {
        // Save previous skill
        if (currentSkill?.path && currentSkill.on) {
          const name = basename(currentSkill.path, extname(currentSkill.path));
          skills.push({
            name,
            path: currentSkill.path,
            on: currentSkill.on,
            trigger: parseTrigger(currentSkill.on),
          });
        }
        currentSkill = { path: itemMatch[1].trim().replace(/^["']|["']$/g, "") };
        continue;
      }

      const onMatch = trimmed.match(/^\s+on:\s*(.+)/);
      if (onMatch && currentSkill) {
        currentSkill.on = onMatch[1].trim().replace(/^["']|["']$/g, "");
        continue;
      }
    }
  }

  // Flush last skill
  if (currentSkill?.path && currentSkill.on) {
    const name = basename(currentSkill.path, extname(currentSkill.path));
    skills.push({
      name,
      path: currentSkill.path,
      on: currentSkill.on,
      trigger: parseTrigger(currentSkill.on),
    });
  }

  return { seed, version, intent, identity, skills };
}

// ─── Trigger state persistence ───────────────────────────────────────────────

const TRIGGER_STATE_FILE = "capsule-triggers.json";

export function loadTriggerState(vaultRoot: string): TriggerState {
  const statePath = join(vaultRoot, "ops", TRIGGER_STATE_FILE);
  if (!existsSync(statePath)) {
    return { lastRun: {}, justCompleted: [] };
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as TriggerState;
    // Reset justCompleted on each load — it's per-heartbeat-cycle
    state.justCompleted = [];
    return state;
  } catch {
    return { lastRun: {}, justCompleted: [] };
  }
}

export function saveTriggerState(vaultRoot: string, state: TriggerState): void {
  const opsDir = join(vaultRoot, "ops");
  if (!existsSync(opsDir)) mkdirSync(opsDir, { recursive: true });
  writeFileSync(
    join(opsDir, TRIGGER_STATE_FILE),
    JSON.stringify(state, null, 2) + "\n",
    "utf-8",
  );
}

export function recordSkillRun(state: TriggerState, skillName: string): void {
  state.lastRun[skillName] = new Date().toISOString();
  state.justCompleted.push(skillName);
}

// ─── Email trigger detection ─────────────────────────────────────────────────

/**
 * Check if there are unprocessed email-sourced files in inbox/.
 * Returns the paths of new inbox files.
 */
function findEmailTriggerFiles(vaultRoot: string): string[] {
  const inboxDir = join(vaultRoot, "inbox");
  if (!existsSync(inboxDir)) return [];

  try {
    return readdirSync(inboxDir)
      .filter((name) => name.endsWith(".md") && !name.startsWith("."))
      .map((name) => join(inboxDir, name));
  } catch {
    return [];
  }
}

// ─── Watch trigger detection ─────────────────────────────────────────────────

/**
 * Simple glob matching for watch triggers.
 * Supports basic patterns: *.ext, dir/*.ext, dir/**​/*.ext
 */
function findWatchTriggerFiles(
  vaultRoot: string,
  globPattern: string,
  since: string | undefined,
): string[] {
  // Convert glob to a directory + extension pattern
  const parts = globPattern.split("/");
  const filePattern = parts.pop() ?? "*";
  const dirPath = parts.length > 0 ? join(vaultRoot, ...parts) : vaultRoot;

  if (!existsSync(dirPath)) return [];

  const sinceMs = since ? new Date(since).getTime() : 0;
  const ext = filePattern.includes(".") ? filePattern.slice(filePattern.lastIndexOf(".")) : "";

  try {
    return readdirSync(dirPath)
      .filter((name) => {
        if (ext && !name.endsWith(ext)) return false;
        const filePath = join(dirPath, name);
        try {
          const stat = statSync(filePath);
          return stat.isFile() && stat.mtimeMs > sinceMs;
        } catch {
          return false;
        }
      })
      .map((name) => join(dirPath, name));
  } catch {
    return [];
  }
}

// ─── Main evaluation ─────────────────────────────────────────────────────────

/**
 * Load the capsule's skill file content.
 * Skills are stored in ~/Mind/skills/ after germination.
 */
function loadSkillContent(vaultRoot: string, skill: CapsuleSkill): string {
  // Try vault skills directory first (where grow phase copies them)
  const vaultSkillPath = join(vaultRoot, "skills", basename(skill.path));
  if (existsSync(vaultSkillPath)) {
    return readFileSync(vaultSkillPath, "utf-8");
  }

  // Fall back to the path as specified in manifest (relative to capsule root)
  // This handles the case where skills haven't been copied yet
  const directPath = join(vaultRoot, skill.path);
  if (existsSync(directPath)) {
    return readFileSync(directPath, "utf-8");
  }

  return "";
}

/**
 * Evaluate all capsule skill triggers and return skills that are due.
 * This is the main entry point — call this from the heartbeat.
 */
export function evaluateTriggers(
  vaultRoot: string,
  now: Date = new Date(),
): DueSkill[] {
  const manifest = loadCapsuleManifest(vaultRoot);
  if (!manifest) return [];

  const state = loadTriggerState(vaultRoot);
  const due: DueSkill[] = [];

  for (const skill of manifest.skills) {
    switch (skill.trigger.kind) {
      case "email": {
        const files = findEmailTriggerFiles(vaultRoot);
        if (files.length > 0) {
          const content = loadSkillContent(vaultRoot, skill);
          if (content) {
            due.push({
              skill,
              reason: `${files.length} unprocessed inbox file(s)`,
              content,
              context: `Process these inbox files:\n${files.map((f) => `- ${f}`).join("\n")}`,
            });
          }
        }
        break;
      }

      case "schedule": {
        if (skill.trigger.cron && isScheduleDue(skill.trigger.cron, skill.name, state, now)) {
          const content = loadSkillContent(vaultRoot, skill);
          if (content) {
            due.push({
              skill,
              reason: `schedule matched: ${skill.trigger.cron}`,
              content,
              context: `Scheduled execution at ${now.toISOString()}`,
            });
          }
        }
        break;
      }

      case "after": {
        if (skill.trigger.after && state.justCompleted.includes(skill.trigger.after)) {
          const content = loadSkillContent(vaultRoot, skill);
          if (content) {
            due.push({
              skill,
              reason: `after: ${skill.trigger.after} completed`,
              content,
              context: `Triggered by completion of ${skill.trigger.after}`,
            });
          }
        }
        break;
      }

      case "watch": {
        if (skill.trigger.glob) {
          const lastRun = state.lastRun[skill.name];
          const files = findWatchTriggerFiles(vaultRoot, skill.trigger.glob, lastRun);
          if (files.length > 0) {
            const content = loadSkillContent(vaultRoot, skill);
            if (content) {
              due.push({
                skill,
                reason: `${files.length} file(s) matching ${skill.trigger.glob}`,
                content,
                context: `New/modified files:\n${files.map((f) => `- ${f}`).join("\n")}`,
              });
            }
          }
        }
        break;
      }

      case "manual":
        // Manual skills are never automatically triggered
        break;
    }
  }

  return due;
}

/**
 * After executing a skill, record it and check for chained "after" triggers.
 * Returns any newly-due skills (the chain).
 */
export function recordAndChain(
  vaultRoot: string,
  completedSkillName: string,
): DueSkill[] {
  const state = loadTriggerState(vaultRoot);
  recordSkillRun(state, completedSkillName);
  saveTriggerState(vaultRoot, state);

  // Re-evaluate to find "after" triggers
  const manifest = loadCapsuleManifest(vaultRoot);
  if (!manifest) return [];

  const due: DueSkill[] = [];
  for (const skill of manifest.skills) {
    if (skill.trigger.kind === "after" && skill.trigger.after === completedSkillName) {
      const content = loadSkillContent(vaultRoot, skill);
      if (content) {
        due.push({
          skill,
          reason: `after: ${completedSkillName} completed`,
          content,
          context: `Chained from ${completedSkillName}`,
        });
      }
    }
  }

  return due;
}
