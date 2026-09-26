import {
  finalizeCaptureExtraction,
  MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS,
  MAX_CAPTURE_EXTRACTION_UNITS,
  renderCaptureExtractionUnits,
  type CaptureExtractionDraftUnit,
  type CaptureStructuredExtraction,
} from "@/lib/capture/extraction";
import { parseDocumentContained, type DocumentParseResult } from "@/lib/capture/document-parse";
import {
  boundedUnitText,
  DocumentParseError,
  groupSpreadsheetRows,
} from "@/lib/capture/document-parse.worker";
import {
  CAPTURE_VIDEO_TYPES,
  transcribeCaptureMedia,
} from "@/lib/capture/transcription";
import { extractTextFromImages, imageOcrConfigured } from "@/lib/openai/ocr";
import { chunkText } from "@/lib/rag/chunk";
import { sourceContractSha256 } from "@/lib/sources/contracts";
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
const audioExtensions = new Set(["mp3", "m4a", "wav", "ogg"]);
const videoExtensions = new Set(["mp4", "webm"]);
const archiveDocumentExtensions = new Set(["xlsx", "xlsm", "pptx", "ppsx", "odt", "ods", "odp", "epub"]);
const markupExtensions = new Set(["html", "htm", "xml"]);
const supportedExtensions = new Set([...textExtensions, ...personalDataExtensions, ...imageExtensions, ...audioExtensions, ...videoExtensions, ...archiveDocumentExtensions, "pdf", "docx"]);
const legacyOfficeExtensions = new Set(["doc", "xls", "ppt"]);
const MAX_EXTRACTED_CHARACTERS = 900_000;

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
  let extraction: CaptureStructuredExtraction;
  try {
    if (extension === "pdf") extraction = await extractPdf(bytes, usageScope);
    else if (extension === "docx" || archiveDocumentExtensions.has(extension)) extraction = await extractContainedDocument(bytes, extension);
    else if (imageExtensions.has(extension)) extraction = await extractImage(bytes, extension, usageScope);
    else if (audioExtensions.has(extension) || videoExtensions.has(extension)) extraction = await extractMedia(file, extension, usageScope);
    else if (extension === "eml") extraction = extractEmail(bytes, extension);
    else if (extension === "ics") extraction = textExtraction(extractCalendarText(bytes), extension, "calendar_event");
    else if (extension === "rtf") extraction = textExtraction(extractRtfText(bytes), extension, "document");
    else if (extension === "vcf") extraction = textExtraction(extractContactText(bytes), extension, "record");
    else if (extension === "ipynb") extraction = textExtraction(extractNotebookText(bytes), extension, "document");
    else {
      if (bytes.includes(0)) throw new CaptureFileError("The selected text file appears to be binary.", 415, "binary_text", extension);
      if (markupExtensions.has(extension)) {
        extraction = await extractContainedDocument(bytes, extension);
      } else {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
        if (extension === "srt" || extension === "vtt") {
          extraction = extractTimedTranscript(content, extension)
            || textExtraction(content, extension, "video");
        } else {
          extraction = extension === "csv" || extension === "tsv"
            ? extractDelimitedText(content, extension)
            : textExtraction(content, extension, "document");
        }
      }
    }
  } catch (error) {
    if (error instanceof CaptureFileError) throw error;
    if (error instanceof DocumentParseError) throw new CaptureFileError(error.message, error.status, error.code, extension);
    throw new CaptureFileError(`Could not extract readable text from this ${extension.toUpperCase()} file.`, 400, "extraction_failed", extension);
  }
  const content = renderCaptureExtractionUnits(extraction.units).trim();
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
    extraction,
  };
}

function extractEmail(bytes: Uint8Array, format: string) {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
  const [rawHeaders, ...bodyParts] = raw.split("\n\n");
  const headers = rawHeaders.replace(/\n[ \t]+/g, " ").split("\n").reduce<Record<string, string>>((result, line) => {
    const separator = line.indexOf(":");
    if (separator > 0) result[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    return result;
  }, {});
  const body = bodyParts.join("\n\n").trim();
  const headerText = [
    headers.subject ? `Subject: ${headers.subject}` : "",
    headers.from ? `From: ${headers.from}` : "",
    headers.to ? `To: ${headers.to}` : "",
    headers.date ? `Date: ${headers.date}` : "",
  ].filter(Boolean).join("\n").trim();
  return finalizeCaptureExtraction({
    sourceKind: "email",
    format,
    units: [
      ...(headerText ? [{
        label: "Email headers",
        content: headerText,
        locator: {
          kind: "email_section" as const,
          section: "headers" as const,
          sectionIndex: 0,
          partKeySha256: sourceContractSha256("headers"),
        },
      }] : []),
      ...(body ? [{
        label: "Email body",
        content: body,
        locator: {
          kind: "email_section" as const,
          section: "body" as const,
          sectionIndex: 0,
          partKeySha256: sourceContractSha256("body"),
        },
      }] : []),
    ],
  });
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

async function extractPdf(bytes: Uint8Array, usageScope?: AiUsageScope) {
  const parsed = await parseDocumentContained({ format: "pdf", bytes });
  if (parsed.kind === "units") return finalizeParsedUnits(parsed, "pdf");
  if (parsed.kind !== "pdf_scanned") throw new Error("The document parser returned an unexpected PDF result.");
  if (!await imageOcrConfigured(usageScope)) {
    throw new CaptureFileError("This PDF appears to be scanned and OCR is not configured.", 503, "ocr_not_configured", "pdf");
  }
  // Pages are rendered only once OCR is known to be available, so a second
  // contained parse is the price of not rendering scans that cannot be read.
  const rendered = await parseDocumentContained({ format: "pdf", bytes, renderScannedPdfPages: true });
  if (rendered.kind !== "pdf_scanned") throw new Error("The document parser returned an unexpected PDF result.");
  const warnings = new Set<string>(["pdf_scanned_ocr"]);
  if (parsed.pageCount > rendered.pages.length) warnings.add("pdf_ocr_page_limit");
  const units: CaptureExtractionDraftUnit[] = [];
  for (const page of rendered.pages) {
    if (!page.dataUrl) continue;
    const text = boundedUnitText(
      await extractImageTextOrThrow([page.dataUrl], usageScope, "pdf"),
      warnings,
      "pdf_page_truncated",
    );
    if (!text) continue;
    units.push({
      label: `Page ${page.pageNumber}`,
      content: text,
      locator: {
        kind: "page",
        pageNumber: page.pageNumber,
        pageCount: parsed.pageCount || null,
      },
    });
  }
  return finalizeCaptureExtraction({
    sourceKind: "document",
    format: "pdf",
    state: warnings.size > 1 ? "partial" : "completed",
    warningCodes: [...warnings],
    units,
  });
}

async function extractContainedDocument(bytes: Uint8Array, format: string) {
  const parsed = await parseDocumentContained({ format, bytes });
  if (parsed.kind === "text") return textExtraction(parsed.content, format, "document");
  if (parsed.kind !== "units") throw new Error("The document parser returned an unexpected result.");
  return finalizeParsedUnits(parsed, format);
}

function finalizeParsedUnits(parsed: Extract<DocumentParseResult, { kind: "units" }>, format: string) {
  return finalizeCaptureExtraction({
    sourceKind: parsed.sourceKind,
    format,
    state: parsed.state,
    warningCodes: parsed.warningCodes,
    units: parsed.units.map((unit): CaptureExtractionDraftUnit => {
      const { locator } = unit;
      if (locator.kind !== "sheet_range") return { ...unit, locator };
      const { sheetKey, ...range } = locator;
      return { ...unit, locator: { ...range, sheetKeySha256: sourceContractSha256(sheetKey) } };
    }),
  });
}

async function extractImage(bytes: Uint8Array, extension: string, usageScope?: AiUsageScope) {
  if (!await imageOcrConfigured(usageScope)) {
    throw new CaptureFileError("Image OCR is not configured.", 503, "ocr_not_configured", extension);
  }
  const mediaType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
  const dimensions = imageDimensions(bytes, extension);
  const warnings = new Set<string>();
  const content = boundedUnitText(await extractImageTextOrThrow(
    [`data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`],
    usageScope,
    extension,
  ), warnings, "image_ocr_truncated");
  return finalizeCaptureExtraction({
    sourceKind: "image",
    format: extension,
    state: warnings.size ? "partial" : "completed",
    warningCodes: [...warnings],
    units: [{
      label: "Image region 1",
      content,
      locator: {
        kind: "image_region",
        coordinateUnit: "pixel",
        x: 0,
        y: 0,
        width: dimensions.width,
        height: dimensions.height,
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
      },
    }],
  });
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

async function extractMedia(
  file: File,
  format: string,
  usageScope?: AiUsageScope,
) {
  const result = await transcribeCaptureMedia(file, undefined, usageScope);
  const mediaKind = CAPTURE_VIDEO_TYPES.has(file.type.split(";", 1)[0].toLowerCase())
    ? "video" as const
    : "audio" as const;
  const warnings = new Set<string>();
  const units = result.segments.flatMap((segment, index) => {
    const content = boundedUnitText(segment.text, warnings, "media_segment_truncated");
    if (!content) return [];
    return [{
      label: `${mediaKind === "video" ? "Video" : "Audio"} segment ${index + 1}`,
      content,
      locator: {
        kind: "media_time_range" as const,
        mediaKind,
        startMilliseconds: segment.startMilliseconds,
        endMillisecondsExclusive: Math.min(
          result.durationMs,
          Math.max(segment.startMilliseconds + 1, segment.endMilliseconds),
        ),
        durationMilliseconds: result.durationMs,
      },
    }];
  });
  if (!units.length) {
    throw new CaptureFileError("No timestamped speech could be extracted from this media file.", 400, "no_timestamped_speech", format);
  }
  return finalizeCaptureExtraction({
    sourceKind: mediaKind,
    format,
    state: warnings.size ? "partial" : "completed",
    warningCodes: [...warnings],
    units,
  });
}

async function extractImageTextOrThrow(
  images: string[],
  usageScope: AiUsageScope | undefined,
  format: string,
) {
  try {
    return await extractTextFromImages(images, usageScope);
  } catch (error) {
    if (error instanceof Error && error.message === "OCR is not configured.") {
      throw new CaptureFileError(
        "Image OCR is not configured.",
        503,
        "ocr_not_configured",
        format,
      );
    }
    throw error;
  }
}

function textExtraction(
  content: string,
  format: string,
  sourceKind: "document" | "calendar_event" | "record" | "video",
) {
  return finalizeCaptureExtraction({
    sourceKind,
    format,
    units: chunkText(content).map((chunk) => ({
      label: `Text span ${chunk.index + 1}`,
      content: chunk.content,
      locator: { kind: "text_span" },
    })),
  });
}

type TimedTranscriptCue = Readonly<{
  cueNumber: number;
  startMilliseconds: number;
  endMilliseconds: number;
  content: string;
}>;

type TimedTranscriptFragment = TimedTranscriptCue & Readonly<{
  partNumber: number;
  partCount: number;
}>;

function extractTimedTranscript(
  content: string,
  format: "srt" | "vtt",
): CaptureStructuredExtraction | null {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;
  const blocks = normalized.split(/\n[ \t]*\n+/).map((block) => block.trim()).filter(Boolean);
  if (!blocks.length) return null;

  let firstCueBlock = 0;
  if (format === "vtt") {
    const headerLines = blocks[0].split("\n");
    if (!/^WEBVTT(?:[ \t].*)?$/.test(headerLines[0].trim())) return null;
    firstCueBlock = 1;
  }

  const cues: TimedTranscriptCue[] = [];
  let previousStartMilliseconds = -1;
  let latestEndMilliseconds = 0;
  for (let blockIndex = firstCueBlock; blockIndex < blocks.length; blockIndex += 1) {
    const lines = blocks[blockIndex].split("\n").map((line) => line.trimEnd());
    if (format === "vtt" && isWebVttMetadataBlock(lines[0])) continue;

    const timingIndexes = lines.flatMap((line, index) => line.includes("-->") ? [index] : []);
    if (timingIndexes.length !== 1) return null;
    const timingIndex = timingIndexes[0];
    if (format === "srt") {
      if (timingIndex > 1 || (timingIndex === 1 && !/^\d+$/.test(lines[0].trim()))) return null;
    } else if (timingIndex > 1) {
      return null;
    }

    const timing = parseTranscriptTimingLine(lines[timingIndex], format);
    if (!timing || timing.startMilliseconds < previousStartMilliseconds) return null;
    previousStartMilliseconds = timing.startMilliseconds;
    latestEndMilliseconds = Math.max(latestEndMilliseconds, timing.endMilliseconds);

    const cueContent = lines.slice(timingIndex + 1).join("\n").trim();
    if (!cueContent) continue;
    cues.push({
      cueNumber: cues.length + 1,
      startMilliseconds: timing.startMilliseconds,
      endMilliseconds: timing.endMilliseconds,
      content: cueContent,
    });
  }
  if (!cues.length || latestEndMilliseconds < 1) return null;

  const fragments = cues.flatMap((cue): TimedTranscriptFragment[] => {
    const parts = chunkText(cue.content, MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS, 0);
    return parts.map((part, index) => ({
      ...cue,
      content: part.content,
      partNumber: index + 1,
      partCount: parts.length,
    }));
  });
  if (!fragments.length) return null;

  const groups = fragments.length <= MAX_CAPTURE_EXTRACTION_UNITS
    ? fragments.map((fragment) => [fragment])
    : mergeTimedTranscriptFragments(fragments);
  if (!groups.length || groups.length > MAX_CAPTURE_EXTRACTION_UNITS) return null;

  return finalizeCaptureExtraction({
    sourceKind: "video",
    format,
    units: groups.map((group) => {
      const first = group[0];
      const last = group[group.length - 1];
      const singleFragment = group.length === 1;
      const partLabel = singleFragment && first.partCount > 1
        ? `, part ${first.partNumber}`
        : "";
      return {
        label: first.cueNumber === last.cueNumber
          ? `Video cue ${first.cueNumber}${partLabel}`
          : `Video cues ${first.cueNumber}-${last.cueNumber}`,
        content: group.map((fragment) => fragment.content).join("\n\n"),
        locator: {
          kind: "media_time_range" as const,
          mediaKind: "video" as const,
          startMilliseconds: first.startMilliseconds,
          endMillisecondsExclusive: Math.max(...group.map((fragment) => fragment.endMilliseconds)),
          durationMilliseconds: latestEndMilliseconds,
        },
      };
    }),
  });
}

function isWebVttMetadataBlock(value: string | undefined) {
  return /^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test((value || "").trim());
}

function parseTranscriptTimingLine(
  line: string,
  format: "srt" | "vtt",
) {
  const match = line.trim().match(/^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+.*)?$/);
  if (!match) return null;
  const startMilliseconds = parseTranscriptTimestamp(match[1], format);
  const endMilliseconds = parseTranscriptTimestamp(match[2], format);
  if (
    startMilliseconds === null
    || endMilliseconds === null
    || endMilliseconds <= startMilliseconds
  ) return null;
  return { startMilliseconds, endMilliseconds };
}

function parseTranscriptTimestamp(value: string, format: "srt" | "vtt") {
  const match = format === "srt"
    ? value.match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/)
    : value.match(/^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) return null;
  const hours = format === "srt" ? Number(match[1]) : Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (
    !Number.isSafeInteger(hours)
    || minutes < 0
    || minutes > 59
    || seconds < 0
    || seconds > 59
  ) return null;
  const result = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function mergeTimedTranscriptFragments(fragments: TimedTranscriptFragment[]) {
  const precisionGroups = packTimedTranscriptFragmentsToUnitLimit(fragments);
  return precisionGroups.length
    ? precisionGroups
    : packTimedTranscriptFragments(fragments, Number.MAX_SAFE_INTEGER);
}

function packTimedTranscriptFragmentsToUnitLimit(fragments: TimedTranscriptFragment[]) {
  const groups: TimedTranscriptFragment[][] = [];
  let cursor = 0;
  while (cursor < fragments.length && groups.length < MAX_CAPTURE_EXTRACTION_UNITS) {
    const remainingSlots = MAX_CAPTURE_EXTRACTION_UNITS - groups.length;
    const targetSize = Math.ceil((fragments.length - cursor) / remainingSlots);
    const group: TimedTranscriptFragment[] = [];
    let characters = 0;
    while (cursor < fragments.length && group.length < targetSize) {
      const fragment = fragments[cursor];
      const separatorCharacters = group.length ? 2 : 0;
      if (
        group.length
        && characters + separatorCharacters + fragment.content.length > MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS
      ) break;
      characters += separatorCharacters + fragment.content.length;
      group.push(fragment);
      cursor += 1;
    }
    groups.push(group);
  }
  return cursor === fragments.length ? groups : [];
}

function packTimedTranscriptFragments(
  fragments: TimedTranscriptFragment[],
  maxFragmentsPerGroup: number,
) {
  const groups: TimedTranscriptFragment[][] = [];
  let current: TimedTranscriptFragment[] = [];
  let characters = 0;
  for (const fragment of fragments) {
    const separatorCharacters = current.length ? 2 : 0;
    if (
      current.length
      && (
        current.length >= maxFragmentsPerGroup
        || characters + separatorCharacters + fragment.content.length > MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS
      )
    ) {
      groups.push(current);
      current = [];
      characters = 0;
    }
    characters += (current.length ? 2 : 0) + fragment.content.length;
    current.push(fragment);
  }
  if (current.length) groups.push(current);
  return groups;
}

function extractDelimitedText(content: string, format: string) {
  const delimiter = format === "tsv" ? "\t" : ",";
  const rows = content.split(/\r?\n/).map((row, index) => ({
    rowNumber: index + 1,
    content: row.trim(),
    columnCount: Math.max(1, row.split(delimiter).length),
  })).filter((row) => row.content);
  const columnCount = Math.max(1, ...rows.map((row) => row.columnCount));
  const rowCount = Math.max(1, ...rows.map((row) => row.rowNumber));
  return finalizeCaptureExtraction({
    sourceKind: "spreadsheet",
    format,
    units: groupSpreadsheetRows(rows).map((group, index) => ({
      label: `Sheet 1, range ${index + 1}`,
      content: group.map((row) => row.content).join("\n"),
      locator: {
        kind: "sheet_range",
        sheetKeySha256: sourceContractSha256("sheet-1"),
        startRow: group[0].rowNumber,
        endRowExclusive: group[group.length - 1].rowNumber + 1,
        startColumn: 1,
        endColumnExclusive: columnCount + 1,
        sheetRowCount: rowCount,
        sheetColumnCount: columnCount,
      },
    })),
  });
}

function imageDimensions(bytes: Uint8Array, extension: string) {
  if (extension === "png" && bytes.length >= 24 && Buffer.from(bytes.slice(1, 4)).toString("ascii") === "PNG") {
    return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
  }
  if ((extension === "jpg" || extension === "jpeg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          height: (bytes[offset + 5] << 8) + bytes[offset + 6],
          width: (bytes[offset + 7] << 8) + bytes[offset + 8],
        };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  if (extension === "webp" && bytes.length >= 30 && Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF") {
    const kind = Buffer.from(bytes.slice(12, 16)).toString("ascii");
    if (kind === "VP8X") {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
  }
  throw new CaptureFileError("The image dimensions could not be validated safely.", 400, "invalid_image_dimensions", extension);
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
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
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  return byMime[file.type.split(";", 1)[0].toLowerCase()] || extension;
}
