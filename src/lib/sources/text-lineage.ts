import { createHash } from "node:crypto";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
} from "@/lib/security/execution-scope";
import {
  buildEvidenceUnitV1,
  buildSourceAdapterUpsertV1,
  buildSourceItemV1,
  buildSourceRevisionV1,
  sourceContractIdSchema,
  sourceContractSha256,
  type SourceAdapterUpsertV1,
  type SourceItemV1,
} from "@/lib/sources/contracts";
import {
  CLAIM_EVIDENCE_PURPOSE_ID,
  CONTEXT_COMPILER_V2_PURPOSE_ID,
} from "@/lib/sources/purposes";

export type TextSourceLineageInput = Readonly<{
  executionScope: ExecutionScope;
  connectionId: string;
  adapterId: string;
  adapterVersionId?: string;
  externalItemId: string;
  providerRevisionId?: string | null;
  sourceKind: SourceItemV1["sourceKind"];
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  capturedAt: string;
  visibility?: SourceItemV1["visibility"];
  sensitivity?: SourceItemV1["sensitivity"];
  permissionGrantIds?: readonly string[];
  allowedPurposeIds?: readonly string[];
  retentionPolicyId?: string;
  retentionExpiresAt?: string | null;
  extractorId?: string;
  extractorVersionId?: string;
  extractorConfigSha256?: string;
  modelVersionId?: string | null;
  adapterConfigSha256?: string;
}>;

export type TextLineageChunk = Readonly<{
  index: number;
  content: string;
  characterStart: number;
  characterEnd: number;
}>;

export type CanonicalTextSourceWrite = Readonly<{
  adapterOutput: SourceAdapterUpsertV1;
  evidenceUnitIdsByChunkIndex: readonly string[];
  executionScope: ExecutionScope;
}>;

export function buildCanonicalTextSourceWrite(input: {
  lineage: TextSourceLineageInput;
  content: string;
  normalizedContent: string;
  chunks: readonly TextLineageChunk[];
  mediaType?: string;
  revisionMetadata?: Record<string, unknown>;
}): CanonicalTextSourceWrite {
  if (canonicalNormalizedText(input.content) !== input.normalizedContent) {
    throw new Error(
      "Canonical source normalized content must be derived from the exact source content.",
    );
  }
  const executionScope = parsePersistedExecutionScope(
    input.lineage.executionScope,
  );
  if (!executionScope?.initiatingActorId) {
    throw new Error("Canonical source lineage requires an initiating actor.");
  }
  assertExecutionScopeTenant(executionScope, executionScope.tenantId);

  const connectionId = sourceContractIdSchema.parse(
    input.lineage.connectionId,
  );
  const adapterId = sourceContractIdSchema.parse(input.lineage.adapterId);
  const adapterVersionId = sourceContractIdSchema.parse(
    input.lineage.adapterVersionId || "1",
  );
  const externalItemId = input.lineage.externalItemId;
  if (!externalItemId.trim() || externalItemId.length > 4_000) {
    throw new Error(
      "Canonical source lineage requires a bounded external item identity.",
    );
  }

  const capturedAt = canonicalTimestamp(
    input.lineage.capturedAt,
    "capturedAt",
  );
  const sourceCreatedAt = optionalCanonicalTimestamp(
    input.lineage.sourceCreatedAt,
    "sourceCreatedAt",
  );
  const sourceUpdatedAt = optionalCanonicalTimestamp(
    input.lineage.sourceUpdatedAt,
    "sourceUpdatedAt",
  );
  const retentionExpiresAt = optionalCanonicalTimestamp(
    input.lineage.retentionExpiresAt,
    "retentionExpiresAt",
  );
  const providerItemKeySha256 = sourceContractSha256({ externalItemId });
  const contentSha256 = contentSha256Hex(input.content);
  const metadataSha256 = sourceContractSha256(
    input.revisionMetadata || {},
  );
  const providerRevisionKeySha256 = sourceContractSha256({
    providerRevisionId: input.lineage.providerRevisionId || null,
    sourceUpdatedAt,
    contentSha256,
    metadataSha256,
  });
  const permissionGrantIds = canonicalIds(
    input.lineage.permissionGrantIds?.length
      ? input.lineage.permissionGrantIds
      : [connectionId],
  );
  const allowedPurposeIds = canonicalIds(
    input.lineage.allowedPurposeIds?.length
      ? input.lineage.allowedPurposeIds
      : [
          `purpose_${sourceContractSha256(executionScope.purpose).slice(0, 56)}`,
          CLAIM_EVIDENCE_PURPOSE_ID,
          CONTEXT_COMPILER_V2_PURPOSE_ID,
        ],
  );
  const extractorIdentity = {
    extractorId: input.lineage.extractorId || "asael.text_chunker",
    extractorVersionId: input.lineage.extractorVersionId || "1",
    extractorConfigSha256:
      input.lineage.extractorConfigSha256 ||
      sourceContractSha256({
        coordinateSpace: "normalized_extracted_text_v1",
        maxCharacters: 1_200,
        overlapCharacters: 160,
      }),
    modelVersionId: input.lineage.modelVersionId || null,
  };
  const binding = {
    tenantId: executionScope.tenantId,
    ownerActorId: executionScope.initiatingActorId,
    workspaceId: executionScope.workspaceId,
    projectId: executionScope.projectId,
    missionId: executionScope.missionId,
    connectionId,
    visibility: input.lineage.visibility || "user_private" as const,
    sensitivity: input.lineage.sensitivity || "confidential" as const,
    permissionGrantIds,
    allowedPurposeIds,
    retentionPolicyId:
      input.lineage.retentionPolicyId || "retention_durable",
    retentionExpiresAt,
  };
  const observation = {
    sourceCreatedAt,
    sourceUpdatedAt,
    capturedAt,
  };
  const sourceItem = buildSourceItemV1({
    ...binding,
    sourceKind: input.lineage.sourceKind,
    providerItemKeySha256,
    metadataSha256,
    ...observation,
    extractorIdentity,
  });
  const sourceRevision = buildSourceRevisionV1({
    ...binding,
    sourceItemId: sourceItem.sourceItemId,
    previousSourceRevisionId: null,
    sourceKind: input.lineage.sourceKind,
    providerItemKeySha256,
    providerRevisionKeySha256,
    contentSha256,
    contentByteLength: Buffer.byteLength(input.content, "utf8"),
    mediaType: input.mediaType || "text/plain",
    metadataSha256,
    ...observation,
    extractorIdentity,
  });
  const normalizedContentSha256 = contentSha256Hex(input.normalizedContent);
  const evidenceByChunkIndex = new Map<number, string>();
  const evidenceUnits = input.chunks.map((chunk) => {
    if (
      chunk.index < 0 ||
      !Number.isInteger(chunk.index) ||
      evidenceByChunkIndex.has(chunk.index)
    ) {
      throw new Error("Canonical source chunks require unique integer indexes.");
    }
    if (
      chunk.characterStart < 0 ||
      chunk.characterEnd <= chunk.characterStart ||
      chunk.characterEnd > input.normalizedContent.length ||
      !isUtf16Boundary(input.normalizedContent, chunk.characterStart) ||
      !isUtf16Boundary(input.normalizedContent, chunk.characterEnd) ||
      input.normalizedContent.slice(
        chunk.characterStart,
        chunk.characterEnd,
      ) !== chunk.content
    ) {
      throw new Error(
        "Canonical source chunk does not match its exact text-span locator.",
      );
    }
    const evidence = buildEvidenceUnitV1({
      ...binding,
      sourceItemId: sourceItem.sourceItemId,
      sourceRevisionId: sourceRevision.sourceRevisionId,
      sourceKind: input.lineage.sourceKind,
      providerItemKeySha256,
      evidenceContentSha256: contentSha256Hex(chunk.content),
      evidenceByteLength: Buffer.byteLength(chunk.content, "utf8"),
      locator: {
        kind: "text_span",
        offsetUnit: "utf16_code_unit",
        startOffset: chunk.characterStart,
        endOffsetExclusive: chunk.characterEnd,
        containerLength: input.normalizedContent.length,
        containerSha256: normalizedContentSha256,
      },
      ...observation,
      extractedAt: capturedAt,
      extractorIdentity,
    });
    evidenceByChunkIndex.set(chunk.index, evidence.evidenceUnitId);
    return evidence;
  });
  const expectedIndexes = input.chunks.map((chunk) => chunk.index).sort(
    (left, right) => left - right,
  );
  expectedIndexes.forEach((value, index) => {
    if (value !== index) {
      throw new Error(
        "Canonical source chunks require contiguous zero-based indexes.",
      );
    }
  });

  const adapterOutput = buildSourceAdapterUpsertV1({
    adapterId,
    adapterVersionId,
    adapterConfigSha256:
      input.lineage.adapterConfigSha256 ||
      sourceContractSha256({ adapterId, adapterVersionId }),
    adapterEventKeySha256: sourceContractSha256({
      sourceItemId: sourceItem.sourceItemId,
      sourceRevisionId: sourceRevision.sourceRevisionId,
    }),
    observedAt: capturedAt,
    sourceItem,
    sourceRevision,
    evidenceUnits,
  });

  return Object.freeze({
    adapterOutput,
    evidenceUnitIdsByChunkIndex: Object.freeze(
      expectedIndexes.map((index) => evidenceByChunkIndex.get(index)!),
    ),
    executionScope,
  });
}

function canonicalNormalizedText(input: string) {
  return input
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function isUtf16Boundary(value: string, offset: number) {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}

function canonicalIds(values: readonly string[]) {
  return [...new Set(values.map((value) => sourceContractIdSchema.parse(value)))]
    .sort();
}

function canonicalTimestamp(value: string, field: string) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`Canonical source ${field} is invalid.`);
  }
  return timestamp.toISOString();
}

function optionalCanonicalTimestamp(
  value: string | null | undefined,
  field: string,
) {
  return value ? canonicalTimestamp(value, field) : null;
}

export function contentSha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
