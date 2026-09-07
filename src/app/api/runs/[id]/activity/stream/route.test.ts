import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  inspectRunActivityService: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));

vi.mock("@/lib/app-services/runs", () => ({
  inspectRunActivityService: mocks.inspectRunActivityService,
}));

import { GET } from "@/app/api/runs/[id]/activity/stream/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
});

describe("run browser activity stream", () => {
  it("pushes fresh activity without a client refresh and then labels replay", async () => {
    vi.useFakeTimers();
    mocks.inspectRunActivityService
      .mockResolvedValueOnce({
        data: { runId: "run-a", status: "running", browserActivity: [] },
      })
      .mockResolvedValueOnce({
        data: {
          runId: "run-a",
          status: "completed",
          browserActivity: [{
            id: "execution-a",
            sequence: 1,
            at: "2026-09-07T00:00:00.000Z",
            action: "Open website",
            operation: "browser_navigate",
            status: "executed",
            summary: "Completed through the governed Playwright connection.",
          }],
        },
      });

    try {
      const response = await getStream("run-a");
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"mode":"live"');

      const next = reader.read();
      await vi.advanceTimersByTimeAsync(1_000);
      const second = await next;
      expect(new TextDecoder().decode(second.value)).toContain('"mode":"replay"');
      expect(new TextDecoder().decode(second.value)).toContain('"id":"execution-a"');
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes a private terminal replay snapshot and closes", async () => {
    mocks.inspectRunActivityService.mockResolvedValue({
      data: {
        runId: "run-a",
        status: "completed",
        browserActivity: [{
          id: "execution-a",
          sequence: 1,
          at: "2026-09-07T00:00:00.000Z",
          action: "Open website",
          operation: "browser_navigate",
          status: "executed",
          summary: "Completed through the governed Playwright connection.",
        }],
      },
    });

    const response = await getStream("run-a");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(body).toContain("event: browser_activity");
    expect(body).toContain('"mode":"replay"');
    expect(body).toContain('"id":"execution-a"');
  });

  it("returns a private not-found response without opening a stream", async () => {
    mocks.inspectRunActivityService.mockResolvedValue({
      data: { runId: "missing", status: null, browserActivity: [] },
    });

    const response = await getStream("missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

function getStream(runId: string) {
  return GET(
    new Request(`http://localhost/api/runs/${runId}/activity/stream`),
    { params: Promise.resolve({ id: runId }) },
  );
}
