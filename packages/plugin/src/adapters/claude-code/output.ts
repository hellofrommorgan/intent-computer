/**
 * output.ts — Write hook output to stdout and exit
 *
 * Claude Code reads JSON from stdout on exit 0.
 * Exit 2 = block the action (stderr = reason shown to Claude).
 */

import type { HookOutput } from "./types.js";

/** Exit 0 with optional additionalContext for Claude. */
export function succeed(additionalContext?: string): never {
  if (additionalContext) {
    const output: HookOutput = {
      hookSpecificOutput: { additionalContext },
    };
    process.stdout.write(JSON.stringify(output));
  }
  process.exit(0);
}

/** Exit 2 to block the tool call. Message goes to stderr for Claude. */
export function block(reason: string): never {
  process.stderr.write(reason);
  process.exit(2);
}

/** Exit 0 silently — no output. */
export function pass(): never {
  process.exit(0);
}
