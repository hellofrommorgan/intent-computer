/**
 * local-identity.ts — IdentityPort adapter
 *
 * Resolves agent identity from the local vault filesystem. Reads self-knowledge
 * files (identity.md, goals.md, working-memory.md) and merges perception signals
 * into the agent's umwelt — the situational awareness envelope.
 *
 * The identity state answers: who am I, what do I care about, and what's my
 * current context?
 */

import type {
  IdentityPort,
  IdentityResolutionInput,
  IdentityState,
  Commitment,
  CommitmentState,
  DesireClass,
  FrictionClass,
  IdentityDriftState,
} from "@intent-computer/architecture";
import {
  deriveCommitmentId,
  readFirstExisting,
  vaultPaths,
} from "@intent-computer/architecture";

const MAX_UMWELT_LINES = 50;

export class LocalIdentityAdapter implements IdentityPort {
  private readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
  }

  async resolve(input: IdentityResolutionInput): Promise<IdentityState> {
    const now = new Date().toISOString();
    const paths = vaultPaths(this.vaultRoot);

    // ─── Self model ─────────────────────────────────────────────────────────
    const selfModel = readFirstExisting(paths.identity) ?? "Identity not configured.";

    // ─── Goals + commitments ────────────────────────────────────────────────
    const goalsContent = readFirstExisting(paths.goals) ?? "";

    const { priorities, commitments } = this.parseGoals(goalsContent);
    const drift = this.detectIdentityDrift(input.intent.statement, commitments, now);

    // ─── Umwelt (recent context + perception signals) ───────────────────────
    const umwelt = this.buildUmwelt(input);

    return {
      actorId: input.session.actorId,
      selfModel,
      umwelt,
      priorities,
      commitments,
      drift,
      updatedAt: now,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private parseGoals(goalsContent: string): { priorities: string[]; commitments: Commitment[] } {
    const priorities: string[] = [];
    const commitments: Commitment[] = [];

    if (!goalsContent) return { priorities, commitments };

    const lines = goalsContent.split("\n");
    let inSection: "threads" | "priorities" | null = null;
    let commitmentIndex = 0;
    const idCounts = new Map<string, number>();

    // Accumulate multi-line thread bodies (main line + indented sub-bullets)
    let currentLabel: string | null = null;
    let currentBodyLines: string[] = [];

    const flushThread = () => {
      if (!currentLabel || currentBodyLines.length === 0) return;

      const firstLine = currentBodyLines[0] ?? "";
      const fullBody = currentBodyLines.join(" ");

      // Scan full body (including sub-bullets) for momentum and state
      const momentumMatch = fullBody.match(/Momentum:\s*(\w+)/i);
      const momentum = momentumMatch?.[1]?.toLowerCase();
      const horizon = momentum === "high" ? "session" as const : "week" as const;
      const desireClass = this.parseDesireClass(`${currentLabel} ${fullBody}`);
      const frictionClass = this.parseFrictionClass(`${currentLabel} ${fullBody}`);
      const cleanLabel = this.stripMarkers(currentLabel);
      if (!cleanLabel) {
        currentLabel = null;
        currentBodyLines = [];
        return;
      }

      let state: CommitmentState = "active";
      if (/paused|on hold|deferred/i.test(fullBody)) state = "paused";
      if (/done|completed|shipped/i.test(fullBody)) state = "satisfied";
      if (/^COMPLETE/i.test(firstLine)) state = "satisfied";

      commitmentIndex++;
      const baseId = deriveCommitmentId(cleanLabel);
      const seen = idCounts.get(baseId) ?? 0;
      idCounts.set(baseId, seen + 1);
      const commitmentId = seen === 0 ? baseId : `${baseId}-${seen + 1}`;

      commitments.push({
        id: commitmentId,
        label: cleanLabel,
        description: firstLine.trim() || undefined,
        state,
        priority: commitmentIndex,
        horizon,
        desireClass,
        frictionClass,
      });

      currentLabel = null;
      currentBodyLines = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect sections
      if (/^##\s+Active Threads/i.test(trimmed)) {
        flushThread();
        inSection = "threads";
        continue;
      }
      if (/^##\s+Priorities/i.test(trimmed) || /^##\s+Current Priorities/i.test(trimmed)) {
        flushThread();
        inSection = "priorities";
        continue;
      }
      // Fix 1: Explicit guard for known non-commitment sections
      if (/^##\s+(Waiting|Completed|Done|On Hold)/i.test(trimmed)) {
        flushThread();
        inSection = null;
        continue;
      }
      if (/^##\s/.test(trimmed)) {
        flushThread();
        inSection = null;
        continue;
      }

      // Parse active threads as commitments
      if (inSection === "threads") {
        // Top-level thread: starts with `- **label** — body` at column 0
        const threadMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/);
        if (threadMatch) {
          flushThread();
          currentLabel = threadMatch[1].trim();
          currentBodyLines = [threadMatch[2].trim()];
        } else if (currentLabel && line.match(/^\s+/) && trimmed.length > 0) {
          // Indented continuation line (sub-bullet or continuation prose)
          currentBodyLines.push(trimmed);
        } else if (trimmed.length === 0 && currentLabel) {
          // Blank line ends the current thread
          flushThread();
        }
      }

      // Parse priorities as priority strings
      if (inSection === "priorities") {
        const priorityMatch = trimmed.match(/^[-*]\s+(.+)/);
        if (priorityMatch) {
          priorities.push(priorityMatch[1].trim());
        }
      }
    }

    flushThread();

    // If no explicit priorities section, derive from thread labels
    if (priorities.length === 0 && commitments.length > 0) {
      for (const c of commitments.filter(c => c.state === "active")) {
        priorities.push(c.label);
      }
    }

    return { priorities, commitments };
  }

  private stripMarkers(value: string): string {
    return value
      .replace(/\[(?:thick|thin|constitutive|incidental)\]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private parseDesireClass(value: string): DesireClass {
    if (/\[thin\]/i.test(value)) return "thin";
    if (/\[thick\]/i.test(value)) return "thick";
    return "unknown";
  }

  private parseFrictionClass(value: string): FrictionClass {
    if (/\[constitutive\]/i.test(value)) return "constitutive";
    if (/\[incidental\]/i.test(value)) return "incidental";
    return "unknown";
  }

  private detectIdentityDrift(
    intentStatement: string,
    commitments: Commitment[],
    comparedAt: string,
  ): IdentityDriftState {
    const active = commitments.filter((commitment) => commitment.state === "active");
    if (active.length === 0) {
      return {
        detected: false,
        score: 0,
        summary: "No active commitments available for drift comparison.",
        alignedCommitmentIds: [],
        comparedAt,
      };
    }

    const intentTerms = this.tokenize(intentStatement);
    const aligned = active.filter((commitment) => {
      const labelLower = commitment.label.toLowerCase();
      if (intentStatement.toLowerCase().includes(labelLower)) return true;
      const labelTerms = this.tokenize(labelLower);
      const overlap = [...labelTerms].filter((term) => intentTerms.has(term)).length;
      return overlap > 0;
    });

    const detected = aligned.length === 0;
    const score = Number((1 - aligned.length / active.length).toFixed(2));
    const alignedIds = aligned.map((commitment) => commitment.id);
    const priorityPreview = active
      .sort((left, right) => left.priority - right.priority)
      .slice(0, 3)
      .map((commitment) => commitment.label)
      .join(", ");

    return {
      detected,
      score,
      summary: detected
        ? `Intent appears off-thread vs active commitments. Top active threads: ${priorityPreview}`
        : `Intent overlaps ${aligned.length}/${active.length} active commitment thread(s).`,
      alignedCommitmentIds: alignedIds,
      comparedAt,
    };
  }

  private tokenize(value: string): Set<string> {
    const STOPWORDS = new Set([
      "the",
      "and",
      "for",
      "with",
      "that",
      "this",
      "from",
      "into",
      "onto",
      "about",
      "have",
      "will",
      "your",
      "current",
      "task",
      "work",
      "plan",
      "next",
    ]);
    const terms = value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
    return new Set(terms);
  }

  private buildUmwelt(input: IdentityResolutionInput): string[] {
    const umwelt: string[] = [];
    const paths = vaultPaths(this.vaultRoot);

    // Working memory — recent session context
    const workingMemory = readFirstExisting(paths.workingMemory);

    if (workingMemory) {
      // Take the last N lines as most recent context
      const recentLines = workingMemory
        .split("\n")
        .filter(l => l.trim().length > 0)
        .slice(-20);
      umwelt.push(...recentLines);
    }

    // Current intent
    umwelt.push(`[intent] ${input.intent.statement}`);

    if (umwelt.length > MAX_UMWELT_LINES) {
      const head = umwelt.slice(0, 10);
      const tail = umwelt.slice(-40);
      return [...head, ...tail];
    }

    return umwelt;
  }
}
