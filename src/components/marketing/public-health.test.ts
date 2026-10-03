import { describe, expect, it } from "vitest";
import { parsePublicHealth } from "./public-health";

describe("public health snapshot", () => {
  it("accepts only known status and HTTP combinations, including the route's unhealthy 503", () => {
    for (const status of ["healthy", "degraded", "unhealthy"] as const) expect(parsePublicHealth(200, { status })).toEqual({ status });
    expect(parsePublicHealth(503, { status: "unhealthy" })).toEqual({ status: "unhealthy" });
    for (const code of [400, 401, 403, 404, 500, 503]) expect(parsePublicHealth(code, { status: "healthy" })).toEqual({ status: "unavailable" });
    for (const body of [null, [], {}, { status: "unknown" }, { status: true }]) expect(parsePublicHealth(200, body)).toEqual({ status: "unavailable" });
  });
  it("projects a valid exact timestamp and excludes private or malformed metadata", () => {
    const checkedAt = "2026-10-04T10:00:00.000Z";
    expect(parsePublicHealth(200, { status: "healthy", checkedAt, dependencies: { secret: "omit" }, requestId: "private" })).toEqual({ status: "healthy", checkedAt });
    for (const value of ["bad", "2026-02-30T00:00:00.000Z", "2026-01-01T25:00:00.000Z", "", null]) expect(parsePublicHealth(200, { status: "healthy", checkedAt: value })).toEqual({ status: "healthy" });
  });
});
