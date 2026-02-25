/**
 * write-validate.ts
 *
 * PostToolUse/Write equivalent. Validates schema on thoughts written to the vault.
 * Equivalent to ars-contexta's write-validate.sh.
 *
 * Checks:
 *   - YAML frontmatter delimiters present
 *   - description: field present
 *   - topics: field present
 *   - description is not just a restatement of the filename
 *
 * Returns: warning string to append to tool output, or null if valid.
 *
 * Unlike Claude Code's additionalContext JSON, this returns a string that
 * the caller (index.ts tool.execute.after hook) appends to the tool output.
 * Claude sees it as part of the write result.
 */

import { readFileSync, existsSync } from "fs";
import { isKebabCase, toKebabCase } from "@intent-computer/architecture";

export async function writeValidate(filePath: string): Promise<string | null> {
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
  if (stem && isKebabCase(stem)) {
    const suggested = stem.replace(/-/g, " ");
    warnings.push(`filename uses kebab-case but vault convention is prose-with-spaces (suggested: ${suggested}.md)`);
  }

  // Check frontmatter delimiters
  const hasOpeningDelimiter = /^---\s*(?:\n|$)/.test(content);
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!hasOpeningDelimiter) {
    warnings.push("Missing YAML frontmatter opening delimiter (---)");
  } else if (!frontmatterMatch) {
    warnings.push("Missing YAML frontmatter closing delimiter (---)");
  } else {
    const frontmatter = frontmatterMatch[1];

    // Check description field
    const descMatch = frontmatter.match(/^description:\s*(.+)\s*$/m);
    if (!descMatch) {
      warnings.push("Missing required field: description");
    } else {
      const rawDesc = descMatch[1].trim();
      const desc = rawDesc.replace(/^['"]|['"]$/g, "").trim();
      const titleFromFilename = filename.replace(/\.md$/, "");
      if (desc.toLowerCase() === titleFromFilename.toLowerCase()) {
        warnings.push("description is identical to the title — add information beyond the title");
      }
      if (desc.length < 20) {
        warnings.push(`description is too short (${desc.length} chars) — aim for ~150 chars that add context`);
      }
    }

    // Check topics field and basic non-empty content
    const topicsKeyMatch = frontmatter.match(/^topics:\s*(.*)$/m);
    if (!topicsKeyMatch) {
      warnings.push("Missing required field: topics — this thought needs at least one map link");
    } else {
      const inlineTopics = topicsKeyMatch[1].trim();
      const hasInlineTopics = inlineTopics.length > 0 && inlineTopics !== "[]";
      const blockTopicsMatch = frontmatter.match(/^topics:\s*\n((?:\s*-\s*.+\n?)*)/m);
      const blockTopicCount = blockTopicsMatch
        ? blockTopicsMatch[1].split("\n").filter((line) => /^\s*-\s*.+/.test(line)).length
        : 0;

      if (!hasInlineTopics && blockTopicCount === 0) {
        warnings.push("topics is empty — add at least one map link topic");
      }
    }
  }

  if (warnings.length === 0) return null;

  return `\n⚠️ Schema warnings for ${filename}:\n${warnings.map(w => `  - ${w}`).join("\n")}`;
}
