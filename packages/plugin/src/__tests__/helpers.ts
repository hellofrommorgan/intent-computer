/**
 * helpers.ts — Shared test factories and constants
 */

import { join } from "path";
import type {
  SessionFrame,
  IntentRequest,
  IdentityState,
  CommitmentPlan,
  MemoryContext,
  DetectedGap,
  Proposition,
  Commitment,
} from "@intent-computer/architecture";

export const FIXTURE_VAULT = join(import.meta.dirname, "fixtures", "test-vault");

export function makeSession(): SessionFrame {
  return {
    sessionId: "test-session-001",
    actorId: "test-actor",
    startedAt: new Date().toISOString(),
    worktree: FIXTURE_VAULT,
  };
}

export function makeIntent(statement = "session start"): IntentRequest {
  return {
    id: "test-intent-001",
    actorId: "test-actor",
    statement,
    source: "inferred",
    requestedAt: new Date().toISOString(),
  };
}

export function makeIdentity(overrides: Partial<IdentityState> = {}): IdentityState {
  return {
    actorId: "test-actor",
    selfModel: "test",
    umwelt: [],
    priorities: [],
    commitments: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeProposition(overrides: Partial<Proposition> = {}): Proposition {
  return {
    id: "prop-1",
    vaultId: FIXTURE_VAULT,
    title: "consistency in creative work compounds like interest",
    description: "Writing daily even when uninspired builds neural pathways",
    topics: ["[[creative resistance]]", "[[productivity patterns]]"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeGap(label: string, evidence: string[], gapClass: "constitutive" | "incidental" = "constitutive"): DetectedGap {
  return {
    id: `gap-${label}`,
    intentId: "test-intent-001",
    label,
    gapClass,
    evidence,
    confidence: "medium",
  };
}

export function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: "commit-1",
    label: "improve creative workflow",
    state: "active",
    priority: 1,
    horizon: "session",
    ...overrides,
  };
}

export function makeMemory(propositions: Proposition[] = []): MemoryContext {
  return {
    vaultId: FIXTURE_VAULT,
    propositions,
    links: [],
    queueDepth: 0,
    loadedAt: new Date().toISOString(),
  };
}

export function makeCommitmentPlan(overrides: Partial<CommitmentPlan> = {}): CommitmentPlan {
  return {
    intentId: "test-intent-001",
    activeCommitments: [],
    protectedGaps: [],
    compressedGaps: [],
    rationale: "Test",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
