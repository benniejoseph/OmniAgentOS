import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunEventRecord, AgentRunRecord } from "@/lib/runs/types";

const mocks = vi.hoisted(() => ({
  getAgentRun: vi.fn(),
  listAgentRunEventsAfter: vi.fn(),
}));

vi.mock("@/lib/runs/store", () => ({
  getAgentRun: mocks.getAgentRun,
  listAgentRunEventsAfter: mocks.listAgentRunEventsAfter,
}));

import {
  agentRunTailResponse,
  parseRunEventCursor,
} from "@/lib/runs/event-tail";

const TENANT_ID = "tenant-tail";
const RUN_ID = "run-tail";

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: RUN_ID,
    tenantId: TENANT_ID,
    ownerActorId: "actor-a",
    mode: "orchestrate",
    status: "running",
    prompt: "Summarize my week.",
    messages: [{ role: "user", content: "Summarize my week." }],
    agentId: "atlas",
    specialistIds: ["atlas"],
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
  };
}

function record(seq: number, payload: Record<string, unknown>): AgentRunEventRecord {
  return {
    id: `event-${seq}`,
    tenantId: TENANT_ID,
    runId: RUN_ID,
    type: String(payload.type),
    payload,
    createdAt: "2026-09-27T00:00:00.000Z",
    seq,
  };
}

type Block = { id?: string; comment?: string; event?: Record<string, unknown> };

function blocks(text: string): Block[] {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    if (lines[0].startsWith(":")) return { comment: lines[0] };
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const data = lines.find((line) => line.startsWith("data: "))!.slice(6);
    return { ...(id ? { id } : {}), event: JSON.parse(data) };
  });
}

function tail(input: Partial<Parameters<typeof agentRunTailResponse>[0]> = {}) {
  return agentRunTailResponse({
    runId: RUN_ID,
    tenantId: TENANT_ID,
    pollIntervalMs: 0,
    ...input,
  });
}

beforeEach(() => {
  mocks.getAgentRun.mockReset();
  mocks.listAgentRunEventsAfter.mockReset();
  mocks.listAgentRunEventsAfter.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseRunEventCursor", () => {
  const request = (headers: Record<string, string> = {}, query = "") =>
    new Request(`https://asael.test/api/runs/run-a/stream${query}`, { headers });

  it("prefers Last-Event-ID and falls back to ?after=", () => {
    expect(parseRunEventCursor(request({ "last-event-id": "42" }, "?after=7"))).toBe(42);
    expect(parseRunEventCursor(request({ "last-event-id": " 12 " }))).toBe(12);
    expect(parseRunEventCursor(request({}, "?after=7"))).toBe(7);
    expect(parseRunEventCursor(request({ "last-event-id": "abc" }, "?after=7"))).toBe(7);
    expect(parseRunEventCursor(request())).toBeUndefined();
  });

  it.each(["", "-1", "1.5", "1e3", "0x10", "12345678901234567", "9999999999999999"])(
    "ignores the position %j",
    (value) => {
      expect(parseRunEventCursor(request({ "last-event-id": value }))).toBeUndefined();
      expect(parseRunEventCursor(request({}, `?after=${encodeURIComponent(value)}`)))
        .toBeUndefined();
    },
  );
});

describe("agentRunTailResponse", () => {
  it("replays the steps after the cursor, then ends on the stored outcome", async () => {
    mocks.getAgentRun
      .mockResolvedValueOnce(run())
      .mockResolvedValueOnce(run({ status: "completed", response: "Stored answer." }));
    mocks.listAgentRunEventsAfter
      .mockResolvedValueOnce([
        record(5, { type: "status", label: "Planning" }),
        record(6, { type: "run", runId: RUN_ID }),
        record(7, { type: "tool", toolId: "memory.search", status: "completed" }),
      ])
      .mockResolvedValueOnce([
        record(8, { type: "done", response: "A stale log record." }),
        record(9, { type: "error", message: "A stale failure." }),
      ]);

    const response = tail({
      afterSeq: 4,
      threadId: "thread-tail",
      headers: { "X-Asael-Run-Id": RUN_ID },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-asael-run-id")).toBe(RUN_ID);

    expect(blocks(await response.text())).toEqual([
      { event: { type: "run", runId: RUN_ID, threadId: "thread-tail" } },
      { id: "5", event: { type: "status", label: "Planning" } },
      { id: "7", event: { type: "tool", toolId: "memory.search", status: "completed" } },
      { event: { type: "done", response: "Stored answer." } },
    ]);
    expect(mocks.getAgentRun).toHaveBeenCalledWith(RUN_ID, { tenantId: TENANT_ID });
    expect(mocks.listAgentRunEventsAfter.mock.calls).toEqual([
      [RUN_ID, { tenantId: TENANT_ID, afterSeq: 4, limit: 200 }],
      [RUN_ID, { tenantId: TENANT_ID, afterSeq: 7, limit: 200 }],
    ]);
  });

  it("pages through a long log before it reports the outcome", async () => {
    mocks.getAgentRun.mockResolvedValue(run({ status: "canceled" }));
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      record(index + 1, { type: "status", label: `Step ${index + 1}` })
    );
    mocks.listAgentRunEventsAfter
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([record(201, { type: "status", label: "Step 201" })]);

    const written = blocks(await tail().text());

    expect(written).toHaveLength(203);
    expect(written.at(-2)).toEqual({
      id: "201",
      event: { type: "status", label: "Step 201" },
    });
    expect(written.at(-1)).toEqual({
      event: { type: "canceled", message: "The Agent run was canceled." },
    });
    expect(mocks.listAgentRunEventsAfter.mock.calls.map(([, options]) => options.afterSeq))
      .toEqual([0, 200]);
  });

  it.each([
    "run",
    "delta",
    "done",
    "error",
    "canceled",
    "waiting_approval",
    "clarification",
    "delegated",
  ])("moves past a logged %s record without replaying it", async (type) => {
    mocks.getAgentRun
      .mockResolvedValueOnce(run())
      .mockResolvedValueOnce(run({ status: "failed", error: "Stored failure." }));
    mocks.listAgentRunEventsAfter
      .mockResolvedValueOnce([record(3, { type })])
      .mockResolvedValueOnce([]);

    expect(blocks(await tail().text())).toEqual([
      { event: { type: "run", runId: RUN_ID } },
      { event: { type: "error", message: "Stored failure." } },
    ]);
    expect(mocks.listAgentRunEventsAfter.mock.calls[1][1].afterSeq).toBe(3);
  });

  it("stops paging a long log once the client goes away", async () => {
    mocks.getAgentRun.mockResolvedValue(run());
    const client = new AbortController();
    mocks.listAgentRunEventsAfter.mockImplementationOnce(async () => {
      client.abort();
      return Array.from({ length: 200 }, (_, index) =>
        record(index + 1, { type: "status", label: `Step ${index + 1}` })
      );
    });

    expect(blocks(await tail({ signal: client.signal }).text())).toEqual([
      { event: { type: "run", runId: RUN_ID } },
    ]);
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledTimes(1);
  });

  it("ends without an outcome when the run is no longer visible", async () => {
    mocks.getAgentRun.mockResolvedValue(undefined);

    expect(blocks(await tail().text())).toEqual([
      { event: { type: "run", runId: RUN_ID } },
    ]);
    expect(mocks.listAgentRunEventsAfter).not.toHaveBeenCalled();
  });

  it("ends at its deadline so the client reconnects", async () => {
    mocks.getAgentRun.mockResolvedValue(run());
    mocks.listAgentRunEventsAfter.mockResolvedValueOnce([
      record(2, { type: "status", label: "Still working" }),
    ]);

    expect(blocks(await tail({ maxDurationMs: 0 }).text())).toEqual([
      { event: { type: "run", runId: RUN_ID } },
      { id: "2", event: { type: "status", label: "Still working" } },
    ]);
    expect(mocks.getAgentRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection alive between polls", async () => {
    vi.useFakeTimers();
    mocks.getAgentRun
      .mockResolvedValueOnce(run())
      .mockResolvedValueOnce(run())
      .mockResolvedValueOnce(run({ status: "completed", response: "Done." }));

    const text = tail({ pollIntervalMs: 1_000, heartbeatIntervalMs: 300 }).text();
    await vi.advanceTimersByTimeAsync(2_500);
    const written = blocks(await text);

    // Every 300 ms until the third poll, at 2 s, finds the run done.
    expect(written.filter((block) => block.comment === ": keep-alive")).toHaveLength(6);
    expect(written.at(-1)).toEqual({ event: { type: "done", response: "Done." } });
    expect(mocks.getAgentRun).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops polling once the client goes away", async () => {
    mocks.getAgentRun.mockResolvedValue(run());
    const client = new AbortController();
    const reader = tail({ signal: client.signal, pollIntervalMs: 60_000 })
      .body!.getReader();

    await reader.read();
    await vi.waitFor(() => expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledTimes(1));
    client.abort();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(mocks.getAgentRun).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    mocks.getAgentRun.mockClear();
    const canceled = tail({ pollIntervalMs: 60_000 }).body!.getReader();
    await canceled.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAgentRun).toHaveBeenCalledTimes(1);
    await canceled.cancel();
    // Past the next poll, which a tail still running would make.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.getAgentRun).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();

    mocks.getAgentRun.mockClear();
    const gone = new AbortController();
    gone.abort();
    expect(blocks(await tail({ signal: gone.signal }).text())).toEqual([]);
    expect(mocks.getAgentRun).not.toHaveBeenCalled();
  });

  it("logs a redacted failure and closes the stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getAgentRun.mockResolvedValue(run());
    mocks.listAgentRunEventsAfter.mockRejectedValue(
      new Error("database unavailable password=hunter2-secret"),
    );

    expect(blocks(await tail().text())).toEqual([
      { event: { type: "run", runId: RUN_ID } },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0][0]));
    expect(logged).toMatchObject({
      level: "warn",
      event: "agent_run_tail_failed",
      runId: RUN_ID,
    });
    expect(logged.message).toContain("database unavailable");
    expect(logged.message).not.toContain("hunter2-secret");
  });
});
