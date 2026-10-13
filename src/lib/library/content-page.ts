import "server-only";

import { z } from "zod";
import { getCaptureAssetForRequest, getCaptureAssetExtractionForRequest } from "@/lib/capture/assets";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import { getWorkspaceLibraryItem } from "@/lib/library/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const libraryContentPageRequestSchema = z.object({
  versionId: z.string().trim().min(1).max(320),
  contentSha256: sha256,
  unitIndex: z.number().int().min(0).max(1023).default(0),
  characterOffset: z.number().int().min(0).max(24_000).default(0),
  extractionReceiptSha256: sha256.optional(),
}).strict().superRefine((value, context) => {
  if ((value.unitIndex > 0 || value.characterOffset > 0) && !value.extractionReceiptSha256) {
    context.addIssue({ code: "custom", path: ["extractionReceiptSha256"], message: "Continuing a content read requires the exact extraction receipt returned by the preceding page." });
  }
});

type ContentPageRequest = z.infer<typeof libraryContentPageRequestSchema>;
type ExtractedUnit = Awaited<ReturnType<typeof getCaptureAssetExtractionForRequest>>["units"][number];
type PageUnit = Omit<ExtractedUnit, "knowledgeChunkId" | "content"> & {
  knowledgeChunkId: string;
  citationId: string;
  citationToken: string;
  characterOffset: number;
  endCharacterOffset: number;
  totalCharacters: number;
  content: string;
  redactionApplied: boolean;
};

export class LibraryContentPageError extends Error {
  constructor(readonly code: "library_content_changed" | "library_content_unavailable" | "library_content_cursor_invalid", message: string) {
    super(message);
    this.name = "LibraryContentPageError";
  }
}

/** Leave space inside the agent's 8k tool envelope for execution/citation metadata. */
const MAX_CONTENT_RESPONSE_CHARACTERS = 5_500;

/** A current-owner read of one exact indexed file, with deterministic continuation. */
export async function readLibraryContentPage(input: {
  context: SecurityContext;
  item: WorkspaceLibraryItem;
  request: z.input<typeof libraryContentPageRequestSchema>;
}) {
  const request = libraryContentPageRequestSchema.parse(input.request);
  const { item, context } = input;
  if (item.tenantId !== context.tenantId || item.status !== "ready" ||
      item.currentVersion.versionId !== request.versionId ||
      item.currentVersion.contentSha256 !== request.contentSha256) {
    throw new LibraryContentPageError("library_content_changed", "The Library file version changed or is no longer readable. Inspect the file again before reading content.");
  }
  if (item.sourceAuthority !== "capture_asset" || !item.currentVersion.sourceRevisionId) {
    throw new LibraryContentPageError("library_content_unavailable", "Exact content paging is available for indexed Capture files with canonical evidence. This source currently supports metadata inspection only.");
  }
  const owner = {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  };
  const asset = await getCaptureAssetForRequest(item.sourceId, owner);
  if (!asset || asset.status !== "indexed" || asset.contentSha256 !== request.contentSha256) {
    throw new LibraryContentPageError("library_content_changed", "The indexed file is no longer available at the requested content digest.");
  }
  if (!asset.knowledgeDocumentId || !item.links.some((link) => link.kind === "knowledge_document" && link.id === asset.knowledgeDocumentId)) {
    throw new LibraryContentPageError("library_content_changed", "The file's indexed document changed. Inspect the current Library item before reading content.");
  }
  const extraction = await getCaptureAssetExtractionForRequest(asset, owner, { includeKnowledgeChunkIds: true });
  const receipt = extraction.receipt;
  if (!extraction.evidenceAvailable || !receipt?.contentSha256 || !extraction.units.length ||
      extraction.units.some((unit) => !unit.knowledgeChunkId)) {
    throw new LibraryContentPageError("library_content_unavailable", "The file's indexed text and canonical citations could not be verified.");
  }
  if (request.extractionReceiptSha256 && request.extractionReceiptSha256 !== receipt.receiptSha256) {
    throw new LibraryContentPageError("library_content_changed", "The file was reindexed during this read. Restart at the first page with the current version.");
  }
  // Reindexing can preserve the binary digest while changing canonical lineage.
  // Never label newly read chunks with a stale Library revision or owner view.
  const current = await getWorkspaceLibraryItem({ ...owner, libraryItemId: item.id });
  if (!current || current.status !== "ready" ||
      current.currentVersion.versionId !== item.currentVersion.versionId ||
      current.currentVersion.contentSha256 !== item.currentVersion.contentSha256 ||
      current.currentVersion.sourceRevisionId !== item.currentVersion.sourceRevisionId ||
      !current.links.some((link) => link.kind === "knowledge_document" && link.id === asset.knowledgeDocumentId)) {
    throw new LibraryContentPageError("library_content_changed", "The file's canonical source changed during the read. Inspect the current Library item and restart the content read.");
  }
  const units = extraction.units.map((unit) => {
    const content = String(redactSensitive(unit.content));
    return { ...unit, content, redactionApplied: content !== unit.content };
  });
  const first = units[request.unitIndex];
  if (!first || request.characterOffset >= first.content.length || splitsSurrogate(first.content, request.characterOffset)) {
    throw new LibraryContentPageError("library_content_cursor_invalid", "The requested content position is outside the verified extracted text.");
  }
  const totalCharacters = units.reduce((total, unit) => total + unit.content.length, 0);
  const selected: PageUnit[] = [];
  const page = (next: ContentPageRequest | null) => ({
    schemaVersion: 1 as const,
    libraryItemId: item.id,
    versionId: request.versionId,
    contentSha256: request.contentSha256,
    sourceRevisionId: item.currentVersion.sourceRevisionId!,
    extractionReceiptSha256: receipt.receiptSha256,
    extractedContentSha256: receipt.contentSha256,
    contentTrust: "untrusted" as const,
    extractionState: receipt.state,
    warningCodes: receipt.warningCodes,
    totalUnitCount: units.length,
    totalCharacters,
    start: { unitIndex: request.unitIndex, characterOffset: request.characterOffset },
    next,
    units: [...selected],
    coverage: {
      startsAtBeginning: request.unitIndex === 0 && request.characterOffset === 0,
      endsAtEnd: next === null,
      wholeExtractedText: request.unitIndex === 0 && request.characterOffset === 0 && next === null,
      pageCharacters: selected.reduce((total, unit) => total + unit.content.length, 0),
    },
  });
  const continuation = (unitIndex: number, characterOffset: number): ContentPageRequest | null => unitIndex >= units.length
    ? null
    : { versionId: request.versionId, contentSha256: request.contentSha256, extractionReceiptSha256: receipt.receiptSha256, unitIndex, characterOffset };
  const fits = (next: ContentPageRequest | null) => JSON.stringify({ item, contentPage: page(next) }).length <= MAX_CONTENT_RESPONSE_CHARACTERS;
  for (let index = request.unitIndex; index < units.length; index += 1) {
    if (selected.length === 4) return page(continuation(index, 0));
    const unit = units[index];
    const offset = index === request.unitIndex ? request.characterOffset : 0;
    const projected = (end: number): PageUnit => ({
      ...unit,
      knowledgeChunkId: unit.knowledgeChunkId!,
      citationId: `knowledge:${unit.knowledgeChunkId}`,
      citationToken: `[knowledge:${unit.knowledgeChunkId}]`,
      characterOffset: offset,
      endCharacterOffset: end,
      totalCharacters: unit.content.length,
      content: unit.content.slice(offset, end),
    });
    selected.push(projected(unit.content.length));
    const next = continuation(index + 1, 0);
    if (fits(next)) continue;
    selected.pop();
    // Prefer whole evidence units. Only split a unit when it cannot fit by itself.
    if (selected.length) return page(continuation(index, offset));
    let low = offset, high = unit.content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      selected[0] = projected(middle);
      if (fits(continuation(index, middle))) low = middle;
      else high = middle - 1;
    }
    if (splitsSurrogate(unit.content, low)) low -= 1;
    if (low <= offset) throw new LibraryContentPageError("library_content_unavailable", "The source metadata exceeds the bounded content response. No text was silently omitted.");
    selected[0] = projected(low);
    return page(continuation(index, low));
  }
  return page(null);
}

function splitsSurrogate(text: string, offset: number) {
  return offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
}
