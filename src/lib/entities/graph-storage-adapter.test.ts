import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryTemporalRelationClaims: vi.fn(),
  readEntityRegistry: vi.fn(),
}));

vi.mock("@/lib/entities/store", () => ({
  readEntityRegistry: mocks.readEntityRegistry,
}));
vi.mock("@/lib/entities/temporal-claim-store", () => ({
  queryTemporalRelationClaims: mocks.queryTemporalRelationClaims,
}));

import {
  POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID,
  postgresTemporalGraphAdapter,
  readGraphStorageSnapshot,
  type GraphStorageAdapter,
} from "@/lib/entities/graph-storage-adapter";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import { buildTemporalRelationClaim } from "@/lib/entities/temporal-claims";
import { createExecutionScope } from "@/lib/security/execution-scope";

const now = "2026-09-07T00:00:00.000Z";
const lineage = {
  kind: "memory" as const,
  referenceId: "memory-a",
  referenceSha256: "a".repeat(64),
};
const binding = buildEntityAccessBinding({
  tenantId: "tenant-a",
  ownerActorId: "actor-a",
  visibility: "user_private",
  sensitivity: "confidential",
  allowedPurposeIds: ENTITY_PURPOSE_IDS,
  boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
});
const scope = createExecutionScope({
  tenantId: binding.tenantId,
  initiatingActorId: binding.ownerActorId,
  executingPrincipalType: "user",
  executingPrincipalId: binding.ownerActorId,
  correlationId: "graph-adapter-test",
  purpose: "entity.read.v1",
});
const person = buildEntityRecord({
  entityId: "entity-person",
  entityTypeId: "person",
  canonicalLabel: "Ada Lovelace",
  accessBinding: binding,
  lineage: [lineage],
  createdAt: now,
});
const organization = buildEntityRecord({
  entityId: "entity-organization",
  entityTypeId: "organization",
  canonicalLabel: "Acme Labs",
  accessBinding: binding,
  lineage: [lineage],
  createdAt: now,
});
const alias = buildEntityAlias({
  entity: person,
  alias: "Countess Ada",
  lineage,
  createdAt: now,
});
const relation = {
  claim: buildTemporalRelationClaim({
    relationTypeId: "affiliated_with",
    sourceEntity: person,
    targetEntity: organization,
    epistemicKind: "asserted",
    confidenceBasisPoints: 10_000,
    accessBinding: binding,
    lineage: [lineage],
    validFrom: now,
    recordedAt: now,
  }),
  supersededAt: null,
};

function adapter(
  adapterId: string,
  overrides: Partial<Awaited<ReturnType<GraphStorageAdapter["readSnapshot"]>>> = {},
): GraphStorageAdapter {
  const snapshot = {
    entities: [person, organization],
    aliases: [alias],
    relations: [relation],
    entityCount: 2,
    aliasCount: 1,
    relationCount: 1,
    relationLimitSaturated: false,
    ...overrides,
  };
  return Object.freeze({
    adapterId,
    readSnapshot: vi.fn(async () => snapshot),
  });
}

describe("P5.6 graph storage adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readEntityRegistry.mockResolvedValue({
      schemaVersion: 1,
      entities: [person, organization],
      aliases: [alias],
      resolutions: [],
      mergeReviews: [],
    });
    mocks.queryTemporalRelationClaims.mockResolvedValue([relation]);
  });

  it("keeps the Postgres temporal graph as the authoritative adapter", async () => {
    const result = await readGraphStorageSnapshot({
      read: {
        accessBinding: binding,
        executionScope: scope,
        asOfTime: now,
        relationLimit: 200,
      },
      primary: postgresTemporalGraphAdapter,
    });

    expect(result.snapshot).toMatchObject({
      adapterId: POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID,
      entityCount: 2,
      aliasCount: 1,
      relationCount: 1,
      relationLimitSaturated: false,
    });
    expect(result.shadow).toMatchObject({
      primaryAdapterId: POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID,
      shadowAdapterId: null,
      state: "not_configured",
      shadowSnapshotSha256: null,
    });
    expect(mocks.queryTemporalRelationClaims).toHaveBeenCalledWith({
      accessBinding: binding,
      executionScope: scope,
      validAt: now,
      recordedAt: now,
      limit: 200,
    });
  });

  it("compares a shadow snapshot but serves only the primary snapshot", async () => {
    const primary = adapter("postgres-test:1");
    const matchingShadow = adapter("graph-shadow:1");
    const matched = await readGraphStorageSnapshot({
      read: {
        accessBinding: binding,
        executionScope: scope,
        asOfTime: now,
        relationLimit: 200,
      },
      primary,
      shadow: matchingShadow,
    });
    expect(matched.shadow.state).toBe("matched");
    expect(matched.shadow.shadowSnapshotSha256).toBe(
      matched.snapshot.snapshotSha256,
    );
    expect(matched.snapshot.adapterId).toBe("postgres-test:1");

    const mismatchingShadow = adapter("graph-shadow:2", {
      aliases: [],
      aliasCount: 0,
    });
    const mismatched = await readGraphStorageSnapshot({
      read: {
        accessBinding: binding,
        executionScope: scope,
        asOfTime: now,
        relationLimit: 200,
      },
      primary,
      shadow: mismatchingShadow,
    });
    expect(mismatched.shadow.state).toBe("mismatched");
    expect(mismatched.snapshot.aliases).toEqual([alias]);
  });

  it("fails a cross-scope primary and holds a failed shadow", async () => {
    const otherBinding = buildEntityAccessBinding({
      tenantId: "tenant-a",
      ownerActorId: "actor-b",
      visibility: "user_private",
      sensitivity: "confidential",
      allowedPurposeIds: ENTITY_PURPOSE_IDS,
      boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
    });
    const crossScopeEntity = buildEntityRecord({
      entityId: "entity-other",
      entityTypeId: "person",
      canonicalLabel: "Other Person",
      accessBinding: otherBinding,
      lineage: [lineage],
      createdAt: now,
    });
    const crossScope = adapter("cross-scope:1", {
      entities: [crossScopeEntity],
      aliases: [],
      relations: [],
      entityCount: 1,
      aliasCount: 0,
      relationCount: 0,
    });
    await expect(readGraphStorageSnapshot({
      read: {
        accessBinding: binding,
        executionScope: scope,
        asOfTime: now,
        relationLimit: 200,
      },
      primary: crossScope,
    })).rejects.toThrow(/cross-scope record/i);

    const failedShadow: GraphStorageAdapter = {
      adapterId: "failed-shadow:1",
      readSnapshot: vi.fn(async () => {
        throw new Error("shadow unavailable");
      }),
    };
    const primary = adapter("postgres-test:1");
    const held = await readGraphStorageSnapshot({
      read: {
        accessBinding: binding,
        executionScope: scope,
        asOfTime: now,
        relationLimit: 200,
      },
      primary,
      shadow: failedShadow,
    });
    expect(held.shadow).toMatchObject({
      state: "failed",
      shadowAdapterId: "failed-shadow:1",
      shadowSnapshotSha256: null,
    });
    expect(held.snapshot.adapterId).toBe("postgres-test:1");
  });
});
