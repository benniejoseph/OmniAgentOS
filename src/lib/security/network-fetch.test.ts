import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const undiciMocks = vi.hoisted(() => ({
  agentOptions: [] as unknown[],
  fetch: vi.fn(),
}));

vi.mock("undici", () => ({
  Agent: class MockAgent {
    constructor(options: unknown) {
      undiciMocks.agentOptions.push(options);
    }
  },
  fetch: undiciMocks.fetch,
}));

import { fetchPublicHttpUrl } from "@/lib/security/network";

describe("fetchPublicHttpUrl transport pairing", () => {
  beforeEach(() => {
    undiciMocks.fetch.mockReset().mockResolvedValue(new Response("ok"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses npm Undici fetch with its matching Agent instead of global fetch", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("invalid onRequestStart method"), {
          code: "UND_ERR_INVALID_ARG",
        }),
      }),
    );

    await expect(
      fetchPublicHttpUrl("https://93.184.216.34/mcp"),
    ).resolves.toBeInstanceOf(Response);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(undiciMocks.fetch).toHaveBeenCalledOnce();
    expect(undiciMocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      redirect: "manual",
    });
    expect(undiciMocks.agentOptions[0]).toMatchObject({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 1_000,
    });
  });

  it("preserves a Request method, headers, and body across the fetch boundary", async () => {
    const request = new Request("https://93.184.216.34/mcp", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-request-source": "regression",
      },
      body: "request-body",
    });

    await fetchPublicHttpUrl(request);

    const [input, init] = undiciMocks.fetch.mock.calls[0] as [
      string,
      { body?: BodyInit; headers?: Array<[string, string]>; method?: string; duplex?: string },
    ];
    expect(input).toBe("https://93.184.216.34/mcp");
    expect(init.method).toBe("POST");
    expect(init.duplex).toBe("half");
    expect(init.headers).toEqual([
      ["content-type", "text/plain"],
      ["x-request-source", "regression"],
    ]);
    await expect(new Response(init.body).text()).resolves.toBe("request-body");
  });
});
