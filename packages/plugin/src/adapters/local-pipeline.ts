/**
 * local-pipeline.ts — PipelinePort adapter
 *
 * Wraps existing fork.ts and injector.ts to run processing pipeline phases
 * (surface, reflect, revisit, verify) in isolated context windows.
 *
 * Each phase loads its skill instructions via the injector, then delegates
 * to forkSkill() for isolated execution. The vault is the shared state
 * channel — the forked session reads from and writes to the same vault.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  PipelinePort,
  PipelineTask,
  PipelinePhase,
  PipelinePhaseResult,
} from "@intent-computer/architecture";
import { forkSkill } from "../skills/fork.js";
import { loadSkillInstructions } from "../skills/injector.js";

/** Phase name to skill name mapping */
const PHASE_SKILL_MAP: Record<PipelinePhase, string> = {
  surface: "reduce",
  reflect: "reflect",
  revisit: "reweave",
  verify: "verify",
};

export class LocalPipelineAdapter implements PipelinePort {
  private readonly vaultRoot: string;
  private readonly client: any;
  private readonly $: any;

  constructor(vaultRoot: string, client: any, $: any) {
    this.vaultRoot = vaultRoot;
    this.client = client;
    this.$ = $;
  }

  async runPhase(task: PipelineTask, phase: PipelinePhase): Promise<PipelinePhaseResult> {
    // ─── Resolve skill name for this phase ──────────────────────────────────
    const skillName = PHASE_SKILL_MAP[phase];
    if (!skillName) {
      return {
        phase,
        success: false,
        summary: `Unknown pipeline phase: ${phase}`,
        artifacts: [],
      };
    }

    // ─── Load skill instructions ────────────────────────────────────────────
    const instructions = await loadSkillInstructions(skillName, this.vaultRoot);
    if (!instructions) {
      return {
        phase,
        success: false,
        summary: `Skill instructions not found for ${skillName} (phase: ${phase})`,
        artifacts: [],
      };
    }

    // ─── Build task context ─────────────────────────────────────────────────
    const taskContext = this.buildTaskContext(task);

    // ─── Fork and execute ───────────────────────────────────────────────────
    try {
      const result = await forkSkill(
        {
          skillName,
          skillInstructions: instructions,
          taskContext,
          vaultRoot: this.vaultRoot,
          timeoutMs: 300_000,
        },
        this.client,
        this.$,
      );

      return {
        phase,
        success: result.success,
        summary: result.summary || `${phase} phase completed`,
        artifacts: result.artifacts,
      };
    } catch (err) {
      return {
        phase,
        success: false,
        summary: `${phase} phase failed: ${err instanceof Error ? err.message : String(err)}`,
        artifacts: [],
      };
    }
  }

  // ─── Task context ─────────────────────────────────────────────────────────

  /**
   * Build the task context string passed to the forked session.
   * Includes the source file content and task metadata.
   */
  private buildTaskContext(task: PipelineTask): string {
    const parts: string[] = [];

    parts.push(`Task ID: ${task.taskId}`);
    parts.push(`Target: ${task.target}`);
    parts.push(`Phase: ${task.phase}`);
    parts.push(`Source: ${task.sourcePath}`);
    parts.push("");

    // Load source file content if it exists
    const sourcePath = task.sourcePath.startsWith("/")
      ? task.sourcePath
      : join(this.vaultRoot, task.sourcePath);

    if (existsSync(sourcePath)) {
      const content = readFileSync(sourcePath, "utf-8");
      parts.push("## Source Content");
      parts.push("");
      parts.push(content);
    } else {
      parts.push(`_Source file not found: ${sourcePath}_`);
    }

    return parts.join("\n");
  }
}
