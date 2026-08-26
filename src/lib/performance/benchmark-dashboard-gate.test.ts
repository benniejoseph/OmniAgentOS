import { describe, expect, it } from "vitest";
import {
  evaluateDashboardReleaseGate,
  nearestRankPercentile,
} from "../../../scripts/benchmark-dashboard-gate.mjs";

const budgets = {
  firstLoadMs: 4_000,
  hotP50Ms: 1_500,
  hotP95Ms: 2_500,
  hotMaxMs: 5_000,
  documentP95Ms: 500,
};

describe("dashboard release gate", () => {
  it("uses nearest-rank percentiles without mistaking n=20 p95 for max", () => {
    expect(nearestRankPercentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(
      nearestRankPercentile(
        Array.from({ length: 20 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(19);
  });

  it("fails a catastrophic maximum even when hot p50 and p95 pass", () => {
    const result = evaluateDashboardReleaseGate({
      firstLoad: measurement(2_000, 300),
      hotMeasurements: [
        ...Array.from({ length: 19 }, () => measurement(1_000, 300)),
        measurement(6_000, 300),
      ],
      warmups: 2,
      minimumSamples: 20,
      budgets,
    });

    expect(result.p50Ms).toBe(1_000);
    expect(result.p95Ms).toBe(1_000);
    expect(result.maxMs).toBe(6_000);
    expect(result.checks).toMatchObject({
      hotP50: true,
      hotP95: true,
      hotMax: false,
    });
    expect(result.passed).toBe(false);
  });

  it("fails an over-budget first load despite healthy hot samples", () => {
    const result = evaluateDashboardReleaseGate({
      firstLoad: measurement(4_001, 300),
      hotMeasurements: healthyMeasurements(),
      warmups: 2,
      minimumSamples: 20,
      budgets,
    });

    expect(result.checks.firstLoad).toBe(false);
    expect(result.checks.hotP95).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("enforces the warm p50 independently from the looser p95 and max", () => {
    const result = evaluateDashboardReleaseGate({
      firstLoad: measurement(2_000, 300),
      hotMeasurements: [
        ...Array.from({ length: 9 }, () => measurement(1_000, 300)),
        ...Array.from({ length: 11 }, () => measurement(1_600, 300)),
      ],
      warmups: 2,
      minimumSamples: 20,
      budgets,
    });

    expect(result.p50Ms).toBe(1_600);
    expect(result.checks).toMatchObject({
      hotP50: false,
      hotP95: true,
      hotMax: true,
    });
    expect(result.passed).toBe(false);
  });

  it("requires every hot sample to meet the document-response p95 gate", () => {
    const result = evaluateDashboardReleaseGate({
      firstLoad: measurement(2_000, 300),
      hotMeasurements: Array.from({ length: 20 }, () =>
        measurement(1_000, 501),
      ),
      warmups: 2,
      minimumSamples: 20,
      budgets,
    });

    expect(result.documentDurationsMs).toHaveLength(20);
    expect(result.documentP95Ms).toBe(501);
    expect(result.checks.documentP95).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("rejects missing NavigationTiming evidence", () => {
    const samples = healthyMeasurements();
    const missingDocumentTiming = {
      durationMs: samples[0].durationMs,
    };
    expect(() =>
      evaluateDashboardReleaseGate({
        firstLoad: measurement(2_000, 300),
        hotMeasurements: [missingDocumentTiming, ...samples.slice(1)],
        warmups: 2,
        minimumSamples: 20,
        budgets,
      }),
    ).toThrow("documentResponseMs");
  });

  it("reports partial Server-Timing coverage without using it as a gate", () => {
    const result = evaluateDashboardReleaseGate({
      firstLoad: measurement(2_000, 300),
      hotMeasurements: Array.from({ length: 20 }, (_, index) =>
        measurement(1_000, 300, index < 10 ? 200 : undefined),
      ),
      warmups: 2,
      minimumSamples: 20,
      budgets,
    });

    expect(result.serverTiming).toMatchObject({
      coverage: "partial",
      samples: 10,
      p95Ms: 200,
    });
    expect(result).toMatchObject({
      samples: 20,
      minimumSamples: 20,
      warmups: 2,
      budgets,
    });
    expect(result.hotDurationsMs).toHaveLength(20);
    expect(result.documentDurationsMs).toHaveLength(20);
    expect(result.passed).toBe(true);
  });

  it("fails closed when an enforced run contains fewer than 20 hot samples", () => {
    const result = evaluateDashboardReleaseGate({
      firstLoad: measurement(2_000, 300),
      hotMeasurements: healthyMeasurements().slice(0, 19),
      warmups: 2,
      minimumSamples: 20,
      budgets,
    });

    expect(result.checks.sampleCount).toBe(false);
    expect(result.passed).toBe(false);
  });
});

function healthyMeasurements() {
  return Array.from({ length: 20 }, () => measurement(1_000, 300));
}

function measurement(
  durationMs: number,
  documentResponseMs: number,
  serverDurationMs?: number,
) {
  return {
    durationMs,
    documentResponseMs,
    ...(serverDurationMs === undefined ? {} : { serverDurationMs }),
  };
}
