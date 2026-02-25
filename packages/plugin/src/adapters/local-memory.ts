/**
 * local-memory.ts — MemoryPort adapter
 *
 * Lightweight memory hydration and recording against the local vault.
 * Loads propositions by searching thoughts/*.md for commitment-relevant
 * content, parses YAML frontmatter, and checks queue depth.
 *
 * This is intentionally minimal — no full search engine. Semantic search
 * (qmd) is used at a higher layer. This adapter provides the structural
 * memory context the intent loop needs to make decisions.
 */

import { appendFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import type {
  MemoryPort,
  MemoryHydrationInput,
  MemoryWriteEnvelope,
  MemoryContext,
  Proposition,
  PropositionLink,
} from "@intent-computer/architecture";
import {
  parseFrontmatter,
} from "@intent-computer/architecture";

// ─── qmd helpers (inline to avoid cross-package dependency) ──────────────────

interface QmdResult {
  path: string;
  score: number;
}

function findQmdBinary(): string | null {
  const envPath = process.env["QMD_PATH"];
  if (envPath) {
    try {
      if (existsSync(envPath)) return envPath;
    } catch { /* ignore */ }
  }

  const candidates = [
    join(homedir(), ".bun", "bin", "qmd"),
    join(homedir(), ".local", "bin", "qmd"),
    "/usr/local/bin/qmd",
    "/opt/homebrew/bin/qmd",
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch { /* ignore */ }
  }

  try {
    const result = execFileSync("which", ["qmd"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: "pipe",
    }).trim();
    if (result && existsSync(result)) return result;
  } catch { /* ignore */ }

  return null;
}

/**
 * Run qmd vsearch and return result paths.
 * Returns null if qmd is unavailable or fails.
 */
function qmdVectorSearchPaths(
  query: string,
  vaultRoot: string,
  limit: number,
): QmdResult[] | null {
  const bin = findQmdBinary();
  if (!bin) return null;

  const args = [
    "vsearch",
    query,
    "--json",
    "-n",
    String(limit),
    "--collection",
    "thoughts",
  ];

  let raw: string;
  try {
    raw = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
      cwd: vaultRoot,
    });
  } catch {
    return null;
  }

  const jsonStart = raw.indexOf("[");
  if (jsonStart === -1) return null;

  let parsed: Array<{ file?: string; score?: number }>;
  try {
    parsed = JSON.parse(raw.slice(jsonStart));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const QMD_SCHEME = "qmd://";
  return parsed
    .filter((r) => typeof r.file === "string")
    .map((r) => {
      const file = r.file as string;
      const rel = file.startsWith(QMD_SCHEME)
        ? file.slice(QMD_SCHEME.length)
        : file;
      return {
        path: join(vaultRoot, rel),
        score: typeof r.score === "number" ? r.score : 0,
      };
    });
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class LocalMemoryAdapter implements MemoryPort {
  private readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
  }

  async hydrate(input: MemoryHydrationInput): Promise<MemoryContext> {
    const now = new Date().toISOString();
    const thoughtsDir = join(this.vaultRoot, "thoughts");
    const propositions: Proposition[] = [];
    const links: PropositionLink[] = [];

    // ─── Load propositions related to active commitments ────────────────────
    const commitmentLabels = input.commitment.activeCommitments.map(c => c.label.toLowerCase());

    if (existsSync(thoughtsDir)) {
      // Build the set of relevant file paths using qmd vector search when possible,
      // falling back to keyword-based relevance scanning.
      const relevantPaths = await this.findRelevantPaths(commitmentLabels, thoughtsDir);

      for (const filePath of relevantPaths) {
        const content = this.safeReadFile(filePath);
        if (!content) continue;

        const parsed = this.parseThought(filePath, content);
        if (!parsed) continue;

        propositions.push(parsed);

        // Extract wiki links as PropositionLinks
        const outgoing = this.extractWikiLinks(content);
        for (const target of outgoing) {
          links.push({
            id: randomUUID(),
            sourceId: parsed.id,
            targetId: target,
            relation: "links-to",
          });
        }
      }
    }

    // ─── Queue depth ────────────────────────────────────────────────────────
    const queueDepth = this.getQueueDepth();

    return {
      vaultId: this.vaultRoot,
      propositions,
      links,
      queueDepth,
      loadedAt: now,
    };
  }

  /**
   * Find thought file paths relevant to the given commitment labels.
   *
   * When qmd is available, runs a vector search for each commitment label
   * and collects the matching paths (deduped). This finds semantic matches
   * even when exact keywords differ.
   *
   * Falls back to a full keyword scan when qmd is unavailable or returns
   * no results (e.g., the thoughts collection hasn't been indexed yet).
   */
  private async findRelevantPaths(
    commitmentLabels: string[],
    thoughtsDir: string,
  ): Promise<string[]> {
    // If no commitments, load all thoughts
    if (commitmentLabels.length === 0) {
      return this.listMdFiles(thoughtsDir).map(f => join(thoughtsDir, f));
    }

    // Try qmd vector search for each commitment label
    const qmdPaths = new Set<string>();
    let qmdSucceeded = false;

    for (const label of commitmentLabels) {
      const results = qmdVectorSearchPaths(label, this.vaultRoot, 20);
      if (results !== null) {
        qmdSucceeded = true;
        for (const r of results) {
          qmdPaths.add(r.path);
        }
      }
    }

    if (qmdSucceeded && qmdPaths.size > 0) {
      // Verify the files actually exist (qmd index may be stale)
      return Array.from(qmdPaths).filter(p => existsSync(p));
    }

    // ── Keyword fallback ─────────────────────────────────────────────────────
    const files = this.listMdFiles(thoughtsDir);
    const relevant: string[] = [];

    for (const file of files) {
      const filePath = join(thoughtsDir, file);
      const content = this.safeReadFile(filePath);
      if (!content) continue;

      const parsed = this.parseThought(filePath, content);
      if (!parsed) continue;

      if (this.isRelevantToCommitments(parsed, content, commitmentLabels)) {
        relevant.push(filePath);
      }
    }

    return relevant;
  }

  // Fix 5: Wrap cycle-log writes in try-catch
  async record(envelope: MemoryWriteEnvelope): Promise<void> {
    try {
      const now = new Date().toISOString();
      const runtimeDir = join(this.vaultRoot, "ops", "runtime");
      if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
      const entry = {
        ts: now,
        intent: envelope.intent.statement,
        commitments: envelope.commitment.activeCommitments.map(c => c.label),
        actions: envelope.plan.actions.map(a => a.label),
        succeeded: envelope.outcome.results.filter(r => r.executed && r.success).length,
        total: envelope.outcome.results.length,
      };
      appendFileSync(join(runtimeDir, "cycle-log.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.error("[memory] cycle-log write failed:", err instanceof Error ? err.message : String(err));
    }

    // Append brief summary to working-memory.md
    try {
      const workingMemoryPath = join(this.vaultRoot, "self", "working-memory.md");
      const ts = new Date().toISOString();
      const commitmentSummary = envelope.commitment.activeCommitments.map(c => c.label).join(", ") || "(none)";
      const summary = `\n## ${ts} Cycle summary\n${envelope.intent.statement} — commitments: ${commitmentSummary}\n`;
      appendFileSync(workingMemoryPath, summary, "utf-8");
    } catch (err) {
      console.error("[memory] working-memory append failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Thought parsing ───────────────────────────────────────────────────────

  private parseThought(filePath: string, content: string): Proposition | null {
    const filename = basename(filePath, ".md");
    const frontmatter = parseFrontmatter(content);

    return {
      id: frontmatter.id ?? filename,
      vaultId: this.vaultRoot,
      title: filename,
      description: frontmatter.description ?? "",
      topics: Array.isArray(frontmatter.topics) ? frontmatter.topics : frontmatter.topics ? [String(frontmatter.topics)] : [],
      confidence: this.confidenceToNumber(frontmatter.confidence),
      sourceRefs: frontmatter.sources ?? [],
      createdAt: frontmatter.created ?? new Date().toISOString(),
      updatedAt: frontmatter.updated ?? frontmatter.created ?? new Date().toISOString(),
    };
  }

  private confidenceToNumber(confidence: string | undefined): number | undefined {
    switch (confidence) {
      case "felt": return 0.3;
      case "observed": return 0.6;
      case "tested": return 0.9;
      default: return undefined;
    }
  }

  // ─── Relevance ──────────────────────────────────────────────────────────────

  private isRelevantToCommitments(
    proposition: Proposition,
    rawContent: string,
    commitmentLabels: string[],
  ): boolean {
    const topics = Array.isArray(proposition.topics)
      ? proposition.topics
      : typeof proposition.topics === "string"
        ? [proposition.topics]
        : [];
    const searchable = [
      proposition.title.toLowerCase(),
      proposition.description.toLowerCase(),
      ...topics.map(t => t.toLowerCase()),
      rawContent.toLowerCase(),
    ].join(" ");

    return commitmentLabels.some(label => searchable.includes(label));
  }

  // ─── Wiki link extraction ─────────────────────────────────────────────────

  private extractWikiLinks(content: string): string[] {
    const links: string[] = [];
    const pattern = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const target = match[1].trim();
      if (!links.includes(target)) links.push(target);
    }
    return links;
  }

  // ─── Queue depth ──────────────────────────────────────────────────────────

  private getQueueDepth(): number {
    const queuePath = join(this.vaultRoot, "ops", "queue", "queue.json");
    if (!existsSync(queuePath)) return 0;

    try {
      const raw = readFileSync(queuePath, "utf-8");
      const queue = JSON.parse(raw);
      if (Array.isArray(queue)) return queue.length;
      if (Array.isArray(queue.tasks)) {
        return queue.tasks.filter((task: Record<string, unknown>) => {
          const status = (task.status ?? "pending").toString();
          return status === "pending" || status === "in-progress";
        }).length;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  // ─── File helpers ─────────────────────────────────────────────────────────

  private listMdFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f: string) => f.endsWith(".md"));
    } catch {
      return [];
    }
  }

  private safeReadFile(path: string): string | null {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }
}
