import { describe, expect, it, vi } from "vitest";
import {
  StudioClient,
  StudioResponseError,
  StudioScopeChanged,
  StudioRequestTimeout,
  readFlow,
  readRun,
  uncertainFailure,
} from "./client";
import { emptyStudioGraph } from "@/lib/studio/contracts";

describe("Studio scoped client", () => {
  it("bounds an ignored transport abort and retries the exact mutation key", async () => {
    const keys: (string | null)[] = [];
    let attempts = 0;
    const transport = vi.fn(async (_path: unknown, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      if (++attempts === 1) return new Promise<Response>(() => {});
      return Response.json({ flow: { id: "one" } });
    });
    const client = new StudioClient(transport as typeof fetch, 10);
    await expect(
      client.post("/flows", { name: "Original" }, "original-key"),
    ).rejects.toBeInstanceOf(StudioRequestTimeout);
    await client.post(
      "/flows",
      { name: "Original" },
      "new-key-must-not-be-used",
    );
    expect(keys).toEqual(["original-key", "original-key"]);
    expect(attempts).toBe(2);
  });
  it("recovers uncertain mutation identity after refresh only for the same owner and body", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    try {
      const first = new StudioClient(
        async () => new Promise<Response>(() => {}),
        10,
        "owner-a",
      );
      await expect(
        first.post("/flows", { name: "Original" }, "original-key"),
      ).rejects.toBeInstanceOf(StudioRequestTimeout);
      let key: string | null = null;
      const transport = async (_path: unknown, init?: RequestInit) => {
        key = new Headers(init?.headers).get("idempotency-key");
        return Response.json({ flow: { id: "one" } });
      };
      await new StudioClient(transport as typeof fetch, 100, "owner-b").post(
        "/flows",
        { name: "Original" },
        "other-owner-key",
      );
      expect(key).toBe("other-owner-key");
      await new StudioClient(transport as typeof fetch, 100, "owner-a").post(
        "/flows",
        { name: "Original" },
        "new-key",
      );
      expect(key).toBe("original-key");
      expect(storage.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rejects a late response after owner disposal, even if transport ignores abort", async () => {
    let finish!: (value: Response) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const client = new StudioClient(transport as typeof fetch);
    const request = client.json("/api/studio/flows");
    client.dispose();
    finish(Response.json({ flows: [] }));
    await expect(request).rejects.toBeInstanceOf(StudioScopeChanged);
    expect(transport.mock.calls).toHaveLength(1);
  });
  it("freezes the submission before yielding and preserves the caller's retry key", async () => {
    const requests: { body: string; key: string | null }[] = [];
    const transport = vi.fn(async (_path: unknown, init?: RequestInit) => {
      requests.push({
        body: String(init?.body),
        key: new Headers(init?.headers).get("idempotency-key"),
      });
      return Response.json({ run: { id: "r" } });
    });
    const client = new StudioClient(transport as typeof fetch);
    const body = { quoteId: "quote-a", maxGenerations: 2 };
    const first = client.post("/runs", body, "attempt-a");
    body.maxGenerations = 99;
    await first;
    await client.post(
      "/runs",
      { quoteId: "quote-a", maxGenerations: 2 },
      "attempt-a",
    );
    expect(requests[0]).toEqual(requests[1]);
    expect(JSON.parse(requests[0].body).maxGenerations).toBe(2);
    expect(requests[0].key).toBe("attempt-a");
  });
  it("retains revision conflict detail instead of accepting the save", async () => {
    const client = new StudioClient(async () =>
      Response.json(
        { code: "studio_revision_conflict", error: "Newer revision exists" },
        { status: 409 },
      ),
    );
    await expect(
      client.json("/flow", { method: "PATCH" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Newer revision exists",
      body: { code: "studio_revision_conflict" },
    });
  });
  it("distinguishes transport uncertainty from a rejected request", () => {
    expect(uncertainFailure(new TypeError("Network unavailable"))).toBe(true);
    expect(uncertainFailure(new StudioResponseError("unavailable", 503))).toBe(
      true,
    );
    expect(
      uncertainFailure(new StudioResponseError("invalid quote", 422)),
    ).toBe(false);
  });
  it("rejects malformed saved graph and a different flow's run", () => {
    expect(() =>
      readFlow({
        id: "a",
        name: "a",
        revision: 1,
        graph: { nodes: [] },
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    ).toThrow();
    expect(() =>
      readRun(
        {
          id: "r",
          flowId: "different",
          nodes: [],
          graph: emptyStudioGraph(),
          status: "running",
        },
        "expected",
      ),
    ).toThrow();
  });
});
