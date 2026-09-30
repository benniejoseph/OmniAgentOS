import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  statements: [] as Array<{ client: string; text: string; values: unknown[] }>,
}));

function fakeSql(client: "pool" | "transaction") {
  return Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.statements.push({ client, text: strings.join("?"), values });
      return Promise.resolve([]);
    },
    {
      transactionScoped: client === "transaction",
      transaction: async (operation: (sql: unknown) => Promise<unknown>) => {
        mocks.statements.push({ client, text: "BEGIN", values: [] });
        const result = await operation(fakeSql("transaction"));
        mocks.statements.push({ client, text: "COMMIT", values: [] });
        return result;
      },
    },
  );
}

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureSchema,
  getDatabaseTenantContext: () => undefined,
  getSql: () => fakeSql("pool"),
  hasDatabaseUrl: () => true,
}));

import { VECTOR_INDEX_DIMENSIONS } from "@/lib/config";
import { searchAuthorizedCanonicalKnowledge } from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const tenantId = "tenant-canonical-vector";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.statements.length = 0;
});

describe("Postgres canonical knowledge vector search", () => {
  it("sizes the HNSW scan in the transaction that reads the candidates", async () => {
    await searchAuthorizedCanonicalKnowledge("restore the backup", {
      tenantId,
      limit: 30,
      asOfTime: "2026-10-01T00:00:00.000Z",
      queryEmbedding: Array.from(
        { length: VECTOR_INDEX_DIMENSIONS },
        (_, index) => (index === 0 ? 1 : 0),
      ),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: "actor-canonical-vector",
        executingPrincipalType: "user",
        executingPrincipalId: "actor-canonical-vector",
        correlationId: "canonical-vector-search",
        purpose: "Search canonical knowledge.",
      }),
    });

    const vectorSearch = mocks.statements.findIndex(({ text }) =>
      text.includes("WITH authorized_vector_candidates AS MATERIALIZED")
    );
    expect(mocks.statements.slice(vectorSearch - 2, vectorSearch + 2).map(
      ({ client, text }) => [client, text.trim().slice(0, 36)],
    )).toEqual([
      ["pool", "BEGIN"],
      ["transaction", "SELECT set_config('hnsw.ef_search', "],
      ["transaction", "WITH authorized_vector_candidates AS"],
      ["pool", "COMMIT"],
    ]);
    expect(mocks.statements[vectorSearch - 1].values).toEqual(["120"]);
  });
});
