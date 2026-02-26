/**
 * triggers.ts — Quality trigger battery
 *
 * Programmable quality checks with pass/fail results, trend tracking, and
 * regression detection. Runs unit-level checks per thought and integration
 * checks across the vault graph.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { randomUUID } from "crypto";
import type {
  TriggerResult,
  TriggerReport,
  TriggerTrend,
  TriggerRegression,
} from "@intent-computer/architecture";
import {
  extractWikiLinkTargets,
  scanVaultGraph,
} from "@intent-computer/architecture";

// ─── YAML frontmatter helpers (no dependency) ────────────────────────────────

interface ParsedFrontmatter {
  description?: string;
  topics?: string[];
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const yaml = match[1]!;
  const result: ParsedFrontmatter = {};

  const descMatch = yaml.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  if (descMatch) result.description = descMatch[1]!.trim();

  const topicsMatch = yaml.match(/^topics:\s*\[([^\]]*)\]/m);
  if (topicsMatch) {
    result.topics = topicsMatch[1]!
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  } else {
    // Handle YAML list style:
    //   topics:
    //     - "[[item]]"
    const topicsBlockMatch = yaml.match(/^topics:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (topicsBlockMatch) {
      result.topics = topicsBlockMatch[1]!
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, "").trim())
        .filter(Boolean);
    }
  }

  return result;
}

function extractBody(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match ? match[1]! : content;
}

// ─── Unit triggers ───────────────────────────────────────────────────────────

function checkSchemaRequiredFields(
  filePath: string,
  content: string,
): TriggerResult {
  const fm = parseFrontmatter(content);
  const missing: string[] = [];
  if (!fm.description) missing.push("description");
  if (!fm.topics || fm.topics.length === 0) missing.push("topics");

  return {
    id: `schema-required-fields:${basename(filePath)}`,
    scope: "unit",
    name: "schema-required-fields",
    severity: missing.length > 0 ? "fail" : "pass",
    message:
      missing.length > 0
        ? `Missing required fields: ${missing.join(", ")}`
        : "All required fields present",
    target: filePath,
  };
}

function checkTitleComposability(filePath: string): TriggerResult {
  const title = basename(filePath, ".md");
  const issues: string[] = [];

  // Must be lowercase (except proper nouns — we approximate by checking first char)
  if (title[0] !== title[0]?.toLowerCase()) {
    issues.push("starts with uppercase");
  }

  // 3+ words
  const words = title.split(/[\s-]+/).filter(Boolean);
  if (words.length < 3) {
    issues.push(`only ${words.length} word(s), need 3+`);
  }

  // No verb-first (common imperative starters)
  const imperativeStarters = [
    "add", "fix", "update", "create", "remove", "delete", "implement",
    "check", "run", "build", "set", "get", "make", "do", "write",
  ];
  const firstWord = words[0]?.toLowerCase();
  if (firstWord && imperativeStarters.includes(firstWord)) {
    issues.push(`starts with imperative verb "${firstWord}"`);
  }

  return {
    id: `title-composability:${basename(filePath)}`,
    scope: "unit",
    name: "title-composability",
    severity: issues.length > 0 ? "warn" : "pass",
    message:
      issues.length > 0
        ? `Title issues: ${issues.join("; ")}`
        : "Title works as prose claim",
    target: filePath,
  };
}

function checkLinkMinimum(
  filePath: string,
  content: string,
): TriggerResult {
  const body = extractBody(content);
  const links = extractWikiLinkTargets(body, { excludeCodeBlocks: true });

  return {
    id: `link-minimum:${basename(filePath)}`,
    scope: "unit",
    name: "link-minimum",
    severity: links.length >= 2 ? "pass" : "warn",
    message:
      links.length >= 2
        ? `${links.length} wiki-link(s) found`
        : `Only ${links.length} wiki-link(s), need at least 2`,
    target: filePath,
  };
}

function checkDescriptionQuality(
  filePath: string,
  content: string,
): TriggerResult {
  const fm = parseFrontmatter(content);
  if (!fm.description) {
    return {
      id: `description-quality:${basename(filePath)}`,
      scope: "unit",
      name: "description-quality",
      severity: "fail",
      message: "No description to evaluate",
      target: filePath,
    };
  }

  const title = basename(filePath, ".md").toLowerCase();
  const titleWords = new Set(
    title.split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  );
  const descWords = fm.description
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

  if (titleWords.size === 0 || descWords.length === 0) {
    return {
      id: `description-quality:${basename(filePath)}`,
      scope: "unit",
      name: "description-quality",
      severity: "pass",
      message: "Description present (too short for overlap analysis)",
      target: filePath,
    };
  }

  const overlap = descWords.filter((w) => titleWords.has(w)).length;
  const ratio = overlap / Math.max(titleWords.size, descWords.length);

  return {
    id: `description-quality:${basename(filePath)}`,
    scope: "unit",
    name: "description-quality",
    severity: ratio >= 0.7 ? "warn" : "pass",
    message:
      ratio >= 0.7
        ? `Description restates title (${Math.round(ratio * 100)}% word overlap)`
        : `Description adds information beyond title (${Math.round(ratio * 100)}% overlap)`,
    target: filePath,
  };
}

// ─── Integration triggers ────────────────────────────────────────────────────

function checkConnectionDensity(
  thoughtFiles: string[],
  vaultRoot: string,
): TriggerResult {
  if (thoughtFiles.length === 0) {
    return {
      id: "connection-density",
      scope: "integration",
      name: "connection-density",
      severity: "pass",
      message: "No thoughts to check",
    };
  }

  let totalLinks = 0;
  for (const filePath of thoughtFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const links = extractWikiLinkTargets(content, { excludeCodeBlocks: true });
      totalLinks += links.length;
    } catch {
      // skip unreadable files
    }
  }

  const avg = totalLinks / thoughtFiles.length;
  return {
    id: "connection-density",
    scope: "integration",
    name: "connection-density",
    severity: avg >= 3.0 ? "pass" : "warn",
    message: `Average ${avg.toFixed(1)} wiki-links per thought (target: ≥3.0)`,
  };
}

function checkOrphanRate(
  orphanCount: number,
  totalEntities: number,
): TriggerResult {
  if (totalEntities === 0) {
    return {
      id: "orphan-rate",
      scope: "integration",
      name: "orphan-rate",
      severity: "pass",
      message: "No entities to check",
    };
  }

  const rate = orphanCount / totalEntities;
  return {
    id: "orphan-rate",
    scope: "integration",
    name: "orphan-rate",
    severity: rate < 0.15 ? "pass" : "fail",
    message: `${(rate * 100).toFixed(1)}% orphan rate (${orphanCount}/${totalEntities}, target: <15%)`,
  };
}

function checkDanglingLinks(danglingCount: number): TriggerResult {
  return {
    id: "dangling-links",
    scope: "integration",
    name: "dangling-links",
    severity: danglingCount < 5 ? "pass" : "fail",
    message: `${danglingCount} dangling wiki-link(s) (target: <5)`,
  };
}

function checkMocCoverage(
  thoughtFiles: string[],
  vaultRoot: string,
): TriggerResult {
  if (thoughtFiles.length === 0) {
    return {
      id: "moc-coverage",
      scope: "integration",
      name: "moc-coverage",
      severity: "pass",
      message: "No thoughts to check",
    };
  }

  let uncovered = 0;
  for (const filePath of thoughtFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm.topics || fm.topics.length === 0) {
        uncovered++;
      }
    } catch {
      // skip unreadable files
    }
  }

  const coverageRate = 1 - uncovered / thoughtFiles.length;
  return {
    id: "moc-coverage",
    scope: "integration",
    name: "moc-coverage",
    severity: uncovered === 0 ? "pass" : "warn",
    message: `${Math.round(coverageRate * 100)}% map coverage (${uncovered} thought(s) not in any map)`,
  };
}

// ─── History, trends, regressions ────────────────────────────────────────────

const HISTORY_PATH = "ops/runtime/trigger-history.jsonl";
const TREND_WINDOW = 5;

async function loadHistory(vaultRoot: string): Promise<TriggerReport[]> {
  const historyFile = join(vaultRoot, HISTORY_PATH);
  if (!existsSync(historyFile)) return [];

  try {
    const raw = await readFile(historyFile, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TriggerReport);
  } catch {
    return [];
  }
}

function computeTrends(
  currentResults: TriggerResult[],
  history: TriggerReport[],
): TriggerTrend[] {
  // Collect unique trigger IDs from integration triggers and unit trigger names
  const triggerIds = new Set<string>();
  for (const r of currentResults) {
    // For unit triggers, track by name (not per-file)
    triggerIds.add(r.scope === "unit" ? r.name : r.id);
  }

  const recentRuns = history.slice(-TREND_WINDOW);
  const trends: TriggerTrend[] = [];

  for (const triggerId of triggerIds) {
    const passRates: number[] = [];

    for (const run of recentRuns) {
      const matching = run.results.filter((r) =>
        r.scope === "unit" ? r.name === triggerId : r.id === triggerId,
      );
      if (matching.length === 0) continue;
      const passed = matching.filter((r) => r.severity === "pass").length;
      passRates.push(passed / matching.length);
    }

    // Add current run
    const currentMatching = currentResults.filter((r) =>
      r.scope === "unit" ? r.name === triggerId : r.id === triggerId,
    );
    if (currentMatching.length > 0) {
      const passed = currentMatching.filter((r) => r.severity === "pass").length;
      passRates.push(passed / currentMatching.length);
    }

    if (passRates.length < 2) {
      trends.push({ triggerId, passRates, direction: "stable" });
      continue;
    }

    const firstHalf = passRates.slice(0, Math.ceil(passRates.length / 2));
    const secondHalf = passRates.slice(Math.ceil(passRates.length / 2));
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    const delta = avgSecond - avgFirst;
    const direction =
      delta > 0.05 ? "improving" : delta < -0.05 ? "degrading" : "stable";

    trends.push({ triggerId, passRates, direction });
  }

  return trends;
}

function detectRegressions(
  currentResults: TriggerResult[],
  history: TriggerReport[],
): TriggerRegression[] {
  if (history.length === 0) return [];

  const previousRun = history[history.length - 1]!;
  const regressions: TriggerRegression[] = [];
  const now = new Date().toISOString().slice(0, 10);

  // Build a set of passing trigger IDs from the previous run
  const previousPassing = new Set<string>();
  for (const r of previousRun.results) {
    if (r.severity === "pass") {
      previousPassing.add(r.id);
    }
  }

  // Check which current results fail but previously passed
  for (const r of currentResults) {
    if (r.severity === "fail" && previousPassing.has(r.id)) {
      regressions.push({
        triggerId: r.id,
        target: r.target,
        firstFailed: now,
        lastPassed: previousRun.timestamp.slice(0, 10),
        message: r.message,
      });
    }
  }

  return regressions;
}

// ─── Main battery ────────────────────────────────────────────────────────────

function listThoughtFiles(vaultRoot: string): string[] {
  const thoughtsDir = join(vaultRoot, "thoughts");
  if (!existsSync(thoughtsDir)) return [];
  try {
    return readdirSync(thoughtsDir)
      .filter((f: string) => f.endsWith(".md"))
      .map((f: string) => join(thoughtsDir, f));
  } catch {
    return [];
  }
}

export async function runTriggerBattery(
  vaultRoot: string,
): Promise<TriggerReport> {
  const timestamp = new Date().toISOString();
  const results: TriggerResult[] = [];
  const thoughtFiles = listThoughtFiles(vaultRoot);

  // ─── Unit triggers (per thought) ─────────────────────────────────────────
  for (const filePath of thoughtFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    results.push(checkSchemaRequiredFields(filePath, content));
    results.push(checkTitleComposability(filePath));
    results.push(checkLinkMinimum(filePath, content));
    results.push(checkDescriptionQuality(filePath, content));
  }

  // ─── Integration triggers ────────────────────────────────────────────────
  const graphScan = scanVaultGraph(vaultRoot, {
    entityDirs: ["thoughts", "self"],
    excludeCodeBlocks: true,
  });

  results.push(checkConnectionDensity(thoughtFiles, vaultRoot));
  results.push(
    checkOrphanRate(graphScan.orphanCount, graphScan.entities.length),
  );
  results.push(checkDanglingLinks(graphScan.danglingCount));
  results.push(checkMocCoverage(thoughtFiles, vaultRoot));

  // ─── History, trends, regressions ────────────────────────────────────────
  const history = await loadHistory(vaultRoot);
  const trends = computeTrends(results, history);
  const regressions = detectRegressions(results, history);

  const passed = results.filter((r) => r.severity === "pass").length;
  const warned = results.filter((r) => r.severity === "warn").length;
  const failed = results.filter((r) => r.severity === "fail").length;

  return {
    timestamp,
    results,
    passRate: results.length > 0 ? passed / results.length : 1,
    trends,
    regressions,
    summary: {
      total: results.length,
      passed,
      warned,
      failed,
    },
  };
}

export async function recordTriggerRun(
  vaultRoot: string,
  report: TriggerReport,
): Promise<void> {
  const historyFile = join(vaultRoot, HISTORY_PATH);
  const dir = dirname(historyFile);

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const line = JSON.stringify(report) + "\n";

  try {
    // Append to existing file
    const existing = existsSync(historyFile)
      ? await readFile(historyFile, "utf-8")
      : "";
    await writeFile(historyFile, existing + line, "utf-8");
  } catch {
    // If append fails, try writing fresh
    await writeFile(historyFile, line, "utf-8");
  }
}
