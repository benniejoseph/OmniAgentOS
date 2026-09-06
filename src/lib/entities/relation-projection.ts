import { z } from "zod";

import {
  entityRelationTypeIdSchema,
  entityTypeIdSchema,
  getEntityRelationDefinition,
  type EntityRelationTypeId,
  type EntityTypeId,
} from "@/lib/entities/ontology";
import {
  labelSha256,
  parseEntityAccessBinding,
  parseEntityAlias,
  parseEntityRecord,
  type EntityAccessBinding,
  type EntityAlias,
  type EntityRecord,
} from "@/lib/entities/registry";
import {
  buildTemporalRelationClaim,
  type RelationEpistemicKind,
  type TemporalRelationClaimRevision,
} from "@/lib/entities/temporal-claims";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const RELATION_PROJECTION_SCHEMA_VERSION = 1 as const;
export const EXPLICIT_RELATION_EXTRACTOR_VERSION_ID =
  "relation-extractor:explicit-markers-v1" as const;

const timestampSchema = z.string().datetime({ offset: true });
const relationLinePrefix = /^\s*relation\s*:/iu;
const endpointPattern = /^\s*([a-z_ ]{1,40})\s*:\s*(?:"([^"\r\n]{1,320})"|“([^”\r\n]{1,320})”)\s*$/iu;

export type ExplicitRelationCandidate = Readonly<{
  relationTypeId: EntityRelationTypeId;
  source: Readonly<{
    entityTypeId: EntityTypeId;
    canonicalLabel: string;
    normalizedLabelSha256: string;
  }>;
  target: Readonly<{
    entityTypeId: EntityTypeId;
    canonicalLabel: string;
    normalizedLabelSha256: string;
  }>;
  validFrom: string;
  validTo: string | null;
  candidateSha256: string;
}>;

export type RelationProjectionSource = Readonly<{
  sourceKind: "memory" | "evidence_unit";
  sourceId: string;
  sourceSha256: string;
  content: string;
  accessBinding: EntityAccessBinding;
  epistemicKind: Extract<RelationEpistemicKind, "asserted" | "observed">;
  confidenceBasisPoints: number;
  defaultValidFrom: string;
  defaultValidTo: string | null;
  recordedAt: string;
}>;

export type RelationProjectionPlan = Readonly<{
  schemaVersion: typeof RELATION_PROJECTION_SCHEMA_VERSION;
  extractorVersionId: typeof EXPLICIT_RELATION_EXTRACTOR_VERSION_ID;
  desiredClaims: readonly TemporalRelationClaimRevision[];
  sourceCount: number;
  markerCount: number;
  rejectedMarkerCount: number;
  unresolvedMarkerCount: number;
  projectionSha256: string;
}>;

/**
 * Parses only explicit, line-bounded relation statements. Ordinary prose,
 * retrieval traces, and model output cannot be promoted into truth edges.
 *
 * relation: assigned_to | work item: "Ship P5.4" -> person: "Ada"
 * relation: belongs_to | project: "Phoenix" -> organization: "Acme" |
 *   valid-from: 2026-01-01T00:00:00Z | valid-to: 2027-01-01T00:00:00Z
 */
export function extractExplicitRelationCandidates(
  content: string,
  defaults: { validFrom: string; validTo?: string | null },
) {
  const defaultValidFrom = canonicalTimestamp(defaults.validFrom);
  const defaultValidTo = defaults.validTo
    ? canonicalTimestamp(defaults.validTo)
    : null;
  const candidates = new Map<string, ExplicitRelationCandidate>();
  let markerCount = 0;
  let rejectedMarkerCount = 0;

  for (const line of content.split(/\r?\n/u)) {
    if (!relationLinePrefix.test(line)) continue;
    markerCount += 1;
    const candidate = parseRelationLine(line, {
      validFrom: defaultValidFrom,
      validTo: defaultValidTo,
    });
    if (!candidate) {
      rejectedMarkerCount += 1;
      continue;
    }
    candidates.set(candidate.candidateSha256, candidate);
    if (candidates.size === 64) break;
  }

  return Object.freeze({
    candidates: Object.freeze([...candidates.values()].sort((left, right) =>
      left.candidateSha256.localeCompare(right.candidateSha256)
    )),
    markerCount,
    rejectedMarkerCount,
  });
}

/** Builds the deterministic desired relation set used by both queue repair and rebuild. */
export function buildRelationProjectionPlan(input: {
  sources: readonly RelationProjectionSource[];
  entities: readonly EntityRecord[];
  aliases?: readonly EntityAlias[];
}): RelationProjectionPlan {
  const entities = input.entities.map(parseEntityRecord);
  const aliases = (input.aliases || []).map(parseEntityAlias);
  const desiredClaims = new Map<string, TemporalRelationClaimRevision>();
  const conflictingClaimIds = new Set<string>();
  let markerCount = 0;
  let rejectedMarkerCount = 0;
  let unresolvedMarkerCount = 0;

  const orderedSources = [...input.sources]
    .map(parseProjectionSource)
    .sort((left, right) =>
      left.sourceKind.localeCompare(right.sourceKind) ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.sourceSha256.localeCompare(right.sourceSha256)
    );

  for (const source of orderedSources) {
    const extraction = extractExplicitRelationCandidates(source.content, {
      validFrom: source.defaultValidFrom,
      validTo: source.defaultValidTo,
    });
    markerCount += extraction.markerCount;
    rejectedMarkerCount += extraction.rejectedMarkerCount;
    for (const candidate of extraction.candidates) {
      const sourceEntity = resolveExactEndpoint(
        entities,
        aliases,
        source.accessBinding,
        candidate.source,
      );
      const targetEntity = resolveExactEndpoint(
        entities,
        aliases,
        source.accessBinding,
        candidate.target,
      );
      if (
        !sourceEntity ||
        !targetEntity ||
        sourceEntity.entityId === targetEntity.entityId
      ) {
        unresolvedMarkerCount += 1;
        continue;
      }
      const claim = buildTemporalRelationClaim({
        relationTypeId: candidate.relationTypeId,
        sourceEntity,
        targetEntity,
        epistemicKind: source.epistemicKind,
        confidenceBasisPoints: source.confidenceBasisPoints,
        accessBinding: source.accessBinding,
        lineage: [{
          kind: source.sourceKind,
          referenceId: source.sourceId,
          referenceSha256: source.sourceSha256,
        }],
        validFrom: candidate.validFrom,
        validTo: candidate.validTo,
        recordedAt: source.recordedAt,
      });
      const existing = desiredClaims.get(claim.claimId);
      if (existing && existing.claimSha256 !== claim.claimSha256) {
        desiredClaims.delete(claim.claimId);
        conflictingClaimIds.add(claim.claimId);
        unresolvedMarkerCount += 1;
      } else if (!conflictingClaimIds.has(claim.claimId)) {
        desiredClaims.set(claim.claimId, claim);
      }
    }
  }

  const claims = [...desiredClaims.values()].sort((left, right) =>
    left.claimId.localeCompare(right.claimId)
  );
  const digestBody = {
    schemaVersion: RELATION_PROJECTION_SCHEMA_VERSION,
    extractorVersionId: EXPLICIT_RELATION_EXTRACTOR_VERSION_ID,
    sourceDigests: orderedSources.map((source) => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sourceSha256: source.sourceSha256,
      accessScopeSha256: source.accessBinding.accessScopeSha256,
    })),
    desiredClaimSha256s: claims.map((claim) => claim.claimSha256),
    markerCount,
    rejectedMarkerCount,
    unresolvedMarkerCount,
  };
  return deepFreeze({
    schemaVersion: RELATION_PROJECTION_SCHEMA_VERSION,
    extractorVersionId: EXPLICIT_RELATION_EXTRACTOR_VERSION_ID,
    desiredClaims: claims,
    sourceCount: orderedSources.length,
    markerCount,
    rejectedMarkerCount,
    unresolvedMarkerCount,
    projectionSha256: sourceContractSha256(digestBody),
  });
}

function parseRelationLine(
  line: string,
  defaults: { validFrom: string; validTo: string | null },
): ExplicitRelationCandidate | undefined {
  const body = line.replace(relationLinePrefix, "");
  const fields = body.split("|").map((field) => field.trim());
  if (fields.length < 2 || fields.length > 4 || fields.some((field) => !field)) {
    return undefined;
  }
  const relationTypeId = entityRelationTypeIdSchema.safeParse(
    normalizeIdentifier(fields[0]),
  );
  const endpointFields = fields[1].split(/\s+->\s+/u);
  if (!relationTypeId.success || endpointFields.length !== 2) return undefined;
  const source = parseEndpoint(endpointFields[0]);
  const target = parseEndpoint(endpointFields[1]);
  if (!source || !target) return undefined;

  const metadata = new Map<string, string>();
  for (const field of fields.slice(2)) {
    const separator = field.indexOf(":");
    if (separator < 1) return undefined;
    const key = normalizeIdentifier(field.slice(0, separator));
    const value = field.slice(separator + 1).trim();
    if (
      !["valid_from", "valid_to"].includes(key) ||
      !value ||
      metadata.has(key)
    ) return undefined;
    metadata.set(key, value);
  }

  const validFrom = safeTimestamp(metadata.get("valid_from")) ||
    (metadata.has("valid_from") ? undefined : defaults.validFrom);
  const validTo = metadata.has("valid_to")
    ? safeTimestamp(metadata.get("valid_to"))
    : defaults.validTo;
  if (
    !validFrom ||
    (metadata.has("valid_to") && !validTo) ||
    (validTo && validTo <= validFrom)
  ) return undefined;

  const relation = getEntityRelationDefinition(
    "asael-ontology:1",
    relationTypeId.data,
  );
  if (
    !relation.sourceTypeIds.includes(source.entityTypeId) ||
    !relation.targetTypeIds.includes(target.entityTypeId)
  ) return undefined;

  const candidateBody = {
    relationTypeId: relationTypeId.data,
    source,
    target,
    validFrom,
    validTo: validTo || null,
  };
  return deepFreeze({
    ...candidateBody,
    candidateSha256: sourceContractSha256(candidateBody),
  });
}

function parseEndpoint(value: string) {
  const match = endpointPattern.exec(value);
  if (!match) return undefined;
  const entityTypeId = entityTypeIdSchema.safeParse(
    normalizeIdentifier(match[1]),
  );
  const canonicalLabel = cleanLabel(match[2] || match[3] || "");
  if (!entityTypeId.success || !canonicalLabel) return undefined;
  return Object.freeze({
    entityTypeId: entityTypeId.data,
    canonicalLabel,
    normalizedLabelSha256: labelSha256(canonicalLabel),
  });
}

function resolveExactEndpoint(
  entities: readonly EntityRecord[],
  aliases: readonly EntityAlias[],
  accessBinding: EntityAccessBinding,
  endpoint: ExplicitRelationCandidate["source"],
) {
  const canonicalMatches = entities.filter((entity) =>
    entity.state === "active" &&
    entity.entityTypeId === endpoint.entityTypeId &&
    entity.accessBinding.tenantId === accessBinding.tenantId &&
    entity.accessBinding.ownerActorId === accessBinding.ownerActorId &&
    entity.accessBinding.accessScopeSha256 === accessBinding.accessScopeSha256 &&
    entity.normalizedLabelSha256 === endpoint.normalizedLabelSha256
  );
  const aliasEntityIds = new Set(aliases.filter((alias) =>
    alias.state === "active" &&
    alias.accessScopeSha256 === accessBinding.accessScopeSha256 &&
    alias.normalizedAliasSha256 === endpoint.normalizedLabelSha256
  ).map((alias) => alias.entityId));
  const matches = [...new Map([
    ...canonicalMatches,
    ...entities.filter((entity) =>
      entity.state === "active" &&
      entity.entityTypeId === endpoint.entityTypeId &&
      entity.accessBinding.tenantId === accessBinding.tenantId &&
      entity.accessBinding.ownerActorId === accessBinding.ownerActorId &&
      entity.accessBinding.accessScopeSha256 === accessBinding.accessScopeSha256 &&
      aliasEntityIds.has(entity.entityId)
    ),
  ].map((entity) => [entity.entityId, entity] as const)).values()];
  return matches.length === 1 ? matches[0] : undefined;
}

function parseProjectionSource(value: RelationProjectionSource) {
  const accessBinding = parseEntityAccessBinding(value.accessBinding);
  const sourceId = value.sourceId.trim();
  if (
    !sourceId ||
    sourceId.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(sourceId) ||
    !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
    !Number.isInteger(value.confidenceBasisPoints) ||
    value.confidenceBasisPoints < 0 ||
    value.confidenceBasisPoints > 10_000
  ) {
    throw new Error("Relation projection source is invalid.");
  }
  const defaultValidFrom = canonicalTimestamp(value.defaultValidFrom);
  const defaultValidTo = value.defaultValidTo
    ? canonicalTimestamp(value.defaultValidTo)
    : null;
  if (defaultValidTo && defaultValidTo <= defaultValidFrom) {
    throw new Error("Relation projection source validity is invalid.");
  }
  return deepFreeze({
    ...value,
    sourceId,
    accessBinding,
    defaultValidFrom,
    defaultValidTo,
    recordedAt: canonicalTimestamp(value.recordedAt),
  });
}

function cleanLabel(value: string) {
  const label = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return label && Array.from(label).length <= 320 ? label : undefined;
}

function normalizeIdentifier(value: string) {
  return value.trim().toLocaleLowerCase("en-US").replace(/[ -]+/gu, "_");
}

function safeTimestamp(value: string | undefined) {
  if (!value) return undefined;
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? new Date(parsed.data).toISOString() : undefined;
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Relation projection timestamp is invalid.");
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
