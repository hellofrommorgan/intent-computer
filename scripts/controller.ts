/**
 * controller.ts — passive telemetry observer for the intent computer
 *
 * Reads structured telemetry from {vaultRoot}/ops/runtime/telemetry.jsonl
 * and produces an actionable markdown report analyzing signal effectiveness,
 * commitment health, heartbeat utility, error patterns, queue throughput,
 * skill usage, and session patterns.
 *
 * Usage:
 *   npx tsx scripts/controller.ts [--vault <path>] [--since <ISO date>] [--json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { coerceTelemetryEvent } from "../packages/architecture/src/telemetry.js";
import type { TelemetryEvent } from "../packages/architecture/src/telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SignalStats {
  fired: number;
  ledToAction: number;
  actionExecuted: number;
}

interface CommitmentStats {
  evaluated: number;
  advanced: number;
  stale: number;
  unchanged: number;
}

interface Analysis {
  period: { first: string; last: string };
  totalEvents: number;
  signals: Record<string, SignalStats>;
  commitments: Record<string, CommitmentStats>;
  heartbeat: {
    totalRuns: number;
    productiveRuns: number;
    emptyRuns: number;
    phaseCounts: Record<string, number>;
  };
  errors: {
    tasksFailed: number;
    repairsQueued: number;
    failedTaskKinds: Record<string, number>;
    repairedTaskKinds: Record<string, number>;
  };
  queue: {
    tasksExecuted: number;
    tasksFailed: number;
    totalDurationMs: number;
    tasksWithDuration: number;
  };
  skills: Record<string, number>;
  sessions: {
    totalSessions: number;
    sessionStartSignals: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): {
  vault: string;
  since: Date;
  json: boolean;
} {
  let vault = join(homedir(), "Mind");
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let since = sevenDaysAgo;
  let json = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vault" && argv[i + 1]) {
      vault = argv[++i];
    } else if (arg === "--since" && argv[i + 1]) {
      const parsed = new Date(argv[++i]);
      if (!isNaN(parsed.getTime())) {
        since = parsed;
      }
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { vault, since, json };
}

// ---------------------------------------------------------------------------
// Telemetry parsing
// ---------------------------------------------------------------------------

export function readTelemetry(vaultRoot: string, since: Date): TelemetryEvent[] {
  const filePath = join(vaultRoot, "ops", "runtime", "telemetry.jsonl");

  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf-8");
  const events: TelemetryEvent[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const event = coerceTelemetryEvent(parsed);
      if (event && new Date(event.timestamp) >= since) {
        events.push(event);
      }
    } catch {
      // Gracefully skip malformed JSON lines
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyze(events: TelemetryEvent[]): Analysis {
  const timestamps = events.map((e) => e.timestamp).sort();

  const analysis: Analysis = {
    period: {
      first: timestamps[0] ?? "N/A",
      last: timestamps[timestamps.length - 1] ?? "N/A",
    },
    totalEvents: events.length,
    signals: {},
    commitments: {},
    heartbeat: {
      totalRuns: 0,
      productiveRuns: 0,
      emptyRuns: 0,
      phaseCounts: {},
    },
    errors: {
      tasksFailed: 0,
      repairsQueued: 0,
      failedTaskKinds: {},
      repairedTaskKinds: {},
    },
    queue: {
      tasksExecuted: 0,
      tasksFailed: 0,
      totalDurationMs: 0,
      tasksWithDuration: 0,
    },
    skills: {},
    sessions: {
      totalSessions: 0,
      sessionStartSignals: {},
    },
  };

  // Build per-session event indices for correlation
  const sessionSignals = new Map<string, Set<string>>();
  const sessionActions = new Map<string, Set<string>>();
  const sessionExecuted = new Map<string, Set<string>>();

  for (const event of events) {
    const sid = event.sessionId ?? "__no_session__";

    switch (event.type) {
      case "signal_fired": {
        const signal = String(event.data.signalId ?? event.data.signal ?? "unknown");

        if (!analysis.signals[signal]) {
          analysis.signals[signal] = { fired: 0, ledToAction: 0, actionExecuted: 0 };
        }
        analysis.signals[signal].fired++;

        if (!sessionSignals.has(sid)) sessionSignals.set(sid, new Set());
        sessionSignals.get(sid)!.add(signal);
        break;
      }

      case "action_proposed": {
        const actionKind = String(
          event.data.actionKey ?? event.data.actionKind ?? event.data.actionId ?? "unknown",
        );

        if (!sessionActions.has(sid)) sessionActions.set(sid, new Set());
        sessionActions.get(sid)!.add(actionKind);
        break;
      }

      case "action_executed": {
        const actionKind = String(
          event.data.actionKey ?? event.data.actionKind ?? event.data.actionId ?? "unknown",
        );

        if (!sessionExecuted.has(sid)) sessionExecuted.set(sid, new Set());
        sessionExecuted.get(sid)!.add(actionKind);
        break;
      }

      case "commitment_evaluated": {
        const label = String(event.data.label ?? event.data.commitmentLabel ?? "unknown");
        const status = String(
          event.data.status ?? (event.data.stale === true ? "stale" : "unchanged"),
        );

        if (!analysis.commitments[label]) {
          analysis.commitments[label] = { evaluated: 0, advanced: 0, stale: 0, unchanged: 0 };
        }
        analysis.commitments[label].evaluated++;
        if (status === "advanced") analysis.commitments[label].advanced++;
        else if (status === "stale") analysis.commitments[label].stale++;
        else analysis.commitments[label].unchanged++;
        break;
      }

      case "heartbeat_run": {
        // Count only 'end' phase events (or events without phase marker) as completed runs
        const phase = event.data.phase;
        if (phase === "start") break;

        analysis.heartbeat.totalRuns++;

        const actionsTriggered = Number(event.data.tasksTriggered ?? event.data.actionsTriggered ?? 0);
        const conditionsFound = Array.isArray(event.data.conditionsExceeded)
          ? event.data.conditionsExceeded.length
          : Number(event.data.conditionsFound ?? 0);
        if (actionsTriggered > 0 || conditionsFound > 0) {
          analysis.heartbeat.productiveRuns++;
        } else {
          analysis.heartbeat.emptyRuns++;
        }

        const phases = event.data.selectivePhases;
        if (Array.isArray(phases)) {
          for (const p of phases) {
            const phaseName = String(p);
            analysis.heartbeat.phaseCounts[phaseName] =
              (analysis.heartbeat.phaseCounts[phaseName] ?? 0) + 1;
          }
        }
        break;
      }

      case "task_executed": {
        analysis.queue.tasksExecuted++;
        const durationMs = event.data.durationMs;
        if (typeof durationMs === "number") {
          analysis.queue.totalDurationMs += durationMs;
          analysis.queue.tasksWithDuration++;
        }
        break;
      }

      case "task_failed": {
        analysis.queue.tasksFailed++;
        analysis.errors.tasksFailed++;
        const taskKind = String(
          event.data.taskKind ??
          event.data.actionKind ??
          event.data.phase ??
          event.data.action ??
          "unknown",
        );
        analysis.errors.failedTaskKinds[taskKind] =
          (analysis.errors.failedTaskKinds[taskKind] ?? 0) + 1;
        break;
      }

      case "repair_queued": {
        analysis.errors.repairsQueued++;
        const taskKind = String(
          event.data.actionKind ??
          event.data.phase ??
          event.data.action ??
          event.data.condition ??
          "unknown",
        );
        analysis.errors.repairedTaskKinds[taskKind] =
          (analysis.errors.repairedTaskKinds[taskKind] ?? 0) + 1;
        break;
      }

      case "skill_invoked": {
        const skillName = String(event.data.skillName ?? "unknown");
        analysis.skills[skillName] = (analysis.skills[skillName] ?? 0) + 1;
        break;
      }

      case "session_started": {
        analysis.sessions.totalSessions++;
        break;
      }

      default:
        break;
    }
  }

  // Correlate signals -> actions -> executions within sessions
  for (const [sid, signals] of sessionSignals) {
    const actions = sessionActions.get(sid);
    const executed = sessionExecuted.get(sid);

    for (const signal of signals) {
      if (!analysis.signals[signal]) continue;

      if (actions && actions.size > 0) {
        analysis.signals[signal].ledToAction++;
      }
      if (executed && executed.size > 0) {
        analysis.signals[signal].actionExecuted++;
      }
    }
  }

  // Collect signals that fired near session starts
  // Find session_started events and look for signal_fired events in the same session
  const sessionStartIds = new Set<string>();
  for (const event of events) {
    if (event.type === "session_started" && event.sessionId) {
      sessionStartIds.add(event.sessionId);
    }
  }
  for (const event of events) {
    if (
      event.type === "signal_fired" &&
      event.sessionId &&
      sessionStartIds.has(event.sessionId)
    ) {
      const signal = String(event.data.signalId ?? event.data.signal ?? "unknown");
      analysis.sessions.sessionStartSignals[signal] =
        (analysis.sessions.sessionStartSignals[signal] ?? 0) + 1;
    }
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export function generateReport(analysis: Analysis): string {
  const lines: string[] = [];

  lines.push("# Intent Computer Controller Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Period: ${analysis.period.first} — ${analysis.period.last}`);
  lines.push(`Total events: ${analysis.totalEvents}`);
  lines.push("");

  // Signal Effectiveness
  lines.push("## Signal Effectiveness");
  lines.push("");
  const signalEntries = Object.entries(analysis.signals).sort(
    (a, b) => b[1].fired - a[1].fired,
  );
  if (signalEntries.length === 0) {
    lines.push("No signals fired during this period.");
  } else {
    lines.push(
      "| Signal | Fired | Led to Action | Action Executed | Effectiveness |",
    );
    lines.push(
      "|--------|-------|---------------|-----------------|---------------|",
    );
    for (const [signal, stats] of signalEntries) {
      const effectiveness =
        stats.fired > 0
          ? `${Math.round((stats.actionExecuted / stats.fired) * 100)}%`
          : "0%";
      lines.push(
        `| ${signal} | ${stats.fired} | ${stats.ledToAction} | ${stats.actionExecuted} | ${effectiveness} |`,
      );
    }
  }
  lines.push("");

  // Commitment Health
  lines.push("## Commitment Health");
  lines.push("");
  const commitmentEntries = Object.entries(analysis.commitments).sort(
    (a, b) => b[1].evaluated - a[1].evaluated,
  );
  if (commitmentEntries.length === 0) {
    lines.push("No commitments evaluated during this period.");
  } else {
    lines.push("| Commitment | Evaluated | Advanced | Stale | Status |");
    lines.push("|------------|-----------|----------|-------|--------|");
    for (const [label, stats] of commitmentEntries) {
      let status: string;
      if (stats.advanced > 0 && stats.stale === 0) status = "healthy";
      else if (stats.stale > stats.advanced) status = "at risk";
      else if (stats.advanced === 0 && stats.stale === 0) status = "unchanged";
      else status = "mixed";
      lines.push(
        `| ${label} | ${stats.evaluated} | ${stats.advanced} | ${stats.stale} | ${status} |`,
      );
    }
  }
  lines.push("");

  // Heartbeat Runs
  lines.push("## Heartbeat Runs");
  lines.push("");
  if (analysis.heartbeat.totalRuns === 0) {
    lines.push("No heartbeat runs during this period.");
  } else {
    const productivePct = Math.round(
      (analysis.heartbeat.productiveRuns / analysis.heartbeat.totalRuns) * 100,
    );
    const emptyPct = Math.round(
      (analysis.heartbeat.emptyRuns / analysis.heartbeat.totalRuns) * 100,
    );
    lines.push(`- Total runs: ${analysis.heartbeat.totalRuns}`);
    lines.push(
      `- Productive runs (triggered actions): ${analysis.heartbeat.productiveRuns} (${productivePct}%)`,
    );
    lines.push(
      `- Empty runs (nothing to do): ${analysis.heartbeat.emptyRuns} (${emptyPct}%)`,
    );

    const phaseEntries = Object.entries(analysis.heartbeat.phaseCounts).sort(
      (a, b) => b[1] - a[1],
    );
    if (phaseEntries.length > 0) {
      lines.push(
        `- Phase frequency: ${phaseEntries.map(([p, c]) => `${p} (${c})`).join(", ")}`,
      );
    }
  }
  lines.push("");

  // Error Recovery
  lines.push("## Error Recovery");
  lines.push("");
  if (analysis.errors.tasksFailed === 0 && analysis.errors.repairsQueued === 0) {
    lines.push("No errors or repairs during this period.");
  } else {
    lines.push(`- Tasks failed: ${analysis.errors.tasksFailed}`);
    lines.push(`- Repairs queued: ${analysis.errors.repairsQueued}`);

    const failedKinds = Object.entries(analysis.errors.failedTaskKinds).sort(
      (a, b) => b[1] - a[1],
    );
    if (failedKinds.length > 0) {
      lines.push(
        `- Recurring patterns: ${failedKinds.map(([k, c]) => `${k} (${c}x)`).join(", ")}`,
      );
    }
  }
  lines.push("");

  // Queue Throughput
  lines.push("## Queue Throughput");
  lines.push("");
  const totalTasks = analysis.queue.tasksExecuted + analysis.queue.tasksFailed;
  if (totalTasks === 0) {
    lines.push("No tasks processed during this period.");
  } else {
    const successRate = Math.round(
      (analysis.queue.tasksExecuted / totalTasks) * 100,
    );
    lines.push(`- Tasks executed: ${analysis.queue.tasksExecuted}`);
    lines.push(`- Tasks failed: ${analysis.queue.tasksFailed}`);
    lines.push(`- Success rate: ${successRate}%`);
    if (analysis.queue.tasksWithDuration > 0) {
      const avgDuration = Math.round(
        analysis.queue.totalDurationMs / analysis.queue.tasksWithDuration,
      );
      lines.push(`- Average task duration: ${avgDuration}ms`);
    }
  }
  lines.push("");

  // Skill Usage
  lines.push("## Skill Usage");
  lines.push("");
  const skillEntries = Object.entries(analysis.skills).sort(
    (a, b) => b[1] - a[1],
  );
  if (skillEntries.length === 0) {
    lines.push("No skills invoked during this period.");
  } else {
    lines.push("| Skill | Invocations |");
    lines.push("|-------|-------------|");
    for (const [skill, count] of skillEntries) {
      lines.push(`| ${skill} | ${count} |`);
    }
  }
  lines.push("");

  // Session Activity
  lines.push("## Session Activity");
  lines.push("");
  if (analysis.sessions.totalSessions === 0) {
    lines.push("No sessions recorded during this period.");
  } else {
    lines.push(`- Total sessions: ${analysis.sessions.totalSessions}`);
    const startSignals = Object.entries(
      analysis.sessions.sessionStartSignals,
    ).sort((a, b) => b[1] - a[1]);
    if (startSignals.length > 0) {
      lines.push(
        `- Most common signals at session start: ${startSignals.map(([s, c]) => `${s} (${c})`).join(", ")}`,
      );
    } else {
      lines.push("- No signals correlated with session starts.");
    }
  }
  lines.push("");

  // Recommendations
  lines.push("## Recommendations");
  lines.push("");
  const recommendations = generateRecommendations(analysis);
  if (recommendations.length === 0) {
    lines.push(
      "Not enough data to generate recommendations. Run the intent computer for a few sessions to accumulate telemetry.",
    );
  } else {
    for (const rec of recommendations) {
      lines.push(`- ${rec}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function generateRecommendations(analysis: Analysis): string[] {
  const recs: string[] = [];

  // Signal effectiveness recommendations
  for (const [signal, stats] of Object.entries(analysis.signals)) {
    if (stats.fired >= 3 && stats.actionExecuted === 0) {
      recs.push(
        `Signal "${signal}" has fired ${stats.fired} times but no actions were ever executed. Consider adjusting its threshold or removing it.`,
      );
    }
    if (stats.fired >= 5 && stats.ledToAction === 0) {
      recs.push(
        `Signal "${signal}" fires frequently (${stats.fired}x) but never leads to proposed actions. The perception layer may be misconfigured.`,
      );
    }
  }

  // Commitment health recommendations
  for (const [label, stats] of Object.entries(analysis.commitments)) {
    if (stats.evaluated >= 3 && stats.advanced === 0) {
      recs.push(
        `Commitment "${label}" has been evaluated ${stats.evaluated} times but never advanced. Consider breaking it into smaller tasks or re-evaluating its priority.`,
      );
    }
    if (stats.stale >= 3) {
      recs.push(
        `Commitment "${label}" has gone stale ${stats.stale} times. It may be blocked or too large to make progress on.`,
      );
    }
  }

  // Heartbeat recommendations
  if (analysis.heartbeat.totalRuns >= 5) {
    const emptyPct = Math.round(
      (analysis.heartbeat.emptyRuns / analysis.heartbeat.totalRuns) * 100,
    );
    if (emptyPct >= 80) {
      recs.push(
        `Heartbeat runs are ${emptyPct}% empty. Consider reducing cadence to save resources.`,
      );
    } else if (emptyPct <= 20) {
      recs.push(
        `Heartbeat runs are ${100 - emptyPct}% productive. Current cadence appears well-tuned.`,
      );
    }
  }

  // Error pattern recommendations
  const failedKinds = Object.entries(analysis.errors.failedTaskKinds).sort(
    (a, b) => b[1] - a[1],
  );
  if (failedKinds.length > 0) {
    const [topKind, topCount] = failedKinds[0];
    if (topCount >= 3) {
      recs.push(
        `Task kind "${topKind}" has failed ${topCount} times. Investigate the root cause — this is a recurring failure pattern.`,
      );
    }
  }

  // Queue throughput recommendations
  const totalTasks = analysis.queue.tasksExecuted + analysis.queue.tasksFailed;
  if (totalTasks >= 5) {
    const successRate = Math.round(
      (analysis.queue.tasksExecuted / totalTasks) * 100,
    );
    if (successRate < 70) {
      recs.push(
        `Queue success rate is only ${successRate}%. Review failing tasks — the repair mechanism may need attention.`,
      );
    }
  }

  // Skill usage recommendations (only if we have any activity)
  if (
    analysis.sessions.totalSessions >= 3 &&
    Object.keys(analysis.skills).length === 0
  ) {
    recs.push(
      "No skills have been invoked despite multiple sessions. Skills may not be registered or triggered correctly.",
    );
  }

  return recs.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function main(): void {
  const { vault, since, json } = parseArgs(process.argv);
  const events = readTelemetry(vault, since);

  if (events.length === 0) {
    const telemetryFile = join(vault, "ops", "runtime", "telemetry.jsonl");
    if (!existsSync(telemetryFile)) {
      console.log(
        "No telemetry data found. The intent computer hasn't generated any events yet.",
      );
    } else {
      console.log(
        `No telemetry events found since ${since.toISOString()}. Try a wider date range with --since.`,
      );
    }
    return;
  }

  const analysis = analyze(events);

  if (json) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  const report = generateReport(analysis);
  console.log(report);

  // Write report to vault
  const reportPath = join(vault, "ops", "runtime", "controller-report.md");
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report, "utf-8");
  } catch (err) {
    console.error(
      `Warning: could not write report to ${reportPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

if (invokedAsScript) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
