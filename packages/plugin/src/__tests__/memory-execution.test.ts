/**
 * memory-execution.test.ts — Tests for memory context enrichment in execution proposals
 *
 * Verifies that execution proposals cite memory context (propositions) when available,
 * and degrade gracefully when no propositions are present.
 */

import { describe, it, expect } from "vitest";
import { LocalExecutionAdapter } from "../adapters/local-execution.js";
import {
  FIXTURE_VAULT,
  makeSession,
  makeIntent,
  makeIdentity,
  makeProposition,
  makeGap,
  makeCommitment,
} from "./helpers.js";

function makeExecutionAdapter() {
  return new LocalExecutionAdapter(FIXTURE_VAULT, {
    policyPath: "/nonexistent/policy.json",
  });
}

describe("Execution proposals cite memory context when available", () => {
  it("orphan-pressure proposal references related propositions", async () => {
    const plan = await makeExecutionAdapter().propose({
      session: makeSession(),
      intent: makeIntent(),
      identity: makeIdentity(),
      commitment: {
        intentId: "test-intent-001",
        activeCommitments: [],
        protectedGaps: [makeGap("orphan-pressure", ["5 orphan thoughts detected"])],
        compressedGaps: [],
        rationale: "Test",
        updatedAt: new Date().toISOString(),
      },
      memory: {
        vaultId: FIXTURE_VAULT,
        propositions: [
          makeProposition({
            id: "prop-orphan",
            title: "orphan thoughts often contain hidden connections",
            description: "Thoughts that seem unrelated may share deep structure",
            topics: ["[[graph health]]"],
          }),
        ],
        links: [],
        queueDepth: 0,
        loadedAt: new Date().toISOString(),
      },
    });

    const orphanAction = plan.actions.find(a => a.actionKey === "connect_orphans");
    expect(orphanAction).toBeDefined();
    expect(orphanAction!.label).toContain("thought");
  });

  it("inbox-pressure proposal references propositions that may connect", async () => {
    const plan = await makeExecutionAdapter().propose({
      session: makeSession(),
      intent: makeIntent(),
      identity: makeIdentity(),
      commitment: {
        intentId: "test-intent-001",
        activeCommitments: [],
        protectedGaps: [makeGap("inbox-pressure", ["3 inbox items pending"])],
        compressedGaps: [],
        rationale: "Test",
        updatedAt: new Date().toISOString(),
      },
      memory: {
        vaultId: FIXTURE_VAULT,
        propositions: [
          makeProposition({
            id: "prop-creative",
            title: "consistency in creative work compounds like interest",
            description: "Writing daily builds neural pathways",
            topics: ["[[creative resistance]]"],
          }),
        ],
        links: [],
        queueDepth: 0,
        loadedAt: new Date().toISOString(),
      },
    });

    const inboxAction = plan.actions.find(a => a.actionKey === "process_inbox");
    expect(inboxAction).toBeDefined();
    expect(inboxAction!.label).toContain("[[consistency in creative work compounds like interest]]");
  });
});

describe("Execution proposals work without memory context", () => {
  it("produces valid proposals with empty propositions", async () => {
    const plan = await makeExecutionAdapter().propose({
      session: makeSession(),
      intent: makeIntent(),
      identity: makeIdentity(),
      commitment: {
        intentId: "test-intent-001",
        activeCommitments: [],
        protectedGaps: [
          makeGap("orphan-pressure", ["5 orphan thoughts"]),
          makeGap("inbox-pressure", ["2 inbox items"]),
        ],
        compressedGaps: [],
        rationale: "Test",
        updatedAt: new Date().toISOString(),
      },
      memory: {
        vaultId: FIXTURE_VAULT,
        propositions: [],
        links: [],
        queueDepth: 0,
        loadedAt: new Date().toISOString(),
      },
    });

    expect(plan.actions.length).toBeGreaterThan(0);
    for (const action of plan.actions) {
      expect(action.label).toBeTruthy();
      expect(action.label).not.toContain("undefined");
      expect(action.reason).toBeTruthy();
    }

    const orphanAction = plan.actions.find(a => a.actionKey === "connect_orphans");
    expect(orphanAction).toBeDefined();
    expect(orphanAction!.label).toBe("Connect orphaned thoughts");
  });
});

describe("Commitment advancement cites relevant propositions", () => {
  it("session-horizon commitment references matching propositions", async () => {
    const plan = await makeExecutionAdapter().propose({
      session: makeSession(),
      intent: makeIntent(),
      identity: makeIdentity(),
      commitment: {
        intentId: "test-intent-001",
        activeCommitments: [
          makeCommitment({
            id: "commit-creative",
            label: "improve creative workflow",
            horizon: "session",
          }),
        ],
        protectedGaps: [],
        compressedGaps: [],
        rationale: "Test",
        updatedAt: new Date().toISOString(),
      },
      memory: {
        vaultId: FIXTURE_VAULT,
        propositions: [
          makeProposition({
            id: "prop-creative",
            title: "consistency in creative work compounds like interest",
            description: "Writing daily builds neural pathways",
            topics: ["[[creative resistance]]", "[[productivity patterns]]"],
          }),
          makeProposition({
            id: "prop-routine",
            title: "morning routine breaks the inertia when nothing else does",
            description: "Routines reduce decision fatigue for creative work",
            topics: ["[[productivity patterns]]"],
          }),
        ],
        links: [],
        queueDepth: 0,
        loadedAt: new Date().toISOString(),
      },
    });

    const advanceAction = plan.actions.find(a => a.actionKey === "advance_commitment");
    expect(advanceAction).toBeDefined();
    expect(advanceAction!.reason).toContain("related thoughts:");
    expect(advanceAction!.reason).toContain("[[");
  });

  it("session-horizon commitment without matching propositions has plain reason", async () => {
    const plan = await makeExecutionAdapter().propose({
      session: makeSession(),
      intent: makeIntent(),
      identity: makeIdentity(),
      commitment: {
        intentId: "test-intent-001",
        activeCommitments: [
          makeCommitment({
            id: "commit-gardening",
            label: "improve creative workflow",
            horizon: "session",
          }),
        ],
        protectedGaps: [],
        compressedGaps: [],
        rationale: "Test",
        updatedAt: new Date().toISOString(),
      },
      memory: {
        vaultId: FIXTURE_VAULT,
        propositions: [
          makeProposition({
            id: "prop-unrelated",
            title: "quantum mechanics defies intuition",
            description: "Wave-particle duality is strange",
            topics: ["[[physics]]"],
          }),
        ],
        links: [],
        queueDepth: 0,
        loadedAt: new Date().toISOString(),
      },
    });

    const advanceAction = plan.actions.find(a => a.actionKey === "advance_commitment");
    expect(advanceAction).toBeDefined();
    expect(advanceAction!.reason).not.toContain("related thoughts:");
    expect(advanceAction!.reason).toContain("Session-horizon commitment");
  });
});
