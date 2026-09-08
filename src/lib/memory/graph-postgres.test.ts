import { beforeEach, describe, expect, it, vi } from "vitest";

const graphMocks = vi.hoisted(() => {
  const statements: string[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
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
  };
});

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getDatabaseTenantContext: vi.fn(() => "tenant-bulk"),
  getSql: vi.fn(() => graphMocks.sql),
  hasDatabaseUrl: vi.fn(() => true),
  runWithDatabaseTenantScope: vi.fn(
    async (_tenantId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock("@/lib/memory/store", () => ({
  listMemories: graphMocks.listMemories,
}));

import { rebuildMemoryGraph } from "@/lib/memory/graph";

describe("memory graph postgres rebuild", () => {
  beforeEach(() => {
    graphMocks.statements.length = 0;
    graphMocks.sql.mockClear();
    graphMocks.listMemories.mockReset().mockResolvedValue(
      Array.from({ length: 80 }, (_, index) => ({
        id: `memory-${index}`,
        tenantId: "tenant-bulk",
        type: "knowledge",
        title: `Workflow graph ${index}`,
        content:
          "Postgres workflow graph memory approval connector evaluation security",
        tags: ["workflow", "graph", `topic-${index}`],
        scope: "workspace",
        source: "test",
        importance: 0.8,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      })),
    );
  });

  it("persists rebuilt nodes and edges with one set-based statement each", async () => {
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
    expect(nodeWrites).toHaveLength(1);
    expect(edgeWrites).toHaveLength(1);
    expect(nodeWrites[0]).toContain("jsonb_to_recordset");
    expect(edgeWrites[0]).toContain("jsonb_to_recordset");
    expect(graphMocks.sql.mock.calls.length).toBeLessThan(12);
  });
});
