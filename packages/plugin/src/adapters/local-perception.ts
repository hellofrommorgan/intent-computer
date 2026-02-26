/**
 * local-perception.ts — PerceptionPort adapter
 *
 * Full ambient perception against a local vault filesystem. Extracts and
 * restructures the sensing logic from session-orient.ts into the canonical
 * PerceptionPort interface.
 *
 * Reads vault structure, self-knowledge files, and maintenance conditions.
 * Returns a PerceptionSnapshot with typed signals and detected gaps.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type {
  PerceptionPort,
  PerceptionInput,
  PerceptionSnapshot,
  PerceptionSignal,
  DetectedGap,
} from "@intent-computer/architecture";
import {
  countUnprocessedMineableSessions,
  loadDesiredState,
  loadMaintenanceThresholds,
  scanVaultGraph,
} from "@intent-computer/architecture";
import { measureDesiredState } from "./desired-state.js";
import { measureMetabolicRate } from "./metabolic.js";
import { runTriggerBattery, recordTriggerRun } from "./triggers.js";

const MAX_SIGNALS_PER_CHANNEL = 3;

export interface LocalPerceptionOptions {
  /** Whether to persist trigger results to history file. Default: true. */
  recordTriggerHistory?: boolean;
}

export class LocalPerceptionAdapter implements PerceptionPort {
  private readonly vaultRoot: string;
  private readonly options: LocalPerceptionOptions;

  constructor(vaultRoot: string, options: LocalPerceptionOptions = {}) {
    this.vaultRoot = vaultRoot;
    this.options = { recordTriggerHistory: true, ...options };
  }

  async capture(input: PerceptionInput): Promise<PerceptionSnapshot> {
    const now = new Date().toISOString();
    const signals: PerceptionSignal[] = [];
    const gaps: DetectedGap[] = [];
    const thresholds = loadMaintenanceThresholds(this.vaultRoot);
    const graphScan = scanVaultGraph(this.vaultRoot, {
      entityDirs: ["thoughts", "self"],
      excludeCodeBlocks: true,
    });

    // ─── Vault structure ────────────────────────────────────────────────────
    const structure = this.readVaultStructure();
    if (structure) {
      const structureSignals: PerceptionSignal[] = [{
        id: randomUUID(),
        observedAt: now,
        channel: "vault:structure",
        summary: `Vault contains ${structure.thoughtCount} thoughts, ${structure.inboxCount} inbox items`,
        confidence: "high",
        metadata: {
          thoughtCount: structure.thoughtCount,
          inboxCount: structure.inboxCount,
        },
      }];
      signals.push(...this.capChannelSignals("vault:structure", structureSignals, now));
    }

    // ─── Inbox pressure ─────────────────────────────────────────────────────
    const inboxItems = this.listDir(join(this.vaultRoot, "inbox"), ".md");
    const inboxSignals: PerceptionSignal[] = [];
    if (inboxItems.length > 0) {
      for (const item of inboxItems) {
        inboxSignals.push({
          id: randomUUID(),
          observedAt: now,
          channel: "vault:inbox",
          summary: `Inbox item: ${item}`,
          confidence: "high",
          metadata: { file: item },
        });
      }
      signals.push(...this.capChannelSignals("vault:inbox", inboxSignals, now));
    }
    if (inboxItems.length >= thresholds.inbox) {
      gaps.push({
        id: randomUUID(),
        intentId: input.intent.id,
        label: "inbox-pressure",
        gapClass: "constitutive",
        evidence: [`${inboxItems.length} unprocessed inbox items (threshold ${thresholds.inbox})`],
        confidence: "high",
      });
    }

    // ─── Orphan count ───────────────────────────────────────────────────────
    const maintenanceSignals: PerceptionSignal[] = [];
    const orphanCount = graphScan.orphanCount;
    if (orphanCount >= thresholds.orphan) {
      gaps.push({
        id: randomUUID(),
        intentId: input.intent.id,
        label: "orphan-pressure",
        gapClass: "incidental",
        evidence: [`${orphanCount} orphan graph entities without incoming links (threshold ${thresholds.orphan})`],
        confidence: "medium",
      });
    } else if (orphanCount > 0) {
      maintenanceSignals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:maintenance",
        summary: `${orphanCount} orphan graph entit${orphanCount === 1 ? "y" : "ies"} detected`,
        confidence: "medium",
        metadata: { orphanCount, graphEntities: graphScan.entities.length },
      });
    }

    // ─── Observation backlog ────────────────────────────────────────────────
    const obsCount = this.listDir(join(this.vaultRoot, "ops", "observations"), ".md").length;
    if (obsCount >= thresholds.observation) {
      gaps.push({
        id: randomUUID(),
        intentId: input.intent.id,
        label: "observation-backlog",
        gapClass: "incidental",
        evidence: [`${obsCount} pending observations need triaging (threshold ${thresholds.observation})`],
        confidence: "high",
      });
    } else if (obsCount > 0) {
      maintenanceSignals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:maintenance",
        summary: `${obsCount} pending observation(s)`,
        confidence: "medium",
        metadata: { obsCount },
      });
    }

    // ─── Tension backlog ────────────────────────────────────────────────────
    const tensionCount = this.listDir(join(this.vaultRoot, "ops", "tensions"), ".md").length;
    if (tensionCount >= thresholds.tension) {
      gaps.push({
        id: randomUUID(),
        intentId: input.intent.id,
        label: "tension-backlog",
        gapClass: "constitutive",
        evidence: [`${tensionCount} pending tensions need resolution (threshold ${thresholds.tension})`],
        confidence: "high",
      });
    } else if (tensionCount > 0) {
      maintenanceSignals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:maintenance",
        summary: `${tensionCount} pending tension(s)`,
        confidence: "medium",
        metadata: { tensionCount },
      });
    }

    // ─── Session backlog ────────────────────────────────────────────────────
    const sessDir = join(this.vaultRoot, "ops", "sessions");
    const sessionCount = countUnprocessedMineableSessions(sessDir);
    if (sessionCount >= thresholds.sessions) {
      gaps.push({
        id: randomUUID(),
        intentId: input.intent.id,
        label: "session-backlog",
        gapClass: "incidental",
        evidence: [`${sessionCount} unprocessed mineable sessions (threshold ${thresholds.sessions})`],
        confidence: "medium",
      });
    } else if (sessionCount > 0) {
      maintenanceSignals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:maintenance",
        summary: `${sessionCount} unprocessed session(s)`,
        confidence: "low",
        metadata: { sessionCount },
      });
    }

    // ─── Schema compliance ──────────────────────────────────────────────
    const healthSignals: PerceptionSignal[] = [];
    const thoughtsDir = join(this.vaultRoot, "thoughts");
    if (existsSync(thoughtsDir)) {
      const thoughtFiles = this.listDir(thoughtsDir, ".md");
      let missingDescription = 0;
      let missingTopics = 0;

      for (const file of thoughtFiles.slice(0, 50)) {
        const content = this.safeReadFile(join(thoughtsDir, file));
        if (!content) continue;

        if (!content.match(/^description:/m)) missingDescription++;
        if (!content.match(/^topics:/m)) missingTopics++;
      }

      const totalChecked = Math.min(thoughtFiles.length, 50);
      const schemaIssues = missingDescription + missingTopics;

      if (schemaIssues > 0) {
        healthSignals.push({
          id: randomUUID(),
          observedAt: now,
          channel: "vault:health",
          summary: `Schema: ${missingDescription} missing description, ${missingTopics} missing topics (of ${totalChecked} checked)`,
          confidence: "high",
          metadata: { missingDescription, missingTopics, totalChecked },
        });
      }

      if (totalChecked > 0 && missingDescription > totalChecked * 0.2) {
        gaps.push({
          id: randomUUID(),
          intentId: input.intent.id,
          label: "schema-compliance",
          gapClass: "incidental",
          evidence: [`${missingDescription}/${totalChecked} thoughts missing description field`],
          confidence: "high",
        });
      }
    }

    // ─── Link health ────────────────────────────────────────────────────
    const danglingCount = graphScan.danglingCount;
    const checked = graphScan.entities;

    if (danglingCount > 0) {
      healthSignals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:health",
        summary: `${danglingCount} dangling wiki link(s) detected in ${checked.length} graph file(s)`,
        confidence: "medium",
        metadata: { danglingCount, scannedGraphFiles: checked.length },
      });
    }

    if (danglingCount > 5) {
      gaps.push({
        id: randomUUID(),
        intentId: input.intent.id,
        label: "link-health",
        gapClass: "incidental",
        evidence: [`${danglingCount} dangling wiki links found`],
        confidence: "medium",
      });
    }

    // ─── Description quality ─────────────────────────────────────────────
    if (existsSync(thoughtsDir)) {
      const thoughtFiles = this.listDir(thoughtsDir, ".md");
      let poorDescriptions = 0;
      const checked = thoughtFiles.slice(0, 30);

      for (const file of checked) {
        const content = this.safeReadFile(join(thoughtsDir, file));
        if (!content) continue;

        const title = file.replace(/\.md$/, "").toLowerCase();
        const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
        if (!descMatch) continue;

        const desc = descMatch[1].toLowerCase();
        const titleWords = new Set(title.split(/[^a-z0-9]+/).filter(Boolean));
        const descWords = desc.split(/[^a-z0-9]+/).filter(Boolean);
        if (titleWords.size > 0 && descWords.length > 0) {
          const overlap = descWords.filter((word) => titleWords.has(word)).length;
          const overlapRatio = overlap / Math.max(titleWords.size, descWords.length);
          if (overlapRatio > 0.6) poorDescriptions++;
        }
      }

      if (poorDescriptions > 0) {
        healthSignals.push({
          id: randomUUID(),
          observedAt: now,
          channel: "vault:health",
          summary: `${poorDescriptions} thought(s) with descriptions that restate the title`,
          confidence: "low",
          metadata: { poorDescriptions },
        });
      }
    }

    // ─── Quality triggers ──────────────────────────────────────────────
    try {
      const triggerReport = await runTriggerBattery(this.vaultRoot);

      signals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:triggers",
        summary: `Trigger battery: ${triggerReport.summary.passed}/${triggerReport.summary.total} passed (${Math.round(triggerReport.passRate * 100)}%)`,
        confidence: "high",
        metadata: {
          passRate: triggerReport.passRate,
          total: triggerReport.summary.total,
          passed: triggerReport.summary.passed,
          warned: triggerReport.summary.warned,
          failed: triggerReport.summary.failed,
          regressionCount: triggerReport.regressions.length,
        },
      });

      if (triggerReport.passRate < 0.8) {
        gaps.push({
          id: randomUUID(),
          intentId: input.intent.id,
          label: "quality-triggers",
          gapClass: "incidental",
          evidence: [
            `Trigger pass rate ${Math.round(triggerReport.passRate * 100)}% is below 80% threshold`,
            `${triggerReport.summary.failed} failed, ${triggerReport.summary.warned} warned`,
          ],
          confidence: "high",
        });
      }

      if (triggerReport.regressions.length > 0) {
        gaps.push({
          id: randomUUID(),
          intentId: input.intent.id,
          label: "quality-regression",
          gapClass: "constitutive",
          evidence: triggerReport.regressions.map(
            (r) => `${r.triggerId}: ${r.message} (passed ${r.lastPassed}, failed ${r.firstFailed})`,
          ),
          confidence: "high",
        });
      }

      if (this.options.recordTriggerHistory) {
        await recordTriggerRun(this.vaultRoot, triggerReport);
      }
    } catch (err) {
      console.error("[perception] trigger battery failed:", err);
    }

    // ─── Metabolic rate ─────────────────────────────────────────────────
    try {
      const metabolicReport = await measureMetabolicRate(this.vaultRoot);
      signals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:metabolic",
        summary: metabolicReport.systemHealthy
          ? "Vault metabolic rate healthy across all spaces"
          : `Metabolic anomalies detected: ${metabolicReport.anomalies.join(", ")}`,
        confidence: "high",
        metadata: {
          systemHealthy: metabolicReport.systemHealthy,
          anomalyCount: metabolicReport.anomalies.length,
        },
      });

      const anomalyGapMap: Record<string, { domain: string; gapClass: "constitutive" | "incidental"; description: string }> = {
        "identity-churn": {
          domain: "metabolic-identity",
          gapClass: "constitutive",
          description: "self/ is changing too frequently — possible identity churn",
        },
        "pipeline-stall": {
          domain: "metabolic-pipeline",
          gapClass: "incidental",
          description: "thoughts/ is not growing — pipeline may be stalled",
        },
        "system-disuse": {
          domain: "metabolic-disuse",
          gapClass: "incidental",
          description: "No vault activity in the past week — system may be unused",
        },
        "ops-silence": {
          domain: "metabolic-ops",
          gapClass: "incidental",
          description: "ops/ has had no changes this week — operational silence",
        },
      };

      for (const anomaly of metabolicReport.anomalies) {
        const mapping = anomalyGapMap[anomaly];
        if (mapping) {
          gaps.push({
            id: randomUUID(),
            intentId: input.intent.id,
            label: mapping.domain,
            gapClass: mapping.gapClass,
            evidence: [mapping.description],
            confidence: "medium",
          });
        }
      }
    } catch (err) {
      console.error("[perception] metabolic rate measurement failed:", err);
    }

    // ─── Desired-state gap report ──────────────────────────────────────
    try {
      const desired = loadDesiredState(this.vaultRoot);
      const dsReport = measureDesiredState(this.vaultRoot, desired);

      signals.push({
        id: randomUUID(),
        observedAt: now,
        channel: "vault:desired-state",
        summary: `Desired state: ${Math.round(dsReport.overallScore * 100)}% of targets met (${dsReport.metrics.filter(m => m.met).length}/${dsReport.metrics.length})`,
        confidence: "high",
        metadata: {
          overallScore: dsReport.overallScore,
          metricsMet: dsReport.metrics.filter(m => m.met).length,
          metricsTotal: dsReport.metrics.length,
        },
      });

      // Emit a single summary gap for the worst offender, not one per metric
      const unmetMetrics = dsReport.metrics.filter(m => !m.met);
      if (unmetMetrics.length > 0 && dsReport.overallScore < 0.8) {
        const worstMetric = unmetMetrics.reduce((worst, m) =>
          Math.abs(m.delta) > Math.abs(worst.delta) ? m : worst,
        );
        const isStructural = worstMetric.name === "schema-compliance" || worstMetric.name === "connection-density";
        gaps.push({
          id: randomUUID(),
          intentId: input.intent.id,
          label: `desired:${worstMetric.name}`,
          gapClass: isStructural ? "constitutive" : "incidental",
          evidence: [
            `Desired state ${Math.round(dsReport.overallScore * 100)}% met — worst: ${worstMetric.name} (actual ${worstMetric.actual.toFixed(2)} vs target ${worstMetric.target.toFixed(2)})`,
            ...unmetMetrics.slice(0, 3).map(m => `${m.name}: ${m.actual.toFixed(2)} vs ${m.target.toFixed(2)}`),
          ],
          confidence: "medium",
        });
      }
    } catch (err) {
      console.error("[perception] desired-state measurement failed:", err);
    }

    signals.push(...this.capChannelSignals("vault:maintenance", maintenanceSignals, now));
    signals.push(...this.capChannelSignals("vault:health", healthSignals, now));

    return { observedAt: now, signals, gaps };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private capChannelSignals(
    channel: string,
    channelSignals: PerceptionSignal[],
    observedAt: string,
  ): PerceptionSignal[] {
    if (channelSignals.length <= MAX_SIGNALS_PER_CHANNEL) {
      return channelSignals;
    }

    const head = channelSignals.slice(0, MAX_SIGNALS_PER_CHANNEL);
    let summary = `${channelSignals.length} signal(s) on ${channel} (showing first ${MAX_SIGNALS_PER_CHANNEL})`;
    if (channel === "vault:inbox") {
      const preview = head
        .map((signal) => {
          const file = signal.metadata?.file;
          if (typeof file === "string") return file;
          return signal.summary.replace(/^Inbox item:\s*/, "").trim();
        })
        .join(", ");
      summary = `${channelSignals.length} inbox items pending (showing first ${MAX_SIGNALS_PER_CHANNEL}: ${preview})`;
    }

    return [
      ...head,
      {
        id: randomUUID(),
        observedAt,
        channel,
        summary,
        confidence: "medium",
        metadata: {
          total: channelSignals.length,
          shown: MAX_SIGNALS_PER_CHANNEL,
        },
      },
    ];
  }

  private readVaultStructure(): { thoughtCount: number; inboxCount: number } | null {
    try {
      const thoughtCount = this.listDir(join(this.vaultRoot, "thoughts"), ".md").length;
      const inboxCount = this.listDir(join(this.vaultRoot, "inbox"), ".md").length;
      return { thoughtCount, inboxCount };
    } catch {
      return null;
    }
  }

  // Fix 2: Log unexpected errors (non-ENOENT) in safeReadFile
  private safeReadFile(path: string): string | null {
    try {
      return readFileSync(path, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EISDIR") {
        console.error(`[perception] safeReadFile failed (${code}): ${path}`);
      }
      return null;
    }
  }

  // Fix 2: Log unexpected errors (non-ENOENT) in listDir
  private listDir(dir: string, ext: string): string[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((f: string) => f.endsWith(ext));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(`[perception] listDir failed (${code}): ${dir}`);
      }
      return [];
    }
  }
}
