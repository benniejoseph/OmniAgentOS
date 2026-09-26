import { afterEach, describe, expect, it, vi } from "vitest";
import { enforcePrivateNoStore } from "@/lib/http/response";
import {
  encodeSse,
  SSE_HEARTBEAT,
  SSE_HEARTBEAT_INTERVAL_MS,
  sseResponse,
  startSseHeartbeat,
} from "@/lib/http/sse";

afterEach(() => {
  vi.useRealTimers();
});

describe("encodeSse", () => {
  it("prefixes a persisted event with its stream position", () => {
    expect(encodeSse({ type: "status", label: "routing" }, { id: 42 })).toBe(
      'id: 42\nevent: status\ndata: {"type":"status","label":"routing"}\n\n',
    );
  });

  it("leaves a transport-only event without an id", () => {
    expect(encodeSse({ type: "delta", text: "hi" })).toBe(
      'event: delta\ndata: {"type":"delta","text":"hi"}\n\n',
    );
  });
});

describe("sseResponse", () => {
  it("disables buffering and transformation and keeps extra headers", () => {
    const response = sseResponse(new ReadableStream(), {
      "X-Asael-Run-Id": "run-a",
      "Content-Type": "application/json",
    });
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-asael-run-id")).toBe("run-a");
  });

  it("stays untransformed when the private cache policy is enforced", () => {
    expect(
      enforcePrivateNoStore(sseResponse(new ReadableStream())).headers.get(
        "cache-control",
      ),
    ).toBe("private, no-store, no-transform");
    // A media type is case-insensitive.
    expect(
      enforcePrivateNoStore(new Response("", {
        headers: { "content-type": "Text/Event-Stream" },
      })).headers.get("cache-control"),
    ).toBe("private, no-store, no-transform");
    expect(
      enforcePrivateNoStore(Response.json({ ok: true })).headers.get(
        "cache-control",
      ),
    ).toBe("private, no-store");
  });
});

describe("startSseHeartbeat", () => {
  it("writes a comment every fifteen seconds until stopped", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const stop = startSseHeartbeat(write);

    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS - 1);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledWith(SSE_HEARTBEAT);
    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS);
    expect(write).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS * 3);
    expect(write).toHaveBeenCalledTimes(2);
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(SSE_HEARTBEAT).toBe(": keep-alive\n\n");
  });
});
