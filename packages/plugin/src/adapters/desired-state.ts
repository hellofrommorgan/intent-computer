/**
 * desired-state.ts — Measure actual vault metrics against desired-state config
 *
 * Reads vault structure and computes gap metrics for orphan rate, connection
 * density, schema compliance, description quality, inbox age, and status
 * distribution. Returns a DesiredStateReport with per-metric deltas.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type {
  DesiredState,
  DesiredStateReport,
  DesiredStateMetric,
} from "@intent-computer/architecture";
import { scanVaultGraph } from "@intent-computer/architecture";

/**
 * Extract simple YAML frontmatter values from markdown content.
 * Returns key-value pairs from the first `---` block.
 */
function extractFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return result;

  const block = fmMatch[1];
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/);
    if (m) {
      result[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return result;
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function buildMetric(
  name: string,
  actual: number,
  target: number,
  lowerIsBetter: boolean,
): DesiredStateMetric {
  const delta = target === 0 ? 0 : (actual - target) / Math.abs(target);
  const met = lowerIsBetter ? actual <= target : actual >= target;
  return { name, actual, target, delta, met };
}

/**
 * Measure actual vault state and compare against desired-state configuration.
 */
export function measureDesiredState(
  vaultRoot: string,
  desired: DesiredState,
): DesiredStateReport {
  const now = new Date().toISOString();
  const metrics: DesiredStateMetric[] = [];

  const thoughtsDir = join(vaultRoot, "thoughts");
  const thoughtFiles = listMarkdownFiles(thoughtsDir);
  const totalThoughts = thoughtFiles.length;

  // ─── Graph scan for orphans and connections ────────────────────────────
  const graphScan = scanVaultGraph(vaultRoot, {
    entityDirs: ["thoughts", "self"],
    excludeCodeBlocks: true,
  });

  // Filter to thoughts-only entities for rate calculation
  const thoughtEntities = graphScan.entities.filter((e) =>
    e.relativePath.startsWith("thoughts/"),
  );
  const thoughtOrphans = graphScan.orphanEntities.filter((e) =>
    e.relativePath.startsWith("thoughts/"),
  );

  // orphan-rate
  const orphanRate = thoughtEntities.length > 0
    ? thoughtOrphans.length / thoughtEntities.length
    : 0;
  metrics.push(buildMetric("orphan-rate", orphanRate, desired.maxOrphanRate, true));

  // connection-density: average outgoing wiki-links per thought
  let totalOutgoing = 0;
  for (const entity of thoughtEntities) {
    const content = safeReadFile(entity.path);
    if (!content) continue;
    const linkMatches = content.match(/\[\[[^\]\n]+\]\]/g);
    totalOutgoing += linkMatches ? linkMatches.length : 0;
  }
  const avgDensity = thoughtEntities.length > 0
    ? totalOutgoing / thoughtEntities.length
    : 0;
  metrics.push(
    buildMetric("connection-density", avgDensity, desired.minConnectionDensity, false),
  );

  // schema-compliance: fraction with both description and topics
  let schemaCompliant = 0;
  for (const file of thoughtFiles) {
    const content = safeReadFile(join(thoughtsDir, file));
    if (!content) continue;
    const hasDescription = /^description:/m.test(content);
    const hasTopics = /^topics:/m.test(content);
    if (hasDescription && hasTopics) schemaCompliant++;
  }
  const schemaRate = totalThoughts > 0 ? schemaCompliant / totalThoughts : 1;
  metrics.push(
    buildMetric("schema-compliance", schemaRate, desired.minSchemaCompliance, false),
  );

  // description-quality: fraction where description doesn't restate title
  let qualityCount = 0;
  let checkedForQuality = 0;
  for (const file of thoughtFiles) {
    const content = safeReadFile(join(thoughtsDir, file));
    if (!content) continue;

    const title = file.replace(/\.md$/, "").toLowerCase();
    const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (!descMatch) continue;

    checkedForQuality++;
    const desc = descMatch[1].toLowerCase();
    const titleWords = new Set(
      title.split(/[^a-z0-9]+/).filter(Boolean),
    );
    const descWords = desc.split(/[^a-z0-9]+/).filter(Boolean);

    if (titleWords.size > 0 && descWords.length > 0) {
      const overlap = descWords.filter((w) => titleWords.has(w)).length;
      const overlapRatio = overlap / Math.max(titleWords.size, descWords.length);
      if (overlapRatio <= 0.7) qualityCount++;
    } else {
      // If we can't compute overlap, count as passing
      qualityCount++;
    }
  }
  const qualityRate = checkedForQuality > 0 ? qualityCount / checkedForQuality : 1;
  metrics.push(
    buildMetric("description-quality", qualityRate, desired.minDescriptionQuality, false),
  );

  // inbox-age: fraction of inbox items within age limit (1 = all fresh)
  const inboxDir = join(vaultRoot, "inbox");
  const inboxFiles = listMarkdownFiles(inboxDir);
  const nowMs = Date.now();
  const maxAgeMs = desired.inboxMaxAgeDays * 24 * 60 * 60 * 1000;
  let freshCount = 0;

  for (const file of inboxFiles) {
    try {
      const stat = statSync(join(inboxDir, file));
      const ageMs = nowMs - stat.mtimeMs;
      if (ageMs <= maxAgeMs) freshCount++;
    } catch {
      // If we can't stat, assume stale
    }
  }
  const inboxFreshRate = inboxFiles.length > 0 ? freshCount / inboxFiles.length : 1;
  metrics.push(buildMetric("inbox-age", inboxFreshRate, 1.0, false));

  // status-distribution: absolute deviation from target distribution
  const statusCounts: Record<string, number> = { seed: 0, growing: 0, evergreen: 0 };
  let statusTotal = 0;

  for (const file of thoughtFiles) {
    const content = safeReadFile(join(thoughtsDir, file));
    if (!content) continue;

    const fm = extractFrontmatter(content);
    const status = fm.status?.toLowerCase();
    if (status && status in statusCounts) {
      statusCounts[status]++;
      statusTotal++;
    }
  }

  if (statusTotal > 0) {
    const targets = desired.statusDistribution;
    for (const [key, target] of Object.entries(targets) as Array<[string, number]>) {
      const actual = statusCounts[key] !== undefined ? statusCounts[key] / statusTotal : 0;
      // For distribution, met = within 0.1 of target
      const deviation = Math.abs(actual - target);
      metrics.push({
        name: `status-distribution:${key}`,
        actual,
        target,
        delta: target === 0 ? 0 : (actual - target) / Math.abs(target),
        met: deviation <= 0.1,
      });
    }
  }

  const metCount = metrics.filter((m) => m.met).length;
  const overallScore = metrics.length > 0 ? metCount / metrics.length : 1;

  return { timestamp: now, metrics, overallScore };
}
