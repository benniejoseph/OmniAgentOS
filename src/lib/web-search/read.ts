import { parseDocument } from "htmlparser2";
import { citationIdForWebUrl } from "@/lib/rag/citations";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import { parseDocumentContained } from "@/lib/capture/document-parse";
import { selectResearchPassages, type ResearchPassage, type ResearchSourceProvenance } from "@/lib/research/evidence";
import { researchDomainAllowed } from "@/lib/research/plan";

export const WEB_SOURCE_MAX_BYTES = 1_048_576;
export const WEB_PDF_MAX_BYTES = 5 * 1_048_576;
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
  requestedUrl?: string;
  sourceContentSha256?: string;
  selectionQuery?: string;
  passages?: ResearchPassage[];
  provenance?: ResearchSourceProvenance;
  limitations?: string[];
};

/** Inert, bounded public reading only. Authority and audit belong to the tool executor. */
export async function readPublicWebSource({
  url,
  query,
  allowedDomains,
  abortSignal,
}: {
  url: string;
  query?: string;
  allowedDomains?: string[];
  abortSignal?: AbortSignal;
}): Promise<PublicWebSourceResult> {
  const startedAt = Date.now();
  const timeout = new AbortController();
  const timeoutId = setTimeout(() => timeout.abort(new Error(
    "Public source reading timed out after 15 seconds. Try another source.",
  )), WEB_SOURCE_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout.signal, ...(abortSignal ? [abortSignal] : [])]);
  try {
    signal.throwIfAborted();
    const requestedUrl = normalizeUrl(url);
    let currentUrl = requestedUrl;
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      signal.throwIfAborted();
      if (!researchDomainAllowed(currentUrl, allowedDomains)) {
        throw new Error("This source or its redirect is outside the allowed research domains. Choose a source within your selected domains.");
      }
      if (visited.has(currentUrl)) throw new Error("Public source redirects form a loop.");
      visited.add(currentUrl);
      // This transport checks every DNS answer and rechecks on connection, so
      // redirects and DNS rebinding cannot reach internal addresses.
      const response = await abortable(fetchPublicHttpUrl(currentUrl, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf;q=0.9" },
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
      if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/pdf", "application/octet-stream"].includes(contentType)) {
        cancelBody(response);
        throw new Error("This source is not a supported HTML, text, or PDF document. Choose a readable public source.");
      }
      const bytes = await readBoundedBytes(response, signal,
        ["application/pdf", "application/octet-stream"].includes(contentType) ? WEB_PDF_MAX_BYTES : WEB_SOURCE_MAX_BYTES);
      const pdfSignature = new TextDecoder("ascii").decode(bytes.subarray(0, 1_024)).includes("%PDF-");
      if (contentType === "application/pdf" || pdfSignature) {
        if (!pdfSignature) throw new Error("This source identifies itself as a PDF but does not contain a readable PDF header.");
        const parsed = await parseDocumentContained({ format: "pdf", bytes }, {
          timeoutMs: Math.max(1, WEB_SOURCE_TIMEOUT_MS - (Date.now() - startedAt)),
        }, { signal });
        signal.throwIfAborted();
        if (parsed.kind === "pdf_scanned") {
          throw new Error("This PDF contains scanned pages without extractable text. No OCR was run; use a text version or upload it for document processing.");
        }
        if (parsed.kind !== "units" || !parsed.units.length) throw new Error("This PDF did not contain readable text.");
        const selected = selectResearchPassages({
          url: currentUrl, query,
          units: parsed.units.map((unit) => ({ content: unit.content,
            ...(unit.locator.kind === "page" ? { pageNumber: unit.locator.pageNumber } : {}) })),
          maxCharacters: WEB_SOURCE_MAX_CHARACTERS,
        });
        if (!selected.content.trim()) throw new Error("This PDF did not contain readable text within the extraction limits.");
        const fetchedAt = new Date().toISOString();
        const limitations = [
          "PDF coverage includes extracted text only; images, charts, and scanned pages were not interpreted.",
          ...(parsed.state === "partial" ? ["The PDF parser reached a page or text limit; some document content was not extracted."] : []),
          ...(selected.selectionTruncated ? ["Only selected passages from this PDF are included."] : []),
        ];
        return {
          url: currentUrl, requestedUrl,
          title: decodePdfTitle(currentUrl),
          content: selected.content, contentType: "application/pdf", fetchedAt,
          citationId: citationIdForWebUrl(currentUrl),
          truncated: parsed.state === "partial" || selected.selectionTruncated,
          contentTrust: "untrusted", sourceContentSha256: selected.sourceContentSha256,
          ...(query ? { selectionQuery: query.slice(0, 4_000) } : {}),
          passages: selected.passages, limitations,
          provenance: { method: "pdf_text", requestedUrl, finalUrl: currentUrl, fetchedAt,
            sourceContentSha256: selected.sourceContentSha256, fullTextCharacters: selected.fullTextCharacters },
        };
      }
      if (contentType === "application/octet-stream") throw new Error("This download is not a supported text PDF.");
      const source = decodeTextBody(bytes, response.headers.get("content-type") || "");
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
      const selected = selectResearchPassages({ url: currentUrl, content: extracted.content, query,
        maxCharacters: WEB_SOURCE_MAX_CHARACTERS });
      const fetchedAt = new Date().toISOString();
      return {
        url: currentUrl,
        requestedUrl,
        title: extracted.title.slice(0, 300) || new URL(currentUrl).hostname,
        content: selected.content,
        contentType,
        fetchedAt,
        citationId: citationIdForWebUrl(currentUrl),
        truncated: selected.selectionTruncated,
        contentTrust: "untrusted",
        sourceContentSha256: selected.sourceContentSha256,
        ...(query ? { selectionQuery: query.slice(0, 4_000) } : {}),
        passages: selected.passages,
        limitations: selected.selectionTruncated ? ["Only selected passages from this page are included."] : [],
        provenance: { method: contentType.includes("html") ? "public_html" : "public_text",
          requestedUrl, finalUrl: currentUrl, fetchedAt, sourceContentSha256: selected.sourceContentSha256,
          fullTextCharacters: selected.fullTextCharacters },
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

async function readBoundedBytes(response: Response, signal: AbortSignal, maxBytes: number) {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) {
    cancelBody(response);
    throw new Error(`Public source exceeds the ${maxBytes / 1_048_576} MiB reading limit. Choose a smaller source.`);
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
      if (size > maxBytes) throw new Error(`Public source exceeds the ${maxBytes / 1_048_576} MiB reading limit. Choose a smaller source.`);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    // Cancelling the request must not depend on a remote stream's teardown
    // resolving; the caller's deadline still applies while cleaning up.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function decodeTextBody(bytes: Uint8Array, contentType: string) {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || "utf-8";
  try { return new TextDecoder(charset).decode(bytes); }
  catch { throw new Error("Public source uses an unsupported text encoding. Choose another source."); }
}

function decodePdfTitle(url: string) {
  const name = new URL(url).pathname.split("/").at(-1) || "Public PDF document";
  try { return decodeURIComponent(name).replace(/[-_]+/gu, " ").slice(0, 300); }
  catch { return name.slice(0, 300); }
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
