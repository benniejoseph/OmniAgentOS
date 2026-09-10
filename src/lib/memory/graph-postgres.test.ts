import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUserPrivateMemoryAccessBindingV1,
  buildWorkspaceSharedMemoryAccessBindingV1,
} from "@/lib/memory/access-binding";
import type { MemoryRecord } from "@/lib/memory/types";

const graphMocks = vi.hoisted(() => {
  const statements: string[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join("?");
    statements.push(statement);
    if (statement.includes("AS nodes") && statement.includes("AS edges")) {
      return [{ nodes: 12, edges: 18 }];
    }
    if (
      statement.includes("FROM omni_capture_assets") &&
      statement.includes("FOR UPDATE")
    ) {
      return [{ id: "capture-bulk" }];
    }
    return [];
  });
  Object.assign(sql, {
    transaction: vi.fn(async (operation: (transaction: typeof sql) => unknown) =>
      operation(sql)),
  });
  return {
    statements,
    sql,
    listMemories: vi.fn(),
    listScopeBoundMemories: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getDatabaseTenantContext: vi.fn(() => "tenant-bulk"),
  getSql: vi.fn(() => graphMocks.sql),
  hasDatabaseUrl: vi.fn(() => true),
  runWithDatabaseSystemScope: vi.fn(
    async (_reason: string, operation: () => Promise<unknown>) => operation(),
  ),
  runWithDatabaseTenantScope: vi.fn(
    async (_tenantId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock("@/lib/memory/store", () => ({
  listMemories: graphMocks.listMemories,
  listScopeBoundMemories: graphMocks.listScopeBoundMemories,
}));

import {
  getMemoryGraphCounts,
  indexMemoryGraphRecords,
  rebuildMemoryGraph,
  rebuildMemoryGraphSystemScoped,
} from "@/lib/memory/graph";

describe("memory graph postgres rebuild", () => {
  function graphMemories(count: number): MemoryRecord[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `memory-${index}`,
      tenantId: "tenant-bulk",
      type: "knowledge",
      title: `Workflow graph ${index}`,
      content:
        `Postgres workflow graph memory approval connector evaluation security signal-${index}`,
      tags: ["workflow", "graph", `topic-${index}`],
      scope: "workspace",
      source: "test",
      importance: 0.8,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    }));
  }

  beforeEach(() => {
    graphMocks.statements.length = 0;
    graphMocks.sql.mockClear();
    graphMocks.listMemories.mockReset().mockResolvedValue(graphMemories(80));
    graphMocks.listScopeBoundMemories.mockReset().mockImplementation(
      graphMocks.listMemories,
    );
  });

  it("batches large graph projections below the per-statement row bound", async () => {
    graphMocks.listMemories.mockResolvedValue(graphMemories(300));

    await rebuildMemoryGraph({
      tenantId: "tenant-bulk",
      source: "test.batched-rebuild",
      memoryLimit: 300,
    });

    const graphWrites = graphMocks.sql.mock.calls.filter((call) => {
      const statement = (call[0] as unknown as TemplateStringsArray).join("?");
      return statement.includes("jsonb_to_recordset");
    });
    const rowCounts = graphWrites.map((call) =>
      (JSON.parse(String(call[1])) as unknown[]).length
    );

    expect(graphWrites.length).toBeGreaterThan(2);
    expect(Math.max(...rowCounts)).toBeLessThanOrEqual(25);
  });

  it("persists rebuilt nodes and edges with bounded set-based statements", async () => {
    const result = await rebuildMemoryGraph({
      tenantId: "tenant-bulk",
      source: "test.bulk-rebuild",
    });

    const nodeWrites = graphMocks.statements.filter((statement) =>
      statement.includes("INSERT INTO omni_memory_graph_nodes"),
    );
    const edgeWrites = graphMocks.statements.filter((statement) =>
      statement.includes("INSERT INTO omni_memory_graph_edges"),
    );

    expect(result.build.nodeCount).toBeGreaterThan(80);
    expect(result.build.edgeCount).toBeGreaterThan(20);
    expect(nodeWrites.length).toBeGreaterThan(1);
    expect(edgeWrites.length).toBeGreaterThan(0);
    expect(nodeWrites.every((statement) =>
      statement.includes("jsonb_to_recordset")
    )).toBe(true);
    expect(edgeWrites.every((statement) =>
      statement.includes("jsonb_to_recordset")
    )).toBe(true);
    expect(result.stats).toEqual(expect.objectContaining({
      nodes: result.build.nodeCount,
      edges: result.build.edgeCount,
    }));
    expect(graphMocks.statements.some((statement) =>
      statement.includes("SELECT node.*") || statement.includes("SELECT edge.*")
    )).toBe(false);
  });

  it.each([26, 108])(
    "keeps a %i-memory capture projection bounded and drains barriers before writes",
    async (memoryCount) => {
      const captureId = "capture-bulk";
      const records = graphMemories(memoryCount).map((record) => ({
        ...record,
        source: `capture:asset:${captureId}`,
      }));

      const result = await indexMemoryGraphRecords(
        records,
        "knowledge.ingest",
        {
          tenantId: "tenant-bulk",
          captureIngestGuard: {
            kind: "asset",
            tenantId: "tenant-bulk",
            actorId: "actor:capture-owner",
            captureId,
            ingestJobId: "job:capture-bulk",
          },
        },
      );

      const graphWrites = graphMocks.sql.mock.calls.filter((call) => {
        const statement = (call[0] as unknown as TemplateStringsArray).join("?");
        return statement.includes("jsonb_to_recordset");
      });
      const rowCounts = graphWrites.map((call) =>
        (JSON.parse(String(call[1])) as unknown[]).length
      );
      const captureLockIndex = graphMocks.statements.findIndex((statement) =>
        statement.includes("FROM omni_capture_assets") &&
        statement.includes("FOR UPDATE")
      );
      const advisoryLockIndex = graphMocks.statements.findIndex((statement) =>
        statement.includes("pg_advisory_xact_lock")
      );
      const barrierIndex = graphMocks.statements.findIndex((statement) =>
        statement.includes("SET CONSTRAINTS")
      );
      const nodeWriteIndex = graphMocks.statements.findIndex((statement) =>
        statement.includes("INSERT INTO omni_memory_graph_nodes")
      );
      const edgeWriteIndex = graphMocks.statements.findIndex((statement) =>
        statement.includes("INSERT INTO omni_memory_graph_edges")
      );
      const buildWriteIndex = graphMocks.statements.findIndex((statement) =>
        statement.includes("INSERT INTO omni_memory_graph_builds")
      );

      expect(result).toEqual({
        indexedMemoryCount: memoryCount,
        nodeCount: expect.any(Number),
        edgeCount: expect.any(Number),
      });
      expect(result.nodeCount).toBeGreaterThan(0);
      expect(result.edgeCount).toBeGreaterThan(0);
      expect(graphWrites.length).toBeGreaterThan(1);
      expect(Math.max(...rowCounts)).toBeLessThanOrEqual(25);
      expect(graphMocks.statements[barrierIndex]).toContain(
        "omni_memory_graph_nodes_validate_deletion_barrier",
      );
      expect(graphMocks.statements[barrierIndex]).toContain(
        "omni_memory_graph_edges_validate_deletion_barrier",
      );
      expect([
        captureLockIndex,
        advisoryLockIndex,
        barrierIndex,
        nodeWriteIndex,
        edgeWriteIndex,
        buildWriteIndex,
      ]).toEqual([
        captureLockIndex,
        advisoryLockIndex,
        barrierIndex,
        nodeWriteIndex,
        edgeWriteIndex,
        buildWriteIndex,
      ].sort((left, right) => left - right));
      expect(captureLockIndex).toBeGreaterThanOrEqual(0);
      expect(graphMocks.statements.some((statement) =>
        statement.includes("SELECT node.*") || statement.includes("SELECT edge.*")
      )).toBe(false);
    },
  );

  it("keeps actor-owned rebuild projections scope-bound", async () => {
    const ownerActorId = "actor:private-owner";
    const accessBinding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-bulk",
      ownerActorId,
      originPurpose: "api.memory.write",
      accessBoundAt: "2026-09-09T00:00:00.000Z",
    });
    graphMocks.listMemories.mockResolvedValue(
      graphMemories(3).map((memory) => ({ ...memory, accessBinding })),
    );

    await rebuildMemoryGraph({
      tenantId: "tenant-bulk",
      source: "test.private-rebuild",
    });

    const graphRows = graphMocks.sql.mock.calls
      .filter((call) => {
        const statement = (call[0] as unknown as TemplateStringsArray).join("?");
        return statement.includes("jsonb_to_recordset");
      })
      .flatMap((call) => JSON.parse(String(call[1])) as Array<Record<string, unknown>>);

    expect(graphRows.length).toBeGreaterThan(0);
    expect(graphRows.every((row) =>
      row.access_contract_version === 1 &&
      row.visibility === "user_private" &&
      row.owner_actor_id === ownerActorId
    )).toBe(true);
  });

  it("prepares schema before entering the non-owner maintenance scope", async () => {
    const database = await import("@/lib/db/client");

    await rebuildMemoryGraphSystemScoped({
      tenantId: "tenant-bulk",
      source: "test.system-rebuild",
      auditReason: "Test the worker projection boundary.",
    });

    expect(database.ensureDatabaseSchema).toHaveBeenCalled();
    expect(database.runWithDatabaseSystemScope).toHaveBeenCalledWith(
      "Test the worker projection boundary.",
      expect.any(Function),
    );
  });

  it("preserves legacy graph rows during a scope-bound maintenance rebuild", async () => {
    await rebuildMemoryGraphSystemScoped({
      tenantId: "tenant-bulk",
      source: "test.scope-bound-maintenance",
      auditReason: "Test legacy graph preservation.",
    });

    const graphDeletes = graphMocks.statements.filter((statement) =>
      statement.includes("DELETE FROM omni_memory_graph_edges") ||
      statement.includes("DELETE FROM omni_memory_graph_nodes")
    );

    expect(graphDeletes).toHaveLength(2);
    expect(graphDeletes.every((statement) =>
      statement.includes("access_contract_version = 1")
    )).toBe(true);
  });

  it("projects supported shared cohorts without widening their scope", async () => {
    const accessBinding = buildWorkspaceSharedMemoryAccessBindingV1({
      tenantId: "tenant-bulk",
      ownerActorId: "actor:workspace-owner",
      workspaceId: "workspace:research",
      originPurpose: "memory.shared.write",
      allowedPurposeIds: ["memory.read.v1", "memory.retrieve.v1"],
      accessBoundAt: "2026-09-09T00:00:00.000Z",
    });
    graphMocks.listScopeBoundMemories.mockResolvedValue([
      { ...graphMemories(1)[0], accessBinding },
    ]);

    await rebuildMemoryGraphSystemScoped({
      tenantId: "tenant-bulk",
      source: "test.workspace-rebuild",
      auditReason: "Test workspace graph projection.",
    });

    const graphRows = graphMocks.sql.mock.calls
      .filter((call) => {
        const statement = (call[0] as unknown as TemplateStringsArray).join("?");
        return statement.includes("jsonb_to_recordset");
      })
      .flatMap((call) => JSON.parse(String(call[1])) as Array<Record<string, unknown>>);
    expect(graphRows.length).toBeGreaterThan(0);
    expect(graphRows.every((row) =>
      row.access_contract_version === 1 &&
      row.visibility === "workspace_shared" &&
      row.workspace_id === "workspace:research" &&
      JSON.stringify(row.allowed_purpose_ids) ===
        JSON.stringify([
          "memory.correct.v1",
          "memory.export.v1",
          "memory.forget.v1",
          "memory.read.v1",
          "memory.retrieve.v1",
          "memory.write.v1",
        ])
    )).toBe(true);
  });

  it("reads dashboard graph size without loading graph records", async () => {
    await expect(getMemoryGraphCounts({ tenantId: "tenant-bulk" }))
      .resolves.toEqual({ nodes: 12, edges: 18 });

    const countStatement = graphMocks.statements.find((statement) =>
      statement.includes("AS nodes") && statement.includes("AS edges")
    );
    expect(countStatement).toContain("COUNT(*)::int");
    expect(countStatement).not.toContain("SELECT node.*");
    expect(countStatement).not.toContain("SELECT edge.*");
  });
});
