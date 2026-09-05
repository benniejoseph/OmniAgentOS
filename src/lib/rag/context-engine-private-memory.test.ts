import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTexts: vi.fn(async () => [[0.2, 0.4]]),
  getSql: vi.fn(),
  searchKnowledge: vi.fn(async () => []),
  searchMemoryGraph: vi.fn(async () => []),
  searchMemories: vi.fn(),
  setTransactionLocalDatabaseMemoryAccessScope: vi.fn(),
  updateJsonFile: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getDatabaseTenantContext: vi.fn(() => undefined),
  getSql: mocks.getSql,
  hasDatabaseUrl: vi.fn(() => true),
}));
vi.mock("@/lib/openai/client", () => ({ embedTexts: mocks.embedTexts }));
vi.mock("@/lib/db/memory-access-scope", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/db/memory-access-scope")
  >();
  return {
    ...actual,
    setTransactionLocalDatabaseMemoryAccessScope:
      mocks.setTransactionLocalDatabaseMemoryAccessScope,
  };
});
vi.mock("@/lib/memory/graph", () => ({
  searchMemoryGraph: mocks.searchMemoryGraph,
}));
vi.mock("@/lib/memory/store", () => ({
  searchMemories: mocks.searchMemories,
}));
vi.mock("@/lib/rag/store", () => ({
  searchKnowledge: mocks.searchKnowledge,
}));
vi.mock("@/lib/storage/json", () => ({
  readJsonFile: vi.fn(async () => ({ traces: [] })),
  updateJsonFile: mocks.updateJsonFile,
}));
vi.mock("@/lib/storage/paths", () => ({
  getDataPath: vi.fn(() => "/tmp/context-engine-private-memory.json"),
}));

import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import type { MemorySearchResult } from "@/lib/memory/types";
import { buildContextPack } from "@/lib/rag/context-engine";

const actorId = "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";

function accessScope(purposeId: string = MEMORY_PURPOSE_IDS.retrieve) {
  return {
    version: 1 as const,
    tenantId: "tenant-a",
    initiatingActorId: actorId,
    executingPrincipalType: "user" as const,
    executingPrincipalId: actorId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purposeId,
    purpose: "test.context.retrieve",
  };
}

function memoryResult(
  id: string,
  title: string,
  score: number,
): MemorySearchResult {
  return {
    record: {
      id,
      tenantId: "tenant-a",
      type: "preference",
      title,
      content: `${title} content`,
      tags: ["preference"],
      scope: "user",
      source: "manual",
      importance: 0.8,
      confidence: 0.9,
      claimStatus: "active",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      embedding: [0.1, 0.3],
    },
    score,
    reasons: ["matched preference"],
  };
}

describe("actor-scoped context retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const transactionSql = Object.assign(vi.fn(async () => []), {
      transactionScoped: true,
    });
    const rootSql = Object.assign(vi.fn(async () => []), {
      transaction: vi.fn(async (
        callback: (sql: typeof transactionSql) => Promise<unknown>,
      ) => callback(transactionSql)),
      transactionScoped: false,
    });
    mocks.getSql.mockReturnValue(rootSql);
    mocks.setTransactionLocalDatabaseMemoryAccessScope.mockImplementation(
      async (_sql: unknown, scope: unknown) => scope,
    );
    mocks.searchMemories.mockImplementation(async (
      _query: string,
      options: { accessScope?: unknown },
    ) => options.accessScope
      ? [memoryResult("private-memory", "Private preference", 1.2)]
      : [memoryResult("legacy-memory", "Legacy preference", 0.8)]);
  });

  it("persists only scoped memory in an actor-private trace", async () => {
    const pack = await buildContextPack("remember my deployment preference", {
      tenantId: "tenant-a",
      databaseMemoryAccessScope: accessScope(),
      persistTrace: true,
      limit: 8,
    });

    expect(mocks.searchMemories).toHaveBeenCalledTimes(2);
    expect(mocks.searchMemories).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ accessScope: accessScope() }),
    );
    expect(pack.memoryResults.map((result) => result.record.id)).toEqual([
      "private-memory",
      "legacy-memory",
    ]);
    expect(pack.contextBlock).toContain("Private preference");
    expect(pack.memoryResults.every((result) =>
      result.record.embedding === undefined
    )).toBe(true);
    expect(pack.results.every((item) =>
      item.kind !== "memory" || item.result.record.embedding === undefined
    )).toBe(true);
    expect(pack.trace).toEqual(expect.objectContaining({
      tenantId: "tenant-a",
      accessBinding: expect.objectContaining({
        ownerActorId: actorId,
        visibility: "user_private",
      }),
      results: [expect.objectContaining({
        id: "private-memory",
        kind: "memory",
      })],
    }));
    expect(pack.trace?.results).not.toContainEqual(
      expect.objectContaining({ id: "legacy-memory" }),
    );
    expect(
      pack.trace?.accessBinding?.allowedPurposeIds,
    ).toEqual([
      MEMORY_PURPOSE_IDS.export,
      MEMORY_PURPOSE_IDS.forget,
      MEMORY_PURPOSE_IDS.read,
      MEMORY_PURPOSE_IDS.retrieve,
    ]);
    expect(
      mocks.setTransactionLocalDatabaseMemoryAccessScope,
    ).toHaveBeenCalledWith(expect.any(Function), accessScope());
    expect(mocks.getSql).toHaveBeenCalled();
    expect(mocks.updateJsonFile).not.toHaveBeenCalled();
  });

  it("rejects a non-retrieval memory purpose before reading", async () => {
    await expect(buildContextPack("remember my preference", {
      tenantId: "tenant-a",
      databaseMemoryAccessScope: accessScope(MEMORY_PURPOSE_IDS.read),
    })).rejects.toThrow("canonical memory retrieval purpose");
    expect(mocks.searchMemories).not.toHaveBeenCalled();
  });
});
