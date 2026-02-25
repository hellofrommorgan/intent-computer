/**
 * claude-code adapter — barrel export
 *
 * The hook handlers (session-start.ts, post-tool-use.ts, session-end.ts) are
 * designed to run as standalone scripts via `npx tsx`. This barrel exports the
 * shared utilities and the install function for programmatic use.
 */

export type {
  HookInput,
  HookOutput,
  SessionStartInput,
  PostToolUseInput,
  StopInput,
  SessionEndInput,
} from "./types.js";

export { resolveVaultRoot } from "./vault.js";
export { readStdin } from "./stdin.js";
export { succeed, block, pass } from "./output.js";
export { generateHooksConfig, mergeSettings, install } from "./install.js";
