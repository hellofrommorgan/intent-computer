#!/usr/bin/env npx tsx
/**
 * stop-capture.ts — Claude Code Stop hook handler
 *
 * Fires when Claude finishes responding. Reads the session transcript,
 * scans the most recent assistant turns for capturable insights using a
 * lightweight heuristic (no LLM call — too slow for a Stop hook), and
 * writes high-confidence captures to ~/Mind/inbox/ as raw markdown.
 *
 * Design principles:
 * - Conservative: false positives erode trust faster than missed captures
 * - Fast: must complete within the 15s timeout budget
 * - Idempotent: deduplication prevents repeat captures within a session
 * - Rate-limited: max 5 captures per session to avoid inbox flooding
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readStdin } from "./stdin.js";
import { pass } from "./output.js";
import { resolveVaultRoot } from "./vault.js";
import {
  detectCapturableInsights,
  isDuplicateCapture,
  parseTranscriptLines,
  extractRecentAssistantText,
  slugify,
  type DetectedCapture,
} from "./capture-heuristic.js";
import type { StopInput } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_CAPTURES_PER_SESSION = 5;

/** Number of recent assistant turns to analyze for insights. */
const RECENT_TURNS_TO_SCAN = 3;

// ─── Rate limiting ────────────────────────────────────────────────────────────

function captureCountPath(sessionId: string): string {
  // Sanitize session_id to avoid path traversal
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return join(tmpdir(), `intent-computer-stop-captures-${safe}.txt`);
}

function getCaptureCount(sessionId: string): number {
  const countFile = captureCountPath(sessionId);
  if (!existsSync(countFile)) return 0;
  try {
    return parseInt(readFileSync(countFile, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function incrementCaptureCount(sessionId: string): void {
  const countFile = captureCountPath(sessionId);
  const current = getCaptureCount(sessionId);
  writeFileSync(countFile, String(current + 1), "utf-8");
}

// ─── Transcript reading ───────────────────────────────────────────────────────

function readTranscriptText(transcriptPath: string, turnsBack: number): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const entries = parseTranscriptLines(lines);
    return extractRecentAssistantText(entries, turnsBack);
  } catch {
    return "";
  }
}

// ─── Capture file writing ─────────────────────────────────────────────────────

function writeCaptureToInbox(
  capture: DetectedCapture,
  sessionId: string,
  inboxDir: string,
): string | null {
  const slug = slugify(capture.claim);
  if (!slug || slug.length < 5) return null;

  const timestamp = new Date().toISOString();
  const filename = `session-capture-${slug}-${Date.now()}.md`;
  const filepath = join(inboxDir, filename);

  const content = [
    "---",
    `title: "${capture.claim}"`,
    `source: "session-capture"`,
    `captured: ${timestamp}`,
    `session_id: "${sessionId}"`,
    `confidence: heuristic`,
    "---",
    "",
    capture.context,
  ].join("\n");

  try {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(filepath, content, "utf-8");
    return filename;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();

  // Don't run when stop_hook_active (prevents hook re-entry loops)
  if (input.stop_hook_active) pass();

  const vaultRoot = resolveVaultRoot(input.cwd);
  if (!vaultRoot) pass();

  const sessionId = input.session_id ?? "unknown";

  // Check rate limit before doing any work
  const captureCount = getCaptureCount(sessionId);
  if (captureCount >= MAX_CAPTURES_PER_SESSION) pass();

  // Read and parse transcript
  const recentText = readTranscriptText(input.transcript_path, RECENT_TURNS_TO_SCAN);
  if (!recentText || recentText.length < 100) pass();

  // Run heuristic detection
  const captures = detectCapturableInsights(recentText);
  if (captures.length === 0) pass();

  // Write captures to inbox
  const inboxDir = join(vaultRoot!, "inbox");
  let written = 0;

  for (const capture of captures) {
    if (captureCount + written >= MAX_CAPTURES_PER_SESSION) break;
    if (isDuplicateCapture(capture.claim, inboxDir)) continue;

    const filename = writeCaptureToInbox(capture, sessionId, inboxDir);
    if (filename) {
      written += 1;
      process.stderr.write(`[stop-capture] captured: ${filename}\n`);
    }
  }

  // Update rate limit counter once per run
  for (let i = 0; i < written; i++) {
    incrementCaptureCount(sessionId);
  }

  pass();
}

main().catch((err) => {
  process.stderr.write(`stop-capture hook error: ${err}\n`);
  process.exit(0); // Never block the agent on hook errors
});
