import type { SqlClient } from "@/lib/db/sql-types";

/** pgvector's default HNSW candidate list. */
const HNSW_DEFAULT_EF_SEARCH = 40;

/** The longest HNSW candidate list pgvector accepts. */
const HNSW_MAX_EF_SEARCH = 1000;

/**
 * Runs a nearest-neighbor query with its HNSW scan sized to the candidates it
 * asks for. An HNSW scan yields at most `hnsw.ef_search` rows, 40 by default,
 * and the query's tenant and lifecycle filters apply after the scan, so a
 * query asking for more got fewer, and nearer rows of another tenant could
 * leave none. The scan keeps as many candidates as the query's limit, and on
 * pgvector 0.8.0 or later it keeps reading the index until the filters leave
 * enough rows. Both settings last only for the query's transaction.
 */
export async function withHnswCandidateScan<T>(
  sql: SqlClient,
  candidateLimit: number,
  query: (sql: SqlClient) => Promise<T>,
): Promise<T> {
  const efSearch = Number.isFinite(candidateLimit)
    ? Math.min(
      Math.max(Math.ceil(candidateLimit), HNSW_DEFAULT_EF_SEARCH),
      HNSW_MAX_EF_SEARCH,
    )
    : HNSW_DEFAULT_EF_SEARCH;
  const run = async (transaction: SqlClient) => {
    // pgvector added the iterative scan in 0.8.0. Earlier releases reserve
    // the hnsw prefix without it, so setting it there is an error.
    await transaction`
      SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true),
             CASE WHEN EXISTS (
               SELECT 1
               FROM pg_extension
               WHERE extname = 'vector'
                 AND extversion !~ '^0[.][0-7]([.]|$)'
             ) THEN set_config('hnsw.iterative_scan', 'relaxed_order', true)
             END
    `;
    return query(transaction);
  };
  return sql.transactionScoped
    ? run(sql)
    : (sql.transaction(run) as Promise<T>);
}
