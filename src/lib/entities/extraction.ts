import { z } from "zod";

import {
  buildEntityAccessBinding,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
  entityLineageReferenceSchema,
  labelSha256,
  type EntityResolutionDecision,
} from "@/lib/entities/registry";
import {
  addEntityLineage,
  resolveAndRecordEntityIdentity,
  saveEntityRecord,
} from "@/lib/entities/store";
import {
  ASAEL_ONTOLOGY_EFFECTIVE_AT,
  entityTypeIdSchema,
  type EntityTypeId,
} from "@/lib/entities/ontology";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { MemoryRecord } from "@/lib/memory/types";
import {
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  sourceAdapterUpsertV1Schema,
  sourceContractSha256,
} from "@/lib/sources/contracts";
import { CLAIM_EVIDENCE_PURPOSE_ID } from "@/lib/sources/purposes";
import {
  contentSha256Hex,
  type CanonicalTextSourceWrite,
} from "@/lib/sources/text-lineage";

export const ENTITY_EXTRACTION_SCHEMA_VERSION = 1 as const;
export const ENTITY_EXTRACTOR_VERSION_ID =
  "entity-extractor:explicit-markers-v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const entityExtractionCandidateSchema = z.object({
  entityTypeId: entityTypeIdSchema,
  canonicalLabel: z.string().trim().min(1).max(320),
  normalizedLabelSha256: sha256Schema,
}).strict();

const entityExtractionBodySchema = z.object({
  schemaVersion: z.literal(ENTITY_EXTRACTION_SCHEMA_VERSION),
  extractorVersionId: z.literal(ENTITY_EXTRACTOR_VERSION_ID),
  sourceMemoryId: z.string().trim().min(1).max(240),
  sourceMemoryEvidenceSha256: sha256Schema,
  candidates: z.array(entityExtractionCandidateSchema).max(32),
}).strict();

const entityExtractionSchema = entityExtractionBodySchema.extend({
  extractionSha256: sha256Schema,
}).strict();

export type EntityExtraction = Readonly<
  Omit<z.infer<typeof entityExtractionSchema>, "candidates"> & {
    candidates: readonly Readonly<
      z.infer<typeof entityExtractionCandidateSchema>
    >[];
  }
>;

export type EntityExtractionProjection = Readonly<{
  extraction: EntityExtraction;
  createdEntityIds: readonly string[];
  linkedEntityIds: readonly string[];
  reviewResolutionIds: readonly string[];
}>;

const canonicalEvidenceEntityCandidateSchema =
  entityExtractionCandidateSchema.extend({
    evidenceUnitId: z.string().trim().min(1).max(240),
    evidenceUnitSha256: sha256Schema,
  }).strict();

const canonicalEvidenceEntityExtractionBodySchema = z.object({
  schemaVersion: z.literal(ENTITY_EXTRACTION_SCHEMA_VERSION),
  extractorVersionId: z.literal(ENTITY_EXTRACTOR_VERSION_ID),
  sourceItemId: z.string().trim().min(1).max(240),
  sourceRevisionId: z.string().trim().min(1).max(240),
  candidates: z.array(canonicalEvidenceEntityCandidateSchema).max(32),
}).strict();

const canonicalEvidenceEntityExtractionSchema =
  canonicalEvidenceEntityExtractionBodySchema.extend({
    extractionSha256: sha256Schema,
  }).strict();

export type CanonicalEvidenceEntityExtraction = Readonly<
  Omit<z.infer<typeof canonicalEvidenceEntityExtractionSchema>, "candidates"> & {
    candidates: readonly Readonly<
      z.infer<typeof canonicalEvidenceEntityCandidateSchema>
    >[];
  }
>;

export type CanonicalEvidenceEntityProjection = Readonly<{
  extraction: CanonicalEvidenceEntityExtraction;
  createdEntityIds: readonly string[];
  linkedEntityIds: readonly string[];
  reviewResolutionIds: readonly string[];
}>;

const MARKER_TO_TYPE = new Map<string, EntityTypeId>([
  ["person", "person"],
  ["organization", "organization"],
  ["account", "account"],
  ["project", "project"],
  ["work item", "work_item"],
  ["work_item", "work_item"],
  ["event", "event"],
  ["meeting", "meeting"],
  ["place", "place"],
  ["asset", "asset"],
  ["decision", "decision"],
  ["commitment", "commitment"],
  ["preference", "preference"],
  ["risk", "risk"],
  ["goal", "goal"],
  ["product", "product"],
  ["case", "case"],
  ["opportunity", "opportunity"],
]);
const TYPE_MARKERS = [...MARKER_TO_TYPE.keys()]
  .sort((left, right) => right.length - left.length)
  .map(escapePattern)
  .join("|");
const EXPLICIT_MARKER_PATTERN = new RegExp(
  `\\b(${TYPE_MARKERS})\\s*:\\s*(?:"([^"\\r\\n]{1,320})"|“([^”\\r\\n]{1,320})”|([^;\\r\\n]{1,320}))`,
  "giu",
);
const NAMED_MARKER_PATTERN = new RegExp(
  `\\b(${TYPE_MARKERS})\\s+(?:named|called)\\s+(?:"([^"\\r\\n]{1,320})"|“([^”\\r\\n]{1,320})”)`,
  "giu",
);

/**
 * Extracts only explicit typed markers from canonical user-authored memory.
 * It intentionally does not guess entities from capitalization or model
 * output. Examples: `project: Phoenix` and `person named "Ada Lovelace"`.
 */
export function extractEntitiesFromExplicitMemory(
  memory: MemoryRecord,
): EntityExtraction {
  assertCanonicalExplicitMemory(memory);
  const candidates = extractExplicitCandidates(memory.content);
  const sourceMemoryEvidenceSha256 = sourceContractSha256({
    memoryId: memory.id,
    tenantId: memory.tenantId,
    ownerActorId: memory.accessBinding!.ownerActorId,
    accessScopeSha256: memory.accessBinding!.accessScopeSha256,
    contentSha256: sourceContractSha256(memory.content),
    updatedAt: memory.updatedAt,
  });
  const body = entityExtractionBodySchema.parse({
    schemaVersion: ENTITY_EXTRACTION_SCHEMA_VERSION,
    extractorVersionId: ENTITY_EXTRACTOR_VERSION_ID,
    sourceMemoryId: memory.id,
    sourceMemoryEvidenceSha256,
    candidates,
  });
  return deepFreeze(entityExtractionSchema.parse({
    ...body,
    extractionSha256: sourceContractSha256(body),
  }));
}

/**
 * Extracts explicit typed markers only from immutable canonical evidence.
 * Every candidate retains the exact evidence-unit digest used to create it.
 */
export function extractEntitiesFromCanonicalEvidence(input: {
  sourceWrite: CanonicalTextSourceWrite;
  chunks: readonly Readonly<{ index: number; content: string }>[];
}): CanonicalEvidenceEntityExtraction {
  const output = sourceAdapterUpsertV1Schema.parse(
    input.sourceWrite.adapterOutput,
  );
  const sourceItem = output.sourceItem;
  const sourceRevision = output.sourceRevision;
  const evidenceById = new Map(
    output.evidenceUnits.map((evidence) => [evidence.evidenceUnitId, evidence]),
  );
  const candidates = new Map<string, z.infer<
    typeof canonicalEvidenceEntityCandidateSchema
  >>();
  const orderedChunks = [...input.chunks].sort((left, right) =>
    left.index - right.index
  );
  if (
    orderedChunks.length !== input.sourceWrite.evidenceUnitIdsByChunkIndex.length ||
    orderedChunks.some((chunk, index) => chunk.index !== index)
  ) {
    throw new Error(
      "Canonical entity extraction requires the complete ordered chunk set.",
    );
  }
  for (const chunk of orderedChunks) {
    const evidenceUnitId =
      input.sourceWrite.evidenceUnitIdsByChunkIndex[chunk.index];
    const evidence = evidenceById.get(evidenceUnitId);
    if (
      !evidence ||
      evidence.tenantId !== sourceItem.tenantId ||
      evidence.ownerActorId !== sourceItem.ownerActorId ||
      evidence.sourceItemId !== sourceItem.sourceItemId ||
      evidence.sourceRevisionId !== sourceRevision.sourceRevisionId ||
      evidence.evidenceContentSha256 !== contentSha256Hex(chunk.content)
    ) {
      throw new Error(
        "Canonical entity extraction chunk does not match immutable evidence.",
      );
    }
    for (const candidate of extractExplicitCandidates(chunk.content)) {
      const key = `${candidate.entityTypeId}:${candidate.normalizedLabelSha256}`;
      if (candidates.has(key)) continue;
      candidates.set(key, {
        ...candidate,
        evidenceUnitId,
        evidenceUnitSha256: evidence.evidenceUnitSha256,
      });
      if (candidates.size === 32) break;
    }
    if (candidates.size === 32) break;
  }
  const body = canonicalEvidenceEntityExtractionBodySchema.parse({
    schemaVersion: ENTITY_EXTRACTION_SCHEMA_VERSION,
    extractorVersionId: ENTITY_EXTRACTOR_VERSION_ID,
    sourceItemId: sourceItem.sourceItemId,
    sourceRevisionId: sourceRevision.sourceRevisionId,
    candidates: [...candidates.values()],
  });
  return deepFreeze(canonicalEvidenceEntityExtractionSchema.parse({
    ...body,
    extractionSha256: sourceContractSha256(body),
  }));
}

export async function projectCanonicalEvidenceEntities(input: {
  sourceWrite: CanonicalTextSourceWrite;
  chunks: readonly Readonly<{ index: number; content: string }>[];
  evaluatedAt?: string;
}): Promise<CanonicalEvidenceEntityProjection | null> {
  const output = sourceAdapterUpsertV1Schema.parse(
    input.sourceWrite.adapterOutput,
  );
  const sourceItem = output.sourceItem;
  const sourceScope = parsePersistedExecutionScope(
    input.sourceWrite.executionScope,
  );
  const evaluatedAt = new Date(input.evaluatedAt || Date.now());
  if (!Number.isFinite(evaluatedAt.getTime())) {
    throw new Error("Canonical entity extraction evaluation time is invalid.");
  }
  if (
    !sourceScope ||
    sourceScope.tenantId !== sourceItem.tenantId ||
    sourceScope.initiatingActorId !== sourceItem.ownerActorId ||
    sourceScope.executingPrincipalType !== "user" ||
    sourceScope.executingPrincipalId !== sourceItem.ownerActorId ||
    sourceScope.workspaceId !== null ||
    sourceScope.projectId !== null ||
    sourceScope.missionId !== null ||
    sourceItem.visibility !== "user_private" ||
    sourceItem.workspaceId !== null ||
    sourceItem.projectId !== null ||
    sourceItem.missionId !== null ||
    !sourceItem.allowedPurposeIds.includes(CLAIM_EVIDENCE_PURPOSE_ID) ||
    (
      sourceItem.retentionExpiresAt !== null &&
      new Date(sourceItem.retentionExpiresAt) <= evaluatedAt
    )
  ) {
    return null;
  }

  const extraction = extractEntitiesFromCanonicalEvidence(input);
  if (!extraction.candidates.length) {
    return frozenCanonicalProjection(extraction, [], [], []);
  }
  const accessBinding = buildEntityAccessBinding({
    tenantId: sourceItem.tenantId,
    ownerActorId: sourceItem.ownerActorId,
    visibility: "user_private",
    sensitivity: sourceItem.sensitivity,
    allowedPurposeIds: ENTITY_PURPOSE_IDS,
    boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
  });
  const resolveScope = deriveExecutionScope(sourceScope, {
    purpose: "entity.resolve.v1",
  });
  const writeScope = deriveExecutionScope(sourceScope, {
    purpose: "entity.write.v1",
  });
  const createdEntityIds: string[] = [];
  const linkedEntityIds: string[] = [];
  const reviewResolutionIds: string[] = [];
  for (const candidate of extraction.candidates) {
    const lineage = entityLineageReferenceSchema.parse({
      kind: "evidence_unit",
      referenceId: candidate.evidenceUnitId,
      referenceSha256: candidate.evidenceUnitSha256,
    });
    const resolution = await resolveAndRecordEntityIdentity({
      entityTypeId: candidate.entityTypeId,
      label: candidate.canonicalLabel,
      accessBinding,
      executionScope: resolveScope,
      decidedAt: output.evidenceUnits.find((evidence) =>
        evidence.evidenceUnitId === candidate.evidenceUnitId
      )!.extractedAt,
    });
    await settleResolution({
      resolution,
      candidate,
      accessBinding,
      lineage,
      writeScope,
      createdEntityIds,
      linkedEntityIds,
      reviewResolutionIds,
      createdAt: output.sourceRevision.capturedAt,
    });
  }

  const projection = frozenCanonicalProjection(
    extraction,
    createdEntityIds,
    linkedEntityIds,
    reviewResolutionIds,
  );
  await appendScopedDomainEvent({
    id: `entity-source-extraction:${extraction.extractionSha256}`,
    streamId: `source:${sourceItem.sourceItemId}`,
    type: "entity.source.extraction.projected",
    executionScope: deriveExecutionScope(sourceScope, {
      purpose: "entity.extract.v1",
    }),
    payload: {
      schemaVersion: ENTITY_EXTRACTION_SCHEMA_VERSION,
      extractorVersionId: ENTITY_EXTRACTOR_VERSION_ID,
      extractionSha256: extraction.extractionSha256,
      sourceItemId: extraction.sourceItemId,
      sourceRevisionId: extraction.sourceRevisionId,
      candidateCount: extraction.candidates.length,
      createdCount: projection.createdEntityIds.length,
      linkedCount: projection.linkedEntityIds.length,
      reviewRequiredCount: projection.reviewResolutionIds.length,
      evidenceUnitSetSha256: sourceContractSha256(
        extraction.candidates.map((candidate) => candidate.evidenceUnitId).sort(),
      ),
      entityTypeIds: [...new Set(
        extraction.candidates.map((candidate) => candidate.entityTypeId),
      )].sort(),
    },
  });
  return projection;
}

function extractExplicitCandidates(content: string) {
  const candidates = new Map<string, z.infer<
    typeof entityExtractionCandidateSchema
  >>();
  for (const pattern of [EXPLICIT_MARKER_PATTERN, NAMED_MARKER_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const entityTypeId = MARKER_TO_TYPE.get(
        String(match[1]).toLocaleLowerCase("en-US"),
      );
      const canonicalLabel = cleanLabel(match[2] || match[3] || match[4] || "");
      if (!entityTypeId || !canonicalLabel) continue;
      const normalizedLabelSha256 = labelSha256(canonicalLabel);
      candidates.set(`${entityTypeId}:${normalizedLabelSha256}`, {
        entityTypeId,
        canonicalLabel,
        normalizedLabelSha256,
      });
    }
  }
  return [...candidates.values()].slice(0, 32);
}

export async function projectExplicitMemoryEntities(input: {
  memory: MemoryRecord;
  executionScope: ExecutionScope;
}): Promise<EntityExtractionProjection> {
  const extraction = extractEntitiesFromExplicitMemory(input.memory);
  const sourceScope = parsePersistedExecutionScope(input.executionScope);
  const ownerActorId = input.memory.accessBinding!.ownerActorId;
  if (
    !sourceScope ||
    sourceScope.tenantId !== input.memory.tenantId ||
    sourceScope.initiatingActorId !== ownerActorId ||
    sourceScope.executingPrincipalType !== "user" ||
    sourceScope.executingPrincipalId !== ownerActorId
  ) {
    throw new Error("Entity extraction scope does not match its source memory.");
  }
  if (!extraction.candidates.length) {
    return frozenProjection(extraction, [], [], []);
  }

  const accessBinding = buildEntityAccessBinding({
    tenantId: sourceScope.tenantId,
    ownerActorId,
    visibility: "user_private",
    sensitivity: input.memory.accessBinding!.sensitivity,
    allowedPurposeIds: ENTITY_PURPOSE_IDS,
    // One stable registry scope per actor and ontology version.
    boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
  });
  const lineage = entityLineageReferenceSchema.parse({
    kind: "memory",
    referenceId: extraction.sourceMemoryId,
    referenceSha256: extraction.sourceMemoryEvidenceSha256,
  });
  const resolveScope = deriveExecutionScope(sourceScope, {
    purpose: "entity.resolve.v1",
  });
  const writeScope = deriveExecutionScope(sourceScope, {
    purpose: "entity.write.v1",
  });
  const createdEntityIds: string[] = [];
  const linkedEntityIds: string[] = [];
  const reviewResolutionIds: string[] = [];

  for (const candidate of extraction.candidates) {
    const resolution = await resolveAndRecordEntityIdentity({
      entityTypeId: candidate.entityTypeId,
      label: candidate.canonicalLabel,
      accessBinding,
      executionScope: resolveScope,
      decidedAt: input.memory.createdAt,
    });
    await settleResolution({
      resolution,
      candidate,
      accessBinding,
      lineage,
      writeScope,
      createdEntityIds,
      linkedEntityIds,
      reviewResolutionIds,
      createdAt: input.memory.createdAt,
    });
  }

  const projection = frozenProjection(
    extraction,
    createdEntityIds,
    linkedEntityIds,
    reviewResolutionIds,
  );
  const eventScope = deriveExecutionScope(sourceScope, {
    purpose: "entity.extract.v1",
  });
  await appendScopedDomainEvent({
    id: `entity-extraction:${extraction.extractionSha256}`,
    streamId: `memory:${input.memory.id}`,
    type: "entity.extraction.projected",
    executionScope: eventScope,
    payload: {
      schemaVersion: ENTITY_EXTRACTION_SCHEMA_VERSION,
      extractorVersionId: ENTITY_EXTRACTOR_VERSION_ID,
      extractionSha256: extraction.extractionSha256,
      sourceMemoryEvidenceSha256: extraction.sourceMemoryEvidenceSha256,
      candidateCount: extraction.candidates.length,
      createdCount: projection.createdEntityIds.length,
      linkedCount: projection.linkedEntityIds.length,
      reviewRequiredCount: projection.reviewResolutionIds.length,
      entityTypeIds: [...new Set(
        extraction.candidates.map((candidate) => candidate.entityTypeId),
      )].sort(),
    },
  });
  return projection;
}

async function settleResolution(input: {
  resolution: EntityResolutionDecision;
  candidate: Readonly<{
    entityTypeId: EntityTypeId;
    canonicalLabel: string;
  }>;
  accessBinding: ReturnType<typeof buildEntityAccessBinding>;
  lineage: z.infer<typeof entityLineageReferenceSchema>;
  writeScope: ExecutionScope;
  createdEntityIds: string[];
  linkedEntityIds: string[];
  reviewResolutionIds: string[];
  createdAt: string;
}) {
  if (input.resolution.decision === "auto_link") {
    await addEntityLineage({
      entityId: input.resolution.selectedEntityId!,
      lineage: input.lineage,
      accessBinding: input.accessBinding,
      executionScope: input.writeScope,
      updatedAt: input.createdAt,
    });
    input.linkedEntityIds.push(input.resolution.selectedEntityId!);
    return;
  }
  if (input.resolution.decision === "review_required") {
    input.reviewResolutionIds.push(input.resolution.resolutionId);
    return;
  }
  const entity = buildEntityRecord({
    entityTypeId: input.candidate.entityTypeId,
    canonicalLabel: input.candidate.canonicalLabel,
    accessBinding: input.accessBinding,
    lineage: [input.lineage],
    createdAt: input.createdAt,
  });
  await saveEntityRecord({ entity, executionScope: input.writeScope });
  input.createdEntityIds.push(entity.entityId);
}

function assertCanonicalExplicitMemory(memory: MemoryRecord) {
  if (
    !memory.tenantId ||
    !(
      ["manual", "user-assertion"].includes(memory.source) ||
      memory.source.startsWith("correction:")
    ) ||
    memory.assertedBy !== "user" ||
    memory.claimStatus !== "active" ||
    !memory.content.trim() ||
    memory.accessBinding?.visibility !== "user_private" ||
    memory.accessBinding.tenantId !== memory.tenantId ||
    memory.accessBinding.ownerAgentId !== null ||
    memory.accessBinding.workspaceId !== null ||
    memory.accessBinding.projectId !== null ||
    memory.accessBinding.missionId !== null
  ) {
    throw new Error(
      "Entity extraction requires canonical active user-authored memory.",
    );
  }
}

function cleanLabel(value: string) {
  const label = value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  return label && Array.from(label).length <= 320 ? label : undefined;
}

function frozenProjection(
  extraction: EntityExtraction,
  createdEntityIds: readonly string[],
  linkedEntityIds: readonly string[],
  reviewResolutionIds: readonly string[],
): EntityExtractionProjection {
  return Object.freeze({
    extraction,
    createdEntityIds: Object.freeze([...createdEntityIds]),
    linkedEntityIds: Object.freeze([...linkedEntityIds]),
    reviewResolutionIds: Object.freeze([...reviewResolutionIds]),
  });
}

function frozenCanonicalProjection(
  extraction: CanonicalEvidenceEntityExtraction,
  createdEntityIds: readonly string[],
  linkedEntityIds: readonly string[],
  reviewResolutionIds: readonly string[],
): CanonicalEvidenceEntityProjection {
  return Object.freeze({
    extraction,
    createdEntityIds: Object.freeze([...createdEntityIds]),
    linkedEntityIds: Object.freeze([...linkedEntityIds]),
    reviewResolutionIds: Object.freeze([...reviewResolutionIds]),
  });
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
