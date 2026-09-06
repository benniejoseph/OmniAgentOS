import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildGraphQueryTelemetry: vi.fn(() => ({ telemetryId: "telemetry-a" })),
  getActiveMemoriesByIds: vi.fn(async () => []),
  getCanonicalKnowledgeEvidenceByEvidenceUnitIds: vi.fn(async () => []),
  readGraphStorageSnapshot: vi.fn(),
  recordGraphQueryTelemetrySafely: vi.fn(async () => undefined),
}));

vi.mock("@/lib/entities/graph-storage-adapter", () => ({
  readGraphStorageSnapshot: mocks.readGraphStorageSnapshot,
}));
vi.mock("@/lib/entities/graph-query-telemetry", () => ({
  buildGraphQueryTelemetry: mocks.buildGraphQueryTelemetry,
  recordGraphQueryTelemetrySafely: mocks.recordGraphQueryTelemetrySafely,
}));
vi.mock("@/lib/memory/store", () => ({
  getActiveMemoriesByIds: mocks.getActiveMemoriesByIds,
}));
vi.mock("@/lib/rag/store", () => ({
  getCanonicalKnowledgeEvidenceByEvidenceUnitIds:
    mocks.getCanonicalKnowledgeEvidenceByEvidenceUnitIds,
}));

import { databaseMemoryAccessScopeFromExecutionScope } from "@/lib/db/memory-access-scope";
import { retrieveGraphRelationshipPaths } from "@/lib/entities/graph-retrieval";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { createExecutionScope } from "@/lib/security/execution-scope";

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
  correlationId: "graph-retrieval-telemetry-test",
  purpose: "entity.read.v1",
});

describe("P5.6 graph retrieval instrumentation", () => {
  it("records bounded scale and latency without passing query content", async () => {
    mocks.readGraphStorageSnapshot.mockResolvedValueOnce({
      snapshot: {
        version: "p5.6-graph-storage-snapshot:1",
        adapterId: "postgres-temporal-graph:1",
        entities: [],
        aliases: [],
        relations: [],
        entityCount: 18,
        aliasCount: 6,
        relationCount: 0,
        relationLimitSaturated: false,
        snapshotSha256: "a".repeat(64),
      },
      shadow: {
        version: "p5.6-graph-storage-shadow:1",
        primaryAdapterId: "postgres-temporal-graph:1",
        shadowAdapterId: null,
        state: "not_configured",
        primarySnapshotSha256: "a".repeat(64),
        shadowSnapshotSha256: null,
        primaryDurationMs: 12,
        shadowDurationMs: null,
        comparisonSha256: "b".repeat(64),
      },
    });
    const memoryScope = databaseMemoryAccessScopeFromExecutionScope(scope, {
      purposeId: MEMORY_PURPOSE_IDS.retrieve,
      auditPurpose: "test.graph.retrieval",
    });

    const result = await retrieveGraphRelationshipPaths(
      "private entity question that must not enter telemetry",
      {
        entityAccess: {
          actorBinding: {} as never,
          accessBinding: binding,
          executionScope: scope,
        },
        memoryAccessScope: memoryScope,
        contextExecutionScope: scope,
        maxHops: 2,
        limit: 12,
        asOfTime: "2026-09-07T00:00:00.000Z",
      },
    );

    expect(result.paths).toEqual([]);
    expect(mocks.buildGraphQueryTelemetry).toHaveBeenCalledWith({
      accessBinding: binding,
      executionScope: scope,
      shadow: expect.objectContaining({ state: "not_configured" }),
      maxHops: 2,
      requestedLimit: 12,
      entityCount: 18,
      aliasCount: 6,
      relationCandidateCount: 0,
      relationLimitSaturated: false,
      authorizedRelationCount: 0,
      rejectedRelationCount: 0,
      pathCount: 0,
      evidenceAuthorizationDurationMs: expect.any(Number),
      pathExpansionDurationMs: expect.any(Number),
      totalDurationMs: expect.any(Number),
    });
    expect(mocks.recordGraphQueryTelemetrySafely).toHaveBeenCalledWith({
      telemetry: { telemetryId: "telemetry-a" },
      executionScope: scope,
    });
  });
});
