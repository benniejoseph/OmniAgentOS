import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discardSmokeResponseBody,
  smokeFetch,
} from "../../../scripts/smoke-helpers.mjs";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all([...servers].map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
  }));
});

describe("smoke transport retry", () => {
  it("consumes bounded status-only bodies so sequential checks release connections", async () => {
    const response = new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

    await expect(discardSmokeResponseBody(response, {
      label: "anonymous memory read",
      maxBytes: 1_000,
    })).resolves.toBeUndefined();
    expect(response.bodyUsed).toBe(true);

    await expect(discardSmokeResponseBody(
      new Response("too large", {
        headers: { "content-length": "100" },
      }),
      { label: "oversized probe", maxBytes: 10 },
    )).rejects.toThrow("oversized probe returned an unexpectedly large response body");

    await expect(discardSmokeResponseBody(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      })),
      { label: "chunked probe", maxBytes: 10 },
    )).rejects.toThrow("chunked probe returned an unexpectedly large response body");
  });

  it("retries one fast reset for an opted-in GET", async () => {
    let requests = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseUrl = await listen((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.socket?.destroy();
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
    });

    const response = await smokeFetch(baseUrl, "/api/memory", {
      retryTransport: true,
      timeoutMs: 2_000,
    });

    expect(response.status).toBe(401);
    expect(requests).toBe(2);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0][0]))).toMatchObject({
      level: "warn",
      event: "smoke.transport_retry",
      method: "GET",
      path: "/api/memory",
      code: "UND_ERR_SOCKET",
      attempt: 1,
      maximumAttempts: 2,
    });
  });

  it("fails closed after one retry and redacts query parameters", async () => {
    let requests = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseUrl = await listen((_request, response) => {
      requests += 1;
      response.socket?.destroy();
    });

    await expect(smokeFetch(
      baseUrl,
      "/api/memory?token=DO_NOT_PRINT",
      { retryTransport: true, timeoutMs: 2_000 },
    )).rejects.toThrow(
      /GET \/api\/memory failed after 2 attempt\(s\).+code=UND_ERR_SOCKET/,
    );
    let diagnostic = "";
    try {
      await smokeFetch(
        baseUrl,
        "/api/memory?token=DO_NOT_PRINT",
        { retryTransport: false, timeoutMs: 2_000 },
      );
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    expect(diagnostic).not.toContain("DO_NOT_PRINT");
    expect(requests).toBe(3);
  });

  it("does not retry a request that hangs until its overall deadline", async () => {
    let requests = 0;
    const baseUrl = await listen(() => {
      requests += 1;
    });

    const startedAt = Date.now();
    await expect(smokeFetch(baseUrl, "/api/memory", {
      retryTransport: true,
      timeoutMs: 75,
    })).rejects.toThrow(
      /failed after 1 attempt\(s\).+timeout 75ms; code=TIMEOUT/,
    );

    expect(requests).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("uses the original deadline for the retry attempt", async () => {
    let requests = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseUrl = await listen((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.socket?.destroy();
      }
    });

    const startedAt = Date.now();
    await expect(smokeFetch(baseUrl, "/api/memory", {
      retryTransport: true,
      timeoutMs: 750,
    })).rejects.toThrow(
      /failed after 2 attempt\(s\).+timeout 750ms; code=TIMEOUT/,
    );

    expect(requests).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("does not retry an allowlisted transport failure that arrives slowly", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_001));
      throw socketResetError();
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = smokeFetch("https://smoke.invalid", "/api/memory", {
      retryTransport: true,
      timeoutMs: 30_000,
    });
    const assertion = expect(request).rejects.toThrow(
      /failed after 1 attempt\(s\) in 10001ms.+code=UND_ERR_SOCKET/,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an explicit abort", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(smokeFetch(
      "https://smoke.invalid",
      "/api/memory",
      { retryTransport: true, timeoutMs: 2_000 },
    )).rejects.toThrow(
      /failed after 1 attempt\(s\).+code=ABORTED/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an HTTP failure without retrying it", async () => {
    let requests = 0;
    const baseUrl = await listen((_request, response) => {
      requests += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unavailable" }));
    });

    const response = await smokeFetch(baseUrl, "/api/memory", {
      retryTransport: true,
      timeoutMs: 2_000,
    });

    expect(response.status).toBe(503);
    expect(requests).toBe(1);
  });

  it("never retries a mutation after a transport reset", async () => {
    let requests = 0;
    const baseUrl = await listen((_request, response) => {
      requests += 1;
      response.socket?.destroy();
    });

    await expect(smokeFetch(baseUrl, "/api/memory", {
      method: "POST",
      body: "{}",
      retryTransport: true,
      timeoutMs: 2_000,
    })).rejects.toThrow(
      /POST \/api\/memory failed after 1 attempt\(s\).+code=UND_ERR_SOCKET/,
    );
    expect(requests).toBe(1);
  });

  it("keeps every security request under 30 seconds and opts in reads only", async () => {
    const source = await readFile("scripts/smoke-security.mjs", "utf8");

    expect(source).toContain("const SECURITY_REQUEST_TIMEOUT_MS = 30_000;");
    expect(source).toContain("timeoutMs: SECURITY_REQUEST_TIMEOUT_MS");
    expect(source).toContain(
      'retryTransport: method === "GET" || method === "HEAD"',
    );
    expect(source).toContain("await discardResponseBody(response, label)");
    expect(source).toContain("await discardSmokeResponseBody(response, { label })");
  });
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Smoke test server did not expose a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function socketResetError() {
  const error = new TypeError("fetch failed");
  Object.defineProperty(error, "cause", {
    value: Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    }),
  });
  return error;
}
