import {
  parseEntityAccessBinding,
  parseEntityAlias,
  parseEntityRecord,
  type EntityAccessBinding,
  type EntityAlias,
  type EntityRecord,
} from "@/lib/entities/registry";
import { readEntityRegistry } from "@/lib/entities/store";
import { queryTemporalRelationClaims } from "@/lib/entities/temporal-claim-store";
import {
  parseTemporalRelationClaimRecord,
  type TemporalRelationClaimRecord,
} from "@/lib/entities/temporal-claims";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID =
  "postgres-temporal-graph:1" as const;
export const GRAPH_STORAGE_SNAPSHOT_VERSION =
  "p5.6-graph-storage-snapshot:1" as const;
export const GRAPH_STORAGE_SHADOW_VERSION =
  "p5.6-graph-storage-shadow:1" as const;

export type GraphStorageReadInput = Readonly<{
  accessBinding: EntityAccessBinding;
  executionScope: ExecutionScope;
  asOfTime: string;
  relationLimit: number;
}>;

export type GraphStorageSnapshot = Readonly<{
  version: typeof GRAPH_STORAGE_SNAPSHOT_VERSION;
  adapterId: string;
  entities: readonly EntityRecord[];
  aliases: readonly EntityAlias[];
  relations: readonly TemporalRelationClaimRecord[];
  entityCount: number;
  aliasCount: number;
  relationCount: number;
  relationLimitSaturated: boolean;
  snapshotSha256: string;
}>;

export type GraphStorageAdapter = Readonly<{
  adapterId: string;
  readSnapshot: (
    input: GraphStorageReadInput,
  ) => Promise<Omit<GraphStorageSnapshot, "version" | "adapterId" | "snapshotSha256">>;
}>;

export type GraphStorageShadowComparison = Readonly<{
  version: typeof GRAPH_STORAGE_SHADOW_VERSION;
  primaryAdapterId: string;
  shadowAdapterId: string | null;
  state: "not_configured" | "matched" | "mismatched" | "failed";
  primarySnapshotSha256: string;
  shadowSnapshotSha256: string | null;
  primaryDurationMs: number;
  shadowDurationMs: number | null;
  comparisonSha256: string;
}>;

export type GraphStorageReadResult = Readonly<{
  snapshot: GraphStorageSnapshot;
  shadow: GraphStorageShadowComparison;
}>;

export const postgresTemporalGraphAdapter: GraphStorageAdapter = Object.freeze({
  adapterId: POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID,
  async readSnapshot(input) {
    const [registry, relations] = await Promise.all([
      readEntityRegistry({
        accessBinding: input.accessBinding,
        executionScope: input.executionScope,
      }),
      queryTemporalRelationClaims({
        accessBinding: input.accessBinding,
        executionScope: input.executionScope,
        validAt: input.asOfTime,
        recordedAt: input.asOfTime,
        limit: input.relationLimit,
      }),
    ]);
    return {
      entities: registry.entities,
      aliases: registry.aliases,
      relations,
      entityCount: registry.entities.length,
      aliasCount: registry.aliases.length,
      relationCount: relations.length,
      relationLimitSaturated: relations.length >= input.relationLimit,
    };
  },
});

/**
 * The primary remains authoritative. A shadow may observe the exact same scoped
 * read, but its data is never returned to retrieval or used for authorization.
 */
export async function readGraphStorageSnapshot(input: {
  read: GraphStorageReadInput;
  primary?: GraphStorageAdapter;
  shadow?: GraphStorageAdapter;
}): Promise<GraphStorageReadResult> {
  const binding = parseEntityAccessBinding(input.read.accessBinding);
  const primary = input.primary || postgresTemporalGraphAdapter;
  assertAdapterId(primary.adapterId);
  if (input.shadow) {
    assertAdapterId(input.shadow.adapterId);
    if (input.shadow.adapterId === primary.adapterId) {
      throw new Error("Graph storage shadow must use a distinct adapter identity.");
    }
  }

  const primaryStartedAt = monotonicNow();
  const primarySnapshot = sealSnapshot(
    primary.adapterId,
    binding,
    input.read.relationLimit,
    await primary.readSnapshot({ ...input.read, accessBinding: binding }),
  );
  const primaryDurationMs = elapsedMilliseconds(primaryStartedAt);

  let shadowSnapshot: GraphStorageSnapshot | undefined;
  let shadowDurationMs: number | null = null;
  let shadowFailed = false;
  if (input.shadow) {
    const shadowStartedAt = monotonicNow();
    try {
      shadowSnapshot = sealSnapshot(
        input.shadow.adapterId,
        binding,
        input.read.relationLimit,
        await input.shadow.readSnapshot({
          ...input.read,
          accessBinding: binding,
        }),
      );
    } catch {
      shadowFailed = true;
    } finally {
      shadowDurationMs = elapsedMilliseconds(shadowStartedAt);
    }
  }

  const comparisonBody = {
    version: GRAPH_STORAGE_SHADOW_VERSION,
    primaryAdapterId: primary.adapterId,
    shadowAdapterId: input.shadow?.adapterId || null,
    state: !input.shadow
      ? "not_configured" as const
      : shadowFailed
        ? "failed" as const
        : shadowSnapshot?.snapshotSha256 === primarySnapshot.snapshotSha256
          ? "matched" as const
          : "mismatched" as const,
    primarySnapshotSha256: primarySnapshot.snapshotSha256,
    shadowSnapshotSha256: shadowSnapshot?.snapshotSha256 || null,
    primaryDurationMs,
    shadowDurationMs,
  };
  return deepFreeze({
    snapshot: primarySnapshot,
    shadow: {
      ...comparisonBody,
      comparisonSha256: sourceContractSha256(comparisonBody),
    },
  });
}

function sealSnapshot(
  adapterId: string,
  binding: EntityAccessBinding,
  relationLimit: number,
  candidate: Awaited<ReturnType<GraphStorageAdapter["readSnapshot"]>>,
): GraphStorageSnapshot {
  const entities = candidate.entities.map(parseEntityRecord);
  const aliases = candidate.aliases.map(parseEntityAlias);
  const relations = candidate.relations.map(parseTemporalRelationClaimRecord);
  if (
    candidate.entityCount !== entities.length ||
    candidate.aliasCount !== aliases.length ||
    candidate.relationCount !== relations.length ||
    candidate.relationLimitSaturated !== (relations.length >= relationLimit)
  ) {
    throw new Error("Graph storage adapter returned inconsistent scale metadata.");
  }
  for (const entity of entities) {
    assertSameAccessBinding(entity.accessBinding, binding);
  }
  const entityIds = new Set(entities.map((entity) => entity.entityId));
  for (const alias of aliases) {
    if (
      alias.accessScopeSha256 !== binding.accessScopeSha256 ||
      !entityIds.has(alias.entityId)
    ) {
      throw new Error("Graph storage adapter returned a cross-scope alias.");
    }
  }
  for (const relation of relations) {
    assertSameAccessBinding(relation.claim.accessBinding, binding);
  }
  const digestBody = {
    version: GRAPH_STORAGE_SNAPSHOT_VERSION,
    entitySha256s: entities.map((entity) => entity.entitySha256).sort(),
    aliasSha256s: aliases.map((alias) => alias.aliasSha256).sort(),
    relationSha256s: relations
      .map((relation) => relation.claim.claimSha256)
      .sort(),
    entityCount: entities.length,
    aliasCount: aliases.length,
    relationCount: relations.length,
    relationLimitSaturated: candidate.relationLimitSaturated,
  };
  return deepFreeze({
    version: GRAPH_STORAGE_SNAPSHOT_VERSION,
    adapterId,
    entities,
    aliases,
    relations,
    entityCount: entities.length,
    aliasCount: aliases.length,
    relationCount: relations.length,
    relationLimitSaturated: candidate.relationLimitSaturated,
    snapshotSha256: sourceContractSha256(digestBody),
  });
}

function assertSameAccessBinding(
  candidate: EntityAccessBinding,
  expected: EntityAccessBinding,
) {
  const parsed = parseEntityAccessBinding(candidate);
  if (
    parsed.tenantId !== expected.tenantId ||
    parsed.ownerActorId !== expected.ownerActorId ||
    parsed.accessScopeSha256 !== expected.accessScopeSha256
  ) {
    throw new Error("Graph storage adapter returned a cross-scope record.");
  }
}

function assertAdapterId(value: string) {
  if (!/^[a-z][a-z0-9._-]{1,79}:[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error("Graph storage adapter identity is invalid.");
  }
}

function monotonicNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function elapsedMilliseconds(startedAt: number) {
  return Math.max(0, Math.round((monotonicNow() - startedAt) * 100) / 100);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
