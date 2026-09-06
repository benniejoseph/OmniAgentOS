import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeTextForChunking } from "@/lib/rag/chunk";
import {
  evidenceLocatorV1Schema,
  sourceContractSha256,
  sourceKindSchema,
  type EvidenceLocatorV1,
  type SourceItemV1,
} from "@/lib/sources/contracts";

export const CAPTURE_EXTRACTION_SCHEMA_VERSION = 1 as const;
export const CAPTURE_STRUCTURED_EXTRACTOR_ID = "asael.capture.structured";
export const CAPTURE_STRUCTURED_EXTRACTOR_VERSION = "1";
export const CAPTURE_STRUCTURED_EXTRACTOR_CONFIG_SHA256 = sourceContractSha256({
  schemaVersion: CAPTURE_EXTRACTION_SCHEMA_VERSION,
  maxUnits: 1_024,
  maxUnitCharacters: 24_000,
  coordinateSpaces: [
    "text_span",
    "page",
    "sheet_range",
    "slide",
    "email_section",
    "image_region",
    "media_time_range",
  ],
});
export const MAX_CAPTURE_EXTRACTION_UNITS = 1_024;
export const MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS = 24_000;
export const MAX_CAPTURE_EXTRACTION_CHARACTERS = 900_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const captureExtractionUnitSchema = z.object({
  index: z.number().int().min(0).max(MAX_CAPTURE_EXTRACTION_UNITS - 1),
  label: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS),
  locator: evidenceLocatorV1Schema,
}).strict();

export const captureStructuredExtractionSchema = z.object({
  schemaVersion: z.literal(CAPTURE_EXTRACTION_SCHEMA_VERSION),
  sourceKind: sourceKindSchema,
  format: z.string().trim().min(1).max(80),
  state: z.enum(["completed", "partial"]),
  units: z.array(captureExtractionUnitSchema).min(1).max(MAX_CAPTURE_EXTRACTION_UNITS),
  warningCodes: z.array(z.string().regex(/^[a-z0-9_]{1,80}$/)).max(32),
  extractorId: z.literal(CAPTURE_STRUCTURED_EXTRACTOR_ID),
  extractorVersionId: z.literal(CAPTURE_STRUCTURED_EXTRACTOR_VERSION),
  extractorConfigSha256: sha256Schema,
  contentSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const seenWarnings = new Set<string>();
  value.warningCodes.forEach((code, index) => {
    if (seenWarnings.has(code)) {
      context.addIssue({ code: "custom", message: "Warning codes must be unique.", path: ["warningCodes", index] });
    }
    seenWarnings.add(code);
  });
  value.units.forEach((unit, index) => {
    if (unit.index !== index) {
      context.addIssue({ code: "custom", message: "Extraction units must be contiguous and ordered.", path: ["units", index, "index"] });
    }
  });
  const content = renderCaptureExtractionUnits(value.units);
  if (content.length > MAX_CAPTURE_EXTRACTION_CHARACTERS) {
    context.addIssue({ code: "custom", message: "Structured extraction exceeds the indexing limit.", path: ["units"] });
  }
  if (sha256Text(content) !== value.contentSha256) {
    context.addIssue({ code: "custom", message: "Extraction content digest does not match its units.", path: ["contentSha256"] });
  }
});

export const captureExtractionReceiptSchema = z.object({
  schemaVersion: z.literal(CAPTURE_EXTRACTION_SCHEMA_VERSION),
  sourceKind: sourceKindSchema,
  format: z.string().trim().min(1).max(80),
  state: z.enum(["completed", "partial", "unsupported", "failed"]),
  unitCount: z.number().int().min(0).max(MAX_CAPTURE_EXTRACTION_UNITS),
  locatorKinds: z.array(z.enum([
    "text_span",
    "page",
    "sheet_range",
    "slide",
    "email_section",
    "image_region",
    "media_time_range",
  ])).max(7),
  warningCodes: z.array(z.string().regex(/^[a-z0-9_]{1,80}$/)).max(32),
  extractorId: z.literal(CAPTURE_STRUCTURED_EXTRACTOR_ID),
  extractorVersionId: z.literal(CAPTURE_STRUCTURED_EXTRACTOR_VERSION),
  extractorConfigSha256: sha256Schema,
  contentSha256: sha256Schema.nullable(),
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  if (sourceContractSha256(body) !== receiptSha256) {
    context.addIssue({ code: "custom", message: "Extraction receipt digest does not match its body.", path: ["receiptSha256"] });
  }
  for (const field of ["locatorKinds", "warningCodes"] as const) {
    const canonical = [...new Set(value[field])].sort();
    if (canonical.length !== value[field].length || canonical.some((item, index) => item !== value[field][index])) {
      context.addIssue({ code: "custom", message: `${field} must be unique and ordered.`, path: [field] });
    }
  }
  if (value.state === "completed" || value.state === "partial") {
    if (!value.unitCount || !value.locatorKinds.length || !value.contentSha256) {
      context.addIssue({ code: "custom", message: "Extracted receipts require units, locators, and a content digest." });
    }
    if (value.state === "partial" && !value.warningCodes.length) {
      context.addIssue({ code: "custom", message: "Partial extraction requires a warning code.", path: ["warningCodes"] });
    }
  } else if (value.unitCount || value.locatorKinds.length || value.contentSha256 !== null) {
    context.addIssue({ code: "custom", message: "Terminal extraction receipts cannot claim extracted evidence." });
  }
});

export type CaptureExtractionUnit = z.infer<typeof captureExtractionUnitSchema>;
export type CaptureStructuredExtraction = z.infer<typeof captureStructuredExtractionSchema>;
export type CaptureExtractionReceipt = z.infer<typeof captureExtractionReceiptSchema>;

export type CaptureExtractionDraftUnit = Readonly<{
  label: string;
  content: string;
  locator: EvidenceLocatorV1 | Readonly<{ kind: "text_span" }>;
}>;

export function finalizeCaptureExtraction(input: {
  sourceKind: SourceItemV1["sourceKind"];
  format: string;
  state?: "completed" | "partial";
  warningCodes?: readonly string[];
  units: readonly CaptureExtractionDraftUnit[];
}): CaptureStructuredExtraction {
  const normalizedDrafts = input.units.flatMap((unit) => {
    const content = normalizeTextForChunking(unit.content);
    if (!content) return [];
    if (content.length > MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS) {
      throw new Error("A structured extraction unit exceeds the per-unit limit.");
    }
    return [{ ...unit, content }];
  });
  if (!normalizedDrafts.length) throw new Error("Structured extraction produced no readable units.");
  if (normalizedDrafts.length > MAX_CAPTURE_EXTRACTION_UNITS) {
    throw new Error("Structured extraction produced too many evidence units.");
  }
  const content = normalizedDrafts.map((unit) => unit.content).join("\n\n");
  if (content.length > MAX_CAPTURE_EXTRACTION_CHARACTERS) {
    throw new Error("Structured extraction exceeds the indexing limit.");
  }
  const containerSha256 = sha256Text(content);
  let cursor = 0;
  const units = normalizedDrafts.map((unit, index): CaptureExtractionUnit => {
    const startOffset = cursor;
    const endOffsetExclusive = startOffset + unit.content.length;
    cursor = endOffsetExclusive + 2;
    return captureExtractionUnitSchema.parse({
      index,
      label: unit.label.trim().slice(0, 240),
      content: unit.content,
      locator: unit.locator.kind === "text_span"
        ? {
            kind: "text_span",
            offsetUnit: "utf16_code_unit",
            startOffset,
            endOffsetExclusive,
            containerLength: content.length,
            containerSha256,
          }
        : unit.locator,
    });
  });
  return captureStructuredExtractionSchema.parse({
    schemaVersion: CAPTURE_EXTRACTION_SCHEMA_VERSION,
    sourceKind: input.sourceKind,
    format: input.format,
    state: input.state || "completed",
    units,
    warningCodes: [...new Set(input.warningCodes || [])].sort(),
    extractorId: CAPTURE_STRUCTURED_EXTRACTOR_ID,
    extractorVersionId: CAPTURE_STRUCTURED_EXTRACTOR_VERSION,
    extractorConfigSha256: CAPTURE_STRUCTURED_EXTRACTOR_CONFIG_SHA256,
    contentSha256: containerSha256,
  });
}

export function appendCaptureNote(
  extraction: CaptureStructuredExtraction,
  note: string,
) {
  const boundedNote = note.trim().slice(0, 20_000);
  if (!boundedNote) return extraction;
  const existing = extraction.units.map((unit) => ({
    label: unit.label,
    content: unit.content,
    locator: unit.locator,
  }));
  return finalizeCaptureExtraction({
    sourceKind: extraction.sourceKind,
    format: extraction.format,
    state: extraction.state,
    warningCodes: extraction.warningCodes,
    units: [
      ...existing,
      {
        label: "Capture note",
        content: `Capture note:\n${boundedNote}`,
        locator: { kind: "text_span" },
      },
    ],
  });
}

export function renderCaptureExtractionUnits(
  units: readonly Pick<CaptureExtractionUnit, "content">[],
) {
  return units.map((unit) => unit.content).join("\n\n");
}

export function captureExtractionReceipt(
  extraction: CaptureStructuredExtraction,
): CaptureExtractionReceipt {
  const body = {
    schemaVersion: CAPTURE_EXTRACTION_SCHEMA_VERSION,
    sourceKind: extraction.sourceKind,
    format: extraction.format,
    state: extraction.state,
    unitCount: extraction.units.length,
    locatorKinds: [...new Set(extraction.units.map((unit) => unit.locator.kind))].sort(),
    warningCodes: [...extraction.warningCodes],
    extractorId: extraction.extractorId,
    extractorVersionId: extraction.extractorVersionId,
    extractorConfigSha256: extraction.extractorConfigSha256,
    contentSha256: extraction.contentSha256,
  };
  return captureExtractionReceiptSchema.parse({
    ...body,
    receiptSha256: sourceContractSha256(body),
  });
}

export function terminalCaptureExtractionReceipt(input: {
  sourceKind?: SourceItemV1["sourceKind"];
  format: string;
  state: "unsupported" | "failed";
  warningCode: string;
}): CaptureExtractionReceipt {
  const body = {
    schemaVersion: CAPTURE_EXTRACTION_SCHEMA_VERSION,
    sourceKind: input.sourceKind || "file" as const,
    format: input.format || "unknown",
    state: input.state,
    unitCount: 0,
    locatorKinds: [],
    warningCodes: [input.warningCode],
    extractorId: CAPTURE_STRUCTURED_EXTRACTOR_ID,
    extractorVersionId: CAPTURE_STRUCTURED_EXTRACTOR_VERSION,
    extractorConfigSha256: CAPTURE_STRUCTURED_EXTRACTOR_CONFIG_SHA256,
    contentSha256: null,
  };
  return captureExtractionReceiptSchema.parse({
    ...body,
    receiptSha256: sourceContractSha256(body),
  });
}

export function captureRecordingExtraction(input: {
  durationMs: number;
  segments: readonly {
    segmentIndex: number;
    durationMs: number;
    transcript: string;
    transcriptionStatus: "pending" | "completed" | "failed";
  }[];
}) {
  const ordered = [...input.segments].sort(
    (left, right) => left.segmentIndex - right.segmentIndex,
  );
  const warnings = new Set<string>();
  if (ordered.some((segment) => segment.transcriptionStatus === "failed")) {
    warnings.add("recording_failed_segments");
  }
  let cursorMilliseconds = 0;
  let extractedCharacters = 0;
  const totalDuration = Math.max(
    1,
    Math.round(input.durationMs),
    ordered.reduce((sum, segment) => sum + Math.max(0, Math.round(segment.durationMs)), 0),
  );
  const units: CaptureExtractionDraftUnit[] = [];
  for (const segment of ordered) {
    const startMilliseconds = cursorMilliseconds;
    const durationMilliseconds = Math.max(0, Math.round(segment.durationMs));
    cursorMilliseconds += durationMilliseconds;
    if (segment.transcriptionStatus !== "completed" || !segment.transcript.trim()) continue;
    let content = normalizeTextForChunking(segment.transcript);
    if (content.length > MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS) {
      content = content.slice(0, MAX_CAPTURE_EXTRACTION_UNIT_CHARACTERS);
      warnings.add("recording_segment_truncated");
    }
    if (extractedCharacters + content.length + (units.length ? 2 : 0) > MAX_CAPTURE_EXTRACTION_CHARACTERS) {
      warnings.add("recording_transcript_truncated");
      break;
    }
    extractedCharacters += content.length + (units.length ? 2 : 0);
    if (durationMilliseconds > 0) {
      units.push({
        label: `Audio segment ${segment.segmentIndex + 1}`,
        content,
        locator: {
          kind: "media_time_range",
          mediaKind: "audio",
          startMilliseconds,
          endMillisecondsExclusive: Math.min(
            totalDuration,
            startMilliseconds + durationMilliseconds,
          ),
          durationMilliseconds: totalDuration,
        },
      });
    } else {
      warnings.add("recording_segment_duration_missing");
      units.push({
        label: `Audio segment ${segment.segmentIndex + 1}`,
        content,
        locator: { kind: "text_span" },
      });
    }
  }
  return finalizeCaptureExtraction({
    sourceKind: "audio",
    format: "segmented_audio",
    state: warnings.size ? "partial" : "completed",
    warningCodes: [...warnings],
    units,
  });
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
