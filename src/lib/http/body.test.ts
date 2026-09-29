import { describe, expect, it } from "vitest";
import {
  JsonBodyError,
  parseBoundedInteger,
  parseJsonBody,
  readResponseBytesLimited,
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

  it("caps response bytes without decoding them, and stops reading at the cap", async () => {
    let pulled = 0;
    let canceled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
      },
      cancel() {
        canceled = true;
      },
    }));
    const result = await readResponseBytesLimited(response, 6);
    expect([...result.bytes]).toEqual([0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe]);
    expect(result).toMatchObject({ bytesRead: 6, truncated: true });
    expect(canceled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(3);
  });

  it("keeps a response that ends at the cap whole", async () => {
    const result = await readResponseBytesLimited(
      new Response(chunkedBody(["1234", "56"])),
      6,
    );
    expect(new TextDecoder().decode(result.bytes)).toBe("123456");
    expect(result).toMatchObject({ bytesRead: 6, truncated: false });
  });

  it("reports a response that declares more than the cap as truncated", async () => {
    const result = await readResponseBytesLimited(
      new Response(chunkedBody(["1234"]), { headers: { "content-length": "100" } }),
      6,
    );
    expect(result).toMatchObject({ bytesRead: 4, truncated: true });
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
