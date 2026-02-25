/**
 * pipeline.ts — Phase 5
 *
 * Sequential end-to-end pipeline: seed → reduce → reflect → reweave → verify.
 *
 * This is the /pipeline command — a convenience wrapper that runs a single source
 * file through the full pipeline without requiring manual /seed, /ralph invocations.
 *
 * Uses ralph's processTask internals for each phase, running them serially rather
 * than via the queue. The queue is not used for pipeline — it's for batch
 * processing managed by ralph. Pipeline is for single-file interactive use.
 *
 * FLOW
 * ----
 * 1. /pipeline source-file.md
 * 2. Check source file exists in inbox/ or archive/
 * 3. If in inbox/: move to archive/[batch-name]/ (same as /seed does)
 * 4. Run reduce on source → produces N thought drafts in thoughts/
 * 5. Run reflect on each new thought → adds wiki links, updates maps
 * 6. Run reweave on each new thought → backward pass, updates older thoughts
 * 7. Run verify on each new thought → quality check, flags issues
 * 8. Report: N thoughts created, M connections added, K issues found
 *
 * All phases use fork semantics (Phase 4) for context isolation.
 * Falls back to process spawning if fork is unavailable.
 *
 * INVOCATION
 * ----------
 * /pipeline [file]                        Run full pipeline on a source file
 * /pipeline [file] --phases reduce,reflect  Run only specified phases
 * /pipeline --resume [batch]              Resume an interrupted pipeline batch
 *
 * TODO Phase 5:
 * - Wire to fork.ts for context isolation
 * - Implement --resume for interrupted pipelines
 * - Track pipeline artifacts for reporting
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { forkSkill } from "./fork.js";
import { loadSkillInstructions } from "./injector.js";

export interface PipelineOptions {
  phases?: string[];      // Subset of phases to run (default: all)
  resume?: string;        // Resume from a specific batch name
}

export async function runPipeline(
  sourceFile: string,
  vaultRoot: string,
  client: PluginInput["client"],
  $: PluginInput["$"],
  options: PipelineOptions = {}
): Promise<string> {
  const phases = options.phases ?? ["reduce", "reflect", "reweave", "verify"];

  // Resolve source file path
  const resolvedPath = resolveSourceFile(sourceFile, vaultRoot);
  if (!resolvedPath) {
    return `Source file not found: ${sourceFile}\nLook in inbox/ or archive/ directories.`;
  }

  const batchName = basename(resolvedPath, ".md");
  const results: string[] = [`Pipeline: ${batchName}`, ""];

  const sourceContent = readFileSync(resolvedPath, "utf-8");

  for (const phase of phases) {
    const phaseStart = Date.now();
    results.push(`Running ${phase}...`);

    const skillInstructions = await loadSkillInstructions(phase, vaultRoot);
    if (!skillInstructions) {
      results.push(`  ✗ ${phase} — skill not found (no SKILL.md for "${phase}")`);
      results.push("Pipeline halted.");
      break;
    }

    const result = await forkSkill(
      {
        skillName: phase,
        skillInstructions,
        taskContext: sourceContent,
        vaultRoot,
        timeoutMs: 300_000,
      },
      client,
      $
    );

    const elapsed = Date.now() - phaseStart;
    if (!result.success) {
      results.push(`  ✗ ${phase} failed (${elapsed}ms): ${result.error}`);
      results.push("Pipeline halted.");
      break;
    }
    results.push(`  ✓ ${phase} — ${result.summary} (${elapsed}ms)`);
    if (result.artifacts.length > 0) {
      results.push(`    artifacts: ${result.artifacts.join(", ")}`);
    }
  }

  return results.join("\n");
}

function resolveSourceFile(sourceFile: string, vaultRoot: string): string | null {
  // Absolute or cwd-relative path
  if (existsSync(sourceFile)) return sourceFile;

  // Check inbox/
  const inboxPath = join(vaultRoot, "inbox", sourceFile);
  if (existsSync(inboxPath)) return inboxPath;

  // Check inbox/ with .md extension
  const inboxMdPath = join(vaultRoot, "inbox", sourceFile + ".md");
  if (existsSync(inboxMdPath)) return inboxMdPath;

  // Search archive/ subdirectories
  const archiveDir = join(vaultRoot, "archive");
  if (existsSync(archiveDir)) {
    for (const batch of readdirSync(archiveDir)) {
      const candidate = join(archiveDir, batch, sourceFile);
      if (existsSync(candidate)) return candidate;
      const candidateMd = join(archiveDir, batch, sourceFile + ".md");
      if (existsSync(candidateMd)) return candidateMd;
    }
  }

  return null;
}
