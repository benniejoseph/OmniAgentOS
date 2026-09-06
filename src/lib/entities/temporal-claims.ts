import { z } from "zod";

import {
  ASAEL_ONTOLOGY_VERSION_ID,
  entityRelationTypeIdSchema,
  entityTypeIdSchema,
  getEntityRelationDefinition,
} from "@/lib/entities/ontology";
import {
  entityAccessBindingSchema,
  entityLineageReferenceSchema,
  parseEntityAccessBinding,
  parseEntityRecord,
  type EntityAccessBinding,
  type EntityRecord,
} from "@/lib/entities/registry";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const TEMPORAL_RELATION_CLAIM_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const relationEpistemicKindSchema = z.enum([
  "asserted",
  "observed",
  "inferred",
  "computed",
]);

const relationEndpointSchema = z.object({
  entityId: idSchema,
  entityTypeId: entityTypeIdSchema,
  entitySha256: sha256Schema,
}).strict();

const temporalRelationClaimRevisionBodySchema = z.object({
  schemaVersion: z.literal(TEMPORAL_RELATION_CLAIM_SCHEMA_VERSION),
  claimId: idSchema,
  revisionId: idSchema,
  previousRevisionId: idSchema.nullable(),
  ontologyVersionId: z.literal(ASAEL_ONTOLOGY_VERSION_ID),
  relationTypeId: entityRelationTypeIdSchema,
  source: relationEndpointSchema,
  target: relationEndpointSchema,
  epistemicKind: relationEpistemicKindSchema,
  claimState: z.enum(["active", "retracted"]),
  confidenceBasisPoints: z.number().int().min(0).max(10_000),
  accessBinding: entityAccessBindingSchema,
  lineage: z.array(entityLineageReferenceSchema).min(1).max(64),
  validFrom: timestampSchema,
  validTo: timestampSchema.nullable(),
  recordedAt: timestampSchema,
}).strict();

export const temporalRelationClaimRevisionSchema =
  temporalRelationClaimRevisionBodySchema.extend({
    claimSha256: sha256Schema,
  }).strict();

export const temporalRelationClaimRecordSchema = z.object({
  claim: temporalRelationClaimRevisionSchema,
  supersededAt: timestampSchema.nullable(),
}).strict();

export type RelationEpistemicKind = z.infer<
  typeof relationEpistemicKindSchema
>;
export type TemporalRelationClaimRevision = z.infer<
  typeof temporalRelationClaimRevisionSchema
>;
export type TemporalRelationClaimRecord = z.infer<
  typeof temporalRelationClaimRecordSchema
>;

export function parseTemporalRelationClaimRevision(
  value: unknown,
): TemporalRelationClaimRevision {
  const claim = temporalRelationClaimRevisionSchema.parse(value);
  parseEntityAccessBinding(claim.accessBinding);
  const relation = getEntityRelationDefinition(
    claim.ontologyVersionId,
    claim.relationTypeId,
  );
  if (!relation.sourceTypeIds.includes(claim.source.entityTypeId)) {
    throw new Error("Entity relation source type is not allowed by the ontology.");
  }
  if (!relation.targetTypeIds.includes(claim.target.entityTypeId)) {
    throw new Error("Entity relation target type is not allowed by the ontology.");
  }
  if (claim.source.entityId === claim.target.entityId) {
    throw new Error("Entity relation endpoints must be distinct.");
  }
  if (
    relation.direction === "symmetric" &&
    claim.source.entityId.localeCompare(claim.target.entityId) >= 0
  ) {
    throw new Error("Symmetric entity relation endpoints are not canonical.");
  }
  if (
    claim.validTo !== null &&
    new Date(claim.validTo).getTime() <= new Date(claim.validFrom).getTime()
  ) {
    throw new Error("Entity relation valid time must be a non-empty interval.");
  }
  if (claim.previousRevisionId === claim.revisionId) {
    throw new Error("Entity relation revision cannot supersede itself.");
  }
  assertUniqueLineage(claim.lineage);
  const { claimSha256, ...body } = claim;
  if (sourceContractSha256(body) !== claimSha256) {
    throw new Error("Entity relation claim digest is invalid.");
  }
  return deepFreeze(claim);
}

export function parseTemporalRelationClaimRecord(
  value: unknown,
): TemporalRelationClaimRecord {
  const record = temporalRelationClaimRecordSchema.parse(value);
  const claim = parseTemporalRelationClaimRevision(record.claim);
  if (
    record.supersededAt !== null &&
    new Date(record.supersededAt).getTime() <=
      new Date(claim.recordedAt).getTime()
  ) {
    throw new Error("Entity relation system time must be a non-empty interval.");
  }
  return deepFreeze({ claim, supersededAt: record.supersededAt });
}

export function buildTemporalRelationClaim(input: {
  claimId?: string;
  relationTypeId: TemporalRelationClaimRevision["relationTypeId"];
  sourceEntity: EntityRecord;
  targetEntity: EntityRecord;
  epistemicKind: RelationEpistemicKind;
  confidenceBasisPoints: number;
  accessBinding: EntityAccessBinding;
  lineage: readonly EntityRecord["lineage"][number][];
  validFrom: string;
  validTo?: string | null;
  recordedAt?: string;
}): TemporalRelationClaimRevision {
  const accessBinding = parseEntityAccessBinding(input.accessBinding);
  const sourceEntity = parseEntityRecord(input.sourceEntity);
  const targetEntity = parseEntityRecord(input.targetEntity);
  assertActiveScopedEndpoints(sourceEntity, targetEntity, accessBinding);
  const relation = getEntityRelationDefinition(
    ASAEL_ONTOLOGY_VERSION_ID,
    input.relationTypeId,
  );
  const [source, target] = canonicalEndpoints(
    relation.direction,
    endpoint(sourceEntity),
    endpoint(targetEntity),
  );
  const lineage = uniqueLineage(input.lineage);
  const validFrom = canonicalTimestamp(input.validFrom);
  const validTo = input.validTo ? canonicalTimestamp(input.validTo) : null;
  const recordedAt = canonicalTimestamp(
    input.recordedAt || new Date().toISOString(),
  );
  const claimId = input.claimId || `relation_claim_${sourceContractSha256({
    ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
    relationTypeId: input.relationTypeId,
    sourceEntityId: source.entityId,
    targetEntityId: target.entityId,
    accessScopeSha256: accessBinding.accessScopeSha256,
    lineage,
    validFrom,
  }).slice(0, 48)}`;
  return buildRevision({
    claimId,
    previousRevisionId: null,
    relationTypeId: input.relationTypeId,
    source,
    target,
    epistemicKind: input.epistemicKind,
    claimState: "active",
    confidenceBasisPoints: input.confidenceBasisPoints,
    accessBinding,
    lineage,
    validFrom,
    validTo,
    recordedAt,
  });
}

export function reviseTemporalRelationClaim(input: {
  current: TemporalRelationClaimRevision;
  epistemicKind?: RelationEpistemicKind;
  claimState?: "active" | "retracted";
  confidenceBasisPoints?: number;
  lineage?: readonly EntityRecord["lineage"][number][];
  validFrom?: string;
  validTo?: string | null;
  recordedAt?: string;
}): TemporalRelationClaimRevision {
  const current = parseTemporalRelationClaimRevision(input.current);
  const recordedAt = canonicalTimestamp(
    input.recordedAt || new Date().toISOString(),
  );
  if (recordedAt <= current.recordedAt) {
    throw new Error("Entity relation revision must advance system time.");
  }
  return buildRevision({
    claimId: current.claimId,
    previousRevisionId: current.revisionId,
    relationTypeId: current.relationTypeId,
    source: current.source,
    target: current.target,
    epistemicKind: input.epistemicKind || current.epistemicKind,
    claimState: input.claimState || current.claimState,
    confidenceBasisPoints:
      input.confidenceBasisPoints ?? current.confidenceBasisPoints,
    accessBinding: current.accessBinding,
    lineage: input.lineage ? uniqueLineage(input.lineage) : current.lineage,
    validFrom: input.validFrom
      ? canonicalTimestamp(input.validFrom)
      : current.validFrom,
    validTo: input.validTo === undefined
      ? current.validTo
      : input.validTo === null
        ? null
        : canonicalTimestamp(input.validTo),
    recordedAt,
  });
}

export function relationClaimIsVisibleAt(
  record: TemporalRelationClaimRecord,
  input: { validAt: string; recordedAt: string; includeRetracted?: boolean },
) {
  const parsed = parseTemporalRelationClaimRecord(record);
  const validAt = canonicalTimestamp(input.validAt);
  const recordedAt = canonicalTimestamp(input.recordedAt);
  return (
    parsed.claim.recordedAt <= recordedAt &&
    (parsed.supersededAt === null || parsed.supersededAt > recordedAt) &&
    parsed.claim.validFrom <= validAt &&
    (parsed.claim.validTo === null || parsed.claim.validTo > validAt) &&
    (input.includeRetracted || parsed.claim.claimState === "active")
  );
}

function buildRevision(
  input: Omit<
    z.input<typeof temporalRelationClaimRevisionBodySchema>,
    "schemaVersion" | "ontologyVersionId" | "revisionId"
  >,
) {
  const revisionIdentity = {
    schemaVersion: TEMPORAL_RELATION_CLAIM_SCHEMA_VERSION,
    ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
    ...input,
  };
  const revisionId = `relation_revision_${sourceContractSha256(
    revisionIdentity,
  ).slice(0, 45)}`;
  const body = temporalRelationClaimRevisionBodySchema.parse({
    ...revisionIdentity,
    revisionId,
  });
  return parseTemporalRelationClaimRevision({
    ...body,
    claimSha256: sourceContractSha256(body),
  });
}

function endpoint(entity: EntityRecord) {
  return {
    entityId: entity.entityId,
    entityTypeId: entity.entityTypeId,
    entitySha256: entity.entitySha256,
  };
}

function canonicalEndpoints(
  direction: "directed" | "symmetric",
  source: z.infer<typeof relationEndpointSchema>,
  target: z.infer<typeof relationEndpointSchema>,
) {
  return direction === "symmetric" &&
      source.entityId.localeCompare(target.entityId) > 0
    ? [target, source] as const
    : [source, target] as const;
}

function assertActiveScopedEndpoints(
  source: EntityRecord,
  target: EntityRecord,
  binding: EntityAccessBinding,
) {
  for (const entity of [source, target]) {
    if (
      entity.state !== "active" ||
      entity.accessBinding.tenantId !== binding.tenantId ||
      entity.accessBinding.ownerActorId !== binding.ownerActorId ||
      entity.accessBinding.accessScopeSha256 !== binding.accessScopeSha256
    ) {
      throw new Error("Entity relation endpoints must be active in one access scope.");
    }
  }
}

function uniqueLineage(
  values: readonly EntityRecord["lineage"][number][],
) {
  return [...new Map(values.map((value) => {
    const parsed = entityLineageReferenceSchema.parse(value);
    return [
      `${parsed.kind}:${parsed.referenceId}:${parsed.referenceSha256}`,
      parsed,
    ];
  })).values()].sort((left, right) =>
    `${left.kind}:${left.referenceId}:${left.referenceSha256}`.localeCompare(
      `${right.kind}:${right.referenceId}:${right.referenceSha256}`,
    )
  );
}

function assertUniqueLineage(
  values: readonly EntityRecord["lineage"][number][],
) {
  if (uniqueLineage(values).length !== values.length) {
    throw new Error("Entity relation lineage contains duplicates.");
  }
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Entity relation timestamp is invalid.");
  }
  return parsed.toISOString();
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
