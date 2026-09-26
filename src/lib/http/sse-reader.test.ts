import { describe, expect, it } from "vitest";
import { readSseEvents, type SseCursor } from "@/lib/http/sse-reader";

function streamOf(...chunks: Array<string | Uint8Array>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<Uint8Array>, cursor?: SseCursor) {
  const events: Array<{ event: unknown; lastEventId: string }> = [];
  await readSseEvents(stream, (event, lastEventId) => {
    events.push({ event, lastEventId });
  }, cursor);
  return events;
}

describe("readSseEvents", () => {
  it("skips heartbeats and gives each event the last id seen", async () => {
    const cursor = { lastEventId: "" };
    const events = await read(streamOf(
      ": keep-alive\n\n",
      'event: status\ndata: {"type":"status","label":"routing"}\n\n',
      'id: 7\nevent: tool\ndata: {"type":"tool","step":1}\n\n',
      ": keep-alive\n\n",
      'event: done\ndata: {"type":"done"}\n\n',
    ), cursor);

    expect(events).toEqual([
      { event: { type: "status", label: "routing" }, lastEventId: "" },
      { event: { type: "tool", step: 1 }, lastEventId: "7" },
      { event: { type: "done" }, lastEventId: "7" },
    ]);
    expect(cursor.lastEventId).toBe("7");
  });

  it("joins multi-line data and strips only one leading space", async () => {
    const events = await read(streamOf(
      'data:{"text":\ndata:   "a  b"}\n\n',
      "data: [1,\ndata:2]\n\n",
    ));
    expect(events.map(({ event }) => event)).toEqual([
      { text: "a  b" },
      [1, 2],
    ]);
  });

  it("reassembles lines, CRLF pairs, and characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"héllo"}\r\n\r\n');
    const split = bytes.indexOf(0xc3) + 1;
    const events = await read(streamOf(
      'id: 3\rdata: {"a":\r',
      '\ndata: 1}\r',
      "\n\r",
      "\n",
      bytes.slice(0, split),
      bytes.slice(split),
    ));
    expect(events).toEqual([
      { event: { a: 1 }, lastEventId: "3" },
      { event: { text: "héllo" }, lastEventId: "3" },
    ]);
  });

  it("drops an event cut off by the end of the stream, and its id", async () => {
    const cursor = { lastEventId: "4" };
    const events = await read(streamOf(
      'id: 5\ndata: {"step":5}\n\n',
      'id: 6\ndata: {"step":',
    ), cursor);
    expect(events).toEqual([{ event: { step: 5 }, lastEventId: "5" }]);
    expect(cursor.lastEventId).toBe("5");
  });

  it("resumes from a given id and ignores an id containing NUL", async () => {
    const cursor = { lastEventId: "12" };
    const events = await read(streamOf(
      'data: {"step":13}\n\n',
      'id: 1\u00002\ndata: {"step":14}\n\n',
      'id\ndata: {"step":15}\n\n',
    ), cursor);
    expect(events).toEqual([
      { event: { step: 13 }, lastEventId: "12" },
      { event: { step: 14 }, lastEventId: "12" },
      { event: { step: 15 }, lastEventId: "" },
    ]);
  });

  it("cancels the stream when an event cannot be parsed", async () => {
    let canceled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {not json}\n\n"));
      },
      cancel(reason) {
        canceled = reason ?? "canceled";
      },
    });
    await expect(read(stream)).rejects.toThrow(SyntaxError);
    await Promise.resolve();
    expect(canceled).toBeDefined();
  });
});
