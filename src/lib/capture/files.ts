import { hasOpenAIKey } from "@/lib/config";
import { extractTextFromImages } from "@/lib/openai/ocr";
import type { AiUsageScope } from "@/lib/usage/types";

export const MAX_CAPTURE_FILE_BYTES = 5 * 1024 * 1024;

const textExtensions = new Set([
  "txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson",
  "html", "htm", "xml", "yaml", "yml", "log", "rtf", "tex", "sql",
  "js", "jsx", "ts", "tsx", "css", "scss", "sass", "less", "py", "rb",
  "go", "rs", "java", "kt", "swift", "sh", "zsh", "toml", "ini", "cfg",
  "conf", "srt", "vtt", "vcf", "ipynb",
]);
const personalDataExtensions = new Set(["eml", "ics"]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "webp"]);
const archiveDocumentExtensions = new Set(["xlsx", "xlsm", "pptx", "ppsx", "odt", "ods", "odp", "epub"]);
const supportedExtensions = new Set([...textExtensions, ...personalDataExtensions, ...imageExtensions, ...archiveDocumentExtensions, "pdf", "docx"]);
const legacyOfficeExtensions = new Set(["doc", "xls", "ppt"]);
const MAX_EXTRACTED_CHARACTERS = 900_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;

type ArchiveEntry = {
  name: string;
  dir: boolean;
  _data?: { uncompressedSize?: number };
  async(type: "string"): Promise<string>;
};

export class CaptureFileError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 | 415 | 503 = 400,
    public readonly code = "capture_file_error",
    public readonly format?: string,
  ) {
    super(message);
    this.name = "CaptureFileError";
  }
}

export function captureTitle(filename: string, fallback = "Untitled capture") {
  const clean = filename.trim().replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return clean.slice(0, 240) || fallback;
}

export async function extractCaptureFile(file: File, usageScope?: AiUsageScope) {
  if (!file.size) throw new CaptureFileError("The selected file is empty.", 400, "empty_file");
  if (file.size > MAX_CAPTURE_FILE_BYTES) throw new CaptureFileError("Files must be 5 MB or smaller.", 413, "file_too_large");
  const extension = resolveExtension(file);
  if (!supportedExtensions.has(extension)) {
    const guidance = legacyOfficeExtensions.has(extension)
      ? `Legacy .${extension.toUpperCase()} files are stored, but text extraction requires conversion to ${extension === "doc" ? "DOCX" : extension === "xls" ? "XLSX" : "PPTX"}.`
      : `.${extension || "unknown"} files are stored, but this format does not yet have a safe text extractor.`;
    throw new CaptureFileError(guidance, 415, "unsupported_format", extension || undefined);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let content: string;
  try {
    if (extension === "pdf") content = await extractPdfText(bytes, usageScope);
    else if (extension === "docx") content = await extractDocxText(bytes);
    else if (archiveDocumentExtensions.has(extension)) content = await extractArchiveDocumentText(bytes, extension);
    else if (imageExtensions.has(extension)) content = await extractImageText(bytes, extension, usageScope);
    else if (extension === "eml") content = extractEmailText(bytes);
    else if (extension === "ics") content = extractCalendarText(bytes);
    else if (extension === "rtf") content = extractRtfText(bytes);
    else if (extension === "vcf") content = extractContactText(bytes);
    else if (extension === "ipynb") content = extractNotebookText(bytes);
    else {
      if (bytes.includes(0)) throw new CaptureFileError("The selected text file appears to be binary.", 415, "binary_text", extension);
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (extension === "html" || extension === "htm" || extension === "xml") content = stripMarkup(content);
    }
  } catch (error) {
    if (error instanceof CaptureFileError) throw error;
    throw new CaptureFileError(`Could not extract readable text from this ${extension.toUpperCase()} file.`, 400, "extraction_failed", extension);
  }
  content = content.trim();
  if (!content) {
    throw new CaptureFileError(extension === "pdf" ? "This PDF has no extractable text." : "The selected file contains no readable text.", 400, "no_readable_text", extension);
  }
  if (content.length > MAX_EXTRACTED_CHARACTERS) {
    throw new CaptureFileError("Extracted document text exceeds the 900,000 character indexing limit.", 413, "extracted_text_too_large", extension);
  }
  return {
    title: captureTitle(file.name),
    content,
    source: `upload://${encodeURIComponent(file.name.slice(0, 240))}`,
    sourceType: "file" as const,
  };
}

function extractEmailText(bytes: Uint8Array) {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
  const [rawHeaders, ...bodyParts] = raw.split("\n\n");
  const headers = rawHeaders.replace(/\n[ \t]+/g, " ").split("\n").reduce<Record<string, string>>((result, line) => {
    const separator = line.indexOf(":");
    if (separator > 0) result[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    return result;
  }, {});
  const body = bodyParts.join("\n\n").trim();
  return [
    headers.subject ? `Subject: ${headers.subject}` : "",
    headers.from ? `From: ${headers.from}` : "",
    headers.to ? `To: ${headers.to}` : "",
    headers.date ? `Date: ${headers.date}` : "",
    "",
    body,
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n").trim();
}

function extractCalendarText(bytes: Uint8Array) {
  const unfolded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const fields = new Set(["SUMMARY", "DESCRIPTION", "DTSTART", "DTEND", "LOCATION", "ORGANIZER", "ATTENDEE", "STATUS", "RRULE"]);
  return unfolded.split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator < 1) return [];
    const rawName = line.slice(0, separator);
    const name = rawName.split(";", 1)[0].toUpperCase();
    if (!fields.has(name)) return [];
    const value = line.slice(separator + 1).replace(/\\n/gi, "\n").replace(/\\,/g, ",").trim();
    return value ? [`${name}: ${value}`] : [];
  }).join("\n");
}

async function extractPdfText(bytes: Uint8Array, usageScope?: AiUsageScope) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes.slice() });
  try {
    const result = await parser.getText({ first: 100, parseHyperlinks: false });
    if (result.text.trim()) return result.text;
    if (!hasOpenAIKey()) throw new CaptureFileError("This PDF appears to be scanned and OCR is not configured.", 503, "ocr_not_configured", "pdf");
    const pages = await parser.getScreenshot({ first: 10, desiredWidth: 1600, imageDataUrl: true, imageBuffer: false });
    return extractTextFromImages(
      pages.pages.map((page) => page.dataUrl).filter(Boolean),
      usageScope,
    );
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractImageText(bytes: Uint8Array, extension: string, usageScope?: AiUsageScope) {
  if (!hasOpenAIKey()) throw new CaptureFileError("Image OCR is not configured.", 503, "ocr_not_configured", extension);
  const mediaType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
  return extractTextFromImages(
    [`data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`],
    usageScope,
  );
}

async function extractDocxText(bytes: Uint8Array) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return result.value;
}

async function extractArchiveDocumentText(bytes: Uint8Array, extension: string) {
  const JSZip = (await import("jszip")).default;
  const archive = await JSZip.loadAsync(bytes);
  const files = Object.values(archive.files).filter((entry) => !entry.dir) as unknown as ArchiveEntry[];
  if (files.length > 1_000) throw new CaptureFileError("This document archive contains too many files to process safely.", 413, "archive_too_large", extension);
  const declaredBytes = files.reduce((sum, entry) => {
    return sum + Number(entry._data?.uncompressedSize || 0);
  }, 0);
  if (declaredBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new CaptureFileError("The expanded document exceeds the 12 MB extraction safety limit.", 413, "archive_too_large", extension);

  if (extension === "xlsx" || extension === "xlsm") return extractSpreadsheetArchive(files);
  if (extension === "pptx" || extension === "ppsx") return extractPresentationArchive(files);
  if (extension === "epub") return extractEpubArchive(files);
  return extractOpenDocumentArchive(files);
}

async function extractSpreadsheetArchive(files: ArchiveEntry[]) {
  const sharedEntry = files.find((entry) => entry.name === "xl/sharedStrings.xml");
  const sharedStrings = sharedEntry ? xmlTextRuns(await sharedEntry.async("string"), "t") : [];
  const sheets = naturalSort(files.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name)));
  const output: string[] = [];
  for (const [index, sheet] of sheets.entries()) {
    const xml = await sheet.async("string");
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].map((row) => {
      const cells = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].map((cell) => {
        const attributes = cell[1];
        const body = cell[2];
        const raw = body.match(/<v>([\s\S]*?)<\/v>/i)?.[1] || xmlTextRuns(body, "t").join(" ");
        const value = /\bt=["']s["']/i.test(attributes) ? sharedStrings[Number(raw)] || raw : raw;
        return decodeXml(value).trim();
      });
      return cells.join("\t").trim();
    }).filter(Boolean);
    if (rows.length) output.push(`Sheet ${index + 1}\n${rows.join("\n")}`);
    enforceArchiveTextLimit(output, "xlsx");
  }
  return output.join("\n\n");
}

async function extractPresentationArchive(files: ArchiveEntry[]) {
  const slides = naturalSort(files.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name)));
  const output: string[] = [];
  for (const [index, slide] of slides.entries()) {
    const text = xmlTextRuns(await slide.async("string"), "t").join("\n").trim();
    if (text) output.push(`Slide ${index + 1}\n${text}`);
    enforceArchiveTextLimit(output, "pptx");
  }
  return output.join("\n\n");
}

async function extractOpenDocumentArchive(files: ArchiveEntry[]) {
  const content = files.find((entry) => entry.name === "content.xml");
  if (!content) return "";
  return stripMarkup(await content.async("string"));
}

async function extractEpubArchive(files: ArchiveEntry[]) {
  const pages = naturalSort(files.filter((entry) => /\.(?:xhtml|html|htm)$/i.test(entry.name))).slice(0, 300);
  const output: string[] = [];
  for (const page of pages) {
    const text = stripMarkup(await page.async("string"));
    if (text) output.push(text);
    enforceArchiveTextLimit(output, "epub");
  }
  return output.join("\n\n");
}

function extractRtfText(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\'[0-9a-f]{2}/gi, (value) => String.fromCharCode(Number.parseInt(value.slice(2), 16)))
    .replace(/\\u(-?\d+)\??/g, (_match, value) => String.fromCharCode(Number(value) < 0 ? Number(value) + 65536 : Number(value)))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractContactText(bytes: Uint8Array) {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const fields = new Set(["FN", "N", "ORG", "TITLE", "EMAIL", "TEL", "ADR", "URL", "NOTE", "BDAY"]);
  return raw.split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator < 1) return [];
    const name = line.slice(0, separator).split(";", 1)[0].toUpperCase();
    const value = line.slice(separator + 1).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/;/g, " ").trim();
    return fields.has(name) && value ? [`${name}: ${value}`] : [];
  }).join("\n");
}

function extractNotebookText(bytes: Uint8Array) {
  const notebook = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { cells?: Array<{ cell_type?: string; source?: string | string[]; outputs?: Array<{ text?: string | string[] }> }> };
  return (notebook.cells || []).flatMap((cell, index) => {
    const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
    const outputs = (cell.outputs || []).flatMap((output) => Array.isArray(output.text) ? output.text.join("") : String(output.text || "")).filter(Boolean).join("\n");
    const content = [source.trim(), outputs.trim()].filter(Boolean).join("\nOutput:\n");
    return content ? [`Cell ${index + 1} (${cell.cell_type || "unknown"})\n${content}`] : [];
  }).join("\n\n");
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

function enforceArchiveTextLimit(parts: string[], format: string) {
  if (parts.reduce((sum, part) => sum + part.length, 0) > MAX_EXTRACTED_CHARACTERS) {
    throw new CaptureFileError("Extracted document text exceeds the 900,000 character indexing limit.", 413, "extracted_text_too_large", format);
  }
}

function resolveExtension(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (extension && extension !== file.name.toLowerCase()) return extension;
  const byMime: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/rtf": "rtf",
    "text/rtf": "rtf",
    "text/calendar": "ics",
    "text/vcard": "vcf",
    "message/rfc822": "eml",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  return byMime[file.type.split(";", 1)[0].toLowerCase()] || extension;
}
