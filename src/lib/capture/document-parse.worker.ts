/**
 * Contained document parser.
 *
 * PDF, DOCX, office and ebook archive, and markup parsing runs here, inside a
 * worker thread that `document-parse.ts` starts with heap limits, an RSS
 * watchdog, a wall-clock timeout, and an empty environment. ZIP entries are
 * inflated against one shared output budget instead of the sizes an archive
 * declares.
 *
 * Node loads this file directly in tests (native type stripping) and
 * Turbopack emits it as its own worker chunk, so it must stay self-contained:
 * runtime imports only from packages and `node:` builtins, `import type` for
 * app modules, and erasable TypeScript only (no enums, namespaces, or
 * constructor parameter properties). The main thread imports the pure helpers
 * too; package imports stay lazy so that costs nothing.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { inflateRawSync } from "node:zlib";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParseWorkerMessage,
  ParsedDocumentUnit,
} from "@/lib/capture/document-parse";

export const DOCUMENT_PARSE_WORKER_KIND = "asael.capture.document-parse.v1";
export const MAX_ARCHIVE_ENTRIES = 1_000;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
/** Mirrors MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS, which this file cannot import. */
export const MAX_PARSED_UNIT_CHARACTERS = 24_000;
const MAX_PDF_TEXT_PAGES = 100;
export const MAX_PDF_OCR_PAGES = 10;
const MAX_PDF_IMAGE_PIXELS = 40_000_000;
const MAX_EPUB_PAGES = 300;

const archiveDocumentFormats = new Set(["xlsx", "xlsm", "pptx", "ppsx", "odt", "ods", "odp", "epub"]);
const markupFormats = new Set(["html", "htm", "xml"]);

export type DocumentParseErrorStatus = 400 | 413 | 415 | 503;

export class DocumentParseError extends Error {
  readonly status: DocumentParseErrorStatus;
  readonly code: string;

  constructor(message: string, status: DocumentParseErrorStatus, code: string) {
    super(message);
    this.name = "DocumentParseError";
    this.status = status;
    this.code = code;
  }
}

type ArchiveFile = Readonly<{
  name: string;
  method: "store" | "deflate";
  compressed: Uint8Array;
  declaredBytes: number;
}>;

type BoundedArchive = Readonly<{
  files: ArchiveFile[];
  readBytes(file: ArchiveFile): Uint8Array;
  readText(file: ArchiveFile): string;
}>;

export async function parseDocument(request: DocumentParseRequest): Promise<DocumentParseResult> {
  const { format, bytes } = request;
  if (format === "pdf") return parsePdf(bytes, request.renderScannedPdfPages === true);
  if (format === "docx") return { kind: "text", content: await parseDocx(bytes) };
  if (markupFormats.has(format)) {
    return { kind: "text", content: stripMarkup(new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()) };
  }
  if (!archiveDocumentFormats.has(format)) {
    throw new DocumentParseError(`.${format} files are not parsed as documents.`, 415, "unsupported_format");
  }
  const archive = await openBoundedArchive(bytes);
  if (format === "xlsx" || format === "xlsm") return parseSpreadsheetArchive(archive);
  if (format === "pptx" || format === "ppsx") return parsePresentationArchive(archive);
  if (format === "epub") return parseEpubArchive(archive);
  return parseOpenDocumentArchive(archive, format);
}

async function parsePdf(bytes: Uint8Array, renderScannedPages: boolean): Promise<DocumentParseResult> {
  await installPdfCanvasGlobals();
  // Without a registered handler pdf.js imports "./pdf.worker.mjs" next to the
  // running chunk, which bundles do not ship. Loading the worker module first
  // registers its in-thread handler on globalThis.pdfjsWorker.
  // @ts-expect-error pdfjs-dist publishes no declarations for its worker entry.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({
    // pdf.js takes ownership of the array it is given.
    data: bytes.slice(),
    verbosity: 0,
    isEvalSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
  });
  try {
    if (renderScannedPages) {
      const screenshots = await parser.getScreenshot({
        first: MAX_PDF_OCR_PAGES,
        desiredWidth: 1600,
        imageDataUrl: true,
        imageBuffer: false,
      });
      return {
        kind: "pdf_scanned",
        pageCount: screenshots.total,
        pages: screenshots.pages.map((page) => ({ pageNumber: page.pageNumber, dataUrl: page.dataUrl || "" })),
      };
    }
    const result = await parser.getText({ first: MAX_PDF_TEXT_PAGES, parseHyperlinks: false });
    // result.text carries "-- n of total --" page markers, so it is never empty.
    if (!result.pages.some((page) => page.text.trim())) return { kind: "pdf_scanned", pageCount: result.total, pages: [] };
    const warnings = new Set<string>();
    if (result.total > result.pages.length) warnings.add("pdf_page_limit");
    const units = result.pages.flatMap((page): ParsedDocumentUnit[] => {
      const bounded = boundedUnitText(page.text, warnings, "pdf_page_truncated");
      return bounded ? [{
        label: `Page ${page.num}`,
        content: bounded,
        locator: {
          kind: "page",
          pageNumber: page.num,
          pageCount: result.total || null,
        },
      }] : [];
    });
    if (units.length < result.pages.length) warnings.add("pdf_empty_pages");
    return unitsResult("document", warnings, units);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * pdf.js needs DOMMatrix, ImageData, and Path2D even for text, and polyfills
 * them from @napi-rs/canvas through a require that file tracing cannot see, so
 * deployments shipped without the native binding and every PDF failed with
 * "DOMMatrix is not defined". Importing it by name lets tracing ship it (it is
 * a server external in next.config.ts); pdf.js keeps globals that exist.
 */
async function installPdfCanvasGlobals() {
  const canvas = await import("@napi-rs/canvas").catch(() => {
    // Without it no PDF can be read, so this is an outage, not a bad document.
    throw new DocumentParseError("PDF extraction is temporarily unavailable.", 503, "extraction_unavailable");
  });
  const globals = globalThis as { DOMMatrix?: unknown; ImageData?: unknown; Path2D?: unknown };
  globals.DOMMatrix ??= canvas.DOMMatrix;
  globals.ImageData ??= canvas.ImageData;
  globals.Path2D ??= canvas.Path2D;
}

async function parseDocx(bytes: Uint8Array) {
  const archive = await openBoundedArchive(bytes);
  const JSZip = (await import("jszip")).default;
  // mammoth inflates parts through JSZip with no output limit, so it gets an
  // uncompressed copy assembled from bounded reads.
  const stored = new JSZip();
  for (const file of archive.files) stored.file(file.name, archive.readBytes(file), { binary: true });
  const buffer = await stored.generateAsync({ type: "nodebuffer", compression: "STORE" });
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function openBoundedArchive(bytes: Uint8Array): Promise<BoundedArchive> {
  const JSZip = (await import("jszip")).default;
  const archive = await JSZip.loadAsync(bytes);
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new DocumentParseError("This document archive contains too many files to process safely.", 413, "archive_too_large");
  }
  const files = entries.map(archiveFile);
  const declaredBytes = files.reduce((sum, file) => sum + file.declaredBytes, 0);
  if (declaredBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw expandedArchiveTooLarge();
  let remainingBytes = MAX_ARCHIVE_UNCOMPRESSED_BYTES;
  const readBytes = (file: ArchiveFile) => {
    const inflated = inflateArchiveFile(file, remainingBytes);
    remainingBytes -= inflated.byteLength;
    return inflated;
  };
  return {
    files,
    readBytes,
    readText: (file) => {
      const inflated = readBytes(file);
      return Buffer.from(inflated.buffer, inflated.byteOffset, inflated.byteLength).toString("utf8");
    },
  };
}

function archiveFile(entry: Readonly<{ name: string }>): ArchiveFile {
  // JSZip parses the central directory eagerly but inflates lazily and only
  // checks sizes afterwards, so entries are inflated here from its internal
  // compressed view. Anything unexpected fails closed.
  const data = (entry as { _data?: unknown })._data as {
    compression?: { magic?: unknown };
    compressedContent?: unknown;
    uncompressedSize?: unknown;
  } | undefined;
  const magic = data?.compression?.magic;
  const method = magic === "\x00\x00" ? "store" : magic === "\x08\x00" ? "deflate" : null;
  if (!method || !(data?.compressedContent instanceof Uint8Array)) {
    throw new Error("Unsupported document archive entry.");
  }
  return {
    name: entry.name,
    method,
    compressed: data.compressedContent,
    declaredBytes: Number(data.uncompressedSize) || 0,
  };
}

function inflateArchiveFile(file: ArchiveFile, limit: number): Uint8Array {
  if (file.method === "store") {
    if (file.compressed.byteLength > limit) throw expandedArchiveTooLarge();
    return file.compressed;
  }
  let inflated: Uint8Array;
  try {
    inflated = inflateRawSync(file.compressed, { maxOutputLength: Math.max(1, limit) });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_BUFFER_TOO_LARGE") throw expandedArchiveTooLarge();
    throw error;
  }
  if (inflated.byteLength > limit) throw expandedArchiveTooLarge();
  return inflated;
}

function expandedArchiveTooLarge() {
  return new DocumentParseError("The expanded document exceeds the 12 MB extraction safety limit.", 413, "archive_too_large");
}

function parseSpreadsheetArchive(archive: BoundedArchive): DocumentParseResult {
  const sharedEntry = archive.files.find((file) => file.name === "xl/sharedStrings.xml");
  const sharedStrings = sharedEntry ? xmlTextRuns(archive.readText(sharedEntry), "t") : [];
  const sheets = naturalSort(archive.files.filter((file) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(file.name)));
  const units: ParsedDocumentUnit[] = [];
  const warnings = new Set<string>();
  for (const [index, sheet] of sheets.entries()) {
    const xml = archive.readText(sheet);
    const rows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)].flatMap((row, rowIndex) => {
      const rowNumber = Number(row[1].match(/\br=["'](\d+)["']/i)?.[1] || rowIndex + 1);
      const cells = [...row[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].map((cell) => {
        const attributes = cell[1];
        const body = cell[2];
        const raw = body.match(/<v>([\s\S]*?)<\/v>/i)?.[1] || xmlTextRuns(body, "t").join(" ");
        const value = /\bt=["']s["']/i.test(attributes) ? sharedStrings[Number(raw)] || raw : raw;
        const reference = attributes.match(/\br=["']([A-Z]+)\d+["']/i)?.[1];
        return { value: decodeXml(value).trim(), column: reference ? spreadsheetColumnNumber(reference) : 0 };
      });
      const content = cells.map((cell) => cell.value).join("\t").trim();
      return content ? [{ rowNumber, content, columnCount: Math.max(cells.length, ...cells.map((cell) => cell.column)) }] : [];
    });
    if (!rows.length) continue;
    const sheetRowCount = Math.max(...rows.map((row) => row.rowNumber));
    const sheetColumnCount = Math.max(1, ...rows.map((row) => row.columnCount));
    const groups = groupSpreadsheetRows(rows);
    for (const [groupIndex, group] of groups.entries()) {
      const content = boundedUnitText(
        `Sheet ${index + 1}\n${group.map((row) => row.content).join("\n")}`,
        warnings,
        "spreadsheet_range_truncated",
      );
      units.push({
        label: `Sheet ${index + 1}, range ${groupIndex + 1}`,
        content,
        locator: {
          kind: "sheet_range",
          sheetKey: sheet.name,
          startRow: group[0].rowNumber,
          endRowExclusive: group[group.length - 1].rowNumber + 1,
          startColumn: 1,
          endColumnExclusive: sheetColumnCount + 1,
          sheetRowCount,
          sheetColumnCount,
        },
      });
    }
  }
  return unitsResult("spreadsheet", warnings, units);
}

function parsePresentationArchive(archive: BoundedArchive): DocumentParseResult {
  const slides = naturalSort(archive.files.filter((file) => /^ppt\/slides\/slide\d+\.xml$/i.test(file.name)));
  const units: ParsedDocumentUnit[] = [];
  const warnings = new Set<string>();
  for (const [index, slide] of slides.entries()) {
    const text = xmlTextRuns(archive.readText(slide), "t").join("\n").trim();
    if (text) units.push({
      label: `Slide ${index + 1}`,
      content: boundedUnitText(`Slide ${index + 1}\n${text}`, warnings, "slide_text_truncated"),
      locator: {
        kind: "slide",
        slideNumber: index + 1,
        slideCount: slides.length,
        elementKeySha256: null,
      },
    });
  }
  return unitsResult("presentation", warnings, units);
}

function parseOpenDocumentArchive(archive: BoundedArchive, format: string): DocumentParseResult {
  const content = archive.files.find((file) => file.name === "content.xml");
  if (!content) throw new Error("OpenDocument content is missing.");
  const xml = archive.readText(content);
  if (format === "ods") return parseOpenDocumentSheets(xml);
  if (format === "odp") return parseOpenDocumentSlides(xml);
  return { kind: "text", content: stripMarkup(xml) };
}

function parseEpubArchive(archive: BoundedArchive): DocumentParseResult {
  const pageFiles = archive.files.filter((file) => /\.(?:xhtml|html|htm)$/i.test(file.name));
  const pages = naturalSort(pageFiles).slice(0, MAX_EPUB_PAGES);
  const units: ParsedDocumentUnit[] = [];
  const warnings = new Set<string>();
  const totalPages = pageFiles.length;
  if (totalPages > pages.length) warnings.add("epub_page_limit");
  for (const page of pages) {
    const text = stripMarkup(archive.readText(page));
    if (text) units.push({
      label: `Page ${units.length + 1}`,
      content: boundedUnitText(text, warnings, "epub_page_truncated"),
      locator: {
        kind: "page",
        pageNumber: units.length + 1,
        pageCount: totalPages || null,
      },
    });
  }
  return unitsResult("document", warnings, units);
}

function parseOpenDocumentSheets(xml: string): DocumentParseResult {
  const tables = [...xml.matchAll(/<table:table\b[^>]*>([\s\S]*?)<\/table:table>/gi)];
  const units: ParsedDocumentUnit[] = [];
  for (const [tableIndex, table] of tables.entries()) {
    const rows = [...table[1].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/gi)].flatMap((row, rowIndex) => {
      const cells = [...row[1].matchAll(/<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/gi)]
        .map((cell) => stripMarkup(cell[1]));
      const content = cells.join("\t").trim();
      return content ? [{ rowNumber: rowIndex + 1, content, columnCount: Math.max(1, cells.length) }] : [];
    });
    if (!rows.length) continue;
    const columnCount = Math.max(1, ...rows.map((row) => row.columnCount));
    for (const [groupIndex, group] of groupSpreadsheetRows(rows).entries()) {
      units.push({
        label: `Sheet ${tableIndex + 1}, range ${groupIndex + 1}`,
        content: `Sheet ${tableIndex + 1}\n${group.map((row) => row.content).join("\n")}`,
        locator: {
          kind: "sheet_range",
          sheetKey: `ods-sheet-${tableIndex + 1}`,
          startRow: group[0].rowNumber,
          endRowExclusive: group[group.length - 1].rowNumber + 1,
          startColumn: 1,
          endColumnExclusive: columnCount + 1,
          sheetRowCount: rows.length,
          sheetColumnCount: columnCount,
        },
      });
    }
  }
  return unitsResult("spreadsheet", new Set(), units);
}

function parseOpenDocumentSlides(xml: string): DocumentParseResult {
  const slides = [...xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/gi)];
  return unitsResult("presentation", new Set(), slides.flatMap((slide, index): ParsedDocumentUnit[] => {
    const content = stripMarkup(slide[1]);
    return content ? [{
      label: `Slide ${index + 1}`,
      content: `Slide ${index + 1}\n${content}`,
      locator: {
        kind: "slide",
        slideNumber: index + 1,
        slideCount: slides.length,
        elementKeySha256: null,
      },
    }] : [];
  }));
}

function unitsResult(
  sourceKind: "document" | "spreadsheet" | "presentation",
  warnings: Set<string>,
  units: ParsedDocumentUnit[],
): DocumentParseResult {
  return {
    kind: "units",
    sourceKind,
    state: warnings.size ? "partial" : "completed",
    warningCodes: [...warnings],
    units,
  };
}

export function groupSpreadsheetRows<T extends { rowNumber: number; content: string }>(rows: T[]) {
  const groups: T[][] = [];
  let current: T[] = [];
  let characters = 0;
  for (const row of rows) {
    if (current.length && (current.length >= 50 || characters + row.content.length + 1 > 20_000)) {
      groups.push(current);
      current = [];
      characters = 0;
    }
    current.push(row);
    characters += row.content.length + 1;
  }
  if (current.length) groups.push(current);
  return groups;
}

export function boundedUnitText(
  value: string,
  warnings: Set<string>,
  warningCode: string,
) {
  const normalized = value.trim();
  if (normalized.length <= MAX_PARSED_UNIT_CHARACTERS) return normalized;
  warnings.add(warningCode);
  return normalized.slice(0, MAX_PARSED_UNIT_CHARACTERS);
}

function spreadsheetColumnNumber(value: string) {
  return value.toUpperCase().split("").reduce((result, character) => (
    result * 26 + character.charCodeAt(0) - 64
  ), 0);
}

function stripMarkup(value: string) {
  return decodeXml(value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|text:p|table:table-row)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function xmlTextRuns(value: string, tag: string) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, "gi");
  return [...value.matchAll(pattern)].map((match) => decodeXml(match[1].replace(/<[^>]+>/g, "")).trim()).filter(Boolean);
}

function decodeXml(value: string) {
  return value.replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'");
}

function naturalSort<T extends { name: string }>(values: T[]) {
  return values.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

function isDocumentParseWorkerData(value: unknown): value is Readonly<{ kind: string; request: DocumentParseRequest }> {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === DOCUMENT_PARSE_WORKER_KIND);
}

if (!isMainThread && parentPort && isDocumentParseWorkerData(workerData)) {
  const port = parentPort;
  parseDocument(workerData.request).then(
    (result) => port.postMessage({ ok: true, result } satisfies DocumentParseWorkerMessage),
    (error: unknown) => port.postMessage({
      ok: false,
      error: error instanceof DocumentParseError
        ? { message: error.message, status: error.status, code: error.code }
        : null,
      // Only the name: messages can quote document content.
      errorName: error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : "UnknownError",
    } satisfies DocumentParseWorkerMessage),
  );
}
