import { describe, expect, it } from "vitest";
import {
  JsonBodyError,
  parseBoundedInteger,
  parseJsonBody,
  readResponseTextLimited,
} from "@/lib/http/body";

describe("bounded HTTP bodies", () => {
  it("normalizes bounded integer query parameters", () => {
    expect(parseBoundedInteger(null, 20, { max: 100 })).toBe(20);
    expect(parseBoundedInteger("not-a-number", 20, { max: 100 })).toBe(20);
    expect(parseBoundedInteger("1000", 20, { max: 100 })).toBe(100);
    expect(parseBoundedInteger("-5", 20, { max: 100 })).toBe(1);
    expect(parseBoundedInteger("4.9", 20, { max: 100 })).toBe(4);
  });

  it("parses chunked JSON below the byte limit", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunkedBody(['{"value":', '"ok"}']),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(parseJsonBody(request, 64)).resolves.toEqual({ value: "ok" });
  });

  it("rejects streamed JSON as soon as it exceeds the limit", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(100)));
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(parseJsonBody(request, 16)).rejects.toBeInstanceOf(JsonBodyError);
    expect(canceled).toBe(true);
  });

  it("rejects non-JSON request media types", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"value":"ok"}',
    });

    await expect(parseJsonBody(request, 64)).rejects.toMatchObject({
      status: 415,
    });
  });

  it("caps response bytes without buffering the full response", async () => {
    const response = new Response(chunkedBody(["1234", "5678", "90"]));
    const result = await readResponseTextLimited(response, 7);
    expect(result).toEqual({
      text: "1234567",
      bytesRead: 7,
      truncated: true,
    });
  });
});

function chunkedBody(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}
