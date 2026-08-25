const MAX_CAPTURE_FILE_BYTES = 5 * 1024 * 1024;
import { hasOpenAIKey } from "@/lib/config";
import { extractTextFromImages } from "@/lib/openai/ocr";

const textExtensions = new Set(["txt", "md", "markdown", "csv", "json", "html", "htm", "yaml", "yml"]);
const personalDataExtensions = new Set(["eml", "ics"]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "webp"]);
const supportedExtensions = new Set([...textExtensions, ...personalDataExtensions, ...imageExtensions, "pdf", "docx"]);
const MAX_EXTRACTED_CHARACTERS = 900_000;

export class CaptureFileError extends Error {
  constructor(message: string, public readonly status: 400 | 413 | 415 | 503 = 400) {
    super(message);
    this.name = "CaptureFileError";
  }
}

export function captureTitle(filename: string, fallback = "Untitled capture") {
  const clean = filename.trim().replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return clean.slice(0, 240) || fallback;
}

export async function extractCaptureFile(file: File) {
  if (!file.size) throw new CaptureFileError("The selected file is empty.");
  if (file.size > MAX_CAPTURE_FILE_BYTES) throw new CaptureFileError("Files must be 5 MB or smaller.", 413);
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!supportedExtensions.has(extension)) {
    throw new CaptureFileError("Unsupported file type. Use PDF, DOCX, EML, ICS, PNG, JPG, WebP, or a supported text format.", 415);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let content: string;
  try {
    if (extension === "pdf") content = await extractPdfText(bytes);
    else if (extension === "docx") content = await extractDocxText(bytes);
    else if (imageExtensions.has(extension)) content = await extractImageText(bytes, extension);
    else if (extension === "eml") content = extractEmailText(bytes);
    else if (extension === "ics") content = extractCalendarText(bytes);
    else {
      if (bytes.includes(0)) throw new CaptureFileError("The selected text file appears to be binary.", 415);
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    }
  } catch (error) {
    if (error instanceof CaptureFileError) throw error;
    throw new CaptureFileError(`Could not extract readable text from this ${extension.toUpperCase()} file.`);
  }
  content = content.trim();
  if (!content) {
    throw new CaptureFileError(extension === "pdf" ? "This PDF has no extractable text." : "The selected file contains no readable text.");
  }
  if (content.length > MAX_EXTRACTED_CHARACTERS) {
    throw new CaptureFileError("Extracted document text exceeds the 900,000 character indexing limit.", 413);
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

async function extractPdfText(bytes: Uint8Array) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes.slice() });
  try {
    const result = await parser.getText({ first: 100, parseHyperlinks: false });
    if (result.text.trim()) return result.text;
    if (!hasOpenAIKey()) throw new CaptureFileError("This PDF appears to be scanned and OCR is not configured.", 503);
    const pages = await parser.getScreenshot({ first: 10, desiredWidth: 1600, imageDataUrl: true, imageBuffer: false });
    return extractTextFromImages(pages.pages.map((page) => page.dataUrl).filter(Boolean));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractImageText(bytes: Uint8Array, extension: string) {
  if (!hasOpenAIKey()) throw new CaptureFileError("Image OCR is not configured.", 503);
  const mediaType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
  return extractTextFromImages([`data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`]);
}

async function extractDocxText(bytes: Uint8Array) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return result.value;
}
