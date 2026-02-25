/**
 * model-router.ts — Phase 2
 *
 * Per-skill model routing via the chat.params hook.
 *
 * ars-contexta uses `model: sonnet` in SKILL.md frontmatter to pin mechanical
 * skills to a cheaper model while quality-sensitive skills inherit the session
 * model. opencode has no per-command model switching, so we replicate it here:
 *
 *   command.execute.before → router.setActive(skill)
 *   chat.params → modelRouter.override(activeSkill, output)
 *
 * This mutates the `output` object of the chat.params hook, which opencode reads
 * before the LLM call. Setting output.options.model overrides the session model
 * for that turn only.
 *
 * Model tiers (from ars-contexta analysis):
 *
 *   PINNED (sonnet) — mechanical/structured work, token-efficient, low creativity needed:
 *     stats, tasks, validate, seed, graph, process, next, remember, setup
 *
 *   INHERIT — quality-sensitive, benefit from Opus if that's the session model:
 *     reduce, reflect, reweave, verify, rethink, refactor, learn, ralph
 *     (also all plugin-level skills: help, tutorial, ask, health, recommend,
 *      architect, reseed, upgrade, add-domain)
 *
 * UNKNOWN: Whether opencode's chat.params hook respects output.options.model
 * as a model override. The type definition shows `options: Record<string, any>`.
 * Need to verify this at runtime in Phase 2 spike. Fallback: ignore model routing
 * if the mechanism doesn't work.
 *
 * Integration point: imported in src/index.ts and wired to the chat.params hook.
 */

import type { PluginInput } from "@opencode-ai/plugin";

// Skills that should always use a fast/cheap model regardless of session model
const PINNED_TO_SONNET = new Set([
  "stats",
  "tasks",
  "validate",
  "seed",
  "graph",
  "process",
  "next",
  "remember",
  "setup",
]);

// Sentinel for "no active skill" — avoid routing when not in a skill invocation
const NO_ACTIVE_SKILL = null;

export interface ModelRouter {
  /**
   * Called from the chat.params hook. If a mechanical skill is active,
   * overrides the model to sonnet. Otherwise leaves output unchanged.
   */
  override(
    activeSkill: string | null,
    output: { temperature: number; topP: number; topK: number; options: Record<string, unknown> }
  ): void;
}

export function createModelRouter(): ModelRouter {
  return {
    override(activeSkill, output) {
      if (activeSkill === NO_ACTIVE_SKILL) return;
      if (!PINNED_TO_SONNET.has(activeSkill)) return;

      // Attempt to override via options.model — verify this works at runtime
      // opencode's chat.params output.options is Record<string, any>; the key
      // name "model" is unverified but is the most likely convention.
      output.options.model = "claude-sonnet-4-5-20251001";
    },
  };
}

// Export the tier classification for use in help text and diagnostics
export function getModelTier(skillName: string): "sonnet" | "inherit" {
  return PINNED_TO_SONNET.has(skillName) ? "sonnet" : "inherit";
}
