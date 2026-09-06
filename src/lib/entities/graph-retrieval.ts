import type { DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { parseDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import {
  getEntityRelationDefinition,
  type EntityRelationTypeId,
  type EntityTypeId,
} from "@/lib/entities/ontology";
import type { RequestEntityAccessV1 } from "@/lib/entities/request-access";
import {
  normalizeEntityLabel,
  parseEntityAccessBinding,
  parseEntityAlias,
  parseEntityRecord,
  type EntityAccessBinding,
  type EntityAlias,
  type EntityRecord,
} from "@/lib/entities/registry";
import { readGraphStorageSnapshot } from "@/lib/entities/graph-storage-adapter";
import {
  buildGraphQueryTelemetry,
  recordGraphQueryTelemetrySafely,
} from "@/lib/entities/graph-query-telemetry";
import {
  parseTemporalRelationClaimRecord,
  relationClaimIsVisibleAt,
  type RelationEpistemicKind,
  type TemporalRelationClaimRecord,
} from "@/lib/entities/temporal-claims";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { getActiveMemoriesByIds } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import {
  getCanonicalKnowledgeEvidenceByEvidenceUnitIds,
  type CanonicalKnowledgeEvidence,
} from "@/lib/rag/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { CONTEXT_COMPILER_V2_PURPOSE_ID } from "@/lib/sources/purposes";

export const GRAPH_RETRIEVAL_VERSION = "p5.5-graph-retrieval:1" as const;
const MAX_RELATIONS = 200;
const MAX_EVIDENCE_PER_HOP = 4;

export type GraphRelationshipEvidence = Readonly<{
  evidenceId: string;
  kind: "memory" | "canonical_evidence";
  title: string;
  excerpt: string;
  source: string;
  observedAt: string;
}>;

export type GraphRelationshipHop = Readonly<{
  claimId: string;
  revisionId: string;
  relationTypeId: EntityRelationTypeId;
  relationLabel: string;
  direction: "forward" | "reverse" | "symmetric";
  source: GraphRelationshipEntity;
  target: GraphRelationshipEntity;
  epistemicKind: RelationEpistemicKind;
  confidenceBasisPoints: number;
  validFrom: string;
  validTo: string | null;
  evidence: readonly GraphRelationshipEvidence[];
}>;

export type GraphRelationshipEntity = Readonly<{
  entityId: string;
  entityTypeId: EntityTypeId;
  label: string;
}>;

export type GraphRelationshipPath = Readonly<{
  pathId: string;
  anchor: GraphRelationshipEntity;
  terminal: GraphRelationshipEntity;
  hopCount: number;
  score: number;
  explanation: string;
  hops: readonly GraphRelationshipHop[];
  pathSha256: string;
}>;

export type GraphRetrievalReceipt = Readonly<{
  version: typeof GRAPH_RETRIEVAL_VERSION;
  querySha256: string;
  asOfTime: string;
  maxHops: number;
  anchorCount: number;
  authorizedRelationCount: number;
  rejectedRelationCount: number;
  pathCount: number;
  receiptSha256: string;
}>;

export type GraphRelationshipPathResult = Readonly<{
  paths: readonly GraphRelationshipPath[];
  receipt: GraphRetrievalReceipt;
}>;

export type ResolvedLineageEvidence = Readonly<{
  referenceKind: "memory" | "evidence_unit";
  referenceId: string;
  referenceSha256: string;
  evidence: GraphRelationshipEvidence;
}>;

export async function retrieveGraphRelationshipPaths(
  query: string,
  input: {
    entityAccess: RequestEntityAccessV1;
    memoryAccessScope: DatabaseMemoryAccessScope;
    contextExecutionScope: ExecutionScope;
    maxHops?: number;
    limit?: number;
    asOfTime?: string;
  },
): Promise<GraphRelationshipPathResult> {
  const retrievalStartedAt = monotonicNow();
  const entityBinding = parseEntityAccessBinding(
    input.entityAccess.accessBinding,
  );
  const memoryScope = assertRuntimeScopes(input, entityBinding);
  const asOfTime = canonicalTimestamp(input.asOfTime || new Date().toISOString());
  const maxHops = Math.min(Math.max(Math.trunc(input.maxHops || 2), 1), 3);
  const limit = Math.min(Math.max(Math.trunc(input.limit || 12), 1), 24);
  const storage = await readGraphStorageSnapshot({
    read: {
      accessBinding: entityBinding,
      executionScope: input.entityAccess.executionScope,
      asOfTime,
      relationLimit: MAX_RELATIONS,
    },
  });
  const { entities, aliases, relations } = storage.snapshot;
  const lineage = uniqueLineage(relations);
  const evidenceStartedAt = monotonicNow();
  const [memories, canonicalEvidence] = await Promise.all([
    getActiveMemoriesByIds(
      lineage
        .filter((reference) => reference.kind === "memory")
        .map((reference) => reference.referenceId),
      { tenantId: entityBinding.tenantId, accessScope: memoryScope },
    ),
    getCanonicalKnowledgeEvidenceByEvidenceUnitIds(
      lineage
        .filter((reference) => reference.kind === "evidence_unit")
        .map((reference) => reference.referenceId),
      { tenantId: entityBinding.tenantId },
    ),
  ]);
  const evidence = [
    ...resolveMemoryEvidence(memories, entityBinding),
    ...resolveCanonicalEvidence(
      canonicalEvidence,
      entityBinding,
      input.contextExecutionScope,
      asOfTime,
    ),
  ];
  const evidenceAuthorizationDurationMs = elapsedMilliseconds(
    evidenceStartedAt,
  );
  const pathExpansionStartedAt = monotonicNow();
  const result = buildGraphRelationshipPaths({
    query,
    accessBinding: entityBinding,
    entities,
    aliases,
    relations,
    evidence,
    maxHops,
    limit,
    asOfTime,
  });
  const pathExpansionDurationMs = elapsedMilliseconds(pathExpansionStartedAt);
  try {
    const telemetry = buildGraphQueryTelemetry({
      accessBinding: entityBinding,
      executionScope: input.entityAccess.executionScope,
      shadow: storage.shadow,
      maxHops,
      requestedLimit: limit,
      entityCount: storage.snapshot.entityCount,
      aliasCount: storage.snapshot.aliasCount,
      relationCandidateCount: storage.snapshot.relationCount,
      relationLimitSaturated: storage.snapshot.relationLimitSaturated,
      authorizedRelationCount: result.receipt.authorizedRelationCount,
      rejectedRelationCount: result.receipt.rejectedRelationCount,
      pathCount: result.receipt.pathCount,
      evidenceAuthorizationDurationMs,
      pathExpansionDurationMs,
      totalDurationMs: elapsedMilliseconds(retrievalStartedAt),
    });
    await recordGraphQueryTelemetrySafely({
      telemetry,
      executionScope: input.entityAccess.executionScope,
    });
  } catch (error) {
    console.warn(
      "Graph query telemetry could not be prepared.",
      error instanceof Error ? error.message : error,
    );
  }
  return result;
}

export function buildGraphRelationshipPaths(input: {
  query: string;
  accessBinding: EntityAccessBinding;
  entities: readonly EntityRecord[];
  aliases: readonly EntityAlias[];
  relations: readonly TemporalRelationClaimRecord[];
  evidence: readonly ResolvedLineageEvidence[];
  maxHops?: number;
  limit?: number;
  asOfTime?: string;
}): GraphRelationshipPathResult {
  const accessBinding = parseEntityAccessBinding(input.accessBinding);
  const asOfTime = canonicalTimestamp(input.asOfTime || new Date().toISOString());
  const maxHops = Math.min(Math.max(Math.trunc(input.maxHops || 2), 1), 3);
  const limit = Math.min(Math.max(Math.trunc(input.limit || 12), 1), 24);
  const entities = input.entities
    .map(parseEntityRecord)
    .filter((entity) => isAuthorizedEntity(entity, accessBinding));
  const entityById = new Map(entities.map((entity) => [entity.entityId, entity]));
  const aliases = input.aliases
    .map(parseEntityAlias)
    .filter((alias) =>
      alias.state === "active" &&
      alias.accessScopeSha256 === accessBinding.accessScopeSha256 &&
      entityById.has(alias.entityId)
    );
  const anchors = resolveQueryAnchors(input.query, entities, aliases);
  const evidenceByReference = new Map(
    input.evidence.map((candidate) => [
      `${candidate.referenceKind}:${candidate.referenceId}:${candidate.referenceSha256}`,
      candidate.evidence,
    ]),
  );
  let rejectedRelationCount = 0;
  const relations = input.relations.flatMap((candidate) => {
    const record = parseTemporalRelationClaimRecord(candidate);
    const claim = record.claim;
    const source = entityById.get(claim.source.entityId);
    const target = entityById.get(claim.target.entityId);
    const evidence = claim.lineage.flatMap((reference) => {
      const resolved = evidenceByReference.get(
        `${reference.kind}:${reference.referenceId}:${reference.referenceSha256}`,
      );
      return resolved ? [resolved] : [];
    }).slice(0, MAX_EVIDENCE_PER_HOP);
    if (
      claim.accessBinding.accessScopeSha256 !==
        accessBinding.accessScopeSha256 ||
      claim.accessBinding.tenantId !== accessBinding.tenantId ||
      claim.accessBinding.ownerActorId !== accessBinding.ownerActorId ||
      !source ||
      !target ||
      source.entitySha256 !== claim.source.entitySha256 ||
      target.entitySha256 !== claim.target.entitySha256 ||
      !relationClaimIsVisibleAt(record, { validAt: asOfTime, recordedAt: asOfTime }) ||
      evidence.length === 0
    ) {
      rejectedRelationCount += 1;
      return [];
    }
    return [{ record, source, target, evidence }];
  });
  const paths = expandPaths({
    query: input.query,
    anchors,
    relations,
    maxHops,
    limit,
  });
  const receiptBody = {
    version: GRAPH_RETRIEVAL_VERSION,
    querySha256: sourceContractSha256(input.query.trim()),
    asOfTime,
    maxHops,
    anchorCount: anchors.length,
    authorizedRelationCount: relations.length,
    rejectedRelationCount,
    pathCount: paths.length,
  };
  return deepFreeze({
    paths,
    receipt: {
      ...receiptBody,
      receiptSha256: sourceContractSha256(receiptBody),
    },
  });
}

function expandPaths(input: {
  query: string;
  anchors: readonly EntityRecord[];
  relations: readonly {
    record: TemporalRelationClaimRecord;
    source: EntityRecord;
    target: EntityRecord;
    evidence: readonly GraphRelationshipEvidence[];
  }[];
  maxHops: number;
  limit: number;
}) {
  const results = new Map<string, GraphRelationshipPath>();
  for (const anchor of input.anchors) {
    const queue: Array<{
      current: EntityRecord;
      visited: Set<string>;
      hops: GraphRelationshipHop[];
    }> = [{ current: anchor, visited: new Set([anchor.entityId]), hops: [] }];
    while (queue.length && results.size < input.limit * 4) {
      const state = queue.shift()!;
      if (state.hops.length >= input.maxHops) continue;
      for (const relation of input.relations) {
        const next = adjacentEntity(relation, state.current.entityId);
        if (!next || state.visited.has(next.entity.entityId)) continue;
        const hop = publicHop(relation, next.direction);
        const hops = [...state.hops, hop];
        const path = buildPath(anchor, next.entity, hops, input.query);
        results.set(path.pathId, path);
        queue.push({
          current: next.entity,
          visited: new Set([...state.visited, next.entity.entityId]),
          hops,
        });
      }
    }
  }
  return [...results.values()]
    .sort((left, right) =>
      right.score - left.score ||
      left.hopCount - right.hopCount ||
      left.pathId.localeCompare(right.pathId)
    )
    .slice(0, input.limit);
}

function adjacentEntity(
  relation: {
    record: TemporalRelationClaimRecord;
    source: EntityRecord;
    target: EntityRecord;
  },
  entityId: string,
) {
  const definition = getEntityRelationDefinition(
    relation.record.claim.ontologyVersionId,
    relation.record.claim.relationTypeId,
  );
  if (relation.source.entityId === entityId) {
    return {
      entity: relation.target,
      direction: definition.direction === "symmetric"
        ? "symmetric" as const
        : "forward" as const,
    };
  }
  if (relation.target.entityId === entityId) {
    return {
      entity: relation.source,
      direction: definition.direction === "symmetric"
        ? "symmetric" as const
        : "reverse" as const,
    };
  }
  return undefined;
}

function publicHop(
  relation: {
    record: TemporalRelationClaimRecord;
    source: EntityRecord;
    target: EntityRecord;
    evidence: readonly GraphRelationshipEvidence[];
  },
  direction: GraphRelationshipHop["direction"],
): GraphRelationshipHop {
  const claim = relation.record.claim;
  return {
    claimId: claim.claimId,
    revisionId: claim.revisionId,
    relationTypeId: claim.relationTypeId,
    relationLabel: getEntityRelationDefinition(
      claim.ontologyVersionId,
      claim.relationTypeId,
    ).label,
    direction,
    source: publicEntity(relation.source),
    target: publicEntity(relation.target),
    epistemicKind: claim.epistemicKind,
    confidenceBasisPoints: claim.confidenceBasisPoints,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
    evidence: relation.evidence,
  };
}

function buildPath(
  anchor: EntityRecord,
  terminal: EntityRecord,
  hops: readonly GraphRelationshipHop[],
  query: string,
): GraphRelationshipPath {
  const identity = {
    anchorEntityId: anchor.entityId,
    terminalEntityId: terminal.entityId,
    revisionIds: hops.map((hop) => hop.revisionId),
  };
  const pathId = `relationship_path_${sourceContractSha256(identity).slice(0, 44)}`;
  const baseConfidence = hops.reduce(
    (product, hop) => product * hop.confidenceBasisPoints / 10_000,
    1,
  );
  const relationQuery = normalizeEntityLabel(query);
  const relationshipMatch = hops.some((hop) =>
    relationQuery.includes(normalizeEntityLabel(hop.relationLabel)) ||
    relationQuery.includes(normalizeEntityLabel(hop.relationTypeId))
  );
  const score = roundScore(
    baseConfidence * Math.pow(0.88, hops.length - 1) +
      (relationshipMatch ? 0.08 : 0),
  );
  const body = {
    pathId,
    anchor: publicEntity(anchor),
    terminal: publicEntity(terminal),
    hopCount: hops.length,
    score,
    explanation: explainPath(anchor, hops),
    hops,
  };
  return deepFreeze({ ...body, pathSha256: sourceContractSha256(body) });
}

function explainPath(anchor: EntityRecord, hops: readonly GraphRelationshipHop[]) {
  const segments = [anchor.canonicalLabel];
  let currentId = anchor.entityId;
  for (const hop of hops) {
    const traversesForward = hop.source.entityId === currentId;
    const next = traversesForward ? hop.target : hop.source;
    const arrow = hop.direction === "reverse" ? "←" : "→";
    segments.push(`${arrow} ${hop.relationLabel} ${arrow}`, next.label);
    currentId = next.entityId;
  }
  return segments.join(" ");
}

function resolveQueryAnchors(
  query: string,
  entities: readonly EntityRecord[],
  aliases: readonly EntityAlias[],
) {
  const normalizedQuery = ` ${normalizeEntityLabel(query)} `;
  const labelsByEntity = new Map<string, string[]>();
  for (const entity of entities) {
    labelsByEntity.set(entity.entityId, [entity.canonicalLabel]);
  }
  for (const alias of aliases) {
    labelsByEntity.get(alias.entityId)?.push(alias.alias);
  }
  return entities.filter((entity) =>
    labelsByEntity.get(entity.entityId)?.some((label) => {
      const normalized = normalizeEntityLabel(label);
      return normalized.length >= 2 && normalizedQuery.includes(` ${normalized} `);
    })
  ).sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function resolveMemoryEvidence(
  memories: readonly MemoryRecord[],
  binding: EntityAccessBinding,
): ResolvedLineageEvidence[] {
  return memories.flatMap((memory) => {
    if (
      !memory.accessBinding ||
      memory.accessBinding.tenantId !== binding.tenantId ||
      memory.accessBinding.ownerActorId !== binding.ownerActorId ||
      memory.claimStatus !== "active"
    ) return [];
    const referenceSha256 = sourceContractSha256({
      memoryId: memory.id,
      tenantId: binding.tenantId,
      ownerActorId: binding.ownerActorId,
      accessScopeSha256: memory.accessBinding.accessScopeSha256,
      contentSha256: sourceContractSha256(memory.content),
      updatedAt: canonicalTimestamp(memory.updatedAt),
    });
    return [{
      referenceKind: "memory" as const,
      referenceId: memory.id,
      referenceSha256,
      evidence: {
        evidenceId: `memory:${memory.id}`,
        kind: "memory" as const,
        title: memory.title,
        excerpt: boundedText(memory.content),
        source: memory.source,
        observedAt: canonicalTimestamp(memory.updatedAt),
      },
    }];
  });
}

function resolveCanonicalEvidence(
  candidates: readonly CanonicalKnowledgeEvidence[],
  binding: EntityAccessBinding,
  scope: ExecutionScope,
  asOfTime: string,
): ResolvedLineageEvidence[] {
  const grants = new Set(scope.contextGrantIds);
  return candidates.flatMap((candidate) => {
    const evidence = candidate.evidenceUnit;
    if (
      candidate.sourceState.operation === "delete" ||
      !candidate.sourceState.isCurrent ||
      evidence.tenantId !== binding.tenantId ||
      evidence.ownerActorId !== binding.ownerActorId ||
      evidence.workspaceId !== null ||
      evidence.projectId !== null ||
      evidence.missionId !== null ||
      !evidence.allowedPurposeIds.includes(CONTEXT_COMPILER_V2_PURPOSE_ID) ||
      evidence.permissionGrantIds.some((id) => !grants.has(id)) ||
      (evidence.retentionExpiresAt !== null &&
        evidence.retentionExpiresAt <= asOfTime) ||
      evidence.capturedAt > asOfTime ||
      evidence.extractedAt > asOfTime ||
      candidate.chunk.evidenceUnitId !== evidence.evidenceUnitId ||
      candidate.chunk.sourceRevisionId !== evidence.sourceRevisionId ||
      sourceContractSha256(candidate.chunk.content) !==
        evidence.evidenceContentSha256
    ) return [];
    return [{
      referenceKind: "evidence_unit" as const,
      referenceId: evidence.evidenceUnitId,
      referenceSha256: evidence.evidenceUnitSha256,
      evidence: {
        evidenceId: `knowledge:${candidate.chunk.id}`,
        kind: "canonical_evidence" as const,
        title: candidate.chunk.title,
        excerpt: boundedText(candidate.chunk.content),
        source: candidate.chunk.source,
        observedAt: evidence.extractedAt,
      },
    }];
  });
}

function assertRuntimeScopes(
  input: {
    entityAccess: RequestEntityAccessV1;
    memoryAccessScope: DatabaseMemoryAccessScope;
    contextExecutionScope: ExecutionScope;
  },
  binding: EntityAccessBinding,
) {
  const memoryScope = parseDatabaseMemoryAccessScope(input.memoryAccessScope);
  const entityScope = input.entityAccess.executionScope;
  if (
    memoryScope.purposeId !== MEMORY_PURPOSE_IDS.retrieve ||
    memoryScope.tenantId !== binding.tenantId ||
    memoryScope.initiatingActorId !== binding.ownerActorId ||
    memoryScope.workspaceId !== null ||
    memoryScope.projectId !== null ||
    memoryScope.missionId !== null ||
    entityScope.tenantId !== binding.tenantId ||
    entityScope.initiatingActorId !== binding.ownerActorId ||
    entityScope.executingPrincipalType !== "user" ||
    entityScope.executingPrincipalId !== binding.ownerActorId ||
    entityScope.purpose !== "entity.read.v1" ||
    input.contextExecutionScope.tenantId !== binding.tenantId
  ) {
    throw new Error("Graph retrieval scopes do not share one actor boundary.");
  }
  return memoryScope;
}

function isAuthorizedEntity(entity: EntityRecord, binding: EntityAccessBinding) {
  return entity.state === "active" &&
    entity.accessBinding.tenantId === binding.tenantId &&
    entity.accessBinding.ownerActorId === binding.ownerActorId &&
    entity.accessBinding.accessScopeSha256 === binding.accessScopeSha256;
}

function uniqueLineage(relations: readonly TemporalRelationClaimRecord[]) {
  return [...new Map(relations.flatMap((record) =>
    parseTemporalRelationClaimRecord(record).claim.lineage
  ).map((reference) => [
    `${reference.kind}:${reference.referenceId}:${reference.referenceSha256}`,
    reference,
  ])).values()];
}

function publicEntity(entity: EntityRecord): GraphRelationshipEntity {
  return {
    entityId: entity.entityId,
    entityTypeId: entity.entityTypeId,
    label: entity.canonicalLabel,
  };
}

function boundedText(value: string) {
  const normalized = value.trim();
  return normalized.length > 1_200
    ? `${normalized.slice(0, 1_199)}…`
    : normalized;
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Graph retrieval timestamp is invalid.");
  }
  return parsed.toISOString();
}

function roundScore(value: number) {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000) / 1_000;
}

function monotonicNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function elapsedMilliseconds(startedAt: number) {
  return Math.max(0, Math.round((monotonicNow() - startedAt) * 100) / 100);
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
