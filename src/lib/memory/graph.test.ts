import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { MemoryRecord } from "@/lib/memory/types";

let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "omni-graph-"));
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;
});

function memory(tenantId: string, id: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    tenantId,
    type: "knowledge",
    title: "Postgres workflow isolation",
    content: "Postgres workflow memory graph tenant isolation",
    tags: ["postgres", "workflow"],
    scope: "workspace",
    source: "test",
    importance: 0.8,
    createdAt: now,
    updatedAt: now,
  };
}

describe("memory graph tenant isolation (file mode)", () => {
  it("keeps legacy unowned graph records in the default tenant", async () => {
    const now = new Date().toISOString();
    await writeFile(
      path.join(dataDir, "memory-graph.json"),
      JSON.stringify({
        nodes: [{
          id: "graph-node-legacy",
          kind: "concept",
          label: "Legacy",
          slug: "legacy",
          aliases: [],
          summary: "Legacy default-tenant graph node",
          weight: 0.5,
          sourceCount: 1,
          memoryIds: ["legacy-memory"],
          traceIds: [],
          tags: [],
          metadata: {},
          createdAt: now,
          updatedAt: now,
        }],
        edges: [],
        builds: [],
      }),
    );
    const graph = await import("@/lib/memory/graph");
    expect(await graph.listMemoryGraphNodes(10, { tenantId: "tenant-b" })).toEqual([]);
    expect(
      (await graph.listMemoryGraphNodes(10, { tenantId: "default" }))[0]?.id,
    ).toBe("graph-node-legacy");
  });

  it("partitions identical graph concepts by tenant", async () => {
    const graph = await import("@/lib/memory/graph");
    await graph.indexMemoryGraphRecords(
      [memory("tenant-a", "memory-a")],
      "test",
      { tenantId: "tenant-a" },
    );
    await graph.indexMemoryGraphRecords(
      [memory("tenant-b", "memory-b")],
      "test",
      { tenantId: "tenant-b" },
    );

    const [tenantANodes, tenantBNodes] = await Promise.all([
      graph.listMemoryGraphNodes(100, { tenantId: "tenant-a" }),
      graph.listMemoryGraphNodes(100, { tenantId: "tenant-b" }),
    ]);

    expect(tenantANodes.length).toBeGreaterThan(0);
    expect(tenantBNodes.length).toBeGreaterThan(0);
    expect(tenantANodes.every((node) => node.tenantId === "tenant-a")).toBe(true);
    expect(tenantBNodes.every((node) => node.tenantId === "tenant-b")).toBe(true);
    expect(new Set(tenantANodes.map((node) => node.id))).not.toEqual(
      new Set(tenantBNodes.map((node) => node.id)),
    );
    expect(tenantANodes.some((node) => node.memoryIds.includes("memory-b"))).toBe(false);
    expect(tenantBNodes.some((node) => node.memoryIds.includes("memory-a"))).toBe(false);
  });

  it("includes tenant-scoped graph evidence in the agent context pack", async () => {
    const graph = await import("@/lib/memory/graph");
    const { buildContextPack } = await import("@/lib/rag/context-engine");
    await graph.indexMemoryGraphRecords(
      [memory("tenant-context", "memory-context")],
      "test",
      { tenantId: "tenant-context" },
    );

    const pack = await buildContextPack("Postgres workflow isolation", {
      tenantId: "tenant-context",
      limit: 8,
      persistTrace: false,
    });

    expect(pack.graphResults.length).toBeGreaterThan(0);
    expect(pack.graphResults.every((result) => result.node.tenantId === "tenant-context")).toBe(true);
    expect(pack.results.some((result) => result.kind === "graph")).toBe(true);
  });

  it("rejects mixed-tenant indexing batches", async () => {
    const graph = await import("@/lib/memory/graph");
    await expect(
      graph.indexMemoryGraphRecords(
        [memory("tenant-a", "mixed-a"), memory("tenant-b", "mixed-b")],
        "test",
        { tenantId: "tenant-a" },
      ),
    ).rejects.toThrow("cannot mix records from different tenants");
  });

  it("rebuilds immediately when the durable queue is unavailable", async () => {
    const graph = await import("@/lib/memory/graph");
    const store = await import("@/lib/memory/store");
    const record = await store.saveMemory({
      ...memory("tenant-queued", "memory-queued"),
      title: "Queued correction verification",
      content: "Queued correction rebuilds remain consistent in file mode",
    });

    const result = await graph.queueMemoryGraphRebuild({
      tenantId: "tenant-queued",
    });
    const nodes = await graph.listMemoryGraphNodes(100, {
      tenantId: "tenant-queued",
    });

    expect(result).toMatchObject({ queued: false, tenantId: "tenant-queued" });
    expect(nodes.some((node) => node.memoryIds.includes(record.id))).toBe(true);
  });

  it("keeps graph evidence counters stable when indexing is replayed", async () => {
    const graph = await import("@/lib/memory/graph");
    const record = memory("tenant-replay", "memory-replay");

    await graph.indexMemoryGraphRecords([record], "test", {
      tenantId: "tenant-replay",
    });
    const firstNodes = await graph.listMemoryGraphNodes(100, {
      tenantId: "tenant-replay",
    });
    const firstEdges = await graph.listMemoryGraphEdges(100, {
      tenantId: "tenant-replay",
    });

    await graph.indexMemoryGraphRecords([record], "test", {
      tenantId: "tenant-replay",
    });
    const replayedNodes = await graph.listMemoryGraphNodes(100, {
      tenantId: "tenant-replay",
    });
    const replayedEdges = await graph.listMemoryGraphEdges(100, {
      tenantId: "tenant-replay",
    });

    expect(
      replayedNodes.map(({ id, sourceCount, memoryIds, traceIds }) => ({
        id,
        sourceCount,
        memoryIds,
        traceIds,
      })),
    ).toEqual(
      firstNodes.map(({ id, sourceCount, memoryIds, traceIds }) => ({
        id,
        sourceCount,
        memoryIds,
        traceIds,
      })),
    );
    expect(
      replayedEdges.map(({ id, evidenceCount, memoryIds, traceIds }) => ({
        id,
        evidenceCount,
        memoryIds,
        traceIds,
      })),
    ).toEqual(
      firstEdges.map(({ id, evidenceCount, memoryIds, traceIds }) => ({
        id,
        evidenceCount,
        memoryIds,
        traceIds,
      })),
    );
  });
});
