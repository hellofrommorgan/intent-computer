/**
 * intent-loop-formatter.ts — Format IntentLoopResult as session context
 *
 * Converts the raw data from the intent loop into a concise, actionable
 * context block that Claude can immediately use. Designed to be readable
 * at a glance — not a data dump.
 *
 * Output shape:
 *
 *   ## Session Intelligence
 *
 *   ### Signals
 *   - Inbox: 7 items waiting (threshold: 3)
 *   - Orphan thoughts: 12 (threshold: 5)
 *   - Schema issues: 3 thoughts missing descriptions
 *
 *   ### Active Commitments
 *   - "intent computer visual identity" — advancing, 2 days active
 *   - "ambient intelligence + session continuity" — advancing, 5 days
 *
 *   ### Suggested Actions
 *   - Process inbox (7 items above threshold)
 *   - Connect 12 orphan thoughts
 *
 *   ### Drift Notice          ← only if drift detected
 *   Current work doesn't match any active commitment.
 *   Closest: "..."
 */

import type { IntentLoopResult, PerceptionSignal, DetectedGap } from "@intent-computer/architecture";

/** Maximum number of signals to show per section. */
const MAX_SIGNALS = 5;
/** Maximum number of commitments to list. */
const MAX_COMMITMENTS = 5;
/** Maximum number of suggested actions to show. */
const MAX_ACTIONS = 5;

// ─── Signal categorization ────────────────────────────────────────────────────

interface CategorizedSignals {
  inbox: number;
  orphans: number;
  observations: number;
  tensions: number;
  sessions: number;
  schemaIssues: string[];
  linkIssues: string[];
  other: PerceptionSignal[];
}

function categorizeSignals(signals: PerceptionSignal[]): CategorizedSignals {
  const result: CategorizedSignals = {
    inbox: 0,
    orphans: 0,
    observations: 0,
    tensions: 0,
    sessions: 0,
    schemaIssues: [],
    linkIssues: [],
    other: [],
  };

  for (const signal of signals) {
    const summary = signal.summary.toLowerCase();

    if (signal.channel === "vault:inbox") {
      // Count inbox signals: the metadata total or individual item
      const total = typeof signal.metadata?.total === "number" ? signal.metadata.total : null;
      if (total !== null) {
        result.inbox = total + (typeof signal.metadata?.shown === "number" ? signal.metadata.shown : 0);
      } else if (summary.includes("inbox item")) {
        result.inbox += 1;
      }
    } else if (signal.channel === "vault:maintenance") {
      if (summary.includes("orphan")) {
        const m = summary.match(/(\d+)\s+orphan/);
        if (m) result.orphans = parseInt(m[1] ?? "0", 10);
      } else if (summary.includes("observation")) {
        const m = summary.match(/(\d+)\s+pending observation/);
        if (m) result.observations = parseInt(m[1] ?? "0", 10);
      } else if (summary.includes("tension")) {
        const m = summary.match(/(\d+)\s+pending tension/);
        if (m) result.tensions = parseInt(m[1] ?? "0", 10);
      } else if (summary.includes("session")) {
        const m = summary.match(/(\d+)\s+unprocessed session/);
        if (m) result.sessions = parseInt(m[1] ?? "0", 10);
      }
    } else if (signal.channel === "vault:health") {
      if (summary.includes("schema") || summary.includes("missing description") || summary.includes("missing topics")) {
        result.schemaIssues.push(signal.summary);
      } else if (summary.includes("dangling") || summary.includes("wiki link")) {
        result.linkIssues.push(signal.summary);
      } else if (summary.includes("description") && summary.includes("restate")) {
        result.schemaIssues.push(signal.summary);
      } else {
        result.other.push(signal);
      }
    } else if (signal.channel !== "vault:structure") {
      // Skip vault:structure — it's mostly informational and verbose
      result.other.push(signal);
    }
  }

  // Resolve inbox count from gaps if signals didn't give us a total
  if (result.inbox === 0) {
    const inboxSignals = signals.filter((s) => s.channel === "vault:inbox");
    // Individual item signals (no total metadata) — count direct signals
    const individualItems = inboxSignals.filter(
      (s) => typeof s.metadata?.total !== "number" && !s.summary.includes("showing first"),
    );
    if (individualItems.length > 0) {
      result.inbox = individualItems.length;
    }
    // Capped summary signal with total count
    const summarySignal = inboxSignals.find((s) => s.summary.includes("inbox items pending"));
    if (summarySignal) {
      const m = summarySignal.summary.match(/^(\d+)\s+inbox items pending/);
      if (m) result.inbox = parseInt(m[1] ?? "0", 10);
    }
  }

  return result;
}

// ─── Gap rendering ────────────────────────────────────────────────────────────

function renderGaps(gaps: DetectedGap[]): string[] {
  const lines: string[] = [];
  for (const gap of gaps.slice(0, MAX_SIGNALS)) {
    const evidence = gap.evidence.join("; ");
    const class_ = gap.gapClass === "constitutive" ? "REQUIRED" : "deferred if needed";
    lines.push(`- [${class_}] ${gap.label}: ${evidence}`);
  }
  return lines;
}

// ─── Commitment rendering ─────────────────────────────────────────────────────

function renderCommitments(result: IntentLoopResult): string[] {
  const active = result.commitment.activeCommitments.slice(0, MAX_COMMITMENTS);
  if (active.length === 0) return ["- No active commitments found"];

  return active.map((c) => {
    const parts: string[] = [`"${c.label}"`];
    if (c.horizon) parts.push(`horizon: ${c.horizon}`);
    if (c.desireClass && c.desireClass !== "unknown") parts.push(`desire: ${c.desireClass}`);
    if (c.frictionClass && c.frictionClass !== "unknown") parts.push(`friction: ${c.frictionClass}`);
    return `- ${parts.join(" — ")}`;
  });
}

// ─── Action rendering ─────────────────────────────────────────────────────────

function renderActions(result: IntentLoopResult): string[] {
  const actions = result.plan.actions
    .filter((a) => a.authorityNeeded === "advisory" || a.authorityNeeded === "delegated")
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_ACTIONS);

  if (actions.length === 0) return ["- No actions suggested"];

  return actions.map((a) => {
    const prefix = a.requiresPermission ? "[needs approval] " : "";
    return `- ${prefix}${a.label}: ${a.reason}`;
  });
}

// ─── Signals section ──────────────────────────────────────────────────────────

function renderSignalsSection(signals: PerceptionSignal[], gaps: DetectedGap[]): string {
  const cat = categorizeSignals(signals);
  const lines: string[] = [];

  if (cat.inbox > 0) {
    lines.push(`- Inbox: ${cat.inbox} item${cat.inbox === 1 ? "" : "s"} waiting`);
  }
  if (cat.orphans > 0) {
    lines.push(`- Orphan thoughts: ${cat.orphans} without incoming links`);
  }
  if (cat.observations > 0) {
    lines.push(`- Pending observations: ${cat.observations}`);
  }
  if (cat.tensions > 0) {
    lines.push(`- Pending tensions: ${cat.tensions}`);
  }
  if (cat.sessions > 0) {
    lines.push(`- Unprocessed sessions: ${cat.sessions}`);
  }
  for (const issue of cat.schemaIssues) {
    lines.push(`- Schema: ${issue}`);
  }
  for (const issue of cat.linkIssues) {
    lines.push(`- Links: ${issue}`);
  }
  for (const signal of cat.other.slice(0, 2)) {
    lines.push(`- ${signal.summary}`);
  }

  if (lines.length === 0) {
    lines.push("- Vault looks healthy — no maintenance conditions detected");
  }

  const gapLines = renderGaps(gaps);
  if (gapLines.length > 0) {
    lines.push("");
    lines.push("Gaps requiring attention:");
    lines.push(...gapLines);
  }

  return `### Signals\n${lines.join("\n")}`;
}

// ─── Main formatter ───────────────────────────────────────────────────────────

/**
 * Format an IntentLoopResult into a concise session context block.
 * Returns an empty string if the result has nothing useful to show.
 */
export function formatIntentLoopResult(result: IntentLoopResult): string {
  const sections: string[] = [];

  // Signals section
  const signalSection = renderSignalsSection(result.perception.signals, result.perception.gaps);
  sections.push(signalSection);

  // Active commitments
  const commitmentLines = renderCommitments(result);
  sections.push(`### Active Commitments\n${commitmentLines.join("\n")}`);

  // Suggested actions
  const actionLines = renderActions(result);
  sections.push(`### Suggested Actions\n${actionLines.join("\n")}`);

  // Drift notice (only when drift detected)
  if (result.identity.drift?.detected) {
    const drift = result.identity.drift;
    const driftLines: string[] = [drift.summary];
    if (drift.score > 0) {
      driftLines.push(`Drift score: ${drift.score.toFixed(2)}`);
    }
    sections.push(`### Drift Notice\n${driftLines.join("\n")}`);
  }

  // Commitment rationale (brief)
  if (result.commitment.rationale) {
    sections.push(`### Session Focus\n${result.commitment.rationale}`);
  }

  // Relevant memory propositions (if any were loaded)
  if (result.memory.propositions.length > 0) {
    const propLines = result.memory.propositions
      .slice(0, 8)
      .map((p) => `- [[${p.title}]]: ${p.description || "(no description)"}`)
      .join("\n");
    sections.push(`### Relevant Thoughts\n${propLines}`);
  }

  if (sections.length === 0) return "";

  const elapsed = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();
  const header = `## Session Intelligence\n_Cycle ${result.cycleId.slice(0, 8)} · ${elapsed}ms_`;

  return `${header}\n\n${sections.join("\n\n")}`;
}
