/**
 * intent-loop.test.ts — End-to-end tests for the 5-layer intent loop
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PerceptionSnapshot } from "@intent-computer/architecture";
import { LocalPerceptionAdapter } from "../adapters/local-perception.js";
import { LocalIdentityAdapter } from "../adapters/local-identity.js";
import { LocalCommitmentAdapter } from "../adapters/local-commitment.js";
import { LocalMemoryAdapter } from "../adapters/local-memory.js";
import { LocalExecutionAdapter } from "../adapters/local-execution.js";
import { measureMetabolicRate } from "../adapters/metabolic.js";
import { FIXTURE_VAULT, makeSession, makeIntent, makeGap, makeIdentity, makeMemory, makeCommitmentPlan } from "./helpers.js";

describe("Perception", () => {
  let snapshot: PerceptionSnapshot;

  beforeAll(async () => {
    const adapter = new LocalPerceptionAdapter(FIXTURE_VAULT, { recordTriggerHistory: false });
    snapshot = await adapter.capture({ session: makeSession(), intent: makeIntent() });
  });

  it("returns signals on expected channels", () => {
    const channels = new Set(snapshot.signals.map((s) => s.channel));
    expect(channels).toContain("vault:structure");
    expect(channels).toContain("vault:inbox");
    expect(channels).toContain("vault:health");
    expect(channels).toContain("vault:triggers");
    expect(channels).toContain("vault:metabolic");
    expect(channels).toContain("vault:desired-state");
  });

  it("detects inbox-pressure gap", () => {
    const gap = snapshot.gaps.find((g) => g.label === "inbox-pressure");
    expect(gap).toBeDefined();
    expect(gap!.gapClass).toBe("constitutive");
  });

  it("detects orphan entities", () => {
    const gap = snapshot.gaps.find((g) => g.label === "orphan-pressure");
    const signal = snapshot.signals.find(
      (s) => s.summary.includes("orphan") && s.channel === "vault:maintenance",
    );
    expect(gap || signal).toBeTruthy();
  });

  it("detects schema violation (missing description)", () => {
    const signal = snapshot.signals.find(
      (s) => s.channel === "vault:health" && s.summary.includes("missing description"),
    );
    expect(signal).toBeDefined();
    expect(signal!.metadata?.missingDescription).toBeGreaterThanOrEqual(1);
  });

  it("runs trigger battery", () => {
    const signal = snapshot.signals.find((s) => s.channel === "vault:triggers");
    expect(signal).toBeDefined();
    expect(signal!.metadata?.total).toBeGreaterThan(0);
  });
});

describe("Gaps flow through to execution proposals", () => {
  let actions: Array<{ label: string; actionKey?: string }>;

  beforeAll(async () => {
    const session = makeSession();
    const intent = makeIntent();

    const snap = await new LocalPerceptionAdapter(FIXTURE_VAULT, { recordTriggerHistory: false })
      .capture({ session, intent });
    const id = await new LocalIdentityAdapter(FIXTURE_VAULT)
      .resolve({ session, intent, perception: snap });
    const commit = await new LocalCommitmentAdapter(FIXTURE_VAULT)
      .plan({ session, intent, perception: snap, identity: id });
    const mem = await new LocalMemoryAdapter(FIXTURE_VAULT)
      .hydrate({ session, intent, perception: snap, identity: id, commitment: commit });
    const plan = await new LocalExecutionAdapter(FIXTURE_VAULT, { policyPath: "/nonexistent" })
      .propose({ session, intent, identity: id, commitment: commit, memory: mem });

    actions = plan.actions;
  });

  it("produces action proposals", () => {
    expect(actions.length).toBeGreaterThan(0);
  });

  it("no proposal has a generic fallback label", () => {
    for (const action of actions) {
      expect(action.label).not.toMatch(/^Address: /);
    }
  });

  it("inbox-pressure maps to process_inbox", () => {
    expect(actions.find((a) => a.actionKey === "process_inbox")).toBeDefined();
  });
});

describe("Desired-state gaps map to actions", () => {
  it("desired:orphan-rate maps to connect_orphans", async () => {
    const plan = await new LocalExecutionAdapter(FIXTURE_VAULT, { policyPath: "/nonexistent" })
      .propose({
        session: makeSession(),
        intent: makeIntent(),
        identity: makeIdentity(),
        commitment: makeCommitmentPlan({
          protectedGaps: [makeGap("desired:orphan-rate", ["orphan rate 0.35 vs target 0.15"])],
        }),
        memory: makeMemory(),
      });

    const action = plan.actions.find((a) => a.actionKey === "connect_orphans");
    expect(action).toBeDefined();
    expect(action!.label).toContain("orphan");
  });
});

describe("Metabolic rate", () => {
  it("gracefully handles non-git directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "intent-test-"));
    const report = await measureMetabolicRate(tmp);

    expect(report.systemHealthy).toBe(true);
    expect(report.anomalies).toHaveLength(0);
    for (const space of report.spaces) {
      expect(space.changesWeek).toBe(0);
      expect(space.changesMonth).toBe(0);
    }
  });
});
