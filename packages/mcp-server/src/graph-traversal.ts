/**
 * graph-traversal.ts
 *
 * Given seed thought paths (typically from qmd search results), traverse
 * wiki links to build the connected cluster of related thoughts.
 *
 * Uses extractWikiLinkTargets() from @intent-computer/architecture to parse
 * [[wiki links]] from thought files, then follows them hop-by-hop up to
 * maxDepth (default: 2).
 *
 * Returns a TraversalResult containing:
 *   - thoughts: each thought in the cluster with its depth from the seeds
 *   - connections: directed edges between thoughts with surrounding context
 *   - maps: which topic maps the cluster belongs to (from frontmatter topics)
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import {
  extractWikiLinkTargets,
  parseFrontmatter,
} from "@intent-computer/architecture";

export interface TraversalThought {
  path: string;
  title: string;
  description: string;
  depth: number;
}

export interface TraversalConnection {
  from: string;
  to: string;
  /** Surrounding prose context where the link appears (up to 200 chars). */
  context: string;
}

export interface TraversalResult {
  thoughts: TraversalThought[];
  connections: TraversalConnection[];
  /** Which maps (topics field) these thoughts belong to. */
  maps: string[];
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build a slug-to-path index for all .md files under a directory.
 * Slug = filename without extension, lowercased.
 */
function buildThoughtIndex(thoughtsDir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(thoughtsDir)) return index;

  let names: string[];
  try {
    names = readdirSync(thoughtsDir);
  } catch {
    return index;
  }

  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -3).toLowerCase();
    index.set(slug, join(thoughtsDir, name));
  }

  return index;
}

/**
 * Extract a short prose snippet surrounding a [[link]] in the content.
 * Returns up to 200 characters of context around the link target.
 */
function extractLinkContext(content: string, linkTarget: string): string {
  // Build a regex that matches the wiki link regardless of case / spacing
  const escaped = linkTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\[${escaped}\\]\\]`, "i");
  const match = re.exec(content);
  if (!match) return "";

  const start = Math.max(0, match.index - 80);
  const end = Math.min(content.length, match.index + match[0].length + 80);
  return content.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Parse the topic map names out of a thought's frontmatter topics array.
 * Topics look like: ["[[anxiety patterns]]", "[[founder ideas]]"]
 * Returns the text inside the brackets.
 */
function parseTopicMaps(fm: Record<string, unknown>): string[] {
  const raw = fm["topics"];
  if (!raw) return [];

  const items: string[] = Array.isArray(raw)
    ? raw.map((r) => String(r))
    : typeof raw === "string"
      ? [raw]
      : [];

  const maps: string[] = [];
  for (const item of items) {
    const match = /\[\[([^\]]+)\]\]/.exec(item);
    if (match && match[1]) {
      maps.push(match[1].trim());
    } else if (item.trim()) {
      maps.push(item.trim());
    }
  }
  return maps;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Traverse the knowledge graph from a set of seed paths, following wiki links
 * up to maxDepth hops. Returns the connected cluster with connections and maps.
 *
 * @param vaultRoot  Absolute path to the vault root directory.
 * @param seedPaths  Absolute paths to seed thought files (from qmd search).
 * @param maxDepth   How many link hops to follow (default: 2).
 */
export function traverseFromSeeds(
  vaultRoot: string,
  seedPaths: string[],
  maxDepth = 2,
): TraversalResult {
  const thoughtsDir = join(vaultRoot, "thoughts");
  const index = buildThoughtIndex(thoughtsDir);

  const thoughtsByPath = new Map<string, TraversalThought>();
  const connections: TraversalConnection[] = [];
  const mapsSet = new Set<string>();

  // Queue entries: [absolutePath, depth]
  const queue: Array<[string, number]> = [];
  const enqueued = new Set<string>();

  // Seed the queue with normalised paths
  for (const raw of seedPaths) {
    const abs = resolve(raw);
    if (!enqueued.has(abs)) {
      queue.push([abs, 0]);
      enqueued.add(abs);
    }
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const [filePath, depth] = item;

    const content = safeReadFile(filePath);
    if (!content) continue;

    const title = basename(filePath, ".md");
    const fm = parseFrontmatter(content);
    const description =
      typeof fm["description"] === "string" ? fm["description"] : "";

    // Register this thought
    if (!thoughtsByPath.has(filePath)) {
      thoughtsByPath.set(filePath, { path: filePath, title, description, depth });
    }

    // Collect map memberships
    for (const mapName of parseTopicMaps(fm)) {
      mapsSet.add(mapName);
    }

    // Don't follow links beyond maxDepth
    if (depth >= maxDepth) continue;

    // Parse outgoing links
    const linkTargets = extractWikiLinkTargets(content, {
      excludeCodeBlocks: true,
    });

    for (const target of linkTargets) {
      const targetPath = index.get(target.toLowerCase());
      if (!targetPath) continue;

      // Record the connection
      const context = extractLinkContext(content, target);
      connections.push({ from: title, to: target, context });

      // Enqueue the target if not yet visited
      if (!enqueued.has(targetPath)) {
        enqueued.add(targetPath);
        queue.push([targetPath, depth + 1]);
      }
    }
  }

  // Deduplicate connections (same from→to pair may appear if linked multiple times)
  const seenConnections = new Set<string>();
  const deduped: TraversalConnection[] = [];
  for (const conn of connections) {
    const key = `${conn.from}→${conn.to}`;
    if (!seenConnections.has(key)) {
      seenConnections.add(key);
      deduped.push(conn);
    }
  }

  return {
    thoughts: Array.from(thoughtsByPath.values()).sort((a, b) => a.depth - b.depth),
    connections: deduped,
    maps: Array.from(mapsSet).sort(),
  };
}
