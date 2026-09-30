import { describe, expect, it } from "vitest";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { withHnswCandidateScan } from "@/lib/db/vector-search";

type Statement = { client: "pool" | "transaction"; text: string; params: unknown[] };

function fakeSql(
  statements: Statement[],
  client: Statement["client"] = "pool",
): SqlClient {
  const record = (text: string, params: unknown[] = []) => {
    statements.push({ client, text, params });
    return Promise.resolve<SqlRow[]>([{ id: "nearest" }]);
  };
  return Object.assign(
    (strings: TemplateStringsArray, ...params: unknown[]) =>
      record(strings.join("?").replace(/\s+/g, " ").trim(), params),
    {
      query: record,
      unsafe: record,
      transactionScoped: client === "transaction",
      transaction: async (operation: unknown) => {
        statements.push({ client, text: "BEGIN", params: [] });
        const result = await (operation as (sql: SqlClient) => Promise<unknown>)(
          fakeSql(statements, "transaction"),
        );
        statements.push({ client, text: "COMMIT", params: [] });
        return result;
      },
    },
  );
}

const nearest = (sql: SqlClient) => sql`SELECT id FROM nearest`;

describe("HNSW candidate scan", () => {
  it("sizes the scan in the query's own transaction", async () => {
    const statements: Statement[] = [];

    const rows = await withHnswCandidateScan(fakeSql(statements), 240, nearest);

    expect(rows).toEqual([{ id: "nearest" }]);
    expect(statements.map(({ client, text }) => [client, text.slice(0, 40)])).toEqual([
      ["pool", "BEGIN"],
      ["transaction", "SELECT set_config('hnsw.ef_search', ?, t"],
      ["transaction", "SELECT id FROM nearest"],
      ["pool", "COMMIT"],
    ]);
    expect(statements[1].params).toEqual(["240"]);
  });

  it("reuses the transaction a scoped read already holds", async () => {
    const statements: Statement[] = [];

    await withHnswCandidateScan(fakeSql(statements, "transaction"), 96, nearest);

    expect(statements.map(({ client, text }) => [client, text.slice(0, 22)])).toEqual([
      ["transaction", "SELECT set_config('hns"],
      ["transaction", "SELECT id FROM nearest"],
    ]);
    expect(statements[0].params).toEqual(["96"]);
  });

  it("keeps pgvector's default list for short limits and caps long ones", async () => {
    const sizes: unknown[] = [];
    for (const limit of [8, 40, 120.5, 1000, 5000, Number.NaN]) {
      const statements: Statement[] = [];
      await withHnswCandidateScan(fakeSql(statements, "transaction"), limit, nearest);
      sizes.push(statements[0].params[0]);
    }

    expect(sizes).toEqual(["40", "40", "121", "1000", "1000", "40"]);
  });
});
