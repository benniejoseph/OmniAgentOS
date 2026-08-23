import { describe, expect, it, vi } from "vitest";
import {
  getObservabilityStats,
  summarizeObservabilityEvents,
} from "@/lib/observability/store";

describe("observability summaries", () => {
  it("derives SLO and failure statistics from an existing event window", () => {
    const stats = summarizeObservabilityEvents([
      {
        id: "one",
        level: "info",
        category: "api",
        action: "request.ok",
        route: "/api/one",
        statusCode: 200,
        durationMs: 100,
        correlationId: "one",
        message: "ok",
        metadata: {},
        createdAt: "2026-08-23T00:00:00.000Z",
      },
      {
        id: "two",
        level: "error",
        category: "connector",
        action: "connector.request_failed",
        route: "/api/two",
        statusCode: 500,
        durationMs: 900,
        correlationId: "two",
        message: "failed",
        metadata: { failureType: "connector_failure" },
        createdAt: "2026-08-23T00:00:01.000Z",
      },
    ]);

    expect(stats).toMatchObject({
      total: 2,
      routeFailures: 1,
      connectorFailures: 1,
      averageDurationMs: 500,
      p95DurationMs: 900,
      slo: {
        availability: 0.5,
        errorRate: 0.5,
      },
    });
  });

  it("aggregates the complete indexed time window instead of a row cap", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://example.invalid/omniagent");
    const query = vi.fn().mockResolvedValue([
      {
        total: 750,
        slo_eligible_events: 700,
        slo_excluded_events: 50,
        synthetic_events: 20,
        auth_failures: 2,
        authentication_challenges: 3,
        policy_blocks: 4,
        connector_failures: 5,
        route_failures: 7,
        failure_count: 10,
        route_count: 500,
        average_duration_ms: 180,
        p95_duration_ms: 420,
        by_level: { info: 730, error: 20 },
        by_category: { api: 750 },
        latest: [],
        recent_errors: [],
      },
    ]);
    try {
      const stats = await getObservabilityStats({
        tenantId: "tenant-window",
        sql: { query } as never,
      });
      expect(query.mock.calls[0][0]).toContain("created_at >= $2");
      expect(query.mock.calls[0][0]).not.toContain("LIMIT 500");
      expect(stats).toMatchObject({
        total: 750,
        sloEligibleEvents: 700,
        routeFailures: 7,
        p95DurationMs: 420,
        slo: {
          availability: 0.986,
          errorRate: 10 / 700,
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
