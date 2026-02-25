#!/usr/bin/env tsx

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, relative } from "path";
import {
  isKebabCase,
  scanVaultGraph,
  toKebabCase,
  withCollisionSuffix,
} from "../packages/architecture/src/index.js";

interface SourceResolutionIssue {
  file: string;
  label: string;
  reason: "missing" | "ambiguous";
  candidates: string[];
}

interface RenameRecord {
  from: string;
  to: string;
}

interface Wave12Report {
  wave: "1.2";
  vaultRoot: string;
  startedAt: string;
  finishedAt: string;
  snapshotPath: string;
  reportPathJson: string;
  reportPathMarkdown: string;
  success: boolean;
  error?: string;
  steps: {
    commandArtifacts: {
      filesUpdated: number;
      replacements: number;
    };
    sourceFooters: {
      filesUpdated: number;
      replacements: number;
      unresolved: SourceResolutionIssue[];
    };
    mapHygiene: {
      mapFilesUpdated: number;
      breadcrumbsWritten: number;
      breadcrumbsMoved: number;
    };
    filenameMigration: {
      filesRenamed: number;
      linksRewritten: number;
      renameRecords: RenameRecord[];
      ambiguousLinkTargets: string[];
    };
    validation: {
      danglingWikiLinks: number;
      orphanCount: number;
    };
  };
}

interface RewriteSummary {
  filesUpdated: number;
  replacements: number;
}

interface SourceRewriteSummary extends RewriteSummary {
  unresolved: SourceResolutionIssue[];
}

interface MapHygieneSummary {
  mapFilesUpdated: number;
  breadcrumbsWritten: number;
  breadcrumbsMoved: number;
}

interface FilenameMigrationSummary {
  filesRenamed: number;
  linksRewritten: number;
  renameRecords: RenameRecord[];
  ambiguousLinkTargets: string[];
}

class MigrationAbortError extends Error {
  readonly report: Wave12Report;

  constructor(message: string, report: Wave12Report) {
    super(message);
    this.name = "MigrationAbortError";
    this.report = report;
  }
}

function nowTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toPosixPath(value: string): string {
  return value.split("\\").join("/");
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (fullPath.includes(join("ops", "migrations"))) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function listTopLevelEntries(vaultRoot: string): string[] {
  try {
    return readdirSync(vaultRoot).sort();
  } catch {
    return [];
  }
}

function createSnapshot(vaultRoot: string, snapshotPath: string): void {
  mkdirSync(snapshotPath, { recursive: true });

  for (const entry of listTopLevelEntries(vaultRoot)) {
    if (entry === ".DS_Store") continue;
    const source = join(vaultRoot, entry);
    const target = join(snapshotPath, entry);

    if (entry === "ops" && existsSync(source)) {
      mkdirSync(target, { recursive: true });
      const opsEntries = readdirSync(source);
      for (const opsEntry of opsEntries) {
        if (opsEntry === "migrations") continue;
        cpSync(join(source, opsEntry), join(target, opsEntry), { recursive: true });
      }
      continue;
    }

    cpSync(source, target, { recursive: true });
  }
}

function rewriteManifestCommands(content: string): { updated: string; replacements: number } {
  let updated = content;
  let replacements = 0;

  if (/^\s*cmd_ralph:\s*.+$/m.test(updated)) {
    updated = updated.replace(/^\s*cmd_ralph:\s*.+\n?/gm, "");
    replacements += 1;
  }
  if (/^\s*cmd_pipeline:\s*.+$/m.test(updated)) {
    updated = updated.replace(/^\s*cmd_pipeline:\s*.+\n?/gm, "");
    replacements += 1;
  }

  if (/^\s*cmd_process:\s*.+$/m.test(updated)) {
    updated = updated.replace(/^\s*cmd_process:\s*.+$/m, '  cmd_process: "process"');
    replacements += 1;
  } else if (/^\s*cmd_seed:\s*.+$/m.test(updated)) {
    updated = updated.replace(/^\s*cmd_seed:\s*.+$/m, (line) => `${line}\n  cmd_process: "process"`);
    replacements += 1;
  }

  return { updated, replacements };
}

function rewriteCommandArtifacts(vaultRoot: string): RewriteSummary {
  let filesUpdated = 0;
  let replacements = 0;

  const manifestPath = join(vaultRoot, "ops", "derivation-manifest.md");
  if (existsSync(manifestPath)) {
    const before = readFileSync(manifestPath, "utf-8");
    const manifest = rewriteManifestCommands(before);
    if (manifest.updated !== before) {
      writeFileSync(manifestPath, manifest.updated, "utf-8");
      filesUpdated += 1;
      replacements += manifest.replacements;
    }
  }

  const roots = [join(vaultRoot, "ops"), join(vaultRoot, "self")];
  const files = roots.flatMap((root) => listMarkdownFiles(root));
  for (const file of files) {
    const before = readFileSync(file, "utf-8");
    const updated = before
      .replace(/\/pipeline\b/g, "/process")
      .replace(/\/ralph\b/g, "/process");
    if (updated === before) continue;

    const localReplacements = (before.match(/\/(pipeline|ralph)\b/g) ?? []).length;
    writeFileSync(file, updated, "utf-8");
    filesUpdated += 1;
    replacements += localReplacements;
  }

  return { filesUpdated, replacements };
}

function buildArchiveIndex(vaultRoot: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const archiveRoots = [
    join(vaultRoot, "ops", "queue", "archive"),
    join(vaultRoot, "archive"),
  ];

  for (const root of archiveRoots) {
    for (const file of listMarkdownFiles(root)) {
      const key = basename(file, ".md").toLowerCase();
      const list = index.get(key) ?? [];
      list.push(file);
      index.set(key, list);
    }
  }

  return index;
}

function resolveArchiveSource(
  label: string,
  archiveIndex: Map<string, string[]>,
): string[] {
  const raw = label.split("|")[0]?.split("#")[0]?.trim() ?? "";
  if (!raw) return [];

  const key = raw.toLowerCase();
  const slugKey = toKebabCase(raw);

  const direct = archiveIndex.get(key) ?? [];
  if (direct.length > 0) return [...direct];

  if (slugKey) {
    const bySlug = archiveIndex.get(slugKey) ?? [];
    if (bySlug.length > 0) return [...bySlug];
  }

  return [];
}

function rewriteSourceFooters(vaultRoot: string): SourceRewriteSummary {
  const files = listMarkdownFiles(vaultRoot);
  const archiveIndex = buildArchiveIndex(vaultRoot);
  const unresolved: SourceResolutionIssue[] = [];
  const plans = new Map<string, string>();

  const sourcePattern = /Source:\s*\[\[([^\]]+)\]\]/g;

  for (const file of files) {
    const before = readFileSync(file, "utf-8");
    const matches = [...before.matchAll(sourcePattern)];
    if (matches.length === 0) continue;

    for (const match of matches) {
      const label = (match[1] ?? "").trim();
      const candidates = resolveArchiveSource(label, archiveIndex);
      if (candidates.length === 0) {
        unresolved.push({
          file: toPosixPath(relative(vaultRoot, file)),
          label,
          reason: "missing",
          candidates: [],
        });
        continue;
      }
      if (candidates.length > 1) {
        unresolved.push({
          file: toPosixPath(relative(vaultRoot, file)),
          label,
          reason: "ambiguous",
          candidates: candidates.map((candidate) => toPosixPath(relative(vaultRoot, candidate))),
        });
        continue;
      }

      const resolved = candidates[0]!;
      const vaultRelative = toPosixPath(relative(vaultRoot, resolved));
      const replacement = `Source: [${label}](${vaultRelative})`;
      const raw = match[0] ?? "";
      plans.set(`${file}::${raw}`, replacement);
    }
  }

  if (unresolved.length > 0) {
    return {
      filesUpdated: 0,
      replacements: 0,
      unresolved,
    };
  }

  let filesUpdated = 0;
  let replacements = 0;

  for (const file of files) {
    const before = readFileSync(file, "utf-8");
    let updated = before;

    const matches = [...before.matchAll(sourcePattern)];
    if (matches.length === 0) continue;

    for (const match of matches) {
      const raw = match[0] ?? "";
      const key = `${file}::${raw}`;
      const replacement = plans.get(key);
      if (!replacement) continue;
      updated = updated.replace(raw, replacement);
      replacements += 1;
    }

    if (updated !== before) {
      writeFileSync(file, updated, "utf-8");
      filesUpdated += 1;
    }
  }

  return { filesUpdated, replacements, unresolved };
}

function collectAgentNotes(content: string): string[] {
  const collected: string[] = [];

  for (const match of content.matchAll(/\n##\s*Agent Notes\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/g)) {
    const body = match[1] ?? "";
    const bullets = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "));
    collected.push(...bullets);
  }

  for (const match of content.matchAll(/\nAgent Notes:\s*\n((?:- .*\n?)+)/g)) {
    const body = match[1] ?? "";
    const bullets = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "));
    collected.push(...bullets);
  }

  return [...new Set(collected)];
}

function removeAgentNotesSections(content: string): string {
  return content
    .replace(/\n##\s*Agent Notes\s*\n[\s\S]*?(?=\n##\s|\n#\s|$)/g, "\n")
    .replace(/\nAgent Notes:\s*\n(?:- .*\n?)+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function writeNavigationBreadcrumb(
  vaultRoot: string,
  mapSlug: string,
  bullets: string[],
): boolean {
  if (bullets.length === 0) return false;

  const dir = join(vaultRoot, "ops", "observations", "navigation");
  mkdirSync(dir, { recursive: true });

  const target = join(dir, `${mapSlug}.md`);
  const title = mapSlug.replace(/-/g, " ");
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
  const existingBullets = existing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));

  const merged = [...new Set([...existingBullets, ...bullets])];
  const content = [
    `# Navigation Breadcrumbs: ${title}`,
    "",
    ...merged,
    "",
  ].join("\n");

  if (content !== existing) {
    writeFileSync(target, content, "utf-8");
    return true;
  }

  return false;
}

function extractMapAgentNotes(vaultRoot: string): MapHygieneSummary {
  const roots = [join(vaultRoot, "thoughts"), join(vaultRoot, "self")];
  const files = roots.flatMap((root) => listMarkdownFiles(root));

  let mapFilesUpdated = 0;
  let breadcrumbsWritten = 0;
  let breadcrumbsMoved = 0;

  for (const file of files) {
    const before = readFileSync(file, "utf-8");
    if (!before.includes("Agent Notes")) continue;

    const notes = collectAgentNotes(before);
    const slug = toKebabCase(basename(file, ".md")) || basename(file, ".md").toLowerCase();
    const breadcrumbWritten = writeNavigationBreadcrumb(vaultRoot, slug, notes);
    if (breadcrumbWritten) breadcrumbsWritten += 1;
    breadcrumbsMoved += notes.length;

    const updated = removeAgentNotesSections(before);
    if (updated !== before) {
      writeFileSync(file, updated, "utf-8");
      mapFilesUpdated += 1;
    }
  }

  return { mapFilesUpdated, breadcrumbsWritten, breadcrumbsMoved };
}

interface RenamePlan {
  oldPath: string;
  newPath: string;
  oldBase: string;
  newBase: string;
}

function buildRenamePlans(vaultRoot: string): RenamePlan[] {
  const roots = [
    join(vaultRoot, "thoughts"),
    join(vaultRoot, "self"),
    join(vaultRoot, "ops", "queue"),
  ];
  const allFiles = roots.flatMap((root) => listMarkdownFiles(root));

  const byDir = new Map<string, string[]>();
  for (const file of allFiles) {
    const dir = dirname(file);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }

  const plans: RenamePlan[] = [];

  for (const [dir, files] of byDir.entries()) {
    const sorted = [...files].sort();
    const reservedLower = new Set(
      sorted.map((file) => basename(file, ".md").toLowerCase()),
    );

    for (const file of sorted) {
      const oldBase = basename(file, ".md");
      if (isKebabCase(oldBase)) continue;

      const stem = toKebabCase(oldBase) || "untitled";
      let index = 1;
      let candidate = withCollisionSuffix(stem, index);
      while (reservedLower.has(candidate.toLowerCase()) && candidate.toLowerCase() !== oldBase.toLowerCase()) {
        index += 1;
        candidate = withCollisionSuffix(stem, index);
      }

      if (candidate.toLowerCase() === oldBase.toLowerCase() && candidate === oldBase) {
        continue;
      }

      reservedLower.delete(oldBase.toLowerCase());
      reservedLower.add(candidate.toLowerCase());

      plans.push({
        oldPath: file,
        newPath: join(dir, `${candidate}.md`),
        oldBase,
        newBase: candidate,
      });
    }
  }

  return plans.sort((a, b) => a.oldPath.localeCompare(b.oldPath));
}

function applyRenames(plans: RenamePlan[]): RenameRecord[] {
  const records: RenameRecord[] = [];

  for (const plan of plans) {
    if (plan.oldPath === plan.newPath) continue;

    const samePathCaseOnly = plan.oldPath.toLowerCase() === plan.newPath.toLowerCase();
    if (samePathCaseOnly) {
      const temp = `${plan.oldPath}.wave12-temp`;
      renameSync(plan.oldPath, temp);
      renameSync(temp, plan.newPath);
    } else {
      renameSync(plan.oldPath, plan.newPath);
    }

    records.push({ from: plan.oldPath, to: plan.newPath });
  }

  return records;
}

function rewriteWikiLinks(vaultRoot: string, renameRecords: RenameRecord[]): {
  linksRewritten: number;
  ambiguousLinkTargets: string[];
} {
  const map = new Map<string, string[]>();
  for (const record of renameRecords) {
    const oldBase = basename(record.from, ".md").toLowerCase();
    const newBase = basename(record.to, ".md");
    const list = map.get(oldBase) ?? [];
    list.push(newBase);
    map.set(oldBase, list);
  }

  const rewriteMap = new Map<string, string>();
  const ambiguousLinkTargets: string[] = [];
  for (const [oldBase, values] of map.entries()) {
    const unique = [...new Set(values)];
    if (unique.length === 1) {
      rewriteMap.set(oldBase, unique[0]!);
    } else {
      ambiguousLinkTargets.push(oldBase);
    }
  }

  let linksRewritten = 0;
  const files = listMarkdownFiles(vaultRoot);

  for (const file of files) {
    const before = readFileSync(file, "utf-8");
    const updated = before.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g, (full, target, anchor, alias) => {
      const rawTarget = String(target ?? "").trim();
      if (!rawTarget) return full;
      const targetKey = rawTarget.split("/").at(-1)!.replace(/\.md$/i, "").toLowerCase();
      const replacement = rewriteMap.get(targetKey);
      if (!replacement) return full;
      if (replacement === rawTarget) return full;
      linksRewritten += 1;
      const anchorPart = typeof anchor === "string" ? anchor : "";
      const aliasPart = typeof alias === "string" ? alias : "";
      return `[[${replacement}${anchorPart}${aliasPart}]]`;
    });

    if (updated !== before) {
      writeFileSync(file, updated, "utf-8");
    }
  }

  return { linksRewritten, ambiguousLinkTargets: ambiguousLinkTargets.sort() };
}

function migrateFilenamesAndLinks(vaultRoot: string): FilenameMigrationSummary {
  const plans = buildRenamePlans(vaultRoot);
  const records = applyRenames(plans);
  const rewritten = rewriteWikiLinks(vaultRoot, records);

  return {
    filesRenamed: records.length,
    linksRewritten: rewritten.linksRewritten,
    renameRecords: records.map((record) => ({
      from: toPosixPath(relative(vaultRoot, record.from)),
      to: toPosixPath(relative(vaultRoot, record.to)),
    })),
    ambiguousLinkTargets: rewritten.ambiguousLinkTargets,
  };
}

function validatePostMigration(vaultRoot: string): { danglingWikiLinks: number; orphanCount: number } {
  const graph = scanVaultGraph(vaultRoot, {
    entityDirs: ["thoughts", "self"],
    excludeCodeBlocks: true,
  });
  return {
    danglingWikiLinks: graph.danglingCount,
    orphanCount: graph.orphanCount,
  };
}

function renderReportMarkdown(report: Wave12Report): string {
  const lines: string[] = [
    "# Wave 1.2 Migration Report",
    "",
    `- Vault: ${report.vaultRoot}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Success: ${report.success ? "yes" : "no"}`,
    `- Snapshot: ${toPosixPath(report.snapshotPath)}`,
    "",
    "## Step Results",
    "",
    `- Command artifacts: ${report.steps.commandArtifacts.filesUpdated} file(s), ${report.steps.commandArtifacts.replacements} replacement(s)`,
    `- Source footers: ${report.steps.sourceFooters.filesUpdated} file(s), ${report.steps.sourceFooters.replacements} rewrite(s)`,
    `- Map hygiene: ${report.steps.mapHygiene.mapFilesUpdated} map file(s), ${report.steps.mapHygiene.breadcrumbsMoved} breadcrumb(s), ${report.steps.mapHygiene.breadcrumbsWritten} breadcrumb file write(s)`,
    `- Filename migration: ${report.steps.filenameMigration.filesRenamed} rename(s), ${report.steps.filenameMigration.linksRewritten} wiki-link rewrite(s)`,
    `- Validation: ${report.steps.validation.danglingWikiLinks} dangling wiki link(s), ${report.steps.validation.orphanCount} orphan graph entity count`,
  ];

  if (report.steps.sourceFooters.unresolved.length > 0) {
    lines.push("", "## Unresolved Source Footers", "");
    for (const issue of report.steps.sourceFooters.unresolved) {
      lines.push(`- ${issue.file}: ${issue.label} (${issue.reason})`);
      if (issue.candidates.length > 0) {
        lines.push(`  candidates: ${issue.candidates.join(", ")}`);
      }
    }
  }

  if (report.steps.filenameMigration.ambiguousLinkTargets.length > 0) {
    lines.push("", "## Ambiguous Wiki-Link Targets", "");
    for (const target of report.steps.filenameMigration.ambiguousLinkTargets) {
      lines.push(`- ${target}`);
    }
  }

  if (report.error) {
    lines.push("", "## Error", "", report.error);
  }

  return `${lines.join("\n").trim()}\n`;
}

function writeReports(report: Wave12Report): void {
  writeFileSync(report.reportPathJson, JSON.stringify(report, null, 2), "utf-8");
  writeFileSync(report.reportPathMarkdown, renderReportMarkdown(report), "utf-8");
}

export function migrateWave12Contracts(vaultRoot: string): Wave12Report {
  const startedAt = new Date().toISOString();
  const stamp = nowTimestamp();
  const migrationRoot = join(vaultRoot, "ops", "migrations", `${stamp}-wave12`);
  const snapshotPath = join(migrationRoot, "pre");
  mkdirSync(migrationRoot, { recursive: true });

  const report: Wave12Report = {
    wave: "1.2",
    vaultRoot,
    startedAt,
    finishedAt: startedAt,
    snapshotPath,
    reportPathJson: join(migrationRoot, "report.json"),
    reportPathMarkdown: join(migrationRoot, "report.md"),
    success: false,
    steps: {
      commandArtifacts: { filesUpdated: 0, replacements: 0 },
      sourceFooters: { filesUpdated: 0, replacements: 0, unresolved: [] },
      mapHygiene: { mapFilesUpdated: 0, breadcrumbsWritten: 0, breadcrumbsMoved: 0 },
      filenameMigration: { filesRenamed: 0, linksRewritten: 0, renameRecords: [], ambiguousLinkTargets: [] },
      validation: { danglingWikiLinks: 0, orphanCount: 0 },
    },
  };

  try {
    createSnapshot(vaultRoot, snapshotPath);

    report.steps.commandArtifacts = rewriteCommandArtifacts(vaultRoot);

    report.steps.sourceFooters = rewriteSourceFooters(vaultRoot);
    if (report.steps.sourceFooters.unresolved.length > 0) {
      throw new Error("Source footer rewrite failed: unresolved archive references");
    }

    report.steps.mapHygiene = extractMapAgentNotes(vaultRoot);

    report.steps.filenameMigration = migrateFilenamesAndLinks(vaultRoot);

    report.steps.validation = validatePostMigration(vaultRoot);

    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.success = false;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeReports(report);
  }

  if (!report.success) {
    throw new MigrationAbortError(report.error ?? "Wave 1.2 migration failed", report);
  }

  return report;
}

function parseArgs(argv: string[]): { vaultRoot: string } {
  const args = argv.slice(2);
  let vaultRoot = join(process.env.HOME ?? "/tmp", "Mind");

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--vault" && args[i + 1]) {
      vaultRoot = args[i + 1]!;
      i += 1;
    }
  }

  return { vaultRoot };
}

function main(): void {
  const { vaultRoot } = parseArgs(process.argv);
  if (!existsSync(vaultRoot)) {
    console.error(`vault not found: ${vaultRoot}`);
    process.exit(1);
    return;
  }

  try {
    const report = migrateWave12Contracts(vaultRoot);
    console.log(`Wave 1.2 migration complete: ${report.reportPathMarkdown}`);
  } catch (error) {
    if (error instanceof MigrationAbortError) {
      console.error(error.message);
      console.error(`report: ${error.report.reportPathMarkdown}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
