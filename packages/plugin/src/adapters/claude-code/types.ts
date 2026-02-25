/**
 * types.ts — Claude Code hook protocol types
 *
 * Defines the JSON shapes that Claude Code sends on stdin and expects on stdout.
 * See: https://docs.anthropic.com/en/docs/claude-code/hooks
 */

/** Common fields present in every hook event's stdin JSON. */
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

/** SessionStart-specific fields. */
export interface SessionStartInput extends HookInput {
  hook_event_name: "SessionStart";
  /** "startup" | "resume" | "clear" | "compact" */
  startup_type?: string;
}

/** PostToolUse-specific fields. */
export interface PostToolUseInput extends HookInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
}

/** Stop-specific fields. */
export interface StopInput extends HookInput {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
}

/** SessionEnd-specific fields. */
export interface SessionEndInput extends HookInput {
  hook_event_name: "SessionEnd";
}

/** The JSON shape Claude Code reads from stdout on exit 0. */
export interface HookOutput {
  /** Additional context injected into Claude's system prompt or tool output. */
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}
