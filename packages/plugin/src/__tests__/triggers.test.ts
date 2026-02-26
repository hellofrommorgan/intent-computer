/**
 * triggers.test.ts — Unit and integration tests for the quality trigger battery
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runTriggerBattery } from "../adapters/triggers.js";
import type { TriggerReport } from "@intent-computer/architecture";
import { FIXTURE_VAULT } from "./helpers.js";

describe("Trigger battery against fixture vault", () => {
  let report: TriggerReport;

  beforeAll(async () => {
    report = await runTriggerBattery(FIXTURE_VAULT);
  });

  it("runs all triggers and returns a report", () => {
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.summary.total).toBe(report.results.length);
    expect(report.summary.passed + report.summary.warned + report.summary.failed).toBe(
      report.summary.total,
    );
    expect(report.passRate).toBeGreaterThanOrEqual(0);
    expect(report.passRate).toBeLessThanOrEqual(1);
  });

  it("thought-two triggers schema-required-fields failure (missing description)", () => {
    const schemaResult = report.results.find(
      (r) =>
        r.name === "schema-required-fields" &&
        r.target?.includes("the anxiety before speaking"),
    );
    expect(schemaResult).toBeDefined();
    expect(schemaResult!.severity).toBe("fail");
    expect(schemaResult!.message).toContain("description");
  });

  it("thought-one passes schema-required-fields", () => {
    const schemaResult = report.results.find(
      (r) =>
        r.name === "schema-required-fields" &&
        r.target?.includes("morning routine breaks"),
    );
    expect(schemaResult).toBeDefined();
    expect(schemaResult!.severity).toBe("pass");
  });

  it("thought-one passes link-minimum (has 2+ wiki-links)", () => {
    const linkResult = report.results.find(
      (r) =>
        r.name === "link-minimum" && r.target?.includes("morning routine breaks"),
    );
    expect(linkResult).toBeDefined();
    expect(linkResult!.severity).toBe("pass");
  });

  it("title-composability passes on prose-claim filenames", () => {
    const titleResults = report.results.filter(
      (r) => r.name === "title-composability",
    );
    expect(titleResults.length).toBeGreaterThan(0);

    const passing = titleResults.filter((r) => r.severity === "pass");
    expect(passing.length).toBeGreaterThan(0);
  });

  it("integration: checks orphan-rate across the vault graph", () => {
    const orphanResult = report.results.find((r) => r.name === "orphan-rate");
    expect(orphanResult).toBeDefined();
    expect(orphanResult!.scope).toBe("integration");
    expect(orphanResult!.message).toContain("orphan rate");
  });

  it("integration: checks connection-density", () => {
    const densityResult = report.results.find(
      (r) => r.name === "connection-density",
    );
    expect(densityResult).toBeDefined();
    expect(densityResult!.scope).toBe("integration");
  });

  it("integration: checks dangling-links", () => {
    const danglingResult = report.results.find(
      (r) => r.name === "dangling-links",
    );
    expect(danglingResult).toBeDefined();
    expect(danglingResult!.scope).toBe("integration");
  });

  it("integration: checks moc-coverage", () => {
    const mocResult = report.results.find((r) => r.name === "moc-coverage");
    expect(mocResult).toBeDefined();
    expect(mocResult!.scope).toBe("integration");
  });

  it("trends are computed (stable with no history)", () => {
    expect(Array.isArray(report.trends)).toBe(true);
    for (const trend of report.trends) {
      expect(trend.direction).toBe("stable");
    }
  });

  it("no regressions with no history", () => {
    expect(report.regressions).toHaveLength(0);
  });
});
