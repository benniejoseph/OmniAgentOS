import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTexts: vi.fn(async () => [[0.2, 0.4]]),
  planRetrievalQuery: vi.fn(),
  searchKnowledge: vi.fn(async () => []),
  searchMemoryGraph: vi.fn(),
  searchMemories: vi.fn(async () => []),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getDatabaseTenantContext: vi.fn(() => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => false),
}));
vi.mock("@/lib/openai/client", () => ({ embedTexts: mocks.embedTexts }));
vi.mock("@/lib/memory/graph", () => ({
  searchMemoryGraph: mocks.searchMemoryGraph,
}));
vi.mock("@/lib/memory/store", () => ({
  getActiveMemoriesByIds: vi.fn(async () => []),
  searchMemories: mocks.searchMemories,
}));
vi.mock("@/lib/rag/store", () => ({
  getCanonicalKnowledgeEvidenceByChunkIds: vi.fn(async () => []),
  searchKnowledge: mocks.searchKnowledge,
}));
vi.mock("@/lib/storage/json", () => ({
  readJsonFile: vi.fn(async () => ({ traces: [] })),
  updateJsonFile: vi.fn(),
}));
vi.mock("@/lib/storage/paths", () => ({
  getDataPath: vi.fn(() => "/tmp/context-engine-query-plan.json"),
}));
vi.mock("@/lib/rag/query-planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rag/query-planner")>();
  return {
    ...actual,
    planRetrievalQuery: mocks.planRetrievalQuery,
  };
});

import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { buildContextPack } from "@/lib/rag/context-engine";
import type { RetrievalQueryPlan } from "@/lib/rag/types";

const accessScope = {
  version: 1 as const,
  tenantId: "tenant-a",
  initiatingActorId: "actor-a",
  executingPrincipalType: "user" as const,
  executingPrincipalId: "actor-a",
  workspaceId: null,
  projectId: null,
  missionId: null,
  contextGrantIds: ["grant-context-a"],
  capabilityGrantIds: [],
  purposeId: MEMORY_PURPOSE_IDS.retrieve,
  purpose: "test.context.query-plan",
};

function semanticRelationshipPlan(): RetrievalQueryPlan {
  return {
    version: "p4.3-query-plan:1",
    source: "model",
    domains: ["entity", "relationship"],
    queries: [
      "Who manages Project Orion?",
      "Project Orion manager ownership relationship",
    ],
    entityTerms: ["Project Orion"],
    relationshipTerms: ["manages"],
    proceduralTerms: [],
    temporal: { mode: "none", expressions: [] },
    confidence: 0.94,
    validation: {
      originalQueryAnchored: true,
      authorizationInputsExcluded: true,
      candidateAccepted: true,
      droppedQueryCount: 0,
    },
    model: {
      provider: "openai",
      model: "router-model",
      usageReceiptRecorded: true,
      usageReceiptId: "usage-a",
    },
  };
}

describe("context-engine P4.3 query-plan integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planRetrievalQuery.mockResolvedValue(semanticRelationshipPlan());
    mocks.searchMemoryGraph.mockResolvedValue([{
      node: {
        id: "graph-orion",
        tenantId: "tenant-a",
        kind: "concept",
        label: "Project Orion",
        slug: "project-orion",
        aliases: ["Orion"],
        summary: "Project Orion is managed by Alice.",
        weight: 0.6,
        sourceCount: 2,
        memoryIds: ["memory-orion"],
        traceIds: [],
        tags: ["project"],
        metadata: {},
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      score: 0.42,
      communityId: "community-orion",
      neighborhood: [],
      reasons: ["matched project, orion"],
    }]);
  });

  it("uses the validated plan for every search without changing authorization", async () => {
    const pack = await buildContextPack("Who manages Project Orion?", {
      tenantId: "tenant-a",
      databaseMemoryAccessScope: accessScope,
      persistTrace: false,
      usageScope: {
        tenantId: "tenant-a",
        actorId: "actor-a",
        sourceStreamId: "run:run-a",
        operation: "embedding",
        purpose: "agent.context.retrieve",
      },
    });
    const retrievalQuery = semanticRelationshipPlan().queries.join("\n");

    expect(mocks.planRetrievalQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "Who manages Project Orion?",
        usageScope: expect.objectContaining({
          tenantId: "tenant-a",
          actorId: "actor-a",
        }),
      }),
    );
    expect(mocks.embedTexts).toHaveBeenCalledWith(
      [retrievalQuery],
      undefined,
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
    expect(mocks.searchMemories).toHaveBeenNthCalledWith(
      2,
      retrievalQuery,
      expect.objectContaining({ accessScope }),
    );
    expect(mocks.searchMemoryGraph).toHaveBeenCalledWith(
      retrievalQuery,
      expect.objectContaining({ accessScope }),
    );
    expect(pack.profile.queryPlan).toEqual(semanticRelationshipPlan());
    expect(pack.results[0]).toMatchObject({
      kind: "graph",
      id: "graph-orion",
    });
    expect(JSON.stringify(pack.profile.queryPlan)).not.toContain(
      "grant-context-a",
    );
  });

  it("does not invoke semantic planning for an explicit empty selection", async () => {
    const pack = await buildContextPack("Who manages Project Orion?", {
      tenantId: "tenant-a",
      databaseMemoryAccessScope: accessScope,
      evidenceIds: [],
      persistTrace: false,
    });

    expect(mocks.planRetrievalQuery).not.toHaveBeenCalled();
    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(mocks.searchMemories).not.toHaveBeenCalled();
    expect(pack.results).toEqual([]);
    expect(pack.profile.queryPlan.source).toBe("deterministic");
  });
});
