import { z } from "zod";

import {
  ASAEL_ONTOLOGY_VERSION_ID,
  entityTypeIdSchema,
  getEntityTypeDefinition,
  type EntityTypeId,
} from "@/lib/entities/ontology";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const ENTITY_REGISTRY_SCHEMA_VERSION = 1 as const;
export const ENTITY_REGISTRY_RESOLVER_VERSION_ID =
  "entity-resolver:deterministic-v1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const entityVisibilitySchema = z.enum([
  "agent_private",
  "user_private",
  "mission_shared",
  "project_shared",
  "workspace_shared",
]);

export const entitySensitivitySchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

const entityAccessBindingBodySchema = z.object({
  schemaVersion: z.literal(ENTITY_REGISTRY_SCHEMA_VERSION),
  tenantId: idSchema,
  ownerActorId: idSchema,
  ownerAgentId: idSchema.nullable(),
  workspaceId: idSchema.nullable(),
  projectId: idSchema.nullable(),
  missionId: idSchema.nullable(),
  visibility: entityVisibilitySchema,
  sensitivity: entitySensitivitySchema,
  allowedPurposeIds: z.array(idSchema).min(1).max(32),
  boundAt: timestampSchema,
}).strict();

export const entityAccessBindingSchema = entityAccessBindingBodySchema.extend({
  accessScopeSha256: sha256Schema,
}).strict();

export const entityLineageReferenceSchema = z.object({
  kind: z.enum([
    "evidence_unit",
    "memory",
    "run_receipt",
    "entity_assertion",
  ]),
  referenceId: idSchema,
  referenceSha256: sha256Schema,
}).strict();

const entityRecordBodySchema = z.object({
  schemaVersion: z.literal(ENTITY_REGISTRY_SCHEMA_VERSION),
  entityId: idSchema,
  ontologyVersionId: z.literal(ASAEL_ONTOLOGY_VERSION_ID),
  entityTypeId: entityTypeIdSchema,
  canonicalLabel: z.string().trim().min(1).max(320),
  normalizedLabelSha256: sha256Schema,
  state: z.enum(["active", "merged", "retired"]),
  mergedIntoEntityId: idSchema.nullable(),
  accessBinding: entityAccessBindingSchema,
  lineage: z.array(entityLineageReferenceSchema).max(64),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.state === "merged") !== (value.mergedIntoEntityId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["mergedIntoEntityId"],
      message: "Only a merged entity may reference its surviving entity.",
    });
  }
  if (value.state !== "retired" && value.lineage.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["lineage"],
      message: "An active or merged entity requires lineage.",
    });
  }
});

export const entityRecordSchema = entityRecordBodySchema.extend({
  entitySha256: sha256Schema,
}).strict();

const entityAliasBodySchema = z.object({
  schemaVersion: z.literal(ENTITY_REGISTRY_SCHEMA_VERSION),
  aliasId: idSchema,
  entityId: idSchema,
  alias: z.string().trim().min(1).max(320),
  normalizedAliasSha256: sha256Schema,
  accessScopeSha256: sha256Schema,
  lineage: entityLineageReferenceSchema,
  state: z.enum(["active", "retired"]),
  createdAt: timestampSchema,
}).strict();

export const entityAliasSchema = entityAliasBodySchema.extend({
  aliasSha256: sha256Schema,
}).strict();

const entityResolutionDecisionBodySchema = z.object({
  schemaVersion: z.literal(ENTITY_REGISTRY_SCHEMA_VERSION),
  resolutionId: idSchema,
  resolverVersionId: z.literal(ENTITY_REGISTRY_RESOLVER_VERSION_ID),
  ontologyVersionId: z.literal(ASAEL_ONTOLOGY_VERSION_ID),
  tenantId: idSchema,
  ownerActorId: idSchema,
  entityTypeId: entityTypeIdSchema,
  inputLabelSha256: sha256Schema,
  accessScopeSha256: sha256Schema,
  decision: z.enum(["auto_link", "review_required", "create_new"]),
  selectedEntityId: idSchema.nullable(),
  candidateEntityIds: z.array(idSchema).max(32),
  matchMethod: z.enum([
    "exact_canonical_label",
    "exact_alias",
    "ambiguous_exact",
    "fuzzy_candidate",
    "none",
  ]),
  scoreBasisPoints: z.number().int().min(0).max(10_000),
  decidedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.decision === "auto_link") !== (value.selectedEntityId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["selectedEntityId"],
      message: "Only an auto-link decision selects an entity.",
    });
  }
  if (value.decision === "review_required" && value.candidateEntityIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["candidateEntityIds"],
      message: "Review requires at least one candidate.",
    });
  }
});

export const entityResolutionDecisionSchema =
  entityResolutionDecisionBodySchema.extend({
    decisionSha256: sha256Schema,
  }).strict();

const entityMergeReviewBodySchema = z.object({
  schemaVersion: z.literal(ENTITY_REGISTRY_SCHEMA_VERSION),
  reviewId: idSchema,
  resolutionId: idSchema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  sourceEntityId: idSchema,
  targetEntityId: idSchema,
  accessScopeSha256: sha256Schema,
  decision: z.enum(["approved", "rejected", "reversed"]),
  previousReviewId: idSchema.nullable(),
  reviewerActorId: idSchema,
  reviewedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if (value.decision === "reversed" && value.previousReviewId === null) {
    context.addIssue({
      code: "custom",
      path: ["previousReviewId"],
      message: "A reversal must reference the approval it reverses.",
    });
  }
  if (value.decision !== "reversed" && value.previousReviewId !== null) {
    context.addIssue({
      code: "custom",
      path: ["previousReviewId"],
      message: "Only a reversal may reference a prior review.",
    });
  }
});

export const entityMergeReviewSchema = entityMergeReviewBodySchema.extend({
  reviewSha256: sha256Schema,
}).strict();

export type EntityAccessBinding = z.infer<typeof entityAccessBindingSchema>;
export type EntityRecord = z.infer<typeof entityRecordSchema>;
export type EntityAlias = z.infer<typeof entityAliasSchema>;
export type EntityResolutionDecision = z.infer<
  typeof entityResolutionDecisionSchema
>;
export type EntityMergeReview = z.infer<typeof entityMergeReviewSchema>;

export function parseEntityAccessBinding(value: unknown): EntityAccessBinding {
  const binding = entityAccessBindingSchema.parse(value);
  const { accessScopeSha256, ...body } = binding;
  if (sourceContractSha256(body) !== accessScopeSha256) {
    throw new Error("Entity access binding digest is invalid.");
  }
  return binding;
}

export function parseEntityRecord(value: unknown): EntityRecord {
  const entity = entityRecordSchema.parse(value);
  parseEntityAccessBinding(entity.accessBinding);
  getEntityTypeDefinition(entity.ontologyVersionId, entity.entityTypeId);
  if (
    !(entity.state === "retired" && entity.canonicalLabel === "[forgotten]") &&
    labelSha256(entity.canonicalLabel) !== entity.normalizedLabelSha256
  ) {
    throw new Error("Entity canonical label digest is invalid.");
  }
  const { entitySha256, ...body } = entity;
  if (sourceContractSha256(body) !== entitySha256) {
    throw new Error("Entity record digest is invalid.");
  }
  return entity;
}

export function parseEntityAlias(value: unknown): EntityAlias {
  const alias = entityAliasSchema.parse(value);
  if (
    !(alias.state === "retired" && alias.alias === "[forgotten]") &&
    labelSha256(alias.alias) !== alias.normalizedAliasSha256
  ) {
    throw new Error("Entity alias label digest is invalid.");
  }
  const { aliasSha256, ...body } = alias;
  if (sourceContractSha256(body) !== aliasSha256) {
    throw new Error("Entity alias digest is invalid.");
  }
  return alias;
}

export function parseEntityResolutionDecision(
  value: unknown,
): EntityResolutionDecision {
  const decision = entityResolutionDecisionSchema.parse(value);
  getEntityTypeDefinition(decision.ontologyVersionId, decision.entityTypeId);
  const { decisionSha256, ...body } = decision;
  if (sourceContractSha256(body) !== decisionSha256) {
    throw new Error("Entity resolution digest is invalid.");
  }
  return decision;
}

export function parseEntityMergeReview(value: unknown): EntityMergeReview {
  const review = entityMergeReviewSchema.parse(value);
  const { reviewSha256, ...body } = review;
  if (sourceContractSha256(body) !== reviewSha256) {
    throw new Error("Entity merge review digest is invalid.");
  }
  return review;
}

export function buildEntityAccessBinding(input: {
  tenantId: string;
  ownerActorId: string;
  ownerAgentId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  visibility: z.infer<typeof entityVisibilitySchema>;
  sensitivity: z.infer<typeof entitySensitivitySchema>;
  allowedPurposeIds: readonly string[];
  boundAt?: string;
}): EntityAccessBinding {
  const body = entityAccessBindingBodySchema.parse({
    schemaVersion: ENTITY_REGISTRY_SCHEMA_VERSION,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    ownerAgentId: input.ownerAgentId || null,
    workspaceId: input.workspaceId || null,
    projectId: input.projectId || null,
    missionId: input.missionId || null,
    visibility: input.visibility,
    sensitivity: input.sensitivity,
    allowedPurposeIds: uniqueSorted(input.allowedPurposeIds),
    boundAt: canonicalTimestamp(input.boundAt || new Date().toISOString()),
  });
  return entityAccessBindingSchema.parse({
    ...body,
    accessScopeSha256: sourceContractSha256(body),
  });
}

export function buildEntityRecord(input: {
  entityId?: string;
  entityTypeId: EntityTypeId;
  canonicalLabel: string;
  accessBinding: EntityAccessBinding;
  lineage: readonly z.infer<typeof entityLineageReferenceSchema>[];
  createdAt?: string;
}): EntityRecord {
  getEntityTypeDefinition(ASAEL_ONTOLOGY_VERSION_ID, input.entityTypeId);
  const createdAt = canonicalTimestamp(input.createdAt || new Date().toISOString());
  const normalizedLabelSha256 = labelSha256(input.canonicalLabel);
  const entityId = input.entityId || `entity_${sourceContractSha256({
    ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
    tenantId: input.accessBinding.tenantId,
    ownerActorId: input.accessBinding.ownerActorId,
    entityTypeId: input.entityTypeId,
    normalizedLabelSha256,
    accessScopeSha256: input.accessBinding.accessScopeSha256,
  }).slice(0, 56)}`;
  const body = entityRecordBodySchema.parse({
    schemaVersion: ENTITY_REGISTRY_SCHEMA_VERSION,
    entityId,
    ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
    entityTypeId: input.entityTypeId,
    canonicalLabel: input.canonicalLabel,
    normalizedLabelSha256,
    state: "active",
    mergedIntoEntityId: null,
    accessBinding: input.accessBinding,
    lineage: input.lineage,
    createdAt,
    updatedAt: createdAt,
  });
  return entityRecordSchema.parse({
    ...body,
    entitySha256: sourceContractSha256(body),
  });
}

export function transitionEntityRecord(input: {
  entity: EntityRecord;
  state: "active" | "merged" | "retired";
  mergedIntoEntityId?: string | null;
  updatedAt?: string;
}): EntityRecord {
  const current = parseEntityRecord(input.entity);
  const updatedAt = canonicalTimestamp(input.updatedAt || new Date().toISOString());
  if (new Date(updatedAt).getTime() < new Date(current.updatedAt).getTime()) {
    throw new Error("Entity state transition cannot move backward in time.");
  }
  const { entitySha256: _currentSha256, ...currentBody } = current;
  void _currentSha256;
  const body = entityRecordBodySchema.parse({
    ...currentBody,
    state: input.state,
    mergedIntoEntityId:
      input.state === "merged" ? input.mergedIntoEntityId || null : null,
    updatedAt,
  });
  return entityRecordSchema.parse({
    ...body,
    entitySha256: sourceContractSha256(body),
  });
}

export function reviseEntityLineage(input: {
  entity: EntityRecord;
  lineage: readonly z.infer<typeof entityLineageReferenceSchema>[];
  updatedAt?: string;
  retire?: boolean;
}): EntityRecord {
  const current = parseEntityRecord(input.entity);
  const updatedAt = canonicalTimestamp(input.updatedAt || new Date().toISOString());
  if (new Date(updatedAt).getTime() < new Date(current.updatedAt).getTime()) {
    throw new Error("Entity lineage revision cannot move backward in time.");
  }
  const lineage = uniqueLineage(input.lineage);
  const retire = input.retire || lineage.length === 0;
  const { entitySha256: _currentSha256, ...currentBody } = current;
  void _currentSha256;
  const body = entityRecordBodySchema.parse({
    ...currentBody,
    canonicalLabel: retire ? "[forgotten]" : current.canonicalLabel,
    state: retire ? "retired" : current.state,
    mergedIntoEntityId: retire ? null : current.mergedIntoEntityId,
    lineage,
    updatedAt,
  });
  return entityRecordSchema.parse({
    ...body,
    entitySha256: sourceContractSha256(body),
  });
}

export function buildEntityAlias(input: {
  entity: EntityRecord;
  alias: string;
  lineage: z.infer<typeof entityLineageReferenceSchema>;
  createdAt?: string;
}): EntityAlias {
  const createdAt = canonicalTimestamp(input.createdAt || new Date().toISOString());
  const normalizedAliasSha256 = labelSha256(input.alias);
  const body = entityAliasBodySchema.parse({
    schemaVersion: ENTITY_REGISTRY_SCHEMA_VERSION,
    aliasId: `entity_alias_${sourceContractSha256({
      entityId: input.entity.entityId,
      normalizedAliasSha256,
      accessScopeSha256: input.entity.accessBinding.accessScopeSha256,
    }).slice(0, 52)}`,
    entityId: input.entity.entityId,
    alias: input.alias,
    normalizedAliasSha256,
    accessScopeSha256: input.entity.accessBinding.accessScopeSha256,
    lineage: input.lineage,
    state: "active",
    createdAt,
  });
  return entityAliasSchema.parse({
    ...body,
    aliasSha256: sourceContractSha256(body),
  });
}

export function retireEntityAlias(input: {
  alias: EntityAlias;
  createdAt?: string;
}): EntityAlias {
  const current = parseEntityAlias(input.alias);
  const { aliasSha256: _currentSha256, ...currentBody } = current;
  void _currentSha256;
  const body = entityAliasBodySchema.parse({
    ...currentBody,
    alias: "[forgotten]",
    state: "retired",
    createdAt: canonicalTimestamp(input.createdAt || current.createdAt),
  });
  return entityAliasSchema.parse({
    ...body,
    aliasSha256: sourceContractSha256(body),
  });
}

export function resolveEntityIdentity(input: {
  entityTypeId: EntityTypeId;
  label: string;
  accessBinding: EntityAccessBinding;
  candidates: readonly Readonly<{
    entity: EntityRecord;
    aliases: readonly EntityAlias[];
  }>[];
  decidedAt?: string;
}): EntityResolutionDecision {
  getEntityTypeDefinition(ASAEL_ONTOLOGY_VERSION_ID, input.entityTypeId);
  const decidedAt = canonicalTimestamp(input.decidedAt || new Date().toISOString());
  const inputLabelSha256 = labelSha256(input.label);
  const eligible = input.candidates.filter(({ entity }) =>
    entity.state === "active" &&
    entity.entityTypeId === input.entityTypeId &&
    entity.accessBinding.tenantId === input.accessBinding.tenantId &&
    entity.accessBinding.ownerActorId === input.accessBinding.ownerActorId &&
    entity.accessBinding.accessScopeSha256 === input.accessBinding.accessScopeSha256
  );
  const exactCanonical = eligible.filter(({ entity }) =>
    entity.normalizedLabelSha256 === inputLabelSha256
  );
  const exactAlias = eligible.filter(({ aliases }) => aliases.some((alias) =>
    alias.state === "active" &&
    alias.accessScopeSha256 === input.accessBinding.accessScopeSha256 &&
    alias.normalizedAliasSha256 === inputLabelSha256
  ));
  const exactById = new Map(
    [...exactCanonical, ...exactAlias].map((candidate) => [
      candidate.entity.entityId,
      candidate,
    ]),
  );
  const exact = [...exactById.values()];
  const fuzzy = exact.length
    ? []
    : eligible
        .map((candidate) => ({
          candidate,
          score: Math.max(
            labelSimilarity(input.label, candidate.entity.canonicalLabel),
            ...candidate.aliases
              .filter((alias) => alias.state === "active")
              .map((alias) => labelSimilarity(input.label, alias.alias)),
          ),
        }))
        .filter(({ score }) => score >= 0.6)
        .sort((left, right) =>
          right.score - left.score ||
          left.candidate.entity.entityId.localeCompare(
            right.candidate.entity.entityId,
          )
        )
        .slice(0, 8);
  const decision = exact.length === 1
    ? "auto_link" as const
    : exact.length > 1 || fuzzy.length
      ? "review_required" as const
      : "create_new" as const;
  const candidates = exact.length
    ? exact.map(({ entity }) => entity.entityId).sort()
    : fuzzy.map(({ candidate }) => candidate.entity.entityId);
  const matchMethod = exact.length > 1
    ? "ambiguous_exact" as const
    : exact.length === 1
      ? exactCanonical.some(({ entity }) => entity.entityId === exact[0].entity.entityId)
        ? "exact_canonical_label" as const
        : "exact_alias" as const
      : fuzzy.length
        ? "fuzzy_candidate" as const
        : "none" as const;
  const scoreBasisPoints = exact.length
    ? 10_000
    : fuzzy.length
      ? Math.round(fuzzy[0].score * 10_000)
      : 0;
  const body = entityResolutionDecisionBodySchema.parse({
    schemaVersion: ENTITY_REGISTRY_SCHEMA_VERSION,
    resolutionId: `entity_resolution_${sourceContractSha256({
      tenantId: input.accessBinding.tenantId,
      ownerActorId: input.accessBinding.ownerActorId,
      entityTypeId: input.entityTypeId,
      inputLabelSha256,
      accessScopeSha256: input.accessBinding.accessScopeSha256,
      decidedAt,
    }).slice(0, 50)}`,
    resolverVersionId: ENTITY_REGISTRY_RESOLVER_VERSION_ID,
    ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
    tenantId: input.accessBinding.tenantId,
    ownerActorId: input.accessBinding.ownerActorId,
    entityTypeId: input.entityTypeId,
    inputLabelSha256,
    accessScopeSha256: input.accessBinding.accessScopeSha256,
    decision,
    selectedEntityId: decision === "auto_link" ? candidates[0] : null,
    candidateEntityIds: candidates,
    matchMethod,
    scoreBasisPoints,
    decidedAt,
  });
  return entityResolutionDecisionSchema.parse({
    ...body,
    decisionSha256: sourceContractSha256(body),
  });
}

export function buildEntityMergeReview(input: {
  resolution: EntityResolutionDecision;
  sourceEntity: EntityRecord;
  targetEntity: EntityRecord;
  reviewerActorId: string;
  decision: "approved" | "rejected" | "reversed";
  previousReview?: EntityMergeReview;
  reviewedAt?: string;
}): EntityMergeReview {
  if (
    input.resolution.decision !== "review_required" ||
    input.sourceEntity.entityId === input.targetEntity.entityId ||
    (input.decision !== "reversed" && input.targetEntity.state !== "active") ||
    input.sourceEntity.entityTypeId !== input.targetEntity.entityTypeId ||
    input.sourceEntity.accessBinding.accessScopeSha256 !==
      input.targetEntity.accessBinding.accessScopeSha256 ||
    input.sourceEntity.accessBinding.accessScopeSha256 !==
      input.resolution.accessScopeSha256 ||
    input.reviewerActorId !== input.resolution.ownerActorId ||
    input.resolution.tenantId !== input.sourceEntity.accessBinding.tenantId ||
    !input.resolution.candidateEntityIds.includes(input.sourceEntity.entityId) ||
    !input.resolution.candidateEntityIds.includes(input.targetEntity.entityId)
  ) {
    throw new Error("Entity merge review does not match its scoped candidates.");
  }
  if (
    (
      input.decision === "reversed" &&
      (
        input.sourceEntity.state !== "merged" ||
        input.sourceEntity.mergedIntoEntityId !== input.targetEntity.entityId
      )
    ) ||
    (input.decision !== "reversed" && input.sourceEntity.state !== "active")
  ) {
    throw new Error("Entity merge review does not match the current entity state.");
  }
  if (
    input.decision === "reversed" &&
    (
      !input.previousReview ||
      input.previousReview.decision !== "approved" ||
      input.previousReview.resolutionId !== input.resolution.resolutionId ||
      input.previousReview.sourceEntityId !== input.sourceEntity.entityId ||
      input.previousReview.targetEntityId !== input.targetEntity.entityId ||
      input.previousReview.ownerActorId !== input.resolution.ownerActorId ||
      input.previousReview.accessScopeSha256 !== input.resolution.accessScopeSha256
    )
  ) {
    throw new Error("Entity merge reversal requires the exact prior approval.");
  }
  const reviewedAt = canonicalTimestamp(input.reviewedAt || new Date().toISOString());
  const body = entityMergeReviewBodySchema.parse({
    schemaVersion: ENTITY_REGISTRY_SCHEMA_VERSION,
    reviewId: `entity_merge_review_${sourceContractSha256({
      resolutionId: input.resolution.resolutionId,
      sourceEntityId: input.sourceEntity.entityId,
      targetEntityId: input.targetEntity.entityId,
      decision: input.decision,
      previousReviewId: input.previousReview?.reviewId || null,
      reviewedAt,
    }).slice(0, 48)}`,
    resolutionId: input.resolution.resolutionId,
    tenantId: input.resolution.tenantId,
    ownerActorId: input.resolution.ownerActorId,
    sourceEntityId: input.sourceEntity.entityId,
    targetEntityId: input.targetEntity.entityId,
    accessScopeSha256: input.resolution.accessScopeSha256,
    decision: input.decision,
    previousReviewId: input.previousReview?.reviewId || null,
    reviewerActorId: input.reviewerActorId,
    reviewedAt,
  });
  return entityMergeReviewSchema.parse({
    ...body,
    reviewSha256: sourceContractSha256(body),
  });
}

export function labelSha256(value: string) {
  return sourceContractSha256(normalizeEntityLabel(value));
}

export function normalizeEntityLabel(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 320);
}

function labelSimilarity(left: string, right: string) {
  const leftTokens = new Set(normalizeEntityLabel(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeEntityLabel(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Entity registry timestamp is invalid.");
  }
  return parsed.toISOString();
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function uniqueLineage(
  values: readonly z.infer<typeof entityLineageReferenceSchema>[],
) {
  return [...new Map(values.map((value) => [
    `${value.kind}:${value.referenceId}:${value.referenceSha256}`,
    entityLineageReferenceSchema.parse(value),
  ])).values()].sort((left, right) =>
    `${left.kind}:${left.referenceId}:${left.referenceSha256}`.localeCompare(
      `${right.kind}:${right.referenceId}:${right.referenceSha256}`,
    )
  );
}
