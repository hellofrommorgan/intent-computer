/**
 * local-adapter.ts
 *
 * Implements IntentComputerMcpApi against the local filesystem.
 * All operations are synchronous reads/writes to the vault directory.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
} from "fs";
import { join, basename, relative, resolve } from "path";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import type {
  IntentComputerMcpApi,
  VaultContextRequest,
  VaultContextResponse,
  InboxCaptureRequest,
  InboxCaptureResponse,
  ThoughtSearchRequest,
  ThoughtSearchResponse,
  ThoughtGetRequest,
  ThoughtWriteRequest,
  ThoughtWriteResponse,
  LinkGraphRequest,
  LinkGraphResponse,
  QueuePushRequest,
  QueuePushResponse,
  QueuePopRequest,
  QueuePopResponse,
  Proposition,
  LinkGraphEdge,
  ThoughtSearchHit,
} from "@intent-computer/architecture";
import {
  extractFrontmatterBody,
  parseFrontmatter,
  parseTopicsFromFrontmatter,
  readQueue,
  withQueueLock,
  writeQueue,
} from "@intent-computer/architecture";
import { qmdSearch, qmdDeepSearch, isQmdAvailable } from "./qmd-bridge.js";
import { traverseFromSeeds } from "./graph-traversal.js";
import type { TraversalResult } from "./graph-traversal.js";

// ─── YAML frontmatter helpers ────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function countMdFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function collectMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      const fullPath = join(dir, name);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (name === ".git" || name === "node_modules") continue;
        stack.push(fullPath);
      } else if (name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const raw = match[1]?.trim();
    if (raw) links.push(raw);
  }
  return links;
}

// ─── Adapter implementation ──────────────────────────────────────────────────

export class LocalMcpAdapter implements IntentComputerMcpApi {
  constructor(private readonly vaultRoot: string) {}

  // ─── vault_context ───────────────────────────────────────────────────────

  async vaultContext(req: VaultContextRequest): Promise<VaultContextResponse> {
    const sections: string[] = [];
    const maintenanceSignals: string[] = [];

    // Identity
    if (req.includeIdentity !== false) {
      const identityPaths = [
        join(this.vaultRoot, "self", "identity.md"),
        join(this.vaultRoot, "ops", "identity.md"),
        join(this.vaultRoot, "identity.md"),
      ];
      for (const p of identityPaths) {
        const content = readFileSafe(p);
        if (content) {
          sections.push(`## Identity\n\n${content.trim()}`);
          break;
        }
      }
    }

    // Goals
    if (req.includeGoals !== false) {
      const goalsPaths = [
        join(this.vaultRoot, "self", "goals.md"),
        join(this.vaultRoot, "ops", "goals.md"),
      ];
      for (const p of goalsPaths) {
        const content = readFileSafe(p);
        if (content) {
          sections.push(`## Goals\n\n${content.trim()}`);
          break;
        }
      }
    }

    // Working memory
    const wmPaths = [
      join(this.vaultRoot, "self", "working-memory.md"),
      join(this.vaultRoot, "ops", "working-memory.md"),
    ];
    for (const p of wmPaths) {
      const content = readFileSafe(p);
      if (content) {
        sections.push(`## Working Memory\n\n${content.trim()}`);
        break;
      }
    }

    // Morning brief
    const briefContent = readFileSafe(
      join(this.vaultRoot, "ops", "morning-brief.md"),
    );
    if (briefContent) {
      sections.push(`## Morning Brief\n\n${briefContent.trim()}`);
    }

    // Maintenance signals
    if (req.includeMaintenance !== false) {
      const inboxCount = countMdFiles(join(this.vaultRoot, "inbox"));
      if (inboxCount >= 3) {
        maintenanceSignals.push(
          `${inboxCount} inbox items waiting for processing`,
        );
      }

      const obsCount = countMdFiles(
        join(this.vaultRoot, "ops", "observations"),
      );
      if (obsCount >= 10) {
        maintenanceSignals.push(`${obsCount} pending observations`);
      }

      const tensionCount = countMdFiles(
        join(this.vaultRoot, "ops", "tensions"),
      );
      if (tensionCount >= 5) {
        maintenanceSignals.push(`${tensionCount} pending tensions`);
      }

      // Orphan detection — thoughts not linked from any map
      try {
        const thoughtsDir = join(this.vaultRoot, "thoughts");
        if (existsSync(thoughtsDir)) {
          const thoughtFiles = readdirSync(thoughtsDir).filter(
            (f) => f.endsWith(".md") && f !== "index.md",
          );
          const linkedThoughts = new Set<string>();
          for (const mdPath of collectMarkdownFiles(this.vaultRoot)) {
            const content = readFileSafe(mdPath);
            if (!content) continue;
            for (const link of extractWikiLinks(content)) {
              linkedThoughts.add(link);
              linkedThoughts.add(slugify(link));
            }
          }
          let orphanCount = 0;
          for (const f of thoughtFiles) {
            const title = f.replace(/\.md$/, "");
            if (
              !linkedThoughts.has(title) &&
              !linkedThoughts.has(slugify(title))
            ) {
              orphanCount++;
            }
          }
          if (orphanCount >= 5) {
            maintenanceSignals.push(`${orphanCount} orphan thoughts detected`);
          }
        }
      } catch {
        // orphan detection is best-effort
      }

      // Session backlog
      const sessDir = join(this.vaultRoot, "ops", "sessions");
      if (existsSync(sessDir)) {
        const rawSessions = readdirSync(sessDir).filter((f) =>
          f.endsWith(".json"),
        );
        if (rawSessions.length >= 5) {
          maintenanceSignals.push(
            `${rawSessions.length} unprocessed sessions`,
          );
        }
      }
    }

    return {
      context: sections.join("\n\n---\n\n"),
      maintenanceSignals,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── inbox_capture ───────────────────────────────────────────────────────

  async inboxCapture(req: InboxCaptureRequest): Promise<InboxCaptureResponse> {
    const inboxDir = join(this.vaultRoot, "inbox");
    if (!existsSync(inboxDir)) {
      mkdirSync(inboxDir, { recursive: true });
    }

    const slug = slugify(req.title);
    const filename = `${slug}.md`;
    const filepath = join(inboxDir, filename);

    const tagsLine =
      req.tags && req.tags.length > 0
        ? `tags: [${req.tags.map((t) => `"${t}"`).join(", ")}]\n`
        : "";

    const content = `---
title: "${req.title}"
source: "${req.source}"
captured: "${new Date().toISOString()}"
${tagsLine}---

${req.body}
`;

    writeFileSync(filepath, content, "utf-8");

    const itemId = randomUUID();
    return { itemId, path: filepath };
  }

  // ─── thought_search ──────────────────────────────────────────────────────

  async thoughtSearch(
    req: ThoughtSearchRequest,
  ): Promise<ThoughtSearchResponse> {
    const thoughtsDir = join(this.vaultRoot, "thoughts");
    if (!existsSync(thoughtsDir)) {
      return { hits: [] };
    }

    const limit = req.limit ?? 10;
    const queryTrimmed = req.query.trim();
    if (!queryTrimmed) return { hits: [] };

    // ── qmd-backed semantic search (preferred) ──────────────────────────────
    if (isQmdAvailable()) {
      try {
        const results = qmdSearch(queryTrimmed, {
          limit,
          collection: "thoughts",
          vaultRoot: this.vaultRoot,
        });

        if (results.length > 0) {
          const hits: ThoughtSearchHit[] = [];
          for (const result of results) {
            const content = readFileSafe(result.path);
            if (!content) continue;

            const title = basename(result.path, ".md");
            const fm = parseFrontmatter(content);
            const topics = parseTopicsFromFrontmatter(content);

            const prop: Proposition = {
              id: title,
              vaultId: "local",
              title,
              description: fm["description"] ?? "",
              topics,
              confidence: fm["confidence"]
                ? parseFloat(fm["confidence"])
                : undefined,
              sourceRefs: fm["sources"] ? [fm["sources"]] : undefined,
              createdAt: fm["created"] ?? "",
              updatedAt: fm["created"] ?? "",
            };

            hits.push({
              proposition: prop,
              score: result.score,
              excerpt: result.excerpt || result.title || undefined,
            });
          }
          return { hits };
        }
      } catch {
        // qmd failed — fall through to keyword scan
      }
    }

    // ── Keyword fallback scan ───────────────────────────────────────────────
    const hits: ThoughtSearchHit[] = [];
    const queryLower = queryTrimmed.toLowerCase();

    for (const file of readdirSync(thoughtsDir).filter((f) => f.endsWith(".md"))) {
      if (hits.length >= limit) break;

      const filepath = join(thoughtsDir, file);
      const content = readFileSafe(filepath);
      if (!content) continue;

      const title = basename(filepath, ".md");
      const body = extractFrontmatterBody(content);
      const searchable = `${title}\n${body}`.toLowerCase();
      if (!searchable.includes(queryLower)) continue;

      const fm = parseFrontmatter(content);
      const topics = parseTopicsFromFrontmatter(content);

      // Extract an excerpt around the match
      let excerpt: string | undefined;
      const bodyLines = body.split("\n");
      for (const line of bodyLines) {
        if (line.toLowerCase().includes(queryLower)) {
          excerpt = line.trim().slice(0, 200);
          break;
        }
      }
      if (!excerpt && title.toLowerCase().includes(queryLower)) {
        excerpt = title;
      }

      const prop: Proposition = {
        id: title,
        vaultId: "local",
        title,
        description: fm["description"] ?? "",
        topics,
        confidence: fm["confidence"] ? parseFloat(fm["confidence"]) : undefined,
        sourceRefs: fm["sources"] ? [fm["sources"]] : undefined,
        createdAt: fm["created"] ?? "",
        updatedAt: fm["created"] ?? "",
      };

      hits.push({ proposition: prop, score: 1.0, excerpt });
    }

    return { hits };
  }

  // ─── thought_get ─────────────────────────────────────────────────────────

  async thoughtGet(req: ThoughtGetRequest): Promise<Proposition | null> {
    const filepath = this.resolveThoughtPath(req.thoughtId);
    if (!filepath) return null;

    const content = readFileSafe(filepath);
    if (!content) return null;

    const fm = parseFrontmatter(content);
    const topics = parseTopicsFromFrontmatter(content);
    const thoughtId = basename(filepath, ".md");

    return {
      id: thoughtId,
      vaultId: "local",
      title: thoughtId,
      description: fm["description"] ?? "",
      topics,
      confidence: fm["confidence"] ? parseFloat(fm["confidence"]) : undefined,
      sourceRefs: fm["sources"] ? [fm["sources"]] : undefined,
      createdAt: fm["created"] ?? "",
      updatedAt: fm["created"] ?? "",
    };
  }

  // ─── thought_write ───────────────────────────────────────────────────────

  async thoughtWrite(req: ThoughtWriteRequest): Promise<ThoughtWriteResponse> {
    const thoughtsDir = join(this.vaultRoot, "thoughts");
    if (!existsSync(thoughtsDir)) {
      mkdirSync(thoughtsDir, { recursive: true });
    }

    const thoughtId =
      slugify(req.proposition.title) ||
      slugify(req.proposition.id) ||
      randomUUID();
    const filename = `${thoughtId}.md`;
    const filepath = join(thoughtsDir, filename);

    const topicsYaml =
      req.proposition.topics.length > 0
        ? `topics: [${req.proposition.topics.map((t) => `"${t}"`).join(", ")}]`
        : "topics: []";

    const confidenceLine =
      req.proposition.confidence != null
        ? `confidence: ${req.proposition.confidence}\n`
        : "";

    const sourceRefsLine =
      req.proposition.sourceRefs && req.proposition.sourceRefs.length > 0
        ? `sources: [${req.proposition.sourceRefs.map((s) => `"${s}"`).join(", ")}]\n`
        : "";

    const now = new Date().toISOString();
    const created = req.proposition.createdAt || now.slice(0, 10);

    const content = `---
id: "${thoughtId}"
description: "${req.proposition.description}"
${topicsYaml}
${confidenceLine}${sourceRefsLine}created: ${created}
---

${req.markdown}
`;

    writeFileSync(filepath, content, "utf-8");

    // Auto-commit via git
    let version = "uncommitted";
    try {
      execFileSync("git", ["add", filepath], {
        cwd: this.vaultRoot,
        timeout: 5000,
        stdio: "pipe",
      });
      execFileSync("git", ["commit", "-m", `thought: ${req.proposition.title}`], {
        cwd: this.vaultRoot,
        timeout: 5000,
        stdio: "pipe",
      });
      const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: this.vaultRoot,
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      }).trim();
      version = hash;
    } catch {
      // git commit may fail if not in a repo or nothing to commit — that's ok
    }

    return {
      thoughtId,
      path: filepath,
      version,
    };
  }

  // ─── link_graph ──────────────────────────────────────────────────────────

  async linkGraph(req: LinkGraphRequest): Promise<LinkGraphResponse> {
    const thoughtsDir = join(this.vaultRoot, "thoughts");
    if (!existsSync(thoughtsDir)) {
      return { edges: [] };
    }

    const filteredThoughtId = req.thoughtId?.trim();
    if (filteredThoughtId && !this.resolveThoughtPath(filteredThoughtId)) {
      return { edges: [] };
    }

    const limit = req.limit ?? 100;
    const edges: LinkGraphEdge[] = [];
    const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

    const files = readdirSync(thoughtsDir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      const sourceId = file.replace(/\.md$/, "");

      // If filtering by thoughtId, only process that file or files linking to it
      if (filteredThoughtId && sourceId !== filteredThoughtId) {
        // Check if this file links TO the requested thought
        const content = readFileSafe(join(thoughtsDir, file));
        if (!content) continue;
        const links = [...content.matchAll(WIKI_LINK_RE)].map((m) => m[1]);
        for (const link of links) {
          if (link === filteredThoughtId || slugify(link) === filteredThoughtId) {
            edges.push({
              sourceId,
              targetId: link,
              relation: "links-to",
            });
          }
        }
        if (edges.length >= limit) break;
        continue;
      }

      const content = readFileSafe(join(thoughtsDir, file));
      if (!content) continue;

      const links = [...content.matchAll(WIKI_LINK_RE)].map((m) => m[1]);
      for (const link of links) {
        edges.push({
          sourceId,
          targetId: link,
          relation: "links-to",
        });
        if (edges.length >= limit) break;
      }
      if (edges.length >= limit) break;
    }

    // If filtering by thoughtId, also collect outgoing links from that thought
    if (filteredThoughtId) {
      const thoughtPath = this.resolveThoughtPath(filteredThoughtId);
      const content = thoughtPath ? readFileSafe(thoughtPath) : null;
      if (content) {
        const links = [...content.matchAll(WIKI_LINK_RE)].map((m) => m[1]);
        for (const link of links) {
          // Avoid duplicates
          if (
            !edges.some(
              (e) => e.sourceId === filteredThoughtId && e.targetId === link,
            )
          ) {
            edges.push({
              sourceId: filteredThoughtId,
              targetId: link,
              relation: "links-to",
            });
          }
        }
      }
    }

    return { edges: edges.slice(0, limit) };
  }

  // ─── queue_push ──────────────────────────────────────────────────────────

  async queuePush(req: QueuePushRequest): Promise<QueuePushResponse> {
    return withQueueLock(this.vaultRoot, async () => {
      const now = new Date().toISOString();
      const queue = readQueue(this.vaultRoot);
      const taskId = randomUUID();

      queue.tasks.push({
        taskId,
        vaultId: this.vaultRoot,
        target: req.target,
        sourcePath: req.sourcePath,
        phase: req.phase,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 3,
      });
      queue.lastUpdated = now;

      writeQueue(this.vaultRoot, queue);
      return { taskId };
    });
  }

  // ─── queue_pop ───────────────────────────────────────────────────────────

  async queuePop(req: QueuePopRequest): Promise<QueuePopResponse | null> {
    return withQueueLock(this.vaultRoot, async () => {
      const now = new Date();
      const nowIso = now.toISOString();
      const queue = readQueue(this.vaultRoot);
      if (queue.tasks.length === 0) return null;

      // Prefer pending tasks first, then retry failed tasks.
      const idx = queue.tasks.findIndex((task) => {
        const status = task.status ?? "pending";
        if (status !== "pending" && status !== "failed") return false;
        if (!task.lockedUntil) return true;
        return new Date(task.lockedUntil) <= now;
      });

      if (idx === -1) return null;

      const task = queue.tasks[idx];
      if (req.lockTtlSeconds && req.lockTtlSeconds > 0) {
        task.lockedUntil = new Date(
          now.getTime() + req.lockTtlSeconds * 1000,
        ).toISOString();
        task.status = "in-progress";
        task.updatedAt = nowIso;
      } else {
        queue.tasks.splice(idx, 1);
      }

      queue.lastUpdated = nowIso;
      writeQueue(this.vaultRoot, queue);

      return {
        taskId: task.taskId,
        target: task.target,
        sourcePath: task.sourcePath,
        phase: task.phase,
      };
    });
  }

  // ─── context_query ────────────────────────────────────────────────────────

  /**
   * Semantic search + graph traversal.
   *
   * 1. Runs qmd deep_search to find seed thoughts.
   * 2. Traverses wiki links from those seeds (up to maxDepth hops).
   * 3. Returns the connected cluster with map membership.
   *
   * Falls back to empty result if qmd is unavailable.
   */
  async contextQuery(req: {
    query: string;
    limit?: number;
    maxDepth?: number;
  }): Promise<TraversalResult> {
    const empty: TraversalResult = { thoughts: [], connections: [], maps: [] };

    if (!isQmdAvailable()) return empty;

    const queryTrimmed = req.query.trim();
    if (!queryTrimmed) return empty;

    let seedPaths: string[];
    try {
      const results = qmdDeepSearch(queryTrimmed, {
        limit: req.limit ?? 5,
        collection: "thoughts",
        vaultRoot: this.vaultRoot,
      });
      seedPaths = results.map((r) => r.path);
    } catch {
      return empty;
    }

    if (seedPaths.length === 0) return empty;

    return traverseFromSeeds(this.vaultRoot, seedPaths, req.maxDepth ?? 2);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private resolveThoughtPath(thoughtId: string): string | null {
    const candidateId = thoughtId.trim();
    if (
      !candidateId ||
      candidateId.includes("..") ||
      candidateId.includes("/") ||
      candidateId.includes("\\") ||
      candidateId.includes("\0")
    ) {
      return null;
    }

    const thoughtsDir = join(this.vaultRoot, "thoughts");
    const filepath = resolve(thoughtsDir, `${candidateId}.md`);
    const rel = relative(thoughtsDir, filepath);
    if (rel.startsWith("..") || rel === "") return null;

    return filepath;
  }
}
