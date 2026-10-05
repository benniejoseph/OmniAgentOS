import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { setFlagsFromString } from "node:v8";
import { type ResourceLimits, Worker } from "node:worker_threads";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCUMENT_PARSE_LIMITS,
  documentParseWorkerMessageSchema,
  parseDocumentContained,
} from "@/lib/capture/document-parse";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_PARSED_UNIT_CHARACTERS,
  MAX_PDF_OCR_PAGES,
  parseDocument,
} from "@/lib/capture/document-parse.worker";
import { MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS } from "@/lib/capture/extraction";
import { extractCaptureFile } from "@/lib/capture/files";

// Records in-process inflation; worker threads load the real module.
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) };
});

const liveWorkers = vi.hoisted(() => new Set<Worker>());

// Tracks every worker until it has exited.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class TrackedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      liveWorkers.add(this);
      this.once("exit", () => liveWorkers.delete(this));
    }
  }
  return { ...actual, Worker: TrackedWorker };
});

describe("contained document parsing", () => {
  it("keeps the worker's unit bound in step with the extraction contract", () => {
    expect(MAX_PARSED_UNIT_CHARACTERS).toBe(MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS);
  });

  it("parses PDF text pages inside the worker", async () => {
    const result = await parseDocumentContained({ format: "pdf", bytes: textPdf("Hello worker") });

    expect(result).toMatchObject({
      kind: "units",
      sourceKind: "document",
      state: "completed",
      units: [{
        label: "Page 1",
        content: "Hello worker",
        locator: { kind: "page", pageNumber: 1, pageCount: 1 },
      }],
    });
  });

  it("reports scanned PDFs and renders their pages only on request", async () => {
    const bytes = scannedPdf();

    await expect(parseDocumentContained({ format: "pdf", bytes })).resolves.toEqual({
      kind: "pdf_scanned",
      pageCount: 1,
      pages: [],
    });
    const rendered = await parseDocumentContained({ format: "pdf", bytes, renderScannedPdfPages: true });
    expect(rendered).toMatchObject({ kind: "pdf_scanned", pageCount: 1, pages: [{ pageNumber: 1 }] });
    expect(rendered.kind === "pdf_scanned" && rendered.pages[0].dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("reads PDFs where pdf.js cannot load the canvas binding itself", async () => {
    // Deployments ship only traced files, and pdf.js requires @napi-rs/canvas
    // in a way file tracing cannot follow.
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@napi-rs/canvas" && context.parentURL?.includes("/pdfjs-dist/")) {
          throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "MODULE_NOT_FOUND" });
        }
        return nextResolve(specifier, context);
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(globalThis).not.toHaveProperty("DOMMatrix");

      await expect(parseDocument({ format: "pdf", bytes: textPdf("Hello trace") })).resolves.toMatchObject({
        kind: "units",
        units: [{ content: "Hello trace" }],
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cannot load \"@napi-rs/canvas\""));
    } finally {
      warn.mockRestore();
      hooks.deregister();
    }
  });

  it("reports PDF extraction as unavailable when the canvas binding is missing", async () => {
    vi.doMock("@napi-rs/canvas", () => {
      throw new Error("Cannot find module '@napi-rs/canvas'");
    });
    try {
      await expect(parseDocument({ format: "pdf", bytes: textPdf("Hello trace") })).rejects.toMatchObject({
        status: 503,
        code: "extraction_unavailable",
      });
    } finally {
      vi.doUnmock("@napi-rs/canvas");
    }
  });

  it("strips markup inside the worker", async () => {
    await expect(parseDocumentContained({
      format: "html",
      bytes: new TextEncoder().encode("<style>p{}</style><h1>Title</h1><p>Body &amp; notes</p>"),
    })).resolves.toEqual({ kind: "text", content: "Title\nBody & notes" });
  });

  it("returns raw sheet keys for the main thread to hash", async () => {
    const workbook = await zipArchive({
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row r=\"2\"><c r=\"C2\"><v>42</v></c></row></sheetData></worksheet>",
    });

    await expect(parseDocument({ format: "xlsx", bytes: workbook })).resolves.toMatchObject({
      kind: "units",
      sourceKind: "spreadsheet",
      units: [{
        content: "Sheet 1\n42",
        locator: {
          kind: "sheet_range",
          sheetKey: "xl/worksheets/sheet1.xml",
          startRow: 2,
          endRowExclusive: 3,
          endColumnExclusive: 4,
        },
      }],
    });
  });

  it("stops inflating entries that expand past their declared sizes", async () => {
    const workbook = withDeclaredSizes(await zipArchive({
      "xl/worksheets/sheet1.xml": `<worksheet>${" ".repeat(MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1024)}</worksheet>`,
    }, "DEFLATE"), 64);

    await expect(parseDocumentContained({ format: "xlsx", bytes: workbook })).rejects.toMatchObject({
      status: 413,
      code: "archive_too_large",
    });
  });

  it("charges every inflated entry against one shared budget", async () => {
    const half = " ".repeat(Math.ceil(MAX_ARCHIVE_UNCOMPRESSED_BYTES * 0.6));
    const workbook = withDeclaredSizes(await zipArchive({
      "xl/worksheets/sheet1.xml": `<worksheet>${half}</worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet>${half}</worksheet>`,
    }, "DEFLATE"), 64);

    await expect(parseDocumentContained({ format: "xlsx", bytes: workbook })).rejects.toMatchObject({
      status: 413,
      code: "archive_too_large",
    });
  });

  it("never inflates an entry past the budget that remains", async () => {
    const first = `<worksheet>${" ".repeat(4_096)}</worksheet>`;
    const workbook = await zipArchive({
      "xl/worksheets/sheet1.xml": first,
      "xl/worksheets/sheet2.xml": "<worksheet></worksheet>",
    }, "DEFLATE");
    const inflate = vi.mocked(inflateRawSync);
    inflate.mockClear();

    await parseDocument({ format: "xlsx", bytes: workbook });

    expect(inflate.mock.calls.map(([, options]) => options?.maxOutputLength)).toEqual([
      MAX_ARCHIVE_UNCOMPRESSED_BYTES,
      MAX_ARCHIVE_UNCOMPRESSED_BYTES - first.length,
    ]);
  });

  it("rejects archives with too many entries before inflating any", async () => {
    const files = Object.fromEntries(Array.from(
      { length: MAX_ARCHIVE_ENTRIES + 1 },
      (_value, index) => [`xl/worksheets/sheet${index + 1}.xml`, "<worksheet/>"],
    ));

    await expect(parseDocument({ format: "xlsx", bytes: await zipArchive(files) })).rejects.toMatchObject({
      status: 413,
      code: "archive_too_large",
    });
  });

  it("stops a parse that outlives its time limit", async () => {
    const bytes = await quadraticWorkbook();
    const started = Date.now();

    await expectResourceLimit("timeout", () => parseDocumentContained({ format: "xlsx", bytes }, { timeoutMs: 300 }));
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  const smallHeap = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 };

  it("stops a parse that exhausts its heap", async () => {
    const bytes = await heapHoldingWorkbook();

    await expectResourceLimit("heap", () => parseDocumentContained({ format: "xlsx", bytes }, smallHeap));
  });

  it("stops a parse that exhausts its heap when a process-wide flag lifts the worker's limits", async () => {
    const bytes = await heapHoldingWorkbook();
    // NODE_OPTIONS=--max-old-space-size=8192 does the same: Node lets the
    // process flag replace a worker's resourceLimits without any error.
    setFlagsFromString("--max-old-space-size=8192");
    // A sample taken before the worker is running rejects; sampling must go on.
    const sample = vi.spyOn(Worker.prototype, "getHeapStatistics")
      .mockRejectedValueOnce(new Error("Worker instance not running"));
    try {
      expect(await workerHeapSizeLimitMb(smallHeap)).toBeGreaterThanOrEqual(8_192);

      await expectResourceLimit("heap", () => parseDocumentContained({ format: "xlsx", bytes }, smallHeap));
      expect(sample.mock.calls.length).toBeGreaterThan(1);
    } finally {
      sample.mockRestore();
      // V8's default; the other tests pass with the flag or without it.
      setFlagsFromString("--max-old-space-size=0");
    }
  });

  it("stops a parse whose process memory grows past the watchdog limit", async () => {
    // Let earlier workers exit, then make the watchdog sample deterministic
    // instead of depending on allocator and GC timing on the test runner.
    await Promise.all([...liveWorkers].map((worker) => once(worker, "exit")));
    const baselineRss = process.memoryUsage.rss();
    let rssSamples = 0;
    const rss = vi.spyOn(process.memoryUsage, "rss").mockImplementation(() => {
      rssSamples += 1;
      return baselineRss + (rssSamples > 1 ? 2 : 0);
    });
    try {
      await expectResourceLimit("rss", () => parseDocumentContained({
        format: "html",
        bytes: new TextEncoder().encode("<p>Hi</p>"),
      }, { rssGrowthLimitBytes: 1, rssPollIntervalMs: 1 }));
      expect(rssSamples).toBeGreaterThan(1);
    } finally {
      rss.mockRestore();
    }
  });

  it("runs at most two parses at once", async () => {
    const bytes = await quadraticWorkbook();
    const timeoutMs = 1_000;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const started = Date.now();
      const settledAfter = await Promise.all([0, 1, 2].map(async () => {
        await expect(parseDocumentContained({ format: "xlsx", bytes }, { timeoutMs }))
          .rejects.toMatchObject({ code: "extraction_resource_limit" });
        return Date.now() - started;
      }));

      // The third parse cannot start its clock until one of the first two has exited.
      expect(warn).toHaveBeenCalledTimes(3);
      expect(Math.max(...settledAfter)).toBeGreaterThanOrEqual(timeoutMs * 2 - 50);
    } finally {
      warn.mockRestore();
    }
  });

  it("uses the documented default limits", () => {
    expect(DEFAULT_DOCUMENT_PARSE_LIMITS).toEqual({
      timeoutMs: 30_000,
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      rssGrowthLimitBytes: 640 * 1024 * 1024,
      rssPollIntervalMs: 25,
    });
  });

  it("accepts only well-formed worker messages", () => {
    const scanned = (pages: Array<{ pageNumber: number; dataUrl: string }>) => ({
      ok: true,
      result: { kind: "pdf_scanned", pageCount: pages.length, pages },
    });

    expect(documentParseWorkerMessageSchema.safeParse(scanned([
      { pageNumber: 1, dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      { pageNumber: 2, dataUrl: "" },
    ])).success).toBe(true);
    expect(documentParseWorkerMessageSchema.safeParse(scanned([
      { pageNumber: 1, dataUrl: "https://example.com/page.png" },
    ])).success).toBe(false);
    expect(documentParseWorkerMessageSchema.safeParse(scanned(Array.from(
      { length: MAX_PDF_OCR_PAGES + 1 },
      (_value, index) => ({ pageNumber: index + 1, dataUrl: "" }),
    ))).success).toBe(false);
    expect(documentParseWorkerMessageSchema.safeParse({
      ok: false,
      error: { message: "Nope.", status: 500, code: "archive_too_large" },
      errorName: "DocumentParseError",
    }).success).toBe(false);
    expect(documentParseWorkerMessageSchema.safeParse({
      ok: false,
      error: { message: "Nope.", status: 413, code: "Not A Code" },
      errorName: "DocumentParseError",
    }).success).toBe(false);
    expect(documentParseWorkerMessageSchema.safeParse({ ok: false, error: null, errorName: "FormatError" }).success).toBe(true);
    expect(documentParseWorkerMessageSchema.safeParse({
      ok: false,
      error: null,
      errorName: "Row 3: quarterly salaries",
    }).success).toBe(false);
  });

  it("logs only the name of an unexpected parser failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(parseDocumentContained({ format: "xlsx", bytes: new TextEncoder().encode("not an archive") }))
        .rejects.toThrow("Document parser could not read this document.");
      expect(warn).toHaveBeenCalledWith("Document parser could not read this document.", "Error");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("capture files through the contained parser", () => {
  it("extracts PDF text pages as page evidence", async () => {
    const result = await extractCaptureFile(new File([Buffer.from(textPdf("Hello worker"))], "paper.pdf"));

    expect(result.content).toBe("Hello worker");
    expect(result.extraction.units.map((unit) => unit.locator)).toEqual([
      { kind: "page", pageNumber: 1, pageCount: 1 },
    ]);
  });

  it("routes scanned PDFs to OCR instead of reporting them as unreadable", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(extractCaptureFile(new File([Buffer.from(scannedPdf())], "scan.pdf"))).rejects.toMatchObject({
        status: 503,
        code: "ocr_not_configured",
      });
    } finally {
      if (previous) process.env.OPENAI_API_KEY = previous;
    }
  });

  it("rejects spreadsheets whose entries inflate past small declared sizes", async () => {
    const workbook = withDeclaredSizes(await zipArchive({
      "xl/worksheets/sheet1.xml": `<worksheet>${" ".repeat(MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1024)}</worksheet>`,
    }, "DEFLATE"), 64);

    await expect(extractCaptureFile(new File([Buffer.from(workbook)], "status.xlsx"))).rejects.toMatchObject({
      status: 413,
      code: "archive_too_large",
      format: "xlsx",
    });
  });

  it("bounds every DOCX part before mammoth reads the document", async () => {
    const JSZip = (await import("jszip")).default;
    const docx = await JSZip.loadAsync(await readFile("node_modules/mammoth/test/test-data/tables.docx"));
    docx.file("word/media/padding.bin", new Uint8Array(MAX_ARCHIVE_UNCOMPRESSED_BYTES));
    const bytes = withDeclaredSizes(await docx.generateAsync({ type: "uint8array", compression: "DEFLATE" }), 64);

    await expect(extractCaptureFile(new File([Buffer.from(bytes)], "padded.docx"))).rejects.toMatchObject({
      status: 413,
      code: "archive_too_large",
      format: "docx",
    });
  });

  it("strips HTML markup before indexing", async () => {
    const result = await extractCaptureFile(new File([
      "<html><script>alert(1)</script><body><h1>Launch</h1><p>Moved to Friday.</p></body></html>",
    ], "update.html", { type: "text/html" }));

    expect(result.content).toBe("Launch\nMoved to Friday.");
  });
});

async function expectResourceLimit(limit: "timeout" | "rss" | "heap", parse: () => Promise<unknown>) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await expect(parse()).rejects.toMatchObject({ status: 413, code: "extraction_resource_limit" });
    expect(warn).toHaveBeenCalledWith("Document parser stopped at a resource limit.", limit);
  } finally {
    warn.mockRestore();
  }
}

async function zipArchive(files: Record<string, string>, compression: "STORE" | "DEFLATE" = "STORE") {
  const JSZip = (await import("jszip")).default;
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "uint8array", compression });
}

/** Rewrites every entry's declared uncompressed size in both ZIP headers. */
function withDeclaredSizes(zip: Uint8Array, declaredBytes: number) {
  const bytes = Buffer.from(zip);
  const directoryEnd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entryCount = bytes.readUInt16LE(directoryEnd + 10);
  let offset = bytes.readUInt32LE(directoryEnd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    bytes.writeUInt32LE(declaredBytes, offset + 24);
    bytes.writeUInt32LE(declaredBytes, bytes.readUInt32LE(offset + 42) + 22);
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return new Uint8Array(bytes);
}

/** Unclosed rows make the row pattern rescan the rest of the sheet from every start. */
function quadraticWorkbook() {
  return zipArchive({ "xl/worksheets/sheet1.xml": "<row>".repeat(100_000) });
}

/**
 * Fits the expansion budget, but every closed row becomes a live match, and
 * the unclosed rows after them keep those matches live while the pattern
 * rescans, so the parse cannot finish before a heap limit stops it.
 */
function heapHoldingWorkbook() {
  return zipArchive({
    "xl/worksheets/sheet1.xml": `${"<row></row>".repeat(1_000_000)}${"<row>".repeat(100_000)}`,
  }, "DEFLATE");
}

/** The heap limit V8 actually gives a worker started with these resourceLimits. */
async function workerHeapSizeLimitMb(resourceLimits: ResourceLimits) {
  const worker = new Worker(
    "require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit)",
    { eval: true, resourceLimits },
  );
  const [limitBytes] = await once(worker, "message");
  return limitBytes / 1024 / 1024;
}

function textPdf(text: string) {
  return minimalPdf(`BT /F1 24 Tf 20 100 Td (${text}) Tj ET`, "/Font << /F1 5 0 R >>");
}

function scannedPdf() {
  return minimalPdf("0 0 1 rg 20 20 160 160 re f");
}

function minimalPdf(pageContent: string, resources = "") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << ${resources} >> /Contents 4 0 R >>`,
    `<< /Length ${pageContent.length} >>\nstream\n${pageContent}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
