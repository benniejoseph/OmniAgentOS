import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_RECONNECT_DELAYS_MS,
  followAgentRunStream,
} from "@/lib/client/agent-run-follow";

type Event = { type: string; step?: number };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function sseStream(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sse(...chunks: string[]) {
  return new Response(sseStream(...chunks), {
    headers: { "content-type": "text/event-stream" },
  });
}

function harness(cursorId = "") {
  const events: Event[] = [];
  const delays: number[] = [];
  const cursor = { lastEventId: cursorId };
  const clock = { now: 0 };
  return {
    events,
    delays,
    cursor,
    clock,
    options: {
      runId: "run/a",
      cursor,
      onEvent: (event: Event) => {
        events.push(event);
      },
      isSettled: () => events.some((event) => event.type === "done"),
      now: () => clock.now,
      sleep: async (ms: number) => {
        delays.push(ms);
        clock.now += ms;
        // A follow that never ends fails here instead of spinning forever.
        if (delays.length > 50) throw new Error("Followed past 50 attempts.");
      },
    },
  };
}

function lastEventIds(fetchImpl: ReturnType<typeof vi.fn>) {
  return fetchImpl.mock.calls.map(([, init]) =>
    (init as RequestInit).headers &&
      ((init as RequestInit).headers as Record<string, string>)["last-event-id"]
  );
}

describe("followAgentRunStream", () => {
  it("resumes after the last event seen until an event settles the run", async () => {
    const { events, delays, cursor, options } = harness("4");
    const signal = new AbortController().signal;
    const fetchImpl = vi.fn(async () => sse(
      'event: run\ndata: {"type":"run"}\n\n',
      'id: 5\nevent: tool\ndata: {"type":"tool","step":5}\n\n',
      'event: done\ndata: {"type":"done"}\n\n',
    ));

    await expect(followAgentRunStream<Event>({
      ...options,
      signal,
      fetchImpl,
    })).resolves.toBe("settled");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/runs/run%2Fa/stream", {
      headers: { accept: "text/event-stream", "last-event-id": "4" },
      cache: "no-store",
      signal,
    });
    expect(events.map((event) => event.type)).toEqual(["run", "tool", "done"]);
    expect(cursor.lastEventId).toBe("5");
    expect(delays).toEqual([AGENT_RUN_RECONNECT_DELAYS_MS[0]]);
  });

  it("backs off while attempts bring nothing new and starts over after progress", async () => {
    const { events, delays, options } = harness("5");
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(sse(
        'data: {"type":"run"}\n\n',
        'id: 6\ndata: {"type":"tool","step":6}\n\n',
      ))
      .mockResolvedValueOnce(sse('data: {"type":"run"}\n\n'))
      .mockResolvedValueOnce(sse('data: {"type":"run"}\n\n'))
      .mockResolvedValueOnce(sse(
        'data: {"type":"run"}\n\n',
        'data: {"type":"done"}\n\n',
      ));

    await expect(followAgentRunStream<Event>({
      ...options,
      signal: new AbortController().signal,
      fetchImpl,
    })).resolves.toBe("settled");

    expect(delays).toEqual([1_000, 2_000, 4_000, 1_000, 2_000, 4_000]);
    expect(lastEventIds(fetchImpl)).toEqual(["5", "5", "5", "6", "6", "6"]);
    expect(events.filter((event) => event.type !== "run")).toEqual([
      { type: "tool", step: 6 },
      { type: "done" },
    ]);
  });

  it("keeps the longest delay once the backoff runs out", async () => {
    const { delays, options } = harness();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 7
        ? new Response("busy", { status: 502 })
        : sse('data: {"type":"done"}\n\n');
    });

    await expect(followAgentRunStream<Event>({
      ...options,
      signal: new AbortController().signal,
      fetchImpl,
    })).resolves.toBe("settled");

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
    expect(lastEventIds(fetchImpl).every((id) => id === undefined)).toBe(true);
  });

  it.each([401, 403, 404])(
    "stops following when the run answers %i",
    async (status) => {
      const { options } = harness("3");
      let canceled = false;
      const body = new ReadableStream({
        cancel() {
          canceled = true;
        },
      });
      const fetchImpl = vi.fn(async () => new Response(body, { status }));

      await expect(followAgentRunStream<Event>({
        ...options,
        signal: new AbortController().signal,
        fetchImpl,
      })).resolves.toBe("unavailable");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(canceled).toBe(true));
    },
  );

  it("stops without reconnecting once the caller aborts", async () => {
    const whileWaiting = new AbortController();
    const waiting = harness();
    const neverFetched = vi.fn();
    await expect(followAgentRunStream<Event>({
      ...waiting.options,
      signal: whileWaiting.signal,
      fetchImpl: neverFetched,
      sleep: async () => {
        whileWaiting.abort();
      },
    })).resolves.toBe("stopped");
    expect(neverFetched).not.toHaveBeenCalled();

    // The budget leaves no room for another attempt, so each of these stops
    // is reported by the abort check, not by the budget running out.
    const whileConnecting = new AbortController();
    const connecting = harness();
    const abortedFetch = vi.fn(async () => {
      whileConnecting.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await expect(followAgentRunStream<Event>({
      ...connecting.options,
      signal: whileConnecting.signal,
      fetchImpl: abortedFetch,
      budgetMs: 1_500,
    })).resolves.toBe("stopped");
    expect(abortedFetch).toHaveBeenCalledTimes(1);

    const whileReading = new AbortController();
    const reading = harness();
    const encoder = new TextEncoder();
    const abortedStream = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('id: 8\ndata: {"type":"tool"}\n\n'));
          whileReading.signal.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      }),
    ));
    const pending = followAgentRunStream<Event>({
      ...reading.options,
      signal: whileReading.signal,
      fetchImpl: abortedStream,
      budgetMs: 1_500,
    });
    await vi.waitFor(() => expect(reading.events).toHaveLength(1));
    whileReading.abort();
    await expect(pending).resolves.toBe("stopped");
    expect(abortedStream).toHaveBeenCalledTimes(1);
    expect(reading.cursor.lastEventId).toBe("8");
  });

  it("gives up once the reconnect budget is spent", async () => {
    const { clock, options } = harness();
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 503 }));

    await expect(followAgentRunStream<Event>({
      ...options,
      signal: new AbortController().signal,
      fetchImpl,
      budgetMs: 6_500,
    })).resolves.toBe("timed_out");
    // 1 s and 2 s fit; the 4 s wait would end past the budget.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.now).toBe(3_000);
  });

  it("reports a failing handler instead of reconnecting", async () => {
    const { options } = harness();
    const fetchImpl = vi.fn(async () => sse('data: {"type":"tool"}\n\n'));

    await expect(followAgentRunStream<Event>({
      ...options,
      signal: new AbortController().signal,
      fetchImpl,
      onEvent: () => {
        throw new Error("render failed");
      },
    })).rejects.toThrow("render failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("waits with real timers and the global fetch by default", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => sse('data: {"type":"done"}\n\n'));
    vi.stubGlobal("fetch", fetchSpy);
    const events: Event[] = [];

    const pending = followAgentRunStream<Event>({
      runId: "run-b",
      cursor: { lastEventId: "" },
      signal: new AbortController().signal,
      onEvent: (event) => {
        events.push(event);
      },
      isSettled: () => events.length > 0,
    });
    await vi.advanceTimersByTimeAsync(AGENT_RUN_RECONNECT_DELAYS_MS[0] - 1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("settled");
    expect(fetchSpy).toHaveBeenCalledWith("/api/runs/run-b/stream", expect.objectContaining({
      cache: "no-store",
    }));
  });
});
