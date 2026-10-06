import { parseDocument } from "htmlparser2";
import { citationIdForWebUrl } from "@/lib/rag/citations";
import { fetchPublicHttpUrl } from "@/lib/security/network";

export const WEB_SOURCE_MAX_BYTES = 1_048_576;
export const WEB_SOURCE_MAX_CHARACTERS = 12_000;
export const WEB_SOURCE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export type PublicWebSourceResult = {
  url: string;
  title: string;
  content: string;
  contentType: string;
  fetchedAt: string;
  citationId: string;
  truncated: boolean;
  contentTrust: "untrusted";
};

/** Inert, bounded public reading only. Authority and audit belong to the tool executor. */
export async function readPublicWebSource({
  url,
  abortSignal,
}: {
  url: string;
  abortSignal?: AbortSignal;
}): Promise<PublicWebSourceResult> {
  const timeout = new AbortController();
  const timeoutId = setTimeout(() => timeout.abort(new Error(
    "Public source reading timed out after 15 seconds. Try another source.",
  )), WEB_SOURCE_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout.signal, ...(abortSignal ? [abortSignal] : [])]);
  try {
    signal.throwIfAborted();
    let currentUrl = normalizeUrl(url);
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      signal.throwIfAborted();
      if (visited.has(currentUrl)) throw new Error("Public source redirects form a loop.");
      visited.add(currentUrl);
      // This transport checks every DNS answer and rechecks on connection, so
      // redirects and DNS rebinding cannot reach internal addresses.
      const response = await abortable(fetchPublicHttpUrl(currentUrl, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9" },
        signal,
      }, "Public source URL"), signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        cancelBody(response);
        const location = response.headers.get("location");
        if (!location) throw new Error("Public source redirect has no destination.");
        if (redirects === MAX_REDIRECTS) throw new Error("Public source has too many redirects; use the final public URL.");
        currentUrl = normalizeUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        cancelBody(response);
        if ([401, 402, 403].includes(response.status)) {
          throw new Error("This source requires access, a subscription, or blocks automated reading. Choose a publicly readable source.");
        }
        throw new Error(`Public source returned HTTP ${response.status}. Try another source.`);
      }
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown"].includes(contentType)) {
        cancelBody(response);
        throw new Error(contentType === "application/pdf"
          ? "PDF sources are not supported by web.read. Find an HTML version or use a document reader."
          : "This source is not a supported HTML or plain-text page. Choose a readable public page.");
      }
      const source = await readBoundedBody(response, signal);
      if (source.trimStart().startsWith("%PDF-")) {
        throw new Error("PDF sources are not supported by web.read. Find an HTML version or use a document reader.");
      }
      const extracted = contentType === "text/html" || contentType === "application/xhtml+xml"
        ? extractHtmlText(source)
        : { title: new URL(currentUrl).hostname, content: normalizeText(source), restricted: false };
      signal.throwIfAborted();
      if (extracted.restricted) {
        throw new Error("This page indicates a subscription or sign-in restriction. Choose a publicly readable source.");
      }
      if (extracted.content.length < 120 || /^(?:enable javascript|please enable javascript|javascript is required)\b/i.test(extracted.content)) {
        throw new Error("This page has too little readable text or requires JavaScript. Choose another source; no browser scripts were executed.");
      }
      return {
        url: currentUrl,
        title: extracted.title.slice(0, 300) || new URL(currentUrl).hostname,
        content: extracted.content.slice(0, WEB_SOURCE_MAX_CHARACTERS),
        contentType,
        fetchedAt: new Date().toISOString(),
        citationId: citationIdForWebUrl(currentUrl),
        truncated: extracted.content.length > WEB_SOURCE_MAX_CHARACTERS,
        contentTrust: "untrusted",
      };
    }
    throw new Error("Public source could not be read.");
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeUrl(value: string) {
  if (!value.trim() || value.length > 4_000) throw new Error("Public source URL must contain 1–4000 characters.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Public source URL must use HTTP or HTTPS without embedded credentials.");
  }
  url.hash = "";
  return url.toString();
}

async function readBoundedBody(response: Response, signal: AbortSignal) {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > WEB_SOURCE_MAX_BYTES) {
    cancelBody(response);
    throw new Error("Public source exceeds the 1 MiB reading limit. Choose a smaller page.");
  }
  if (!response.body) throw new Error("Public source returned an empty body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      // Enforce decompressed bytes as well as Content-Length (which can be
      // absent, incorrect, or describe a much smaller compressed body).
      if (size > WEB_SOURCE_MAX_BYTES) throw new Error("Public source exceeds the 1 MiB reading limit. Choose a smaller page.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers.get("content-type") || "")?.[1] || "utf-8";
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      throw new Error("Public source uses an unsupported text encoding. Choose another source.");
    }
  } finally {
    // Cancelling the request must not depend on a remote stream's teardown
    // resolving; the caller's deadline still applies while cleaning up.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function cancelBody(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

type ParsedNode = ReturnType<typeof parseDocument>["children"][number];
const excludedTags = new Set(["script", "style", "noscript", "template", "nav", "footer", "header", "aside", "form", "button", "iframe", "object", "embed", "svg", "canvas", "head"]);
const blockTags = new Set(["p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "table", "tr", "blockquote", "pre", "br"]);

function extractHtmlText(source: string) {
  const document = parseDocument(source, { decodeEntities: true });
  const pending = document.children.toReversed().map((node) => ({ node, readable: true }));
  const candidates: ParsedNode[] = [];
  let title = "";
  let restricted = false;
  let fallback: ParsedNode = document;
  while (pending.length) {
    const entry = pending.pop()!;
    const node = entry.node;
    const readable = entry.readable && !excludedNode(node);
    if ("name" in node && "attribs" in node) {
      if (node.name === "title") title = plainText(node);
      if (node.name === "body") fallback = node;
      if (node.name === "meta" && node.attribs.property === "og:title" && !title) title = node.attribs.content || "";
      if (node.name === "script" && node.attribs.type === "application/ld+json") {
        try { restricted ||= hasRestrictedAccess(JSON.parse(plainText(node, true))); } catch { /* Invalid metadata is not evidence. */ }
      }
      if (readable && candidates.length < 32 && (node.name === "main" || node.name === "article" || node.attribs.role === "main")) candidates.push(node);
    }
    if ("children" in node) for (let i = node.children.length - 1; i >= 0; i -= 1) pending.push({ node: node.children[i], readable });
  }
  const texts = candidates.map((node) => plainText(node)).filter((text) => text.length >= 120);
  const content = texts.sort((left, right) => right.length - left.length)[0] || plainText(fallback);
  // Strong gate language on a short shell is an access failure, not source evidence.
  restricted ||= content.length < 1_000 && /\b(?:subscribe to (?:continue|read|unlock)|sign in to (?:continue reading|read this)|subscription required|already a subscriber)\b/i.test(content);
  return { title: normalizeText(title), content, restricted };
}

function plainText(root: ParsedNode, includeScripts = false) {
  const parts: string[] = [];
  const stack: Array<ParsedNode | string> = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === "string") { parts.push(node); continue; }
    if (node.type === "text") { parts.push(node.data); continue; }
    if ("name" in node && "attribs" in node) {
      if (!includeScripts && excludedNode(node)) continue;
      if (node.name === "td" || node.name === "th") parts.push(" | ");
      if (blockTags.has(node.name)) { parts.push("\n"); stack.push("\n"); }
    }
    if ("children" in node) for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
  return normalizeText(parts.join(""));
}

function excludedNode(node: ParsedNode) {
  return "name" in node && "attribs" in node && (excludedTags.has(node.name) || "hidden" in node.attribs || node.attribs["aria-hidden"] === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.attribs.style || ""));
}

function normalizeText(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function hasRestrictedAccess(value: unknown) {
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.isAccessibleForFree === false || record.isAccessibleForFree === "False" || record.isAccessibleForFree === "false") return true;
    for (const value of Object.values(record)) stack.push(value);
  }
  return false;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("Public source reading was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
