/**
 * write-validate handler — OpenClaw message:sent hook
 *
 * After the agent sends a message, checks whether any vault files were
 * written. If so, validates frontmatter and auto-commits.
 *
 * Since OpenClaw doesn't provide granular tool-use events, we detect
 * file writes by scanning the message content for file path references
 * and checking mtimes against a session-start watermark.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, normalize } from "path";
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

// ─── Note path detection ────────────────────────────────────────────────────

const NOTE_SEGMENTS = ["/thoughts/", "/inbox/", "/notes/", "/thinking/", "/claims/"];

function isNotePath(filePath: string): boolean {
  const normalized = normalize(filePath).replaceAll("\\", "/");
  return NOTE_SEGMENTS.some((seg) => normalized.includes(seg));
}

// ─── Schema validation (mirrors write-validate.ts) ──────────────────────────

function validateFrontmatter(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const warnings: string[] = [];
  const filename = filePath.split("/").pop() ?? "";
  const stem = filename.replace(/\.md$/, "");

  // Kebab-case check
  if (stem && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(stem)) {
    const suggested = stem.replace(/-/g, " ");
    warnings.push(
      `filename uses kebab-case but vault convention is prose-with-spaces (suggested: ${suggested}.md)`
    );
  }

  const hasOpeningDelimiter = /^---\s*(?:\n|$)/.test(content);
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);

  if (!hasOpeningDelimiter) {
    warnings.push("Missing YAML frontmatter opening delimiter (---)");
  } else if (!frontmatterMatch) {
    warnings.push("Missing YAML frontmatter closing delimiter (---)");
  } else {
    const frontmatter = frontmatterMatch[1];

    // description
    const descMatch = frontmatter.match(/^description:\s*(.+)\s*$/m);
    if (!descMatch) {
      warnings.push("Missing required field: description");
    } else {
      const desc = descMatch[1].trim().replace(/^['"]|['"]$/g, "").trim();
      const titleFromFilename = filename.replace(/\.md$/, "");
      if (desc.toLowerCase() === titleFromFilename.toLowerCase()) {
        warnings.push("description is identical to the title -- add information beyond the title");
      }
      if (desc.length < 20) {
        warnings.push(
          `description is too short (${desc.length} chars) -- aim for ~150 chars that add context`
        );
      }
    }

    // topics
    const topicsKeyMatch = frontmatter.match(/^topics:\s*(.*)$/m);
    if (!topicsKeyMatch) {
      warnings.push("Missing required field: topics -- this thought needs at least one map link");
    } else {
      const inlineTopics = topicsKeyMatch[1].trim();
      const hasInlineTopics = inlineTopics.length > 0 && inlineTopics !== "[]";
      const blockTopicsMatch = frontmatter.match(/^topics:\s*\n((?:\s*-\s*.+\n?)*)/m);
      const blockTopicCount = blockTopicsMatch
        ? blockTopicsMatch[1].split("\n").filter((line: string) => /^\s*-\s*.+/.test(line)).length
        : 0;
      if (!hasInlineTopics && blockTopicCount === 0) {
        warnings.push("topics is empty -- add at least one map link topic");
      }
    }
  }

  if (warnings.length === 0) return null;
  return `Schema warnings for ${filename}:\n${warnings.map((w) => `  - ${w}`).join("\n")}`;
}

// ─── Auto-commit (mirrors auto-commit.ts) ───────────────────────────────────

function autoCommit(vaultRoot: string, changedFiles: string[]): void {
  try {
    execSync(`git -C "${vaultRoot}" rev-parse --git-dir`, { stdio: "ignore" });
  } catch {
    return; // Not a git repo
  }

  // Stage changed files
  for (const f of changedFiles) {
    try {
      execSync(`git -C "${vaultRoot}" add "${f}"`, { stdio: "ignore" });
    } catch {
      // skip
    }
  }

  // Stage vault state dirs
  for (const dir of ["self", "ops", "inbox"]) {
    const p = join(vaultRoot, dir);
    if (existsSync(p)) {
      try {
        execSync(`git -C "${vaultRoot}" add "${p}"`, { stdio: "ignore" });
      } catch {
        // skip
      }
    }
  }

  // Commit if anything staged
  let status: string;
  try {
    status = execSync(`git -C "${vaultRoot}" diff --cached --name-only`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    return;
  }
  if (!status) return;

  const files = status.split("\n");
  const count = files.length;
  const names = files
    .slice(0, 3)
    .map((f) => f.split("/").pop())
    .join(", ");
  const suffix = count > 3 ? ` +${count - 3} more` : "";
  const message = `auto: update ${count} note(s) -- ${names}${suffix}`;

  try {
    execSync(`git -C "${vaultRoot}" commit -m "${message}" --no-verify`, {
      stdio: "ignore",
    });
  } catch {
    // Swallow commit failures
  }
}

// ─── Detect recently modified vault files ───────────────────────────────────

/**
 * Find .md files in note directories that were modified in the last N seconds.
 * This is our heuristic for detecting agent writes since OpenClaw doesn't
 * provide per-tool-use events.
 */
function findRecentlyModifiedNotes(vaultRoot: string, withinSeconds: number = 30): string[] {
  const cutoff = Date.now() - withinSeconds * 1000;
  const results: string[] = [];

  for (const dir of ["thoughts", "inbox"]) {
    const fullDir = join(vaultRoot, dir);
    if (!existsSync(fullDir)) continue;
    try {
      for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const fullPath = join(fullDir, entry.name);
        try {
          if (statSync(fullPath).mtimeMs > cutoff) {
            results.push(fullPath);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  return results;
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

  // Find vault notes modified recently (within last 30 seconds)
  const recentNotes = findRecentlyModifiedNotes(vaultRoot, 30);
  if (recentNotes.length === 0) return;

  // Validate each modified note
  const allWarnings: string[] = [];
  for (const notePath of recentNotes) {
    if (!isNotePath(notePath)) continue;
    const warning = validateFrontmatter(notePath);
    if (warning) allWarnings.push(warning);
  }

  // Push validation warnings as a system message so the agent sees them
  if (allWarnings.length > 0) {
    event.messages.push({
      role: "system",
      content: `[intent-computer] ${allWarnings.join("\n\n")}`,
    });
  }

  // Auto-commit the changes
  const notePathsInVault = recentNotes.filter(isNotePath);
  if (notePathsInVault.length > 0) {
    autoCommit(vaultRoot, notePathsInVault);
  }
}
