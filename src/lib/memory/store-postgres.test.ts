import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queries: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getDatabaseTenantContext: vi.fn(() => undefined),
  hasDatabaseUrl: vi.fn(() => true),
  getSql: vi.fn(() => async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => {
    void params;
    mocks.queries.push(strings.join("?"));
    return [];
  }),
}));

import { searchMemories } from "@/lib/memory/store";

describe("Postgres memory recall", () => {
  beforeEach(() => {
    mocks.queries.length = 0;
  });

  it("ranks the projected lexical score from an outer query", async () => {
    await expect(
      searchMemories("release verification", { tenantId: "tenant-a" }),
    ).resolves.toEqual([]);

    const lexicalQuery = mocks.queries.find((query) =>
      query.includes("AS lexical_score"),
    );
    expect(lexicalQuery).toContain("FROM (\n      SELECT *");
    expect(lexicalQuery).toContain(") ranked");
    expect(lexicalQuery).toContain(
      "ORDER BY (ranked.lexical_score * (0.35 + ranked.confidence * 0.65))",
    );
    expect(lexicalQuery).not.toContain("ORDER BY (lexical_score *");
  });
});
