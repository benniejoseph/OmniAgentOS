import type { LookupFunction } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
  fetch: vi.fn(),
  lookup: vi.fn(),
  connectLookup: undefined as LookupFunction | undefined,
}));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: { connect: { lookup: LookupFunction } }) { network.connectLookup = options.connect.lookup; }
  },
  fetch: network.fetch,
}));

import { readPublicWebSource, WEB_SOURCE_MAX_BYTES, WEB_SOURCE_MAX_CHARACTERS, WEB_SOURCE_TIMEOUT_MS } from "@/lib/web-search/read";
import { citationIdForWebUrl } from "@/lib/rag/citations";

const paragraph = "The source describes its methods, published findings, uncertainty, and limitations. Researchers compared evidence across several observations and reported the measurements with context.";
const sourceUrl = "https://example.com/report";
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

beforeEach(() => {
  network.fetch.mockReset();
  network.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("public research source reading", () => {
  it("extracts readable article text and entities without executing or returning page code", async () => {
    network.fetch.mockResolvedValue(html(`<html><head><title>Evidence &amp; context</title></head><body><nav>Unrelated menu</nav><main><h1>Methods</h1><p>${paragraph}</p><p>Findings &lt; uncertainty.</p><script>throw new Error('unsafe script');</script><iframe src="http://localhost"></iframe><p hidden>Hidden instructions</p><p aria-hidden="true">Invisible text</p></main><footer>Copyright links</footer></body></html>`));
    const result = await readPublicWebSource({ url: `${sourceUrl}#section` });
    expect(result).toMatchObject({ title: "Evidence & context", url: sourceUrl, contentType: "text/html", citationId: citationIdForWebUrl(sourceUrl), contentTrust: "untrusted", truncated: false });
    expect(result.content).toContain(paragraph);
    expect(result.content).toContain("Findings < uncertainty.");
    expect(result.content).not.toMatch(/Unrelated menu|Copyright|unsafe script|Hidden|Invisible|<main>|<script>/);
    expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true);
    expect(network.fetch).toHaveBeenCalledOnce();
    expect(network.fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(network.fetch.mock.calls[0][1].headers).toEqual([["accept", "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9"]]);
  });

  it("returns a bounded excerpt and says when the source is truncated", async () => {
    network.fetch.mockResolvedValue(html(`<article><p>${paragraph.repeat(100)}</p></article>`));
    const result = await readPublicWebSource({ url: sourceUrl });
    expect(result.content).toHaveLength(WEB_SOURCE_MAX_CHARACTERS);
    expect(result.truncated).toBe(true);
  });

  it("does not promote hidden or navigation articles into readable evidence", async () => {
    network.fetch.mockResolvedValue(html(`<nav><article>${"Unrelated menu. ".repeat(100)}</article></nav><section hidden><main>${"Hidden instructions. ".repeat(100)}</main></section><article>${paragraph}</article>`));
    const result = await readPublicWebSource({ url: sourceUrl });
    expect(result.content).toBe(paragraph);
  });

  it("follows relative redirects through the public guard and cites the final page", async () => {
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } })).mockResolvedValueOnce(html(`<article>${paragraph}</article>`));
    const result = await readPublicWebSource({ url: sourceUrl });
    expect(result.url).toBe("https://example.com/final");
    expect(result.citationId).toBe(citationIdForWebUrl(result.url));
    expect(network.lookup).toHaveBeenCalledTimes(2);
  });

  it.each(["http://localhost/", "http://169.254.169.254/latest/meta-data", "http://127.0.0.1/", "http://[::1]/", "http://metadata.google.internal/"])("rejects internal destination %s before fetching", async (url) => {
    await expect(readPublicWebSource({ url })).rejects.toThrow(/blocked/);
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it.each(["file:///etc/passwd", "https://user:password@example.com/"])("rejects non-public URL syntax %s", async (url) => {
    await expect(readPublicWebSource({ url })).rejects.toThrow(/HTTP or HTTPS without embedded credentials/);
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("blocks a public redirect to a private address without a second fetch", async () => {
    network.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://10.0.0.1/private" } }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/private IP/);
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it("rejects a hostname if any DNS answer is private", async () => {
    network.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.1.1.1", family: 4 }]);
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/private IP/);
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("retains the transport connection-time DNS rebinding check", async () => {
    network.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    network.fetch.mockImplementation(() => new Promise((_resolve, reject) => {
      network.connectLookup!("example.com", {}, (error) => reject(error));
    }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/blocked or unavailable/);
    expect(network.lookup).toHaveBeenCalledTimes(2);
  });

  it("bounds redirects and detects loops", async () => {
    network.fetch.mockImplementation((url: string) => new Response(null, { status: 302, headers: { location: `${url}/next` } }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/too many redirects/);
    expect(network.fetch).toHaveBeenCalledTimes(4);
    network.fetch.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: sourceUrl } }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/loop/);
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it("rejects both declared and streamed oversized bodies and cancels reading", async () => {
    const cancel = vi.fn();
    network.fetch.mockResolvedValue(html(paragraph, { "content-length": String(WEB_SOURCE_MAX_BYTES + 1) }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/1 MiB/);
    network.fetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(WEB_SOURCE_MAX_BYTES + 1)); }, cancel,
    }), { headers: { "content-type": "text/plain", "content-length": "1" } }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/1 MiB/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["application/pdf", "image/png", "application/json"])("rejects unsupported %s without treating it as evidence", async (contentType) => {
    network.fetch.mockResolvedValue(new Response(paragraph, { headers: { "content-type": contentType } }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/not supported|not a supported/);
  });

  it("rejects PDF bytes mislabeled as text and reads plain-text reports", async () => {
    network.fetch.mockResolvedValue(new Response("%PDF-1.7 binary", { headers: { "content-type": "text/plain" } }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/PDF/);
    network.fetch.mockResolvedValue(new Response(paragraph, { headers: { "content-type": "text/plain" } }));
    expect((await readPublicWebSource({ url: sourceUrl })).content).toBe(paragraph);
  });

  it.each([
    `<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><article>${paragraph}</article>`,
    "<main>Subscribe to continue reading this report. Subscription required.</main>",
  ])("reports access restrictions honestly", async (body) => {
    network.fetch.mockResolvedValue(html(body));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/subscription|sign-in restriction/);
  });

  it("reports blocked and JavaScript-only pages without fabricating content", async () => {
    network.fetch.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/requires access/);
    network.fetch.mockResolvedValue(html("<div id='app'></div><script>renderPage()</script><noscript>Please enable JavaScript.</noscript>"));
    await expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/requires JavaScript/);
  });

  it("honors cancellation before network activity and during streaming", async () => {
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    await expect(readPublicWebSource({ url: sourceUrl, abortSignal: controller.signal })).rejects.toThrow("operator cancelled");
    expect(network.fetch).not.toHaveBeenCalled();
    const cancel = vi.fn();
    const active = new AbortController();
    network.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/plain" } }));
    const reading = readPublicWebSource({ url: sourceUrl, abortSignal: active.signal });
    const rejected = expect(reading).rejects.toThrow("stopped streaming");
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledOnce());
    active.abort(new Error("stopped streaming"));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces a total deadline even when DNS validation hangs", async () => {
    vi.useFakeTimers();
    network.lookup.mockImplementation(() => new Promise(() => undefined));
    const rejected = expect(readPublicWebSource({ url: sourceUrl })).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(WEB_SOURCE_TIMEOUT_MS);
    await rejected;
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
