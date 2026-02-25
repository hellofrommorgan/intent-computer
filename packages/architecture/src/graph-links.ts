import { existsSync, readdirSync, readFileSync } from "fs";
import type { Dirent } from "fs";
import { basename, join, relative } from "path";

const DEFAULT_ENTITY_DIRS = ["thoughts", "self"];

export interface GraphScanOptions {
  entityDirs?: string[];
  excludeCodeBlocks?: boolean;
}

export interface GraphEntity {
  slug: string;
  key: string;
  path: string;
  relativePath: string;
}

export interface DanglingWikiLink {
  sourcePath: string;
  sourceRelativePath: string;
  target: string;
}

export interface GraphScanResult {
  entities: GraphEntity[];
  incomingByPath: Record<string, number>;
  orphanEntities: GraphEntity[];
  orphanCount: number;
  danglingLinks: DanglingWikiLink[];
  danglingCount: number;
}

function canonicalLinkTarget(value: string): string {
  const withoutAlias = value.split("|")[0]?.trim() ?? "";
  const withoutAnchor = withoutAlias.split("#")[0]?.trim() ?? "";
  const basenameOnly = withoutAnchor.split("/").at(-1)?.trim() ?? "";
  return basenameOnly.replace(/\.md$/i, "").toLowerCase();
}

function walkMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
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

export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "");
}

export function extractWikiLinkTargets(
  content: string,
  options: { excludeCodeBlocks?: boolean } = {},
): string[] {
  const scanContent = options.excludeCodeBlocks === false
    ? content
    : stripFencedCodeBlocks(content);

  const targets: string[] = [];
  const matches = scanContent.matchAll(/\[\[([^\]\n]+)\]\]/g);
  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const canonical = canonicalLinkTarget(raw);
    if (!canonical) continue;
    targets.push(canonical);
  }
  return targets;
}

export function scanVaultGraph(
  vaultRoot: string,
  options: GraphScanOptions = {},
): GraphScanResult {
  const entityDirs = options.entityDirs ?? DEFAULT_ENTITY_DIRS;
  const entities: GraphEntity[] = [];

  for (const dir of entityDirs) {
    const fullDir = join(vaultRoot, dir);
    for (const filePath of walkMarkdownFiles(fullDir)) {
      const slug = basename(filePath, ".md");
      entities.push({
        slug,
        key: slug.toLowerCase(),
        path: filePath,
        relativePath: relative(vaultRoot, filePath),
      });
    }
  }

  const entityByKey = new Map<string, GraphEntity>();
  for (const entity of entities) {
    if (!entityByKey.has(entity.key)) {
      entityByKey.set(entity.key, entity);
    }
  }

  const incomingByPath: Record<string, number> = {};
  for (const entity of entities) incomingByPath[entity.path] = 0;

  const danglingLinks: DanglingWikiLink[] = [];

  for (const entity of entities) {
    let content = "";
    try {
      content = readFileSync(entity.path, "utf-8");
    } catch {
      continue;
    }

    const targets = extractWikiLinkTargets(content, {
      excludeCodeBlocks: options.excludeCodeBlocks,
    });
    for (const target of targets) {
      const linked = entityByKey.get(target);
      if (!linked) {
        danglingLinks.push({
          sourcePath: entity.path,
          sourceRelativePath: entity.relativePath,
          target,
        });
        continue;
      }

      // Self-links should not clear orphan status.
      if (linked.path === entity.path) continue;
      incomingByPath[linked.path] = (incomingByPath[linked.path] ?? 0) + 1;
    }
  }

  const orphanEntities = entities.filter((entity) => (incomingByPath[entity.path] ?? 0) === 0);

  return {
    entities,
    incomingByPath,
    orphanEntities,
    orphanCount: orphanEntities.length,
    danglingLinks,
    danglingCount: danglingLinks.length,
  };
}
