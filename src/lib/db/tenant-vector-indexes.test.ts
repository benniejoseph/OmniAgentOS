import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maintainTenantVectorIndexes,
  planTenantVectorIndexes,
  TENANT_VECTOR_INDEX,
  tenantVectorIndexDropStatement,
  tenantVectorIndexMinRows,
  tenantVectorIndexName,
  tenantVectorIndexPrefix,
  tenantVectorIndexStatement,
} from "@/lib/db/tenant-vector-indexes";

const TABLE = "omni_memories";

function name(tenantId: string) {
  return tenantVectorIndexName(TABLE, tenantId);
}

function plan(
  tenants: Array<[string, number]>,
  indexes: Array<[string, boolean]> = [],
  options: { minRows?: number; buildsPerRun?: number } = {},
) {
  return planTenantVectorIndexes({
    table: TABLE,
    tenants: tenants.map(([tenantId, rows]) => ({ tenantId, rows })),
    indexes: indexes.map(([indexName, valid]) => ({ name: indexName, valid })),
    minRows: options.minRows ?? 10,
    ...(options.buildsPerRun === undefined ? {} : { buildsPerRun: options.buildsPerRun }),
  });
}

describe("the name of a tenant's vector index", () => {
  it("is the table's prefix and 16 hex digits of the tenant id's hash", () => {
    const digest = createHash("sha256").update("tenant-a").digest("hex");
    expect(tenantVectorIndexPrefix(TABLE)).toBe("omni_memories_tenant_vector_");
    expect(name("tenant-a")).toBe(`omni_memories_tenant_vector_${digest.slice(0, 16)}`);
    expect(tenantVectorIndexName("omni_knowledge_chunks", "tenant-a"))
      .toBe(`omni_knowledge_chunks_tenant_vector_${digest.slice(0, 16)}`);
  });

  it("fits a PostgreSQL name, differs a tenant, and never carries the id", () => {
    const longest = "t".repeat(120);
    for (const table of ["omni_memories", "omni_knowledge_chunks"] as const) {
      expect(tenantVectorIndexName(table, longest).length).toBeLessThanOrEqual(63);
      expect(tenantVectorIndexName(table, longest)).not.toContain("tttt");
    }
    expect(name("tenant-a")).not.toBe(name("tenant-b"));
    expect(name("tenant-a")).not.toBe(tenantVectorIndexName("omni_knowledge_chunks", "tenant-a"));
  });
});

describe("the tenant vector index threshold", () => {
  it("is 2,000 vectors unless set to a number of at least one", () => {
    expect(TENANT_VECTOR_INDEX).toEqual({ minRows: 2_000, buildsPerRun: 4 });
    for (const value of [undefined, "", "0", "-1", "0.5", "abc", "Infinity"]) {
      expect(tenantVectorIndexMinRows(value)).toBe(2_000);
    }
    expect(tenantVectorIndexMinRows("1")).toBe(1);
    expect(tenantVectorIndexMinRows("30")).toBe(30);
    expect(tenantVectorIndexMinRows("30.7")).toBe(30);
  });
});

describe("the tenant vector index plan", () => {
  it("builds for a tenant at the threshold and not below it", () => {
    expect(plan([["at", 10], ["below", 9]])).toEqual({
      drop: [],
      build: [{ name: name("at"), tenantId: "at" }],
    });
  });

  it("keeps a valid index, below the threshold too", () => {
    expect(plan([["large", 50], ["shrank", 3]], [[name("large"), true], [name("shrank"), true]]))
      .toEqual({ drop: [], build: [] });
  });

  it("drops an index that is not valid and builds it again while its tenant qualifies", () => {
    expect(plan([["large", 50], ["small", 3]], [[name("large"), false], [name("small"), false]]))
      .toEqual({
        drop: [name("large"), name("small")].sort(),
        build: [{ name: name("large"), tenantId: "large" }],
      });
  });

  it("drops the index of a tenant that holds no vectors any more", () => {
    expect(plan([["kept", 50], ["emptied", 0]], [
      [name("kept"), true],
      [name("emptied"), true],
      [name("gone"), true],
    ])).toEqual({ drop: [name("emptied"), name("gone")].sort(), build: [] });
  });

  it("leaves indexes outside the table's tenant prefix alone", () => {
    expect(plan([["large", 50]], [
      ["omni_memories_embedding_vector_idx", true],
      [tenantVectorIndexName("omni_knowledge_chunks", "large"), false],
      ["omni_memories_tenant_idx", false],
    ])).toEqual({ drop: [], build: [{ name: name("large"), tenantId: "large" }] });
  });

  it("gives no index to a tenant id a quoted literal could not hold", () => {
    const unsafe = ["it's", "two words", "", "t".repeat(121), "semi;colon", "ünïcode"];
    expect(plan(unsafe.map((tenantId): [string, number] => [tenantId, 50]))).toEqual({ drop: [], build: [] });
    expect(plan([["Plain.Id_1:2-3", 50], ["t".repeat(120), 50]]).build.map((build) => build.tenantId))
      .toEqual(["Plain.Id_1:2-3", "t".repeat(120)]);
  });

  it("builds the largest tenants first, ties by tenant id, a few a run", () => {
    const tenants: Array<[string, number]> = [
      ["c", 20], ["a", 30], ["b", 30], ["d", 40], ["e", 10], ["f", 15],
    ];
    expect(plan(tenants).build.map((build) => build.tenantId)).toEqual(["d", "a", "b", "c"]);
    expect(plan(tenants, [], { buildsPerRun: 2 }).build.map((build) => build.tenantId))
      .toEqual(["d", "a"]);
    expect(plan([["b", 30], ["a", 30]]).build.map((build) => build.tenantId)).toEqual(["a", "b"]);
    expect(plan(tenants, [], { buildsPerRun: 10 }).build).toHaveLength(6);
  });

  it("lists the drops in name order", () => {
    const names = ["z", "y", "x", "w"].map(name);
    const { drop } = plan([], names.map((indexName): [string, boolean] => [indexName, true]));
    expect(drop).toEqual([...names].sort());
  });
});

describe("the tenant vector index statements", () => {
  it("build a partial HNSW index over the tenant's vectors", () => {
    expect(tenantVectorIndexStatement(TABLE, { name: name("tenant-a"), tenantId: "tenant-a" }))
      .toBe(
        `CREATE INDEX IF NOT EXISTS ${name("tenant-a")} ON omni_memories ` +
          "USING hnsw (embedding_vector vector_cosine_ops) WHERE tenant_id = 'tenant-a'",
      );
  });

  it("refuse a tenant id a literal could not hold, or a name not the tenant's", () => {
    expect(() => tenantVectorIndexStatement(TABLE, { name: name("it's"), tenantId: "it's" }))
      .toThrow("A tenant vector index needs a plain tenant id and its own name.");
    expect(() => tenantVectorIndexStatement(TABLE, { name: name("tenant-b"), tenantId: "tenant-a" }))
      .toThrow("A tenant vector index needs a plain tenant id and its own name.");
    expect(() => tenantVectorIndexStatement("omni_knowledge_chunks", {
      name: name("tenant-a"),
      tenantId: "tenant-a",
    })).toThrow("A tenant vector index needs a plain tenant id and its own name.");
  });

  it("drop an index by its quoted name", () => {
    expect(tenantVectorIndexDropStatement(name("tenant-a")))
      .toBe(`DROP INDEX IF EXISTS "${name("tenant-a")}"`);
    expect(tenantVectorIndexDropStatement("odd\"name")).toBe("DROP INDEX IF EXISTS \"odd\"\"name\"");
  });
});

describe("keeping a table's tenant vector indexes in step", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failures(warn: { mock: { calls: unknown[][] } }) {
    return warn.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
  }

  it("runs each drop and then each build, each statement on its own", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn(async (_index: string, _statement: string) => undefined);
    await maintainTenantVectorIndexes({
      table: TABLE,
      plan: async () => ({
        drop: [name("gone"), name("broken")],
        build: [
          { name: name("broken"), tenantId: "broken" },
          { name: name("large"), tenantId: "large" },
        ],
      }),
      run,
    });

    expect(run.mock.calls).toEqual([
      [name("gone"), tenantVectorIndexDropStatement(name("gone"))],
      [name("broken"), tenantVectorIndexDropStatement(name("broken"))],
      [name("broken"), tenantVectorIndexStatement(TABLE, { name: name("broken"), tenantId: "broken" })],
      [name("large"), tenantVectorIndexStatement(TABLE, { name: name("large"), tenantId: "large" })],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("changes nothing when the plan cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn(async (_index: string, _statement: string) => undefined);
    await maintainTenantVectorIndexes({
      table: "omni_knowledge_chunks",
      plan: async () => {
        throw new Error("catalog unavailable");
      },
      run,
    });

    expect(run).not.toHaveBeenCalled();
    expect(failures(warn)).toEqual([{
      level: "warn",
      event: "database_tenant_vector_index_failed",
      table: "omni_knowledge_chunks",
      error: "catalog unavailable",
    }]);
  });

  it("logs a failed statement and runs the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn(async (index: string, _statement: string) => {
      if (index === name("gone")) {
        throw new Error("lock not available");
      }
      if (index === name("first")) {
        throw "not an error";
      }
    });
    await maintainTenantVectorIndexes({
      table: TABLE,
      plan: async () => ({
        drop: [name("gone")],
        build: [
          { name: name("first"), tenantId: "first" },
          { name: name("second"), tenantId: "second" },
        ],
      }),
      run,
    });

    expect(run.mock.calls.map(([index]) => index))
      .toEqual([name("gone"), name("first"), name("second")]);
    expect(failures(warn)).toEqual([
      {
        level: "warn",
        event: "database_tenant_vector_index_failed",
        table: TABLE,
        index: name("gone"),
        error: "lock not available",
      },
      {
        level: "warn",
        event: "database_tenant_vector_index_failed",
        table: TABLE,
        index: name("first"),
        error: "not an error",
      },
    ]);
  });

  it("logs a build whose statement is refused and runs the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn(async (_index: string, _statement: string) => undefined);
    await maintainTenantVectorIndexes({
      table: TABLE,
      plan: async () => ({
        drop: [],
        build: [
          { name: name("tenant-b"), tenantId: "tenant-a" },
          { name: name("large"), tenantId: "large" },
        ],
      }),
      run,
    });

    expect(run.mock.calls.map(([index]) => index)).toEqual([name("large")]);
    expect(failures(warn)).toEqual([{
      level: "warn",
      event: "database_tenant_vector_index_failed",
      table: TABLE,
      index: name("tenant-b"),
      error: "A tenant vector index needs a plain tenant id and its own name.",
    }]);
  });
});
