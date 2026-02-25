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
      const files = this.listMdFiles(thoughtsDir);

      for (const file of files) {
        const filePath = join(thoughtsDir, file);
        const content = this.safeReadFile(filePath);
        if (!content) continue;

        const parsed = this.parseThought(filePath, content);
        if (!parsed) continue;

        // Check relevance: does this thought relate to any active commitment?
        const isRelevant = commitmentLabels.length === 0 || this.isRelevantToCommitments(
          parsed,
          content,
          commitmentLabels,
        );

        if (isRelevant) {
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
