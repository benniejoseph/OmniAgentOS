import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  DOCUMENT_PARSE_WORKER_KIND,
  DocumentParseError,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_PARSED_UNIT_CHARACTERS,
  MAX_PDF_OCR_PAGES,
} from "@/lib/capture/document-parse.worker";

export type DocumentParseRequest = Readonly<{
  format: string;
  bytes: Uint8Array;
  /** Render the leading pages of a scanned PDF as PNG data URLs for OCR. */
  renderScannedPdfPages?: boolean;
}>;

export type DocumentParseLimits = Readonly<{
  timeoutMs: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  /** Growth of the whole process RSS, which also catches native allocations the heap limits miss. */
  rssGrowthLimitBytes: number;
  rssPollIntervalMs: number;
}>;

export const DEFAULT_DOCUMENT_PARSE_LIMITS: DocumentParseLimits = Object.freeze({
  timeoutMs: 30_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  rssGrowthLimitBytes: 640 * 1024 * 1024,
  rssPollIntervalMs: 25,
});
export const MAX_CONCURRENT_DOCUMENT_PARSES = 2;
const WORKER_EXIT_GRACE_MS = 5_000;

const parsedDocumentLocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    pageNumber: z.number(),
    pageCount: z.number().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("slide"),
    slideNumber: z.number(),
    slideCount: z.number(),
    elementKeySha256: z.null(),
  }).strict(),
  z.object({
    kind: z.literal("sheet_range"),
    sheetKey: z.string().max(65_535),
    startRow: z.number(),
    endRowExclusive: z.number(),
    startColumn: z.number(),
    endColumnExclusive: z.number(),
    sheetRowCount: z.number(),
    sheetColumnCount: z.number(),
  }).strict(),
]);

const parsedDocumentUnitSchema = z.object({
  label: z.string().max(240),
  content: z.string().max(MAX_PARSED_UNIT_CHARACTERS),
  locator: parsedDocumentLocatorSchema,
}).strict();

const documentParseResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    content: z.string().max(MAX_ARCHIVE_UNCOMPRESSED_BYTES),
  }).strict(),
  z.object({
    kind: z.literal("units"),
    sourceKind: z.enum(["document", "spreadsheet", "presentation"]),
    state: z.enum(["completed", "partial"]),
    warningCodes: z.array(z.string().regex(/^[a-z0-9_]{1,80}$/)).max(32),
    units: z.array(parsedDocumentUnitSchema),
  }).strict(),
  z.object({
    kind: z.literal("pdf_scanned"),
    pageCount: z.number(),
    pages: z.array(z.object({
      pageNumber: z.number(),
      dataUrl: z.string().regex(/^(?:data:image\/png;base64,[A-Za-z0-9+/]+={0,2})?$/),
    }).strict()).max(MAX_PDF_OCR_PAGES),
  }).strict(),
]);

export const documentParseWorkerMessageSchema = z.union([
  z.object({ ok: z.literal(true), result: documentParseResultSchema }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      message: z.string().min(1).max(500),
      status: z.union([z.literal(400), z.literal(413), z.literal(415), z.literal(503)]),
      code: z.string().regex(/^[a-z0-9_]{1,80}$/),
    }).strict().nullable(),
    errorName: z.string().regex(/^\w{1,64}$/),
  }).strict(),
]);

export type ParsedDocumentLocator = z.infer<typeof parsedDocumentLocatorSchema>;
export type ParsedDocumentUnit = z.infer<typeof parsedDocumentUnitSchema>;
export type DocumentParseResult = z.infer<typeof documentParseResultSchema>;
export type DocumentParseWorkerMessage = z.infer<typeof documentParseWorkerMessageSchema>;

let activeParses = 0;
const waitingParses: Array<() => void> = [];

/**
 * Parses an untrusted document in a worker thread with heap limits, an RSS
 * watchdog, a wall-clock timeout, and an empty environment, and validates
 * what comes back. At most two parses run at once; a slot is held until its
 * worker has actually exited, so a parse stuck in native code keeps its slot.
 */
export async function parseDocumentContained(
  request: DocumentParseRequest,
  limits: Partial<DocumentParseLimits> = {},
): Promise<DocumentParseResult> {
  const settings: DocumentParseLimits = { ...DEFAULT_DOCUMENT_PARSE_LIMITS, ...limits };
  await acquireParseSlot();
  let slotHeld = true;
  const releaseSlot = () => {
    if (!slotHeld) return;
    slotHeld = false;
    releaseParseSlot();
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL("./document-parse.worker.ts", import.meta.url), {
      workerData: { kind: DOCUMENT_PARSE_WORKER_KIND, request },
      env: {},
      // Replaces the inherited flags. Tests load the TypeScript source, which
      // Node would otherwise reparse as ESM with a warning on every parse.
      execArgv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
      resourceLimits: {
        maxOldGenerationSizeMb: settings.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: settings.maxYoungGenerationSizeMb,
      },
    });
  } catch (error) {
    releaseSlot();
    console.error("Document parser worker could not start.", workerErrorName(error));
    throw new DocumentParseError("Document extraction is temporarily unavailable.", 503, "extraction_unavailable");
  }

  return new Promise<DocumentParseResult>((resolve, reject) => {
    let settled = false;
    const baselineRss = process.memoryUsage.rss();
    const settle = (outcome: Readonly<{ result: DocumentParseResult }> | Readonly<{ error: Error }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(rssWatchdog);
      void worker.terminate();
      setTimeout(releaseSlot, WORKER_EXIT_GRACE_MS).unref();
      if ("result" in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };
    const stopAtResourceLimit = (limit: "timeout" | "rss" | "heap") => {
      if (settled) return;
      console.warn("Document parser stopped at a resource limit.", limit);
      settle({
        error: new DocumentParseError(
          "This document needs more time or memory than extraction safely allows.",
          413,
          "extraction_resource_limit",
        ),
      });
    };
    const timeout = setTimeout(() => stopAtResourceLimit("timeout"), settings.timeoutMs);
    const rssWatchdog = setInterval(() => {
      if (process.memoryUsage.rss() - baselineRss > settings.rssGrowthLimitBytes) stopAtResourceLimit("rss");
    }, settings.rssPollIntervalMs);

    worker.once("message", (message: unknown) => {
      const parsed = documentParseWorkerMessageSchema.safeParse(message);
      if (!parsed.success) {
        settle({ error: new Error("Document parser returned an invalid result.") });
      } else if (parsed.data.ok) {
        settle({ result: parsed.data.result });
      } else if (parsed.data.error) {
        const { message: reason, status, code } = parsed.data.error;
        settle({ error: new DocumentParseError(reason, status, code) });
      } else {
        console.warn("Document parser could not read this document.", parsed.data.errorName);
        settle({ error: new Error("Document parser could not read this document.") });
      }
    });
    worker.once("error", (error) => {
      if ((error as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY") {
        stopAtResourceLimit("heap");
        return;
      }
      if (!settled) console.error("Document parser worker failed.", workerErrorName(error));
      settle({ error: new Error("Document parser failed.") });
    });
    worker.once("exit", (exitCode) => {
      releaseSlot();
      if (!settled) console.error("Document parser worker exited without a result.", exitCode);
      settle({ error: new Error("Document parser exited without a result.") });
    });
  });
}

async function acquireParseSlot() {
  if (activeParses < MAX_CONCURRENT_DOCUMENT_PARSES) {
    activeParses += 1;
    return;
  }
  await new Promise<void>((resolve) => waitingParses.push(resolve));
}

function releaseParseSlot() {
  const next = waitingParses.shift();
  if (next) next();
  else activeParses -= 1;
}

function workerErrorName(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "UnknownError";
}
