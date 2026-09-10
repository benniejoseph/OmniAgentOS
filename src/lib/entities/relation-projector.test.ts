import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  sql: vi.fn(),
  memorySource: "manual",
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(),
  hasDatabaseUrl: () => true,
  getSql: () => Object.assign(mocks.sql, {
    transaction: (operation: (sql: typeof mocks.sql) => unknown) =>
      operation(mocks.sql),
  }),
  runWithDatabaseSystemScope: (
    _reason: string,
    operation: () => unknown,
  ) => operation(),
}));

vi.mock("@/lib/entities/temporal-claim-store", () => ({
  reconcileTemporalRelationClaimProjection: mocks.reconcile,
}));

import { rebuildTemporalRelationProjection } from "@/lib/entities/relation-projector";
import {
  buildEntityAccessBinding,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";

const accessBinding = buildEntityAccessBinding({
  tenantId: "tenant-projector",
  ownerActorId: "actor-projector",
  visibility: "user_private",
  sensitivity: "confidential",
  allowedPurposeIds: ENTITY_PURPOSE_IDS,
  boundAt: "2026-09-06T00:00:00.000Z",
});
const lineage = {
  kind: "memory" as const,
  referenceId: "memory-projector",
  referenceSha256: "a".repeat(64),
};
const workItem = buildEntityRecord({
  entityTypeId: "work_item",
  canonicalLabel: "Ship P5.4",
  accessBinding,
  lineage: [lineage],
  createdAt: "2026-09-07T00:00:00.000Z",
});
const person = buildEntityRecord({
  entityTypeId: "person",
  canonicalLabel: "Ada",
  accessBinding,
  lineage: [lineage],
  createdAt: "2026-09-07T00:00:00.000Z",
});

describe("canonical temporal relation projector", () => {
  beforeEach(() => {
    mocks.memorySource = "manual";
    mocks.sql.mockReset().mockImplementation(
      (strings: TemplateStringsArray) => {
        const query = strings.join(" ");
        if (query.includes("FROM omni_memories")) {
          return Promise.resolve([{
            id: "memory-projector",
            tenant_id: "tenant-projector",
            owner_actor_id: "actor-projector",
            access_scope_sha256: "f".repeat(64),
            sensitivity: "confidential",
            source: mocks.memorySource,
            content:
              'relation: assigned_to | work item: "Ship P5.4" -> person: "Ada"',
            confidence: 0.95,
            valid_from: "2026-01-01T00:00:00.000Z",
            valid_to: null,
            created_at: "2026-09-07T00:00:00.000Z",
            updated_at: "2026-09-07T00:00:00.000Z",
          }]);
        }
        if (query.includes("FROM omni_source_items")) return Promise.resolve([]);
        if (query.includes("FROM omni_entity_records")) {
          return Promise.resolve([{ contract: workItem }, { contract: person }]);
        }
        if (query.includes("FROM omni_entity_aliases")) return Promise.resolve([]);
        return Promise.resolve([]);
      },
    );
    mocks.reconcile.mockReset().mockResolvedValue({
      stateSha256: "b".repeat(64),
      activeClaims: [{}],
      createdCount: 1,
      revisedCount: 0,
      retractedCount: 0,
      unchangedCount: 0,
    });
  });

  it("reads only canonical stores and applies one deterministic desired set", async () => {
    const report = await rebuildTemporalRelationProjection({
      tenantId: "tenant-projector",
      ownerActorId: "actor-projector",
      correlationId: "projector-test",
    });

    expect(report).toMatchObject({
      sourceCount: 1,
      markerCount: 1,
      rejectedMarkerCount: 0,
      unresolvedMarkerCount: 0,
      activeClaimCount: 1,
      createdCount: 1,
    });
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    const call = mocks.reconcile.mock.calls[0][0];
    expect(call).toMatchObject({
      tenantId: "tenant-projector",
      ownerActorId: "actor-projector",
      executionScope: {
        initiatingActorId: "actor-projector",
        executingPrincipalType: "system",
        purpose: "entity.relation.project.v1",
      },
    });
    expect(call.desiredClaims).toHaveLength(1);
    expect(call.desiredClaims[0]).toMatchObject({
      relationTypeId: "assigned_to",
      epistemicKind: "asserted",
      confidenceBasisPoints: 9_500,
      lineage: [{ kind: "memory", referenceId: "memory-projector" }],
    });
    const queries = mocks.sql.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(" ")
    ).join("\n");
    expect(queries).toContain("FROM omni_memories");
    expect(queries).toContain("FROM omni_source_items");
    expect(queries).not.toContain("omni_retrieval_traces");
    const memorySelect = queries.split("FROM omni_memories")[0];
    expect(memorySelect).toContain("source");
    expect(queries).toContain("claim_status = 'active'");
    expect(queries).toContain("asserted_by = 'user'");
    expect(queries).toContain("source LIKE 'cognify-reviewed:%'");
    expect(queries).toContain("formation_reason = 'source_cognition'");
    expect(queries).toContain("reference LIKE 'cognition-review:%'");
    expect(queries).toContain("reference LIKE 'knowledge:%'");
    expect(queries).toContain("reference LIKE 'evidence:%'");
  });

  it("projects reviewed model cognition as inferred rather than asserted truth", async () => {
    mocks.memorySource = "cognify-reviewed:cognition-batch-a";

    await rebuildTemporalRelationProjection({
      tenantId: "tenant-projector",
      ownerActorId: "actor-projector",
      correlationId: "projector-reviewed-cognition-test",
    });

    expect(mocks.reconcile.mock.calls[0][0].desiredClaims[0])
      .toMatchObject({ epistemicKind: "inferred" });
  });
});
