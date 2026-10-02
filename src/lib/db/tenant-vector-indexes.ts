import { createHash } from "node:crypto";

/**
 * A tenant gets an HNSW index of its own once it holds `minRows` vectors in a
 * table (OMNIAGENT_TENANT_VECTOR_INDEX_MIN_ROWS). One run of the pgvector step
 * builds at most `buildsPerRun` of them a table, the largest tenants first.
 */
export const TENANT_VECTOR_INDEX = Object.freeze({
  minRows: 2_000,
  buildsPerRun: 4,
});

export type TenantVectorTable = "omni_memories" | "omni_knowledge_chunks";

export type TenantVectorCount = Readonly<{ tenantId: string; rows: number }>;

export type TenantVectorIndex = Readonly<{ name: string; valid: boolean }>;

export type TenantVectorIndexBuild = Readonly<{ name: string; tenantId: string }>;

export type TenantVectorIndexPlan = Readonly<{
  drop: readonly string[];
  build: readonly TenantVectorIndexBuild[];
}>;

/** The characters a stored tenant id may hold, which a quoted literal keeps. */
const TENANT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** OMNIAGENT_TENANT_VECTOR_INDEX_MIN_ROWS: 2,000 by default, at least 1. */
export function tenantVectorIndexMinRows(
  value = process.env.OMNIAGENT_TENANT_VECTOR_INDEX_MIN_ROWS,
) {
  const rows = Number(value);
  return Number.isFinite(rows) && rows >= 1
    ? Math.floor(rows)
    : TENANT_VECTOR_INDEX.minRows;
}

/** Every tenant index of a table has a name that starts with this. */
export function tenantVectorIndexPrefix(table: TenantVectorTable) {
  return `${table}_tenant_vector_`;
}

/**
 * The name of a tenant's index on a table: the table's prefix, then the first
 * 16 hex digits of the tenant id's SHA-256, so it stays within PostgreSQL's
 * 63-byte names and never carries the tenant id.
 */
export function tenantVectorIndexName(table: TenantVectorTable, tenantId: string) {
  const digest = createHash("sha256").update(tenantId).digest("hex");
  return `${tenantVectorIndexPrefix(table)}${digest.slice(0, 16)}`;
}

/**
 * Decides which tenant indexes of a table to drop and which to build, from the
 * vectors each tenant holds and the tenant indexes the catalog has. A tenant
 * at the threshold gets an index when it has no valid one. An index that is
 * not valid, which a failed build leaves behind, is dropped, and built again
 * if its tenant still qualifies; so is an index whose tenant holds no vectors
 * any more. A tenant that fell below the threshold keeps its index. Tenant ids
 * a quoted literal could not hold safely get none.
 */
export function planTenantVectorIndexes(input: Readonly<{
  table: TenantVectorTable;
  tenants: readonly TenantVectorCount[];
  indexes: readonly TenantVectorIndex[];
  minRows: number;
  buildsPerRun?: number;
}>): TenantVectorIndexPlan {
  const prefix = tenantVectorIndexPrefix(input.table);
  const existing = new Map(
    input.indexes
      .filter((index) => index.name.startsWith(prefix))
      .map((index) => [index.name, index.valid]),
  );
  const holders = new Map<string, TenantVectorCount>();
  for (const tenant of input.tenants) {
    if (TENANT_ID.test(tenant.tenantId) && tenant.rows > 0) {
      holders.set(tenantVectorIndexName(input.table, tenant.tenantId), tenant);
    }
  }
  const drop = [...existing]
    .filter(([name, valid]) => !valid || !holders.has(name))
    .map(([name]) => name)
    .sort();
  const build = [...holders]
    .filter(([name, tenant]) => tenant.rows >= input.minRows && existing.get(name) !== true)
    .sort(([, left], [, right]) =>
      right.rows - left.rows || (left.tenantId < right.tenantId ? -1 : 1)
    )
    .slice(0, input.buildsPerRun ?? TENANT_VECTOR_INDEX.buildsPerRun)
    .map(([name, tenant]) => ({ name, tenantId: tenant.tenantId }));
  return { drop, build };
}

/**
 * The statement that builds a tenant's index: HNSW over the table's vectors,
 * partial to the tenant's rows, so a search filtered to the tenant walks a
 * graph of the tenant's vectors alone.
 */
export function tenantVectorIndexStatement(
  table: TenantVectorTable,
  index: TenantVectorIndexBuild,
) {
  if (!TENANT_ID.test(index.tenantId) || index.name !== tenantVectorIndexName(table, index.tenantId)) {
    throw new Error("A tenant vector index needs a plain tenant id and its own name.");
  }
  return `CREATE INDEX IF NOT EXISTS ${index.name} ON ${table} ` +
    `USING hnsw (embedding_vector vector_cosine_ops) WHERE tenant_id = '${index.tenantId}'`;
}

/** The statement that drops a tenant index by its name in the catalog. */
export function tenantVectorIndexDropStatement(name: string) {
  return `DROP INDEX IF EXISTS "${name.replaceAll("\"", "\"\"")}"`;
}

/**
 * Brings a table's tenant indexes in step with its tenants: reads the plan,
 * then runs each drop and then each build through `run`, which gives each
 * statement a transaction of its own. A failure logs a
 * `database_tenant_vector_index_failed` line. A failed plan changes nothing;
 * a failed statement leaves the others to run.
 */
export async function maintainTenantVectorIndexes(input: Readonly<{
  table: TenantVectorTable;
  plan: () => Promise<TenantVectorIndexPlan>;
  run: (index: string, statement: string) => Promise<void>;
}>) {
  let plan: TenantVectorIndexPlan;
  try {
    plan = await input.plan();
  } catch (error) {
    logTenantVectorIndexFailure(input.table, undefined, error);
    return;
  }
  for (const name of plan.drop) {
    await runTenantVectorIndexStatement(input, name, () => tenantVectorIndexDropStatement(name));
  }
  for (const index of plan.build) {
    await runTenantVectorIndexStatement(
      input,
      index.name,
      () => tenantVectorIndexStatement(input.table, index),
    );
  }
}

async function runTenantVectorIndexStatement(
  input: Readonly<{
    table: TenantVectorTable;
    run: (index: string, statement: string) => Promise<void>;
  }>,
  index: string,
  statement: () => string,
) {
  try {
    await input.run(index, statement());
  } catch (error) {
    logTenantVectorIndexFailure(input.table, index, error);
  }
}

function logTenantVectorIndexFailure(
  table: TenantVectorTable,
  index: string | undefined,
  error: unknown,
) {
  console.warn(JSON.stringify({
    level: "warn",
    event: "database_tenant_vector_index_failed",
    table,
    ...(index === undefined ? {} : { index }),
    error: error instanceof Error ? error.message : String(error),
  }));
}
