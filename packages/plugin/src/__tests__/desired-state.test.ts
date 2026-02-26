/**
 * desired-state.test.ts — Tests for desired-state gap measurement
 */

import { describe, it, expect, beforeAll } from "vitest";
import { loadDesiredState } from "@intent-computer/architecture";
import type { DesiredStateReport } from "@intent-computer/architecture";
import { measureDesiredState } from "../adapters/desired-state.js";
import { FIXTURE_VAULT } from "./helpers.js";

describe("measureDesiredState against fixture vault", () => {
  let report: DesiredStateReport;

  beforeAll(() => {
    const desired = loadDesiredState(FIXTURE_VAULT);
    report = measureDesiredState(FIXTURE_VAULT, desired);
  });

  it("returns a report with metrics", () => {
    expect(report.metrics.length).toBeGreaterThan(0);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(1);
    expect(report.timestamp).toBeTruthy();
  });

  it("measures orphan-rate metric", () => {
    const orphanMetric = report.metrics.find((m) => m.name === "orphan-rate");
    expect(orphanMetric).toBeDefined();
    expect(orphanMetric!.actual).toBeGreaterThan(0);
    expect(orphanMetric!.target).toBe(0.15);
  });

  it("measures schema-compliance metric", () => {
    const schemaMetric = report.metrics.find(
      (m) => m.name === "schema-compliance",
    );
    expect(schemaMetric).toBeDefined();
    expect(schemaMetric!.actual).toBeLessThan(1.0);
    expect(schemaMetric!.target).toBe(0.9);
  });

  it("measures connection-density metric", () => {
    const densityMetric = report.metrics.find(
      (m) => m.name === "connection-density",
    );
    expect(densityMetric).toBeDefined();
    expect(densityMetric!.actual).toBeGreaterThan(0);
    expect(densityMetric!.target).toBe(3.0);
  });

  it("measures description-quality metric", () => {
    const qualityMetric = report.metrics.find(
      (m) => m.name === "description-quality",
    );
    expect(qualityMetric).toBeDefined();
    expect(qualityMetric!.actual).toBeGreaterThan(0);
  });

  it("measures inbox-age metric", () => {
    const inboxMetric = report.metrics.find((m) => m.name === "inbox-age");
    expect(inboxMetric).toBeDefined();
    expect(inboxMetric!.target).toBe(1.0);
  });

  it("each metric has correct structure", () => {
    for (const metric of report.metrics) {
      expect(metric).toHaveProperty("name");
      expect(metric).toHaveProperty("actual");
      expect(metric).toHaveProperty("target");
      expect(metric).toHaveProperty("delta");
      expect(metric).toHaveProperty("met");
      expect(typeof metric.actual).toBe("number");
      expect(typeof metric.target).toBe("number");
      expect(typeof metric.delta).toBe("number");
      expect(typeof metric.met).toBe("boolean");
    }
  });
});
