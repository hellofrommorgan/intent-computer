#!/usr/bin/env node
// Syncs skill SKILL.md files and generates command files for opencode.
// Usage: node sync-skills.js [vault-path] [--plugin-root=/path/to/plugin/root] [--dry-run]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SKILL_REFERENCE_CONSTANTS } from "./skill-reference-constants.js";

// ─── Parse arguments ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pluginRootFlag = args.find((a) => a.startsWith("--plugin-root="));
const positionalArgs = args.filter((a) => !a.startsWith("--"));
const vaultArg = positionalArgs[0];
const pluginRootArg = pluginRootFlag?.slice("--plugin-root=".length) || positionalArgs[1];
const H = process.env.HOME || process.env.USERPROFILE || "";
const vaultPath = vaultArg
  ? vaultArg.startsWith("~") ? join(H, vaultArg.slice(1)) : vaultArg
  : join(H, "Mind");

const root = new URL("..", import.meta.url).pathname;

const skillDest = join(vaultPath, ".opencode", "skills");
const cmdDests = [join(vaultPath, ".opencode", "commands"), join(H, ".config", "opencode", "commands")];

// ─── Constants for transformation ───────────────────────────────────────────
// Resolve plugin root from CLI argument, environment variable, or default
const PLUGIN_ROOT = pluginRootArg
  || process.env.ARSCONTEXTA_PLUGIN_ROOT
  || (() => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cacheDir = join(home, ".claude", "plugins", "cache", "agenticnotetaking", "arscontexta");
    try {
      const versions = readdirSync(cacheDir).sort();
      if (versions.length > 0) {
        return join(cacheDir, versions[versions.length - 1]);
      }
    } catch {
      // fall through
    }
    return join(home, ".claude", "plugins", "cache", "agenticnotetaking", "arscontexta", "0.8.0");
  })();
const PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

if (dryRun) {
  console.log(`[dry-run] vault: ${vaultPath}`);
}

// ─── Check source directories ────────────────────────────────────────────────
const sources = ["packages/plugin/src/skill-sources", "packages/plugin/src/plugin-skills"];
for (const src of sources) {
  const srcPath = join(root, src);
  if (!existsSync(srcPath)) {
    console.error(`ERROR: source directory not found: ${srcPath}`);
    console.error("Run from the intent-computer package root or ensure the build is present.");
    process.exit(1);
  }
}

// ─── Transform SKILL.md content ─────────────────────────────────────────────
// Applies two transformations:
//   1. Replaces ${CLAUDE_PLUGIN_ROOT} with the real plugin cache path
//   2. Removes AskUserQuestion from the allowed-tools frontmatter line only
//   3. Normalizes legacy queue references and schema labels
//   4. Rewrites {DOMAIN:*} placeholders to {vocabulary.*} placeholders
//   5. Normalizes vocabulary key aliases
function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function transformSkillContent(raw, skillName) {
  // Split into frontmatter and body
  const fmBoundary = raw.startsWith("---") ? raw.indexOf("\n---", 4) : -1;
  let frontmatter = fmBoundary >= 0 ? raw.slice(0, fmBoundary + 4) : "";
  const body = fmBoundary >= 0 ? raw.slice(fmBoundary + 4) : raw;

  // Remove AskUserQuestion from allowed-tools line in frontmatter only
  frontmatter = frontmatter.replace(
    /^(allowed-tools:.*?),\s*AskUserQuestion/m,
    "$1"
  ).replace(
    /^(allowed-tools:.*?)AskUserQuestion,\s*/m,
    "$1"
  ).replace(
    /^(allowed-tools:.*?)AskUserQuestion/m,
    "$1"
  );

  let transformed = frontmatter + body;

  // Count and replace ${CLAUDE_PLUGIN_ROOT} references
  const pluginRootCount = (transformed.match(/\$\{CLAUDE_PLUGIN_ROOT\}/g) ?? []).length;
  transformed = transformed.replaceAll(PLUGIN_ROOT_PLACEHOLDER, PLUGIN_ROOT);

  // Normalize queue paths to canonical JSON queue path
  let queuePathCount = 0;
  for (const legacyPath of SKILL_REFERENCE_CONSTANTS.queue.legacyPaths) {
    const pattern = new RegExp(escapeRegExp(legacyPath), "g");
    queuePathCount += countMatches(transformed, pattern);
    transformed = transformed.replace(pattern, SKILL_REFERENCE_CONSTANTS.queue.canonicalPath);
  }

  // Normalize schema label references
  const schemaPatterns = [
    { pattern: /"schema_version"\s*:\s*3/g, replacement: '"version": 1' },
    { pattern: /schema_version\s*:\s*3/g, replacement: "version: 1" },
    { pattern: /`schema_version`\s*<\s*3/g, replacement: "`version` !== 1" },
    { pattern: /schema_version\s*<\s*3/g, replacement: "version !== 1" },
    { pattern: /schema_version\s*>=\s*3/g, replacement: SKILL_REFERENCE_CONSTANTS.queue.canonicalSchemaLabel },
  ];
  let queueSchemaCount = 0;
  for (const entry of schemaPatterns) {
    queueSchemaCount += countMatches(transformed, entry.pattern);
    transformed = transformed.replace(entry.pattern, entry.replacement);
  }

  // Rewrite {DOMAIN:*} placeholders
  let domainPlaceholderCount = 0;
  for (const [legacy, canonical] of Object.entries(SKILL_REFERENCE_CONSTANTS.domainPlaceholderMap)) {
    const pattern = new RegExp(escapeRegExp(legacy), "g");
    domainPlaceholderCount += countMatches(transformed, pattern);
    transformed = transformed.replace(pattern, canonical);
  }

  // Normalize vocabulary key aliases
  let vocabularyAliasCount = 0;
  for (const [legacyKey, canonicalKey] of Object.entries(SKILL_REFERENCE_CONSTANTS.vocabulary.aliases)) {
    const pattern = new RegExp(`\\{vocabulary\\.${escapeRegExp(legacyKey)}\\}`, "g");
    vocabularyAliasCount += countMatches(transformed, pattern);
    transformed = transformed.replace(pattern, `{vocabulary.${canonicalKey}}`);
  }

  return {
    content: transformed,
    pluginRootCount,
    queuePathCount,
    queueSchemaCount,
    domainPlaceholderCount,
    vocabularyAliasCount,
  };
}

// ─── Sync loop ───────────────────────────────────────────────────────────────
let synced = 0;
let skipped = 0;

for (const src of sources) {
  const srcPath = join(root, src);
  const names = readdirSync(srcPath);

  for (const name of names) {
    const skillMdSrc = join(srcPath, name, "SKILL.md");

    if (!existsSync(skillMdSrc)) continue;

    // Read frontmatter to check for stub status and extract description
    const raw = readFileSync(skillMdSrc, "utf-8");
    const fmMatch = raw.match(/^---\n([\s\S]+?)\n---/);
    const fm = fmMatch?.[1] ?? "";

    // Skip stubs
    const statusMatch = fm.match(/^status:\s*(.+)$/m);
    const status = statusMatch?.[1]?.trim().toLowerCase();
    if (status === "todo" || status === "stub") {
      console.log(`  ⚠  ${name} (skipped — status: ${status})`);
      skipped++;
      continue;
    }

    const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? name;
    const cmd = `---\ndescription: ${desc}\n---\nCall skill("${name}") and execute it. Arguments: $ARGUMENTS\n`;

    // Transform content: resolve ${CLAUDE_PLUGIN_ROOT} and strip AskUserQuestion
    const {
      content: transformedContent,
      pluginRootCount,
      queuePathCount,
      queueSchemaCount,
      domainPlaceholderCount,
      vocabularyAliasCount,
    } = transformSkillContent(raw, name);

    if (dryRun) {
      console.log(`  ✓  ${name} [dry-run]`);
      if (pluginRootCount > 0) {
        console.log(`    - ${pluginRootCount} plugin-root placeholder(s)`);
      }
      if (queuePathCount > 0 || queueSchemaCount > 0) {
        console.log(`    - normalized ${queuePathCount} queue path(s), ${queueSchemaCount} schema reference(s)`);
      }
      if (domainPlaceholderCount > 0 || vocabularyAliasCount > 0) {
        console.log(`    - normalized ${domainPlaceholderCount} DOMAIN placeholder(s), ${vocabularyAliasCount} vocabulary alias(es)`);
      }
      synced++;
      continue;
    }

    // Write SKILL.md to .opencode/skills/
    const skillDir = join(skillDest, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), transformedContent);

    if (pluginRootCount > 0) {
      console.log(`  → resolved ${pluginRootCount} \${CLAUDE_PLUGIN_ROOT} reference${pluginRootCount === 1 ? "" : "s"}`);
    }
    if (queuePathCount > 0 || queueSchemaCount > 0) {
      console.log(`  → normalized ${queuePathCount} queue path reference${queuePathCount === 1 ? "" : "s"} and ${queueSchemaCount} schema reference${queueSchemaCount === 1 ? "" : "s"}`);
    }
    if (domainPlaceholderCount > 0 || vocabularyAliasCount > 0) {
      console.log(`  → normalized ${domainPlaceholderCount} DOMAIN placeholder${domainPlaceholderCount === 1 ? "" : "s"} and ${vocabularyAliasCount} vocabulary alias${vocabularyAliasCount === 1 ? "" : "es"}`);
    }

    // Generate command stubs
    for (const dest of cmdDests) {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, `${name}.md`), cmd);
    }

    console.log(`  ✓  ${name}`);
    synced++;
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const action = dryRun ? "would sync" : "synced";
console.log(`\n${action}: ${synced} skill(s), skipped: ${skipped} stub(s)`);
if (dryRun) {
  console.log("[dry-run] no files written");
}
