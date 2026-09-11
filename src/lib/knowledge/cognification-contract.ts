import { z } from "zod";

import {
  ASAEL_ONTOLOGY_VERSION_ID,
  entityRelationTypeIdSchema,
  entityTypeIdSchema,
  getEntityRelationDefinition,
} from "@/lib/entities/ontology";
import { contentSha256Hex } from "@/lib/sources/text-lineage";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const COGNIFICATION_CONTRACT_SCHEMA_VERSION = 1 as const;
export const COGNIFICATION_CONTRACT_KIND =
  "cognification_candidate_batch" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const contractIdSchema = z.string().trim().min(1).max(320).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const candidateIdSchema = z.string().regex(
  /^cognition_candidate_[a-f0-9]{48}$/,
);
const batchIdSchema = z.string().regex(/^cognition_batch_[a-f0-9]{48}$/);
export const cognitionGenerationIdSchema = z.string().regex(
  /^cognition_generation_[a-f0-9]{48}$/,
);
const boundedTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const confidenceBasisPointsSchema = z.number().int().min(0).max(10_000);
const nullableTimestampSchema = z.string().datetime({ offset: true }).nullable();

export const cognificationEvidenceBindingV1Schema = z.object({
  evidenceUnitId: contractIdSchema,
  chunkId: contractIdSchema,
  chunkIndex: z.number().int().nonnegative(),
  quote: z.string().min(1).max(1_200),
  quoteSha256: sha256Schema,
  coordinateSpace: z.literal("evidence_content"),
  offsetUnit: z.literal("utf16_code_unit"),
  startOffset: z.number().int().nonnegative(),
  endOffsetExclusive: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.endOffsetExclusive <= value.startOffset) {
    context.addIssue({
      code: "custom",
      message: "Cognification evidence span must be non-empty.",
      path: ["endOffsetExclusive"],
    });
  }
  if (
    value.endOffsetExclusive - value.startOffset !== value.quote.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Cognification quote length does not match its UTF-16 span.",
      path: ["quote"],
    });
  }
  if (contentSha256Hex(value.quote) !== value.quoteSha256) {
    context.addIssue({
      code: "custom",
      message: "Cognification quote digest is invalid.",
      path: ["quoteSha256"],
    });
  }
});

const evidenceBindingsSchema = z.array(cognificationEvidenceBindingV1Schema)
  .min(1)
  .max(8);

export const cognificationTopicCandidateV1Schema = z.object({
  candidateId: candidateIdSchema,
  label: boundedTextSchema(160),
  description: boundedTextSchema(600),
  confidenceBasisPoints: confidenceBasisPointsSchema,
  evidence: evidenceBindingsSchema,
}).strict();

export const cognificationClaimCandidateV1Schema = z.object({
  candidateId: candidateIdSchema,
  statement: boundedTextSchema(1_200),
  epistemicKind: z.enum(["fact", "procedure", "opinion", "prediction"]),
  confidenceBasisPoints: confidenceBasisPointsSchema,
  evidence: evidenceBindingsSchema,
}).strict();

const markerSafeLabelSchema = boundedTextSchema(320).refine(
  (value) => !/[\r\n|"“”]/u.test(value) && !value.includes("->"),
  "Entity labels must be safe for explicit review markers.",
);

export const cognificationEntityCandidateV1Schema = z.object({
  candidateId: candidateIdSchema,
  entityTypeId: entityTypeIdSchema,
  canonicalLabel: markerSafeLabelSchema,
  description: boundedTextSchema(600),
  confidenceBasisPoints: confidenceBasisPointsSchema,
  evidence: evidenceBindingsSchema,
}).strict();

const relationEndpointSchema = z.object({
  entityCandidateId: candidateIdSchema,
  entityTypeId: entityTypeIdSchema,
  canonicalLabel: markerSafeLabelSchema,
}).strict();

export const cognificationRelationCandidateV1Schema = z.object({
  candidateId: candidateIdSchema,
  relationTypeId: entityRelationTypeIdSchema,
  source: relationEndpointSchema,
  target: relationEndpointSchema,
  statement: boundedTextSchema(1_200),
  confidenceBasisPoints: confidenceBasisPointsSchema,
  evidence: evidenceBindingsSchema,
}).strict();

export const cognificationSummaryCandidateV1Schema = z.object({
  candidateId: candidateIdSchema,
  text: boundedTextSchema(2_400),
  confidenceBasisPoints: confidenceBasisPointsSchema,
  evidence: evidenceBindingsSchema,
}).strict();

export const cognificationModelAttributionV1Schema = z.object({
  provider: z.enum(["openai", "google", "anthropic", "aws_bedrock", "local"]),
  model: boundedTextSchema(240),
  routingSource: z.enum(["tenant_assignment", "deployment_environment"]),
  assignmentScope: z.literal("memory"),
  assignmentId: contractIdSchema.optional(),
  assignmentRevision: z.number().int().positive().optional(),
  assignmentConfigurationSha256: sha256Schema.optional(),
  credentialSource: z.enum([
    "tenant_vault",
    "deployment_environment",
  ]).optional(),
  usageReceiptRecorded: z.literal(true),
  usageReceiptId: contractIdSchema,
}).strict();

const cognificationCandidateBatchBodyV1Schema = z.object({
  schemaVersion: z.literal(COGNIFICATION_CONTRACT_SCHEMA_VERSION),
  contractKind: z.literal(COGNIFICATION_CONTRACT_KIND),
  candidateOnly: z.literal(true),
  batchId: batchIdSchema,
  tenantId: contractIdSchema,
  ownerActorId: contractIdSchema,
  documentId: contractIdSchema,
  sourceItemId: contractIdSchema,
  sourceRevisionId: contractIdSchema,
  generationId: cognitionGenerationIdSchema.optional(),
  retentionExpiresAt: nullableTimestampSchema,
  batchIndex: z.number().int().nonnegative(),
  batchCount: z.number().int().positive().max(10_000),
  firstChunkIndex: z.number().int().nonnegative(),
  lastChunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive().max(64),
  inputCharacterCount: z.number().int().positive().max(100_000),
  batchInputSha256: sha256Schema,
  evidenceUnitIds: z.array(contractIdSchema).min(1).max(64),
  ontologyVersionId: z.literal(ASAEL_ONTOLOGY_VERSION_ID),
  topics: z.array(cognificationTopicCandidateV1Schema).max(12),
  claims: z.array(cognificationClaimCandidateV1Schema).max(32),
  entities: z.array(cognificationEntityCandidateV1Schema).max(32),
  relations: z.array(cognificationRelationCandidateV1Schema).max(32),
  summary: cognificationSummaryCandidateV1Schema,
  modelAttribution: cognificationModelAttributionV1Schema,
}).strict();

export const cognificationCandidateBatchV1Schema =
  cognificationCandidateBatchBodyV1Schema.extend({
    contractSha256: sha256Schema,
  }).strict().superRefine((value, context) => {
    validateBatchShape(value, context);
  });

export type CognificationEvidenceBindingV1 = Readonly<
  z.infer<typeof cognificationEvidenceBindingV1Schema>
>;
export type CognificationTopicCandidateV1 = Readonly<
  z.infer<typeof cognificationTopicCandidateV1Schema>
>;
export type CognificationClaimCandidateV1 = Readonly<
  z.infer<typeof cognificationClaimCandidateV1Schema>
>;
export type CognificationEntityCandidateV1 = Readonly<
  z.infer<typeof cognificationEntityCandidateV1Schema>
>;
export type CognificationRelationCandidateV1 = Readonly<
  z.infer<typeof cognificationRelationCandidateV1Schema>
>;
export type CognificationSummaryCandidateV1 = Readonly<
  z.infer<typeof cognificationSummaryCandidateV1Schema>
>;
export type CognificationCandidateBatchV1 = Readonly<
  z.infer<typeof cognificationCandidateBatchV1Schema>
>;
export type CognificationCandidateBatch = CognificationCandidateBatchV1;

export type BuildCognificationCandidateBatchV1Input = Omit<
  z.infer<typeof cognificationCandidateBatchBodyV1Schema>,
  "schemaVersion" | "contractKind" | "candidateOnly"
>;

export function buildCognificationCandidateBatchV1(
  input: BuildCognificationCandidateBatchV1Input,
): CognificationCandidateBatchV1 {
  const body = cognificationCandidateBatchBodyV1Schema.parse({
    schemaVersion: COGNIFICATION_CONTRACT_SCHEMA_VERSION,
    contractKind: COGNIFICATION_CONTRACT_KIND,
    candidateOnly: true,
    ...input,
  });
  return parseCognificationCandidateBatchV1({
    ...body,
    contractSha256: sourceContractSha256(body),
  });
}

export function parseCognificationCandidateBatchV1(
  value: unknown,
): CognificationCandidateBatchV1 {
  return deepFreeze(cognificationCandidateBatchV1Schema.parse(value));
}

export function deriveCognificationBatchId(input: {
  documentId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  generationId?: string;
  retentionExpiresAt: string | null;
  batchIndex: number;
  batchInputSha256: string;
}) {
  return `cognition_batch_${sourceContractSha256(input).slice(0, 48)}`;
}

export function deriveCognificationCandidateId(
  candidateKind: "topic" | "claim" | "entity" | "relation" | "summary",
  candidateBody: Record<string, unknown>,
) {
  return `cognition_candidate_${sourceContractSha256({
    candidateKind,
    ...candidateBody,
  }).slice(0, 48)}`;
}

/** Exact canonical evidence IDs cited by at least one candidate. */
export function collectCognificationEvidenceUnitIds(
  value: unknown,
): readonly string[] {
  const contract = parseCognificationCandidateBatchV1(value);
  const ids = new Set<string>();
  for (const binding of everyEvidenceBinding(contract)) {
    ids.add(binding.evidenceUnitId);
  }
  return Object.freeze([...ids].sort((left, right) =>
    left.localeCompare(right)
  ));
}

/** Memory formation refs for the immutable evidence cited by the candidates. */
export function collectCognificationEvidenceRefs(
  value: unknown,
): readonly string[] {
  return Object.freeze(
    collectCognificationEvidenceUnitIds(value).map((id) => `evidence:${id}`),
  );
}

/**
 * Renders only validated review candidates. Explicit entity/relation marker
 * lines are isolated from model-authored prose so promotion remains a human
 * review action, never an implicit model write.
 */
export function renderCognificationCandidateReview(value: unknown) {
  const contract = parseCognificationCandidateBatchV1(value);
  const evidenceRefs = collectCognificationEvidenceRefs(contract);
  const lines = [
    "Cognification review candidate — not canonical until confirmed",
    "",
    "Summary",
    sanitizeReviewProse(contract.summary.text),
    "",
    "Topics",
    ...contract.topics.map((topic) =>
      `- ${sanitizeReviewProse(topic.label)} — ${sanitizeReviewProse(topic.description)}`
    ),
    "",
    "Claims",
    ...contract.claims.map((claim) =>
      `- [${claim.epistemicKind}] ${sanitizeReviewProse(claim.statement)}`
    ),
    "",
    "Explicit typed entities",
    ...contract.entities.map((entity) =>
      `${humanTypeId(entity.entityTypeId)}: "${entity.canonicalLabel}"`
    ),
    "",
    "Explicit typed relations",
    ...contract.relations.map((relation) =>
      `relation: ${relation.relationTypeId} | ${humanTypeId(relation.source.entityTypeId)}: "${relation.source.canonicalLabel}" -> ${humanTypeId(relation.target.entityTypeId)}: "${relation.target.canonicalLabel}"`
    ),
    "",
    "Evidence",
    ...evidenceRefs.map((reference) => `- ${reference}`),
  ];
  return `${lines.join("\n").trim()}\n`;
}

function validateBatchShape(
  value: z.infer<typeof cognificationCandidateBatchV1Schema>,
  context: z.RefinementCtx,
) {
  if (
    value.batchIndex >= value.batchCount ||
    value.lastChunkIndex < value.firstChunkIndex ||
    value.lastChunkIndex - value.firstChunkIndex + 1 !== value.chunkCount ||
    value.evidenceUnitIds.length !== value.chunkCount ||
    new Set(value.evidenceUnitIds).size !== value.evidenceUnitIds.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Cognification batch boundaries are inconsistent.",
      path: ["batchIndex"],
    });
  }
  if (
    value.batchId !== deriveCognificationBatchId({
      documentId: value.documentId,
      sourceItemId: value.sourceItemId,
      sourceRevisionId: value.sourceRevisionId,
      ...(value.generationId ? { generationId: value.generationId } : {}),
      retentionExpiresAt: value.retentionExpiresAt,
      batchIndex: value.batchIndex,
      batchInputSha256: value.batchInputSha256,
    })
  ) {
    context.addIssue({
      code: "custom",
      message: "Cognification batch ID does not match its immutable input.",
      path: ["batchId"],
    });
  }

  const evidenceIds = new Set(value.evidenceUnitIds);
  for (const binding of everyEvidenceBinding(value)) {
    if (!evidenceIds.has(binding.evidenceUnitId)) {
      context.addIssue({
        code: "custom",
        message: "Candidate evidence is outside this cognition batch.",
        path: ["evidenceUnitIds"],
      });
    }
    if (
      binding.chunkIndex < value.firstChunkIndex ||
      binding.chunkIndex > value.lastChunkIndex
    ) {
      context.addIssue({
        code: "custom",
        message: "Candidate evidence references a chunk outside this batch.",
        path: ["firstChunkIndex"],
      });
    }
  }

  const candidateIds = new Set<string>();
  const candidates: Array<{
    kind: "topic" | "claim" | "entity" | "relation" | "summary";
    candidate: { candidateId: string } & Record<string, unknown>;
  }> = [
    ...value.topics.map((candidate) => ({ kind: "topic" as const, candidate })),
    ...value.claims.map((candidate) => ({ kind: "claim" as const, candidate })),
    ...value.entities.map((candidate) => ({ kind: "entity" as const, candidate })),
    ...value.relations.map((candidate) => ({ kind: "relation" as const, candidate })),
    { kind: "summary", candidate: value.summary },
  ];
  for (const { kind, candidate } of candidates) {
    const { candidateId, ...body } = candidate;
    if (
      candidateIds.has(candidateId) ||
      candidateId !== deriveCognificationCandidateId(kind, body)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cognification candidate identity is invalid or duplicated.",
        path: [`${kind}s`],
      });
    }
    candidateIds.add(candidateId);
  }

  const entities = new Map(value.entities.map((entity) => [
    entity.candidateId,
    entity,
  ]));
  for (const relation of value.relations) {
    const source = entities.get(relation.source.entityCandidateId);
    const target = entities.get(relation.target.entityCandidateId);
    const definition = getEntityRelationDefinition(
      value.ontologyVersionId,
      relation.relationTypeId,
    );
    if (
      !source ||
      !target ||
      source.entityTypeId !== relation.source.entityTypeId ||
      source.canonicalLabel !== relation.source.canonicalLabel ||
      target.entityTypeId !== relation.target.entityTypeId ||
      target.canonicalLabel !== relation.target.canonicalLabel ||
      !definition.sourceTypeIds.includes(relation.source.entityTypeId) ||
      !definition.targetTypeIds.includes(relation.target.entityTypeId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cognification relation endpoints violate the pinned ontology.",
        path: ["relations"],
      });
    }
  }

  const { contractSha256, ...body } = value;
  if (sourceContractSha256(body) !== contractSha256) {
    context.addIssue({
      code: "custom",
      message: "Cognification contract digest is invalid.",
      path: ["contractSha256"],
    });
  }
}

function everyEvidenceBinding(
  contract: Pick<
    CognificationCandidateBatchV1,
    "topics" | "claims" | "entities" | "relations" | "summary"
  >,
) {
  return [
    ...contract.summary.evidence,
    ...contract.topics.flatMap((candidate) => candidate.evidence),
    ...contract.claims.flatMap((candidate) => candidate.evidence),
    ...contract.entities.flatMap((candidate) => candidate.evidence),
    ...contract.relations.flatMap((candidate) => candidate.evidence),
  ];
}

function humanTypeId(value: string) {
  return value.replaceAll("_", " ");
}

function sanitizeReviewProse(value: string) {
  const entityMarkers = [
    "person",
    "organization",
    "account",
    "project",
    "work item",
    "work_item",
    "event",
    "meeting",
    "place",
    "asset",
    "decision",
    "commitment",
    "preference",
    "risk",
    "goal",
    "product",
    "case",
    "opportunity",
    "relation",
  ].join("|");
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(new RegExp(`\\b(${entityMarkers})\\s*:`, "giu"), "$1꞉")
    .trim();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
