/**
 * injector.ts
 *
 * System prompt injection. Loads a skill's SKILL.md and injects its body
 * into the system prompt via experimental.chat.system.transform.
 *
 * Skill files are loaded from the package's skill-sources/ directory.
 * Plugin-level skills are loaded from skills/.
 *
 * At injection time, vocabulary placeholders ({vocabulary.notes}, etc.) are
 * replaced with values from ops/derivation-manifest.md.
 *
 * This approximates Claude Code's `context: fork` behavior at the system prompt
 * level. Full isolation (separate session per invocation) is implemented in
 * Phase 4 (src/skills/fork.ts).
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadVocabulary as parseVocabulary } from "@intent-computer/architecture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");

export interface Injector {
  load(skillName: string, vaultRoot: string): Promise<string | null>;
}

/**
 * Load skill instructions without the "=== ACTIVE SKILL ===" wrapper.
 * Used by fork.ts to pass raw instructions to isolated sessions, which
 * provide their own framing via the fork system prompt.
 */
export async function loadSkillInstructions(
  skillName: string,
  vaultRoot: string
): Promise<string | null> {
  const content = loadSkillContent(skillName);
  if (!content) return null;
  const vocabulary = await loadVocabulary(vaultRoot);
  return applyVocabulary(content, vocabulary);
}

export function createInjector(): Injector {
  return {
    async load(skillName: string, vaultRoot: string): Promise<string | null> {
      const skillContent = loadSkillContent(skillName);
      if (!skillContent) return null;

      const vocabulary = await loadVocabulary(vaultRoot);
      const transformed = applyVocabulary(skillContent, vocabulary);

      return [
        `=== ACTIVE SKILL: ${skillName} ===`,
        ``,
        `The user has invoked the /${skillName} skill. Follow these instructions for this response:`,
        ``,
        transformed,
        ``,
        `=== END SKILL: ${skillName} ===`,
      ].join("\n");
    },
  };
}

function loadSkillContent(skillName: string): string | null {
  // Check skill-sources/ first (generated/operational skills)
  // Markdown files are not compiled — always load from src/ directly
  const skillSourcesPath = join(PACKAGE_ROOT, "src", "skill-sources", skillName, "SKILL.md");
  if (existsSync(skillSourcesPath)) {
    return extractBody(readFileSync(skillSourcesPath, "utf-8"));
  }

  // Check plugin-skills/ (plugin-level skills: setup, help, health, ask, etc.)
  const pluginSkillsPath = join(PACKAGE_ROOT, "src", "plugin-skills", skillName, "SKILL.md");
  if (existsSync(pluginSkillsPath)) {
    return extractBody(readFileSync(pluginSkillsPath, "utf-8"));
  }

  return null;
}

function extractBody(skillMd: string): string {
  // Strip YAML frontmatter — everything between the first two --- delimiters
  if (!skillMd.startsWith("---")) return skillMd;

  const closingDelim = skillMd.indexOf("---", 3);
  if (closingDelim === -1) return skillMd;

  return skillMd.slice(closingDelim + 3).trim();
}

async function loadVocabulary(vaultRoot: string): Promise<Record<string, string>> {
  const manifestPath = join(vaultRoot, "ops", "derivation-manifest.md");
  if (!existsSync(manifestPath)) return {};

  const content = readFileSync(manifestPath, "utf-8");
  return parseVocabulary(content);
}

function applyVocabulary(content: string, vocabulary: Record<string, string>): string {
  // Replace {vocabulary.key} placeholders
  return content.replace(/\{vocabulary\.(\w+)\}/g, (match, key) => {
    return vocabulary[key] ?? match;
  });
}
