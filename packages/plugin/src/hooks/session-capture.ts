/**
 * session-capture.ts
 *
 * Stop hook equivalent. Saves session artifacts and commits on session end.
 * Equivalent to ars-contexta's session-capture.sh.
 *
 * On session end:
 *   - Saves session metadata to ops/sessions/YYYY-MM-DDTHH-MM-SS.json
 *     including title, summary (file diff counts), and timestamps from the SDK
 *   - Stages and commits session artifacts, observations, goals
 */

import { existsSync } from "fs";
import { join } from "path";
import type { PluginInput } from "@opencode-ai/plugin";

type SessionInfo = {
  id?: string;
  title?: string;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
  time?: {
    created?: number;
    updated?: number;
  };
};

type SessionCaptureInput = {
  eventType?: string;
  sessionID?: string;
  sessionInfo?: SessionInfo;
};

export async function sessionCapture(
  vaultRoot: string,
  $: PluginInput["$"],
  _input: SessionCaptureInput = {}
): Promise<void> {
  // Session JSON stubs disabled — they contained only metadata with nothing
  // to mine, accumulating thousands of empty files. The git commit below
  // still stages useful session artifacts (observations, goals, working memory).

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Verify git repo
  try {
    await $`git -C ${vaultRoot} rev-parse --git-dir`.quiet();
  } catch {
    return;
  }

  // Stage session artifacts
  const paths = [
    join(vaultRoot, "ops", "sessions"),
    join(vaultRoot, "ops", "observations"),
    join(vaultRoot, "ops", "methodology"),
    join(vaultRoot, "self", "goals.md"),
    join(vaultRoot, "self", "working-memory.md"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        await $`git -C ${vaultRoot} add ${p}`.quiet();
      } catch {
        // Path may not exist — fine
      }
    }
  }

  const status = await $`git -C ${vaultRoot} diff --cached --name-only`.text();
  if (!status.trim()) return;

  try {
    await $`git -C ${vaultRoot} commit -m "session: capture ${timestamp}" --no-verify`.quiet();
  } catch {
    // Swallow
  }
}
