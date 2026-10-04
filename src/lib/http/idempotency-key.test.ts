import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  IdempotencyKeyError,
  requireIdempotencyKey,
} from "@/lib/http/idempotency-key";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "admin",
  source: "session",
};
const routeContext = { params: Promise.resolve({ id: "item-a" }) };

// Exports in a route that uses the request mutation caller but whose own
// handler does not.
const UNKEYED_ROUTE_EXPORTS = new Set([
  "src/app/api/capture/recordings/[id]/route.ts PATCH",
  "src/app/api/connectors/[id]/route.ts PATCH",
  "src/app/api/openapi-connectors/[id]/route.ts PATCH",
  "src/app/api/memory/personal-context-consent/route.ts POST",
  "src/app/api/memory/personal-context-consent/route.ts DELETE",
]);

// This shared route retains its unkeyed legacy web envelope. Its strict native
// contract branch validates the standard key before authorization; route tests
// also verify missing keys and mobile legacy-envelope rejection behavior.
const CONTRACT_KEYED_ROUTE_EXPORTS = new Set([
  "src/app/api/memory/reconciliation/route.ts PATCH",
  "src/app/api/capture/recordings/[id]/complete/route.ts POST",
]);

function request(method: string, headers: Record<string, string> = {}) {
  return new Request("http://asael.test/api/items/item-a", { method, headers });
}

describe("client idempotency keys", () => {
  it("refuses a change without a valid key before its handler runs", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const guarded = requireIdempotencyKey(handler);

    for (const headers of [
      {},
      { "x-request-id": "request-1" },
      { "x-idempotency-key": "legacy-key" },
      { "idempotency-key": "   " },
    ] as Record<string, string>[]) {
      const response = await guarded(request("POST", headers), routeContext);
      expect(response.status, JSON.stringify(headers)).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: "Invalid request",
        message: "An Idempotency-Key header is required for this change.",
      });
    }
    for (const key of ["has space", "-leading-dash", "k".repeat(513)]) {
      const response = await guarded(
        request("DELETE", { "idempotency-key": key }),
        routeContext,
      );
      expect(response.status, key).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        message: "Idempotency-Key must be an opaque identifier of 512 characters or fewer.",
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes a keyed change and a read to the handler unchanged", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }));
    const guarded = requireIdempotencyKey(handler);
    const change = request("PATCH", { "idempotency-key": "change-1" });
    const read = request("GET");

    expect((await guarded(change, routeContext)).status).toBe(201);
    expect((await guarded(read, routeContext)).status).toBe(201);
    expect(handler.mock.calls).toEqual([
      [change, routeContext],
      [read, routeContext],
    ]);
  });

  it("keys and correlates a change only by the client's key", () => {
    const caller = createRequestMutationAppServiceCaller(
      request("POST", {
        "idempotency-key": " change-1 ",
        "x-request-id": "attempt-1",
      }),
      context,
      { purpose: "test.change" },
    );
    expect(caller.idempotencyKey).toBe("change-1");
    expect(caller.executionScope?.correlationId).toBe("change-1");

    const longKey = "k".repeat(300);
    const correlations = ["attempt-1", "attempt-2"].map((requestId) =>
      createRequestMutationAppServiceCaller(
        request("DELETE", { "idempotency-key": longKey, "x-request-id": requestId }),
        context,
        { purpose: "test.change" },
      ).executionScope?.correlationId);
    expect(correlations[0]).toMatch(/^idempotency-key:[0-9a-f]{64}$/);
    expect(correlations[1]).toBe(correlations[0]);
    const longestKey = "k".repeat(256);
    expect(createRequestMutationAppServiceCaller(
      request("POST", { "idempotency-key": longestKey }),
      context,
      { purpose: "test.change" },
    ).executionScope?.correlationId).toBe(longestKey);
    expect(createRequestMutationAppServiceCaller(
      request("POST", { "idempotency-key": `${longestKey}k` }),
      context,
      { purpose: "test.change" },
    ).executionScope?.correlationId).toMatch(/^idempotency-key:/);

    for (const headers of [
      {},
      { "x-request-id": "attempt-1" },
      { "x-idempotency-key": "legacy-key" },
    ] as Record<string, string>[]) {
      expect(() => createRequestMutationAppServiceCaller(
        request("POST", headers),
        context,
        { purpose: "test.change" },
      ), JSON.stringify(headers)).toThrow(IdempotencyKeyError);
    }
  });

  it("gives a read a correlation id but no key", () => {
    const traced = createRequestMutationAppServiceCaller(
      request("GET", { "x-request-id": "read-1" }),
      context,
      { purpose: "test.read" },
    );
    expect(traced.idempotencyKey).toBeUndefined();
    expect(traced.executionScope?.correlationId).toBe("read-1");
    const longestRequestId = "r".repeat(256);
    expect(createRequestMutationAppServiceCaller(
      request("GET", { "x-request-id": longestRequestId }),
      context,
      { purpose: "test.read" },
    ).executionScope?.correlationId).toBe(longestRequestId);

    for (const headers of [{}, { "x-request-id": "r".repeat(257) }] as Record<string, string>[]) {
      const untraced = createRequestMutationAppServiceCaller(
        request("GET", headers),
        context,
        { purpose: "test.read" },
      );
      expect(untraced.idempotencyKey).toBeUndefined();
      expect(untraced.executionScope?.correlationId).toMatch(/^app_[0-9a-f-]{36}$/);
    }
  });

  it("guards every change in a route that uses the request mutation caller", async () => {
    const root = process.cwd();
    const routes = (await routeFiles(resolve(root, "src/app/api")))
      .map((file) => relative(root, file));
    const unguarded: string[] = [];
    const exempt: string[] = [];
    const contractGuarded: string[] = [];
    let guarded = 0;
    for (const route of routes) {
      const source = await readFile(resolve(root, route), "utf8");
      if (!source.includes("createRequestMutationAppServiceCaller(")) continue;
      const exports = source.matchAll(
        /^export (?:const|async function|function) (POST|PUT|PATCH|DELETE)\b.*$/gm,
      );
      for (const [line, method] of exports) {
        const name = `${route} ${method}`;
        if (UNKEYED_ROUTE_EXPORTS.has(name)) {
          exempt.push(name);
        } else if (CONTRACT_KEYED_ROUTE_EXPORTS.has(name)) {
          const branch = source.indexOf('if ("contract" in parsed.data) {');
          const key = source.indexOf("requiredRequestIdempotencyKey(request)", branch);
          const authorization = source.indexOf("authorizeRequest({", branch);
          const mutation = source.indexOf("createRequestMutationAppServiceCaller(", branch);
          expect(branch, name).toBeGreaterThanOrEqual(0);
          expect(key, name).toBeGreaterThan(branch);
          expect(authorization, name).toBeGreaterThan(key);
          expect(mutation, name).toBeGreaterThan(authorization);
          expect(source.slice(key, authorization), name).toContain("idempotencyKeyErrorResponse(error)");
          contractGuarded.push(name);
        } else if (line.includes("requireIdempotencyKey(")) {
          guarded += 1;
        } else {
          unguarded.push(name);
        }
      }
    }

    expect(unguarded).toEqual([]);
    expect(exempt.sort()).toEqual([...UNKEYED_ROUTE_EXPORTS].sort());
    expect(contractGuarded.sort()).toEqual([...CONTRACT_KEYED_ROUTE_EXPORTS].sort());
    expect(guarded).toBeGreaterThanOrEqual(69);
  });
});

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return Promise.resolve(entry.name === "route.ts" ? [path] : []);
  }));
  return nested.flat();
}
