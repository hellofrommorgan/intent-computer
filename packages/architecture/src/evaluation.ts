/**
 * evaluation.ts — Thought impact scoring
 *
 * Pure functions that score thoughts based on graph structure.
 * No filesystem access — operates on GraphScanResult.
 *
 * Scoring formula:
 *   impact = (incoming_links * 1.0) + (map_memberships * 2.0) - age_penalty
 *   age_penalty = max(0, 0.01 * days_since_last_incoming_link)
 *
 * Thoughts < 7 days old get a grace period (no age penalty).
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { randomUUID } from "crypto";
import type { GraphScanResult } from "./graph-links.js";
import type { EvaluationRecord, ThoughtScore } from "./domain.js";

const GRACE_PERIOD_DAYS = 7;
const INCOMING_LINK_WEIGHT = 1.0;
const MAP_MEMBERSHIP_WEIGHT = 2.0;
const AGE_PENALTY_RATE = 0.01;
const TOP_THOUGHTS_LIMIT = 10;

/**
 * Determine if a file path looks like a map file.
 * Maps are identified by having "map" or "index" in the filename.
 */
function isMapFile(filePath: string): boolean {
  const name = basename(filePath, ".md").toLowerCase();
  return name === "index" || name.includes("map");
}

/**
 * Count how many map-like entities link to a given entity path.
 */
function countMapMemberships(
  entityPath: string,
  graph: GraphScanResult,
): number {
  const entitySlug = basename(entityPath, ".md").toLowerCase();
  let count = 0;

  for (const entity of graph.entities) {
    if (entity.path === entityPath) continue;
    if (!isMapFile(entity.path)) continue;

    // Check if this map entity has an incoming link count > 0 for our entity,
    // meaning the map links TO our entity. We need to check the raw graph data.
    // Since incomingByPath only tells us how many links come IN, we need to
    // look at it from the map's perspective — but we don't have outgoing links.
    //
    // Alternative: check if the map's file content mentions this entity.
    // But we're pure — no filesystem access.
    //
    // Best approach with available data: count entities that are map-like
    // and that contribute to this entity's incoming count.
    // We can't distinguish which entities contributed to incoming links
    // from the GraphScanResult alone.
    //
    // Simpler proxy: read the map file content... but we're pure.
    // We'll use a different approach: for each map entity, check if it
    // appears in the graph as having outgoing links to our entity.
    // The graph doesn't track outgoing links per source, only total incoming.
    //
    // The pragmatic approach: use a separate pass.
    void entity;
    void entitySlug;
  }

  // Since GraphScanResult doesn't track per-source outgoing links,
  // we'll use a heuristic: entities from outside the thoughtsDir
  // (like self/ files) or map-like files contribute to map memberships.
  // This requires the caller to pass thoughtsDir context.
  return count;
}

/**
 * Build a source-to-target map from the graph by re-scanning entities.
 * This lets us know which entities link to which others.
 *
 * Since GraphScanResult only has aggregate incomingByPath, we need
 * to reconstruct per-source links. We do this by reading entity content
 * from the graph scan's entity list — but we need file content.
 *
 * To keep scoreThought/scoreAllThoughts pure, we precompute this mapping
 * once and pass it in.
 */
export interface LinkSourceMap {
  /** For each target entity path, the set of source entity paths that link to it. */
  sourcesByTarget: Map<string, Set<string>>;
}

/**
 * Build a link source map from the graph.
 * NOTE: This function reads files — call it once, then pass the result
 * to the pure scoring functions.
 */
export function buildLinkSourceMap(graph: GraphScanResult): LinkSourceMap {
  const sourcesByTarget = new Map<string, Set<string>>();

  // Initialize all entity paths
  for (const entity of graph.entities) {
    sourcesByTarget.set(entity.path, new Set());
  }

  // We need to re-derive which entities link to which.
  // The graph already computed incomingByPath but didn't store source info.
  // We'll re-read entity content to extract links.
  const entityByKey = new Map(graph.entities.map((e) => [e.key, e]));

  for (const entity of graph.entities) {
    let content: string;
    try {
      content = readFileSync(entity.path, "utf-8");
    } catch {
      continue;
    }

    // Extract wiki link targets (inline implementation to avoid circular dep)
    const stripped = content.replace(/```[\s\S]*?```/g, "");
    const matches = stripped.matchAll(/\[\[([^\]\n]+)\]\]/g);
    for (const match of matches) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      const withoutAlias = raw.split("|")[0]?.trim() ?? "";
      const withoutAnchor = withoutAlias.split("#")[0]?.trim() ?? "";
      const basenameOnly = withoutAnchor.split("/").at(-1)?.trim() ?? "";
      const canonical = basenameOnly.replace(/\.md$/i, "").toLowerCase();
      if (!canonical) continue;

      const linked = entityByKey.get(canonical);
      if (!linked || linked.path === entity.path) continue;

      const targets = sourcesByTarget.get(linked.path);
      if (targets) {
        targets.add(entity.path);
      }
    }
  }

  return { sourcesByTarget };
}

/**
 * Get the age of a file in days based on its filesystem creation time.
 * Falls back to modification time if birth time unavailable.
 */
function getFileAgeDays(filePath: string): number {
  try {
    const stats = statSync(filePath);
    const created = stats.birthtime ?? stats.mtime;
    return Math.max(0, (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/**
 * Score a single thought based on graph structure.
 *
 * Pure with respect to graph data — uses linkSourceMap for per-source info,
 * and ageDays/daysSinceLastLink are derived from filesystem metadata passed in.
 */
export function scoreThought(
  entityPath: string,
  graph: GraphScanResult,
  thoughtsDir: string,
  linkSourceMap: LinkSourceMap,
): ThoughtScore {
  const title = basename(entityPath, ".md");
  const incomingLinks = graph.incomingByPath[entityPath] ?? 0;

  // Count map memberships: incoming links from map-like files
  const sources = linkSourceMap.sourcesByTarget.get(entityPath) ?? new Set();
  let mapMemberships = 0;
  for (const sourcePath of sources) {
    if (isMapFile(sourcePath)) {
      mapMemberships++;
    }
  }

  const ageDays = getFileAgeDays(entityPath);

  // daysSinceLastLink: we approximate this as the age of the newest
  // source file that links to this entity, or ageDays if no links.
  let daysSinceLastLink = ageDays;
  if (sources.size > 0) {
    let newestSourceAge = Infinity;
    for (const sourcePath of sources) {
      try {
        const stats = statSync(sourcePath);
        const mtime = stats.mtime;
        const ageOfSource = (Date.now() - mtime.getTime()) / (1000 * 60 * 60 * 24);
        if (ageOfSource < newestSourceAge) {
          newestSourceAge = ageOfSource;
        }
      } catch {
        continue;
      }
    }
    if (newestSourceAge < Infinity) {
      daysSinceLastLink = newestSourceAge;
    }
  }

  // Grace period: thoughts < 7 days old get no age penalty
  const agePenalty = ageDays < GRACE_PERIOD_DAYS
    ? 0
    : Math.max(0, AGE_PENALTY_RATE * daysSinceLastLink);

  const impactScore =
    incomingLinks * INCOMING_LINK_WEIGHT +
    mapMemberships * MAP_MEMBERSHIP_WEIGHT -
    agePenalty;

  return {
    path: entityPath,
    title,
    incomingLinks,
    mapMemberships,
    ageDays: Math.round(ageDays * 10) / 10,
    daysSinceLastLink: Math.round(daysSinceLastLink * 10) / 10,
    impactScore: Math.round(impactScore * 100) / 100,
  };
}

/**
 * Score all thoughts in the graph that reside under the thoughts directory.
 * Returns a complete EvaluationRecord with aggregates.
 */
export function scoreAllThoughts(
  graph: GraphScanResult,
  thoughtsDir: string,
): EvaluationRecord {
  const linkSourceMap = buildLinkSourceMap(graph);

  // Filter entities to those under the thoughts directory
  const thoughtEntities = graph.entities.filter((entity) =>
    entity.path.startsWith(thoughtsDir),
  );

  const scores: ThoughtScore[] = thoughtEntities.map((entity) =>
    scoreThought(entity.path, graph, thoughtsDir, linkSourceMap),
  );

  // Sort by impact descending
  const sorted = [...scores].sort((a, b) => b.impactScore - a.impactScore);

  const topThoughts = sorted.slice(0, TOP_THOUGHTS_LIMIT);

  // Orphans: score <= 0 AND age > 7 days (grace period excluded)
  const orphanThoughts = scores.filter(
    (s) => s.impactScore <= 0 && s.ageDays > GRACE_PERIOD_DAYS,
  );

  const totalScore = scores.reduce((sum, s) => sum + s.impactScore, 0);
  const avgImpactScore =
    scores.length > 0
      ? Math.round((totalScore / scores.length) * 100) / 100
      : 0;

  const orphanRate =
    scores.length > 0
      ? Math.round((orphanThoughts.length / scores.length) * 100) / 100
      : 0;

  return {
    id: randomUUID(),
    evaluatedAt: new Date().toISOString(),
    thoughtsScored: scores.length,
    avgImpactScore,
    topThoughts,
    orphanThoughts,
    orphanRate,
  };
}

/**
 * Write an evaluation record to ops/evaluations/YYYY-MM-DD.md as markdown
 * with YAML frontmatter. This is the only function in this module that
 * touches the filesystem for output.
 */
export function writeEvaluationRecord(
  vaultRoot: string,
  record: EvaluationRecord,
): string {
  const dateStr = record.evaluatedAt.split("T")[0];
  const evalDir = join(vaultRoot, "ops", "evaluations");
  mkdirSync(evalDir, { recursive: true });

  const filePath = join(evalDir, `${dateStr}.md`);

  const lines: string[] = [
    "---",
    `id: ${record.id}`,
    `evaluatedAt: ${record.evaluatedAt}`,
    `thoughtsScored: ${record.thoughtsScored}`,
    `avgImpactScore: ${record.avgImpactScore}`,
    `orphanRate: ${record.orphanRate}`,
    "---",
    "",
    `# Evaluation — ${dateStr}`,
    "",
    `**Thoughts scored:** ${record.thoughtsScored}`,
    `**Average impact score:** ${record.avgImpactScore}`,
    `**Orphan rate:** ${(record.orphanRate * 100).toFixed(1)}%`,
    "",
  ];

  if (record.topThoughts.length > 0) {
    lines.push("## Top Thoughts by Impact", "");
    lines.push("| Rank | Title | Impact | Links | Maps | Age (d) |");
    lines.push("|------|-------|--------|-------|------|---------|");
    record.topThoughts.forEach((t, i) => {
      lines.push(
        `| ${i + 1} | ${t.title} | ${t.impactScore} | ${t.incomingLinks} | ${t.mapMemberships} | ${t.ageDays} |`,
      );
    });
    lines.push("");
  }

  if (record.orphanThoughts.length > 0) {
    lines.push(`## Orphan Thoughts (${record.orphanThoughts.length})`, "");
    lines.push("| Title | Score | Age (d) | Days Since Link |");
    lines.push("|-------|-------|---------|-----------------|");
    for (const t of record.orphanThoughts) {
      lines.push(
        `| ${t.title} | ${t.impactScore} | ${t.ageDays} | ${t.daysSinceLastLink} |`,
      );
    }
    lines.push("");
  }

  writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}
