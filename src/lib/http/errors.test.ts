import { afterEach, describe, expect, it, vi } from "vitest";
import { isServerFailure, serverErrorResponse } from "@/lib/http/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function captureLog() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => {
    expect(spy).toHaveBeenCalledTimes(1);
    return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serverErrorResponse", () => {
  it("answers with a fixed message and logs the detail under its id", async () => {
    const logged = captureLog();
    const error = Object.assign(
      new Error("relation \"secrets\" failed at postgres://owner:pw@db.internal/app"),
      { code: "57P01" },
    );

    const response = serverErrorResponse(error, {
      message: "Memory write failed",
      request: new Request("https://asael.test/api/memory?x=1", {
        method: "POST",
        headers: { "x-vercel-id": "bom1::abc12-1700000000000-0f" },
      }),
      body: { stored: true, error: "overridden", code: "overridden" },
      headers: { "cache-control": "public, max-age=60", "retry-after": "5" },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toEqual({
      stored: true,
      error: "Memory write failed",
      code: "internal_error",
      requestId: expect.stringMatching(UUID),
    });
    expect(JSON.stringify(body)).not.toContain("relation");
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("5");

    const entry = logged();
    expect(entry).toMatchObject({
      level: "error",
      event: "api.server_error",
      requestId: body.requestId,
      status: 500,
      code: "internal_error",
      method: "POST",
      route: "/api/memory",
      platformRequestId: "bom1::abc12-1700000000000-0f",
      error: {
        name: "Error",
        message: "relation \"secrets\" failed at [redacted-connection-url]",
        code: "57P01",
      },
    });
    expect(String((entry.error as { stack?: unknown }).stack)).toContain(
      "errors.test.ts",
    );
    expect(JSON.stringify(entry)).not.toContain("owner:pw");
  });

  it("names each server status with its own code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const codes = await Promise.all(
      ([500, 502, 503, 504] as const).map(async (status) => {
        const response = serverErrorResponse(new Error("x"), {
          message: "Failed",
          status,
        });
        expect(response.status).toBe(status);
        return (await response.json() as { code: string }).code;
      }),
    );
    const custom = serverErrorResponse(new Error("x"), {
      message: "Failed",
      status: 503,
      code: "storage_unavailable",
    });

    expect(codes).toEqual([
      "internal_error",
      "upstream_failed",
      "unavailable",
      "timeout",
    ]);
    expect(await custom.json()).toMatchObject({ code: "storage_unavailable" });
  });

  it("logs a thrown value that is not an error and skips a forged id", () => {
    const logged = captureLog();

    serverErrorResponse("socket hang up", {
      message: "Failed",
      request: new Request("https://asael.test/api/x", {
        headers: { "x-vercel-id": "bad id <forged>" },
      }),
    });

    const entry = logged();
    expect(entry.error).toEqual({ thrown: "socket hang up" });
    expect(entry).toMatchObject({ method: "GET", route: "/api/x" });
    expect(entry).not.toHaveProperty("platformRequestId");
  });
});

describe("isServerFailure", () => {
  it("tells database and host failures from request errors", () => {
    const postgres = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    postgres.name = "PostgresError";
    const host = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
      syscall: "open",
    });
    const dropped = Object.assign(new Error("write CONNECTION_CLOSED db:5432"), {
      code: "CONNECTION_CLOSED",
    });

    expect([postgres, host, dropped].map(isServerFailure)).toEqual([
      true,
      true,
      true,
    ]);
    expect(isServerFailure(new Error("Trash item not found."))).toBe(false);
    expect(
      isServerFailure(Object.assign(new Error("Bad key"), { code: "23505" })),
    ).toBe(false);
    expect(isServerFailure({ name: "PostgresError", message: "x" })).toBe(false);
  });
});
