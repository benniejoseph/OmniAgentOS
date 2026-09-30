import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRequestTelemetry,
  getObservabilityStats,
  recordRuntimeEvent,
  summarizeObservabilityEvents,
} from "@/lib/observability/store";

describe("observability event ids", () => {
  const telemetryFor = (headers: Record<string, string>) => createRequestTelemetry(
    new Request("https://asael.test/api/agent", { headers }),
    "security",
  );

  it("keeps a well-formed client id and mints one for any other", () => {
    expect(telemetryFor({
      "x-omni-correlation-id": "production-smoke:security:123-abc_1.2",
      "x-vercel-id": "sin1::iad1::abcde-1727654400000-0123456789ab",
    })).toMatchObject({
      correlationId: "production-smoke:security:123-abc_1.2",
      requestId: "sin1::iad1::abcde-1727654400000-0123456789ab",
    });
    expect(telemetryFor({ "x-omni-correlation-id": "c".repeat(128) }).correlationId)
      .toBe("c".repeat(128));

    for (const supplied of ["c".repeat(129), "x".repeat(3_000), "forged id", "a\tb", "id/../other"]) {
      const telemetry = telemetryFor({
        "x-omni-correlation-id": supplied,
        "x-vercel-id": supplied,
      });
      expect(telemetry.requestId).toBeUndefined();
      expect(telemetry.correlationId).toMatch(/^security:[0-9a-f-]{36}$/);
    }
    // A well-formed Vercel id stands in for a malformed client id.
    expect(telemetryFor({
      "x-omni-correlation-id": "x".repeat(3_000),
      "x-vercel-id": "sin1::abcde-1",
    }).correlationId).toBe("sin1::abcde-1");
  });

  it("bounds the indexed fields a request can shape before it records them", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv(
      "OMNIAGENT_DATA_DIR",
      await mkdtemp(path.join(os.tmpdir(), "asael-observability-ids-")),
    );
    try {
      const record = await recordRuntimeEvent({
        category: "security",
        action: "security.auth_failed",
        route: `/api/connectors/${"r".repeat(3_000)}`,
        requestId: `req\n${"q".repeat(3_000)}`,
        correlationId: `corr\r\n${"c".repeat(3_000)}`,
        resourceType: "connector",
        resourceId: `\u0000${"i".repeat(3_000)}`,
        message: "Authentication failed.",
      });

      expect(record).toMatchObject({
        route: `/api/connectors/${"r".repeat(496)}`,
        requestId: `req${"q".repeat(125)}`,
        correlationId: `corr${"c".repeat(124)}`,
        resourceId: "i".repeat(256),
      });
      await expect(recordRuntimeEvent({
        category: "security",
        action: "security.auth_failed",
        correlationId: "\u0000\n ",
        message: "Authentication failed.",
      })).resolves.toMatchObject({
        correlationId: expect.stringMatching(/^security:[0-9a-f-]{36}$/),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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
