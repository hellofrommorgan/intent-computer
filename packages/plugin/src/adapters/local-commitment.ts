/**
 * local-commitment.ts — CommitmentPort adapter
 *
 * Evaluates and plans commitments from a local vault. Reads active commitments
 * from ops/commitments.json (creating if absent), merges with goals.md-derived
 * commitments from identity, and classifies perception gaps against the
 * commitment landscape.
 *
 * Protected gaps (constitutive) cannot be compressed — they represent
 * structural integrity of the knowledge system. Incidental gaps can be
 * deferred if they don't align with active commitments.
 */

import { readFileSync, existsSync } from "fs";
import {
  commitmentPath,
  deriveCommitmentId,
  enforceCommitmentIntegrity,
  withCommitmentLock,
  writeCommitmentsAtomic,
} from "@intent-computer/architecture";
import type {
  CommitmentPort,
  CommitmentPlanningInput,
  CommitmentOutcomeInput,
  CommitmentPlan,
  Commitment,
  CommitmentState,
  DetectedGap,
} from "@intent-computer/architecture";

interface StoredCommitment {
  id: string;
  label: string;
  state: CommitmentState;
  priority: number;
  horizon: "session" | "week" | "quarter" | "long";
  desireClass?: "thick" | "thin" | "unknown";
  frictionClass?: "constitutive" | "incidental" | "unknown";
  source: string;
  lastAdvancedAt: string;
  evidence: string[];
}

interface CommitmentsFile {
  version: number;
  commitments: StoredCommitment[];
  lastEvaluatedAt: string;
}

export class LocalCommitmentAdapter implements CommitmentPort {
  private readonly vaultRoot: string;
  private readonly commitmentsPath: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
    this.commitmentsPath = commitmentPath(vaultRoot);
  }

  async plan(input: CommitmentPlanningInput): Promise<CommitmentPlan> {
    const now = new Date().toISOString();
    let merged: CommitmentsFile = {
      version: 1,
      commitments: [],
      lastEvaluatedAt: now,
    };
    await withCommitmentLock(this.vaultRoot, async () => {
      // ─── Load stored commitments ──────────────────────────────────────────
      const stored = this.loadCommitments();

      // ─── Merge identity commitments (from goals.md) ───────────────────────
      merged = this.mergeIdentityCommitments(stored, input.identity.commitments);

      // ─── Persist updated state ────────────────────────────────────────────
      merged.lastEvaluatedAt = now;
      this.saveCommitments(merged);
    });

    // ─── Classify gaps ──────────────────────────────────────────────────────
    const activeCommitments = merged.commitments.filter(c => c.state === "active");
    const { protectedGaps, compressedGaps } = this.classifyGaps(
      input.perception.gaps,
      activeCommitments,
    );

    // ─── Build rationale ────────────────────────────────────────────────────
    const rationale = this.buildRationale(activeCommitments, protectedGaps, compressedGaps);

    // ─── Map stored commitments to domain type ──────────────────────────────
    const domainCommitments: Commitment[] = activeCommitments.map(sc => ({
      id: sc.id,
      label: sc.label,
      state: sc.state,
      priority: sc.priority,
      horizon: sc.horizon,
      desireClass: sc.desireClass ?? "unknown",
      frictionClass: sc.frictionClass ?? "unknown",
    }));

    const drift = input.identity.drift;
    const driftAwareRationale = drift?.detected
      ? `${rationale} Identity drift flagged (score ${drift.score}): ${drift.summary}`
      : rationale;

    return {
      intentId: input.intent.id,
      activeCommitments: domainCommitments,
      protectedGaps,
      compressedGaps,
      rationale: driftAwareRationale,
      updatedAt: now,
    };
  }

  async recordOutcome(input: CommitmentOutcomeInput): Promise<void> {
    const succeeded = input.outcome.results.filter((result) => result.success && result.executed);
    if (succeeded.length === 0) return;

    const now = new Date().toISOString();
    await withCommitmentLock(this.vaultRoot, async () => {
      const store = this.loadCommitments();
      const byId = new Map(store.commitments.map((commitment) => [commitment.id, commitment]));
      const byLabel = new Map(
        store.commitments.map((commitment) => [commitment.label.toLowerCase(), commitment]),
      );

      const touched = new Set<string>();
      for (const commitment of input.commitment.activeCommitments) {
        const label = commitment.label.toLowerCase();
        const matchedAction = input.plan.actions.some((action) => {
          const actionResult = succeeded.find((result) => result.actionId === action.id);
          if (!actionResult) return false;
          const actionText = `${action.label} ${action.reason} ${actionResult.detail}`.toLowerCase();
          return (
            actionText.includes(label) ||
            action.payload?.commitmentId === commitment.id ||
            action.payload?.commitmentLabel === commitment.label
          );
        });

        if (matchedAction) {
          touched.add(commitment.id);
        }
      }

      if (touched.size === 0) return;

      for (const commitment of input.commitment.activeCommitments) {
        if (!touched.has(commitment.id)) continue;

        const existing = byId.get(commitment.id) ?? byLabel.get(commitment.label.toLowerCase());
        if (existing) {
          existing.lastAdvancedAt = now;
          existing.state = "active";
          existing.desireClass = commitment.desireClass ?? existing.desireClass ?? "unknown";
          existing.frictionClass = commitment.frictionClass ?? existing.frictionClass ?? "unknown";
          existing.evidence = [
            ...existing.evidence.slice(-19),
            `${now}: ${input.intent.statement} (${succeeded.length}/${input.outcome.results.length} action(s) succeeded)`,
          ];
        } else {
          store.commitments.push({
            id: commitment.id ?? deriveCommitmentId(commitment.label),
            label: commitment.label,
            state: "active",
            priority: commitment.priority,
            horizon: commitment.horizon,
            desireClass: commitment.desireClass ?? "unknown",
            frictionClass: commitment.frictionClass ?? "unknown",
            source: "runtime",
            lastAdvancedAt: now,
            evidence: [
              `${now}: ${input.intent.statement} (${succeeded.length}/${input.outcome.results.length} action(s) succeeded)`,
            ],
          });
        }
      }

      store.lastEvaluatedAt = now;
      this.saveCommitments(store);
    });
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  private loadCommitments(): CommitmentsFile {
    if (!existsSync(this.commitmentsPath)) {
      return {
        version: 1,
        commitments: [],
        lastEvaluatedAt: new Date().toISOString(),
      };
    }
    try {
      const raw = readFileSync(this.commitmentsPath, "utf-8");
      return JSON.parse(raw) as CommitmentsFile;
    } catch {
      return {
        version: 1,
        commitments: [],
        lastEvaluatedAt: new Date().toISOString(),
      };
    }
  }

  private saveCommitments(data: CommitmentsFile): void {
    writeCommitmentsAtomic(this.vaultRoot, data);
  }

  // ─── Merging ────────────────────────────────────────────────────────────────

  /**
   * Merge commitments from identity (goals.md) with persisted commitments.
   * Identity commitments are the source of truth for labels and priorities.
   * Stored commitments carry evidence and advancement history.
   */
  private mergeIdentityCommitments(
    stored: CommitmentsFile,
    identityCommitments: Commitment[],
  ): CommitmentsFile {
    const now = new Date().toISOString();
    const storedByLabel = new Map(stored.commitments.map(c => [c.label.toLowerCase(), c]));
    const merged: StoredCommitment[] = [];
    const seenLabels = new Set<string>();

    // Identity commitments take priority for ordering
    for (const ic of identityCommitments) {
      const key = ic.label.toLowerCase();
      seenLabels.add(key);
      const stableId = deriveCommitmentId(ic.label);

      const existing = storedByLabel.get(key);
      if (existing) {
        // Update priority and state from identity, preserve evidence
        merged.push({
          ...existing,
          id: stableId,
          state: ic.state,
          priority: ic.priority,
          horizon: ic.horizon,
          desireClass: ic.desireClass ?? existing.desireClass ?? "unknown",
          frictionClass: ic.frictionClass ?? existing.frictionClass ?? "unknown",
        });
      } else {
        // New commitment from goals.md
        merged.push({
          id: stableId,
          label: ic.label,
          state: ic.state,
          priority: ic.priority,
          horizon: ic.horizon,
          desireClass: ic.desireClass ?? "unknown",
          frictionClass: ic.frictionClass ?? "unknown",
          source: "goals.md",
          lastAdvancedAt: now,
          evidence: [],
        });
      }
    }

    // Preserve stored commitments not in identity (may be from other sources)
    for (const sc of stored.commitments) {
      if (!seenLabels.has(sc.label.toLowerCase())) {
        merged.push({
          ...sc,
          id: sc.id || deriveCommitmentId(sc.label),
          desireClass: sc.desireClass ?? "unknown",
          frictionClass: sc.frictionClass ?? "unknown",
        });
      }
    }

    const deduped = enforceCommitmentIntegrity(merged);

    return {
      version: stored.version,
      commitments: deduped,
      lastEvaluatedAt: stored.lastEvaluatedAt,
    };
  }

  // ─── Gap classification ─────────────────────────────────────────────────────

  /**
   * Classify perception gaps as protected or compressible.
   *
   * Protected gaps (constitutive): structural integrity issues that cannot
   * be deferred — inbox pressure, tension backlogs, things that degrade
   * the knowledge graph.
   *
   * Compressed gaps (incidental): issues that are real but can be deferred
   * if they don't align with active commitments — orphans, session backlog,
   * observation triaging.
   *
   * Desired-state gaps (desired:*) arrive pre-classified from perception:
   * constitutive for structural metrics (schema-compliance, connection-density),
   * incidental for others. This classification is respected as-is.
   */
  private classifyGaps(
    gaps: DetectedGap[],
    activeCommitments: StoredCommitment[],
  ): { protectedGaps: DetectedGap[]; compressedGaps: DetectedGap[] } {
    const protectedGaps: DetectedGap[] = [];
    const compressedGaps: DetectedGap[] = [];

    for (const gap of gaps) {
      if (gap.gapClass === "constitutive") {
        // Constitutive gaps are always protected
        protectedGaps.push(gap);
      } else {
        // Incidental gaps: check if any active commitment relates
        const relatesTo = activeCommitments.some(c =>
          gap.label.toLowerCase().includes(c.label.toLowerCase()) ||
          c.label.toLowerCase().includes(gap.label.toLowerCase()) ||
          gap.evidence.some(e => e.toLowerCase().includes(c.label.toLowerCase())),
        );

        if (relatesTo) {
          protectedGaps.push(gap);
        } else {
          compressedGaps.push(gap);
        }
      }
    }

    return { protectedGaps, compressedGaps };
  }

  // ─── Rationale ──────────────────────────────────────────────────────────────

  private buildRationale(
    active: StoredCommitment[],
    protectedGaps: DetectedGap[],
    compressedGaps: DetectedGap[],
  ): string {
    const parts: string[] = [];

    if (active.length === 0) {
      parts.push("No active commitments. Operating in open exploration mode.");
    } else {
      const labels = active.slice(0, 3).map(c => c.label).join(", ");
      parts.push(`Active commitments: ${labels}${active.length > 3 ? ` (+${active.length - 3} more)` : ""}.`);
    }

    if (protectedGaps.length > 0) {
      parts.push(
        `${protectedGaps.length} gap(s) require attention: ${protectedGaps.map(g => g.label).join(", ")}.`,
      );
    }

    if (compressedGaps.length > 0) {
      parts.push(
        `${compressedGaps.length} gap(s) deferred: ${compressedGaps.map(g => g.label).join(", ")}.`,
      );
    }

    return parts.join(" ");
  }
}
