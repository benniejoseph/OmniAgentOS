import { describe, expect, it } from "vitest";
import {
  appendServerTiming,
  formatServerTimingHeader,
  measureRequestStage,
  recordDatabaseTiming,
  runWithRequestTiming,
} from "@/lib/observability/request-timing";

describe("request timing", () => {
  it("formats bounded stage and query details for Server-Timing", () => {
    expect(
      formatServerTimingHeader({
        totalMs: 125.24,
        authMs: 20.01,
        auditMs: 5.2,
        processingMs: 100.03,
        databaseMs: 12.34,
        databaseQueryCount: 2,
        databaseWriteCount: 1,
      }),
    ).toBe(
      'total;dur=125.2, auth;dur=20.0, db;dur=12.3;desc="2 queries; 1 write", audit;dur=5.2, processing;dur=100.0',
    );
  });

  it("adds timing headers only inside a request scope", async () => {
    const response = await runWithRequestTiming(async () => {
      await measureRequestStage("auth", async () => undefined);
      recordDatabaseTiming(4.5, true);
      return appendServerTiming(Response.json({ ok: true }));
    });

    expect(response.headers.get("server-timing")).toContain("auth;dur=");
    expect(response.headers.get("server-timing")).toContain(
      'db;dur=4.5;desc="1 query; 1 write"',
    );
    expect(response.headers.get("x-omni-db-queries")).toBe("1");
    expect(response.headers.get("x-omni-db-writes")).toBe("1");
    expect(
      appendServerTiming(Response.json({ ok: true })).headers.has(
        "server-timing",
      ),
    ).toBe(false);
  });
});
