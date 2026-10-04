import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { PGVECTOR_HNSW_MAX_DIMENSIONS, VECTOR_INDEX_DIMENSIONS } from "@/lib/config";
import {
  appendServerTiming,
  recordDatabaseTiming,
  runWithRequestTiming,
} from "@/lib/observability/request-timing";
import { enforcePrivateNoStore } from "@/lib/http/response";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import {
  beginMigrationTransaction,
  runWithMigrationLockRetry,
} from "@/lib/db/migration-transaction";
import {
  maintainTenantVectorIndexes,
  planTenantVectorIndexes,
  tenantVectorIndexMinRows,
  tenantVectorIndexPrefix,
} from "@/lib/db/tenant-vector-indexes";
import { typescriptSchemaMigrations } from "@/lib/db/schema/steps";
import type { SchemaMigrationUp, SqlClient, SqlRow } from "@/lib/db/sql-types";
import schemaMigrationManifest from "../../../schema-migrations.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DatabaseScope =
  | { kind: "tenant"; tenantId: string; actorIds: string[] }
  | { kind: "system"; reason: string };

type SchemaMigrationRecord = Readonly<{
  version: number;
  name: string;
  checksum: string;
}>;

/**
 * A schema-migrations.json entry. `file` names the SQL file that applies it,
 * and `sha256` is that file's digest.
 */
type SchemaMigrationManifestEntry = Readonly<
  SchemaMigrationRecord & { file?: string; sha256?: string }
>;

/** One unit of the ordered migration run: a TypeScript step or a SQL file. */
export type SchemaMigrationStep = Readonly<
  | {
      kind: "typescript";
      migrations: readonly [SchemaMigrationRecord];
      up: SchemaMigrationUp;
    }
  | {
      kind: "sql";
      /** Every version the file records, in order; the file runs whole. */
      migrations: readonly SchemaMigrationRecord[];
      file: string;
      sha256: string;
    }
>;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let sqlClient: postgres.Sql | null = null;
let scopedSqlClient: SqlClient | null = null;
let maintenanceSqlClient: postgres.Sql | null = null;
let maintenanceScopedSqlClient: SqlClient | null = null;
let schemaReady: Promise<void> | null = null;
let schemaMigrationReady: Promise<void> | null = null;
const databaseScope = new AsyncLocalStorage<DatabaseScope>();
type ManagedTransactionCapability = { active: boolean; scope: DatabaseScope | undefined; rollbackOnly?: { reason: unknown }; joined: boolean; inFlight: number };
type JoinedTransactionContext = {
  active: boolean; capability: ManagedTransactionCapability; sql: SqlClient; client: SqlClient;
  tail: Promise<unknown>; pending: Set<Promise<unknown>>;
};
const managedTransactionCapabilities = new WeakMap<SqlClient, ManagedTransactionCapability>();
const joinedTransactionContext = new AsyncLocalStorage<JoinedTransactionContext>();
const joinedStatementDispatch = new AsyncLocalStorage<ManagedTransactionCapability>();

const DEFAULT_SCHEMA_VERIFICATION_TIMEOUT_MS = 10_000;
const MIN_SCHEMA_VERIFICATION_TIMEOUT_MS = 1_000;
const MAX_SCHEMA_VERIFICATION_TIMEOUT_MS = 60_000;
const DEFAULT_DATABASE_ACQUIRE_TIMEOUT_MS = 20_000;
const MIN_DATABASE_ACQUIRE_TIMEOUT_MS = 500;
const MAX_DATABASE_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_DATABASE_RESERVATION_TIMEOUT_MS = 30_000;
const MIN_DATABASE_RESERVATION_TIMEOUT_MS = 1_000;
const MAX_DATABASE_RESERVATION_TIMEOUT_MS = 120_000;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 15_000;
const MIN_DATABASE_STATEMENT_TIMEOUT_MS = 1_000;
const MAX_DATABASE_STATEMENT_TIMEOUT_MS = 60_000;
const DEFAULT_DATABASE_LOCK_TIMEOUT_MS = 1_000;
const MIN_DATABASE_LOCK_TIMEOUT_MS = 100;
const MAX_DATABASE_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;
const MIN_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 1_000;
const MAX_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 60_000;
// Connection close is a generation boundary while a reservation is active.
// Disable postgres.js's local idle/lifetime timers so routine timer rotation
// cannot retire unrelated work in a wider durable pool. The platform, upstream
// pooler, and network can still close idle sockets; postgres.js reconnects them
// when there is no active generation work to fence.
const DATABASE_POOL_IDLE_TIMEOUT_SECONDS = 0;
// Keep Supavisor-compatible unnamed statements while forcing PostgreSQL's
// extended-protocol Parse boundary, which rejects multi-statement raw batches
// before any member of the batch can execute.
const DATABASE_SINGLE_STATEMENT_QUERY_OPTIONS = Object.freeze({
  prepare: false,
  simple: false,
});

// ---------------------------------------------------------------------------
// Public exports (unchanged API surface)
// ---------------------------------------------------------------------------

export {
  migrationScopedTenantTables,
  tenantChildPolicyTables,
  tenantIsolationExemptTables,
  tenantPolicyTables,
  tenantRootPolicyTables,
} from "@/lib/db/schema/tenant-isolation";

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function hasMaintenanceDatabaseUrl() {
  return Boolean(process.env.OMNIAGENT_MAINTENANCE_DATABASE_URL?.trim());
}

export function getDatabasePoolMax() {
  const configured = Number(process.env.OMNIAGENT_DATABASE_POOL_MAX);
  if (Number.isInteger(configured) && configured > 0) {
    // Every Vercel route bundle/isolate owns its own postgres.js singleton.
    // Enforce one connection per runtime or maintenance pool even when the
    // shared production override is higher so independent functions cannot
    // multiply the Supavisor frontend count under burst traffic.
    return process.env.VERCEL ? 1 : Math.min(configured, 20);
  }
  if (process.env.VERCEL) return 1;
  // Production runtimes can serve overlapping requests in one process. A
  // single connection lets a long workflow tick starve unrelated reads.
  return process.env.NODE_ENV === "production" ? 4 : 1;
}

export function getDatabasePoolIdleTimeoutSeconds() {
  return DATABASE_POOL_IDLE_TIMEOUT_SECONDS;
}

export function getDatabaseAcquireTimeoutMs() {
  const configured = Number(
    process.env.OMNIAGENT_DATABASE_ACQUIRE_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_DATABASE_ACQUIRE_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(configured), MIN_DATABASE_ACQUIRE_TIMEOUT_MS),
    MAX_DATABASE_ACQUIRE_TIMEOUT_MS,
  );
}

export function getDatabaseReservationTimeoutMs() {
  const configured = Number(
    process.env.OMNIAGENT_DATABASE_RESERVATION_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_DATABASE_RESERVATION_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(configured), MIN_DATABASE_RESERVATION_TIMEOUT_MS),
    MAX_DATABASE_RESERVATION_TIMEOUT_MS,
  );
}

export function getDatabaseSchemaVerificationTimeoutMs() {
  const configured = Number(
    process.env.OMNIAGENT_SCHEMA_VERIFICATION_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SCHEMA_VERIFICATION_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(configured), MIN_SCHEMA_VERIFICATION_TIMEOUT_MS),
    MAX_SCHEMA_VERIFICATION_TIMEOUT_MS,
  );
}

export function getDatabaseStatementTimeoutMs() {
  const configured = Number(
    process.env.OMNIAGENT_DATABASE_STATEMENT_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(configured), MIN_DATABASE_STATEMENT_TIMEOUT_MS),
    MAX_DATABASE_STATEMENT_TIMEOUT_MS,
  );
}

export function getDatabaseLockTimeoutMs(
  statementTimeoutMs = getDatabaseStatementTimeoutMs(),
) {
  const configured = Number(process.env.OMNIAGENT_DATABASE_LOCK_TIMEOUT_MS);
  const lockTimeoutMs =
    Number.isFinite(configured) && configured > 0
      ? Math.min(
          Math.max(Math.round(configured), MIN_DATABASE_LOCK_TIMEOUT_MS),
          MAX_DATABASE_LOCK_TIMEOUT_MS,
        )
      : DEFAULT_DATABASE_LOCK_TIMEOUT_MS;
  return Math.min(lockTimeoutMs, statementTimeoutMs);
}

export function getDatabaseIdleTransactionTimeoutMs() {
  const configured = Number(
    process.env.OMNIAGENT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(
      Math.round(configured),
      MIN_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
    ),
    MAX_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
  );
}

export async function closeDatabaseClient() {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
  }
  if (maintenanceSqlClient && maintenanceSqlClient !== sqlClient) {
    await maintenanceSqlClient.end({ timeout: 5 });
  }
  sqlClient = null;
  scopedSqlClient = null;
  maintenanceSqlClient = null;
  maintenanceScopedSqlClient = null;
  schemaReady = null;
  schemaMigrationReady = null;
}

export function getStorageBackend() {
  if (hasDatabaseUrl()) {
    return "postgres";
  }

  if (process.env.VERCEL) {
    return "ephemeral";
  }

  return "file";
}

export async function getVectorStoreStatus() {
  if (!hasDatabaseUrl()) {
    return {
      configured: false,
      hnswSupported: VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS,
      dimensions: VECTOR_INDEX_DIMENSIONS,
    };
  }

  await ensureDatabaseSchema();
  const sql = wrapPg(getRawPg());
  const [extensionRows, indexRows] = await Promise.all([
    sql`SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1`,
    sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'omni_memories_embedding_vector_idx',
          'omni_knowledge_chunks_embedding_vector_idx'
        )
    `,
  ]);
  const indexNames = new Set(indexRows.map((row) => String(row.indexname)));
  const memoryColumnDimensions = await getVectorColumnDimensions(sql, "omni_memories");
  const knowledgeColumnDimensions = await getVectorColumnDimensions(sql, "omni_knowledge_chunks");

  return {
    configured:
      Boolean(extensionRows[0]) &&
      memoryColumnDimensions === VECTOR_INDEX_DIMENSIONS &&
      knowledgeColumnDimensions === VECTOR_INDEX_DIMENSIONS &&
      indexNames.has("omni_memories_embedding_vector_idx") &&
      indexNames.has("omni_knowledge_chunks_embedding_vector_idx"),
    extensionInstalled: Boolean(extensionRows[0]),
    extensionVersion: extensionRows[0]?.extversion ? String(extensionRows[0].extversion) : undefined,
    dimensions: VECTOR_INDEX_DIMENSIONS,
    hnswSupported: VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS,
    memoryColumnDimensions,
    knowledgeColumnDimensions,
    memoryIndexed: indexNames.has("omni_memories_embedding_vector_idx"),
    knowledgeIndexed: indexNames.has("omni_knowledge_chunks_embedding_vector_idx"),
  };
}

// Returns the tenant-scoped sql client. All queries run through this are
// automatically wrapped in a short transaction that sets omni.tenant_id
// locally when a tenant context is active.
export function getSql(): SqlClient {
  const joined = joinedTransactionContext.getStore();
  if (joined) {
    assertJoinedTransactionScope(joined);
    return joined.client;
  }
  const scope = databaseScope.getStore();
  if (scope?.kind === "system") {
    if (hasMaintenanceDatabaseUrl()) {
      if (!maintenanceScopedSqlClient) {
        maintenanceScopedSqlClient = createTenantScopedSqlClient(
          getRawMaintenancePg(),
          false,
          getRawMaintenancePg,
        );
      }
      return maintenanceScopedSqlClient;
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "OMNIAGENT_MAINTENANCE_DATABASE_URL is required for production system-scope database work.",
      );
    }
  }
  if (!scopedSqlClient) {
    scopedSqlClient = createTenantScopedSqlClient(getRawPg(), false, getRawPg);
  }
  return scopedSqlClient;
}

/** Explicitly joins one manager-owned transaction for the closed responsibility
 * Meeting-read pilot and its normal audit stores. This is not a general scoped
 * store adapter: memory-access/other transaction-local scope installers fail.
 * Nested
 * callbacks share the outer commit; any failure makes that commit rollback-only.
 * No provider effects, transaction controls, wider actor scope or system scope
 * are introduced. Ordinary callers retain their existing transaction behavior.
 */
export async function runWithManagedDatabaseTransaction<T>(sql: SqlClient, operation: () => Promise<T>): Promise<T> {
  const capability = managedTransactionCapabilities.get(sql);
  if (!capability?.active || !sql.transactionScoped || capability.scope?.kind !== "tenant" || !capability.scope.tenantId || !capability.scope.actorIds.length) {
    throw joinedTransactionError("A live managed actor transaction is required.");
  }
  if (joinedTransactionContext.getStore() || capability.joined || capability.inFlight) {
    const error = joinedTransactionError("Transaction adoption requires an idle outer callback and cannot be nested.");
    capability.rollbackOnly ??= { reason: error };
    throw error;
  }
  const context: JoinedTransactionContext = { active: true, capability, sql, client: sql, tail: Promise.resolve(), pending: new Set() };
  context.client = createJoinedTransactionClient(context);
  capability.joined = true;
  try {
    return await joinedTransactionContext.run(context, async () => {
      assertJoinedTransactionScope(context);
      const result = await operation();
      if (context.pending.size) throw joinedTransactionError("A joined transaction callback returned with outstanding work.", "DATABASE_RESERVATION_INFLIGHT");
      if (capability.rollbackOnly) throw capability.rollbackOnly.reason;
      return result;
    });
  } catch (error) {
    capability.rollbackOnly ??= { reason: error };
    throw error;
  } finally {
    context.active = false;
    // Drain already-issued bounded statements and scope restoration before the
    // manager can roll back/release. Queued work sees active=false and refuses
    // to begin. The existing server and reservation deadlines remain in force.
    await Promise.allSettled([...context.pending]);
    capability.joined = false;
  }
}

function createJoinedTransactionClient(context: JoinedTransactionContext): SqlClient {
  const issue = (statement: string, operation: () => Promise<SqlRow[]>): Promise<SqlRow[]> => {
    let scope: DatabaseScope;
    try { scope = assertJoinedTransactionScope(context); assertJoinedStatement(statement); }
    catch (error) { context.capability.rollbackOnly ??= { reason: error }; return Promise.reject(error); }
    const pending = context.tail.then(async () => {
      assertJoinedTransactionScope(context, scope);
      return joinedStatementDispatch.run(context.capability, async () => {
        let operationFailed = false;
        try {
          await applyDatabaseScope(context.sql, scope);
          assertJoinedTransactionScope(context, scope);
          return await operation();
        } catch (error) {
          operationFailed = true;
          // Poison admission before cleanup. In PostgreSQL a failed statement
          // aborts the transaction, so restoration may itself fail with 25P02;
          // that secondary diagnostic must not replace the original failure.
          context.capability.rollbackOnly ??= { reason: error };
          throw error;
        } finally {
          // Scope restoration belongs to the queued unit, so concurrent narrow
          // readers cannot interleave SET LOCAL with one another's query.
          try {
            await applyDatabaseScope(context.sql, context.capability.scope);
          } catch (error) {
            if (!operationFailed) {
              context.capability.rollbackOnly ??= { reason: error };
              throw error;
            }
          }
        }
      });
    }).catch((error: unknown) => { context.capability.rollbackOnly ??= { reason: error }; throw error; });
    context.tail = pending.catch(() => undefined);
    trackJoinedOperation(context, pending);
    return pending;
  };
  const client = ((strings: TemplateStringsArray, ...params: unknown[]) => issue(strings.join("?"), () => context.sql(strings, ...params))) as SqlClient;
  client.query = (text, params) => issue(text, () => context.sql.query(text, params));
  client.unsafe = (text, params) => issue(text, () => context.sql.unsafe(text, params));
  client.transaction = (callback: unknown) => {
    const pending = Promise.resolve().then(async () => {
      assertJoinedTransactionScope(context);
      if (typeof callback !== "function") throw joinedTransactionError("Database transactions require an async callback.");
      const result = (callback as (sql: SqlClient) => unknown)(client);
      return Array.isArray(result) ? await Promise.all(result) : await result;
    }).catch((error: unknown) => { context.capability.rollbackOnly ??= { reason: error }; throw error; });
    trackJoinedOperation(context, pending);
    return pending;
  };
  Object.defineProperty(client, "transactionScoped", { value: true });
  return client;
}
function trackJoinedOperation(context: JoinedTransactionContext, pending: Promise<unknown>) {
  context.pending.add(pending);
  void pending.then(() => context.pending.delete(pending), () => context.pending.delete(pending));
}
function assertJoinedTransactionScope(context: JoinedTransactionContext, captured = snapshotDatabaseScope(databaseScope.getStore())): DatabaseScope {
  const outer = context.capability.scope;
  if (context.capability.rollbackOnly) throw context.capability.rollbackOnly.reason;
  if (!context.active || !context.capability.active) throw joinedTransactionError("This managed transaction context is no longer active.");
  if (outer?.kind !== "tenant" || captured?.kind !== "tenant" || captured.tenantId !== outer.tenantId || !captured.actorIds.length || captured.actorIds.some((id) => !outer.actorIds.includes(id))) {
    const error = joinedTransactionError("A joined transaction cannot widen or replace its tenant and actor scope.");
    context.capability.rollbackOnly ??= { reason: error };
    throw error;
  }
  return captured;
}
function joinedTransactionError(message: string, code = "DATABASE_TRANSACTION_CONTEXT_INVALID") { return Object.assign(new Error(message), { code }); }
function assertJoinedStatement(statement: string) {
  assertNotTransactionControlStatement(statement);
  const executable = statement.slice(skipLeadingDatabaseSqlTrivia(statement));
  // Existing memory scope callbacks set a transaction-local access GUC and
  // then read. Statement-level serialization cannot isolate that multi-query
  // protocol, so this pilot refuses every extra setting installer (including
  // schema-qualified/quoted set_config calls) before it touches the connection.
  if (!/^(?:select|insert|update|delete|with)\b/i.test(executable.trimStart()) || /\bset_config\b/i.test(executable)) {
    throw joinedTransactionError("Extra transaction-local scope installers are unavailable in the responsibility audit context.", "DATABASE_TRANSACTION_EXTRA_SCOPE_UNSUPPORTED");
  }
}

export function enterDatabaseTenantContext(tenantId?: string) {
  const normalized = normalizeTenantId(tenantId) || "";
  const existing = databaseScope.getStore();
  if (existing?.kind === "tenant") {
    if (existing.tenantId !== normalized) {
      existing.actorIds = [];
    }
    existing.tenantId = normalized;
    return;
  }
  databaseScope.enterWith({ kind: "tenant", tenantId: normalized, actorIds: [] });
}

export function getDatabaseTenantContext() {
  const scope = databaseScope.getStore();
  return scope?.kind === "tenant" ? scope.tenantId || undefined : undefined;
}

export function enterDatabaseActorContext(
  tenantId: string,
  actorIds: readonly string[],
) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (!normalizedTenantId) {
    throw new Error("A tenant id is required for actor-scoped database work.");
  }
  const normalizedActorIds = normalizeDatabaseActorIds(actorIds);
  const existing = databaseScope.getStore();
  if (existing?.kind === "tenant") {
    existing.tenantId = normalizedTenantId;
    existing.actorIds = normalizedActorIds;
    return;
  }
  databaseScope.enterWith({
    kind: "tenant",
    tenantId: normalizedTenantId,
    actorIds: normalizedActorIds,
  });
}

export function getDatabaseActorContext() {
  const scope = databaseScope.getStore();
  return scope?.kind === "tenant" ? [...scope.actorIds] : [];
}

export function runWithDatabaseTenantScope<T>(
  tenantId: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const normalized = normalizeTenantId(tenantId);
  if (!normalized) {
    throw new Error("A tenant id is required for tenant-scoped database work.");
  }
  const existing = databaseScope.getStore();
  const inheritedActorIds = existing?.kind === "tenant" &&
      existing.tenantId === normalized
    ? existing.actorIds
    : [];
  return Promise.resolve(databaseScope.run({
    kind: "tenant",
    tenantId: normalized,
    actorIds: [...inheritedActorIds],
  }, operation));
}

export function runWithDatabaseActorScope<T>(
  tenantId: string,
  actorIds: readonly string[],
  operation: () => T | Promise<T>,
): Promise<T> {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (!normalizedTenantId) {
    throw new Error("A tenant id is required for actor-scoped database work.");
  }
  return Promise.resolve(databaseScope.run({
    kind: "tenant",
    tenantId: normalizedTenantId,
    actorIds: normalizeDatabaseActorIds(actorIds),
  }, operation));
}

export function withDatabaseRequestScope<
  TArgs extends unknown[],
  TResult,
>(
  handler: (...args: TArgs) => TResult | Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return (...args) => {
    const request = args[0] instanceof Request ? args[0] : undefined;
    return runWithRequestTiming(async () => {
      const result = await databaseScope.run(
        { kind: "tenant", tenantId: "", actorIds: [] },
        () => handler(...args),
      );
      return (
        result instanceof Response
          ? finalizeDatabaseRequestResponse(result, request)
          : result
      ) as TResult;
    }, request);
  };
}

function finalizeDatabaseRequestResponse(
  response: Response,
  request?: Request,
) {
  const timedResponse = appendServerTiming(response, request);
  if (isExplicitPublicHealthSummary(request, timedResponse)) {
    return timedResponse;
  }
  return enforcePrivateNoStore(timedResponse);
}

function isExplicitPublicHealthSummary(
  request: Request | undefined,
  response: Response,
) {
  if (!request) return false;
  const url = new URL(request.url);
  return (
    url.pathname === "/api/health" &&
    url.searchParams.get("public") === "1" &&
    response.headers.get("cache-control")?.startsWith("public,") === true
  );
}

/**
 * Explicit bypass for audited platform maintenance and opaque-record lookup.
 * Callers must supply a human-readable reason; tenant request paths must use
 * runWithDatabaseTenantScope instead.
 */
export function runWithDatabaseSystemScope<T>(
  reason: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const auditReason = reason.trim();
  if (!auditReason) {
    throw new Error("System database scope requires an audit reason.");
  }
  console.info(JSON.stringify({
    level: "info",
    event: "database.system_scope",
    reason: auditReason,
    timestamp: new Date().toISOString(),
  }));
  return Promise.resolve(databaseScope.run({ kind: "system", reason: auditReason }, operation));
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

export const databaseSchemaMigrations: readonly SchemaMigrationRecord[] =
  schemaMigrationManifest.map(({ version, name, checksum }) =>
    Object.freeze({ version, name, checksum }),
  );

/**
 * Versions before this one keep the checksums their ledgers already record.
 * From this version on, a migration is a SQL file whose sha256 is its
 * checksum, so each database records the digest of the file it ran, and a
 * later edit to the file fails schema verification wherever it ran.
 */
const FIRST_FILE_DIGEST_CHECKSUM_VERSION = 208;

/**
 * Settings the runner relies on between migrations. Whatever a SQL file does
 * to these, or to settings it names itself, is put back after the file runs.
 */
const MIGRATION_TRANSACTION_SETTINGS = Object.freeze([
  "lock_timeout",
  "omni.system_reason",
  "omni.system_scope",
  "search_path",
  "statement_timeout",
]);

/**
 * Roles the migration files grant to by name. Deployments create them with
 * their own login and RLS attributes; a database that lacks one gets a
 * placeholder that cannot log in, so every database carries the same grants.
 */
const MIGRATION_GRANTEE_ROLES = Object.freeze([
  "omni_backup",
  "omni_maintenance",
  "omni_runtime",
]);

export function getPendingSchemaMigrationVersions(
  appliedVersions: Iterable<number>,
  options: { allowFutureVersions?: boolean } = {},
) {
  const applied = new Set(Array.from(appliedVersions));
  const knownVersions = new Set(
    databaseSchemaMigrations.map((migration) => migration.version),
  );
  const unknown = [...applied]
    .filter((version) => !knownVersions.has(version))
    .sort((left, right) => left - right);
  const latestKnownVersion = databaseSchemaMigrations.at(-1)?.version || 0;
  const futureVersionsAreContiguous = unknown.every(
    (version, index) => version === latestKnownVersion + index + 1,
  );
  if (
    unknown.length &&
    (!options.allowFutureVersions || !futureVersionsAreContiguous)
  ) {
    throw new Error(
      `Database schema contains unknown migration versions: ${unknown.join(", ")}.`,
    );
  }
  return databaseSchemaMigrations
    .filter((migration) => !applied.has(migration.version))
    .map((migration) => migration.version);
}

export function validateSchemaMigrationMarkers(
  rows: Array<{ version: number; name?: string | null; checksum?: string | null }>,
  options: {
    allowLegacyMissingValues?: boolean;
    allowFutureVersions?: boolean;
  } = {},
) {
  getPendingSchemaMigrationVersions(
    rows.map((row) => Number(row.version)),
    { allowFutureVersions: options.allowFutureVersions },
  );
  const known = new Map(
    databaseSchemaMigrations.map((migration) => [migration.version, migration]),
  );
  const missing: number[] = [];
  for (const row of rows) {
    const expected = known.get(Number(row.version));
    if (!expected) {
      if (
        !options.allowFutureVersions ||
        !row.name?.trim() ||
        !row.checksum ||
        !/^[a-f0-9]{64}$/.test(row.checksum)
      ) {
        throw new Error(
          `Future database migration ${Number(row.version)} is missing integrity metadata.`,
        );
      }
      continue;
    }
    if (row.name && row.name !== expected.name) {
      throw new Error(
        `Database migration ${expected.version} name does not match this release.`,
      );
    }
    if (row.checksum && row.checksum !== expected.checksum) {
      throw new Error(
        `Database migration ${expected.version} checksum does not match this release.`,
      );
    }
    if (!row.name || !row.checksum) {
      if (!options.allowLegacyMissingValues) {
        throw new Error(
          `Database migration ${expected.version} is missing integrity metadata.`,
        );
      }
      missing.push(expected.version);
    }
  }
  return missing;
}

/**
 * The ordered steps that apply schema-migrations.json. A version with a `file`
 * runs that SQL file and every other version runs its TypeScript step; no
 * version has both or neither. Versions that share a file must be adjacent,
 * because the file runs once, as a whole, and must record the same sha256.
 */
export function getSchemaMigrationSteps(
  manifest: readonly SchemaMigrationManifestEntry[] = schemaMigrationManifest,
  typescriptSteps: ReadonlyMap<number, SchemaMigrationUp> = typescriptSchemaMigrations,
): SchemaMigrationStep[] {
  const steps: SchemaMigrationStep[] = [];
  const files = new Set<string>();
  for (const entry of manifest) {
    const migration: SchemaMigrationRecord = Object.freeze({
      version: entry.version,
      name: entry.name,
      checksum: entry.checksum,
    });
    const up = typescriptSteps.get(migration.version);
    if (entry.file && up) {
      throw new Error(
        `Database migration ${migration.version} has both a SQL file and a TypeScript step.`,
      );
    }
    if (up && migration.version >= FIRST_FILE_DIGEST_CHECKSUM_VERSION) {
      throw new Error(
        `Database migration ${migration.version} is a TypeScript step, but every migration from ${FIRST_FILE_DIGEST_CHECKSUM_VERSION} on is a SQL file.`,
      );
    }
    if (up) {
      steps.push({ kind: "typescript", migrations: [migration], up });
      continue;
    }
    if (!entry.file) {
      throw new Error(
        `Database migration ${migration.version} has no SQL file or TypeScript step.`,
      );
    }
    if (!entry.sha256) {
      throw new Error(
        `Database migration ${migration.version} names ${entry.file} without its sha256.`,
      );
    }
    if (
      migration.version >= FIRST_FILE_DIGEST_CHECKSUM_VERSION &&
      migration.checksum !== entry.sha256
    ) {
      throw new Error(
        `Database migration ${migration.version} must use the sha256 of ${entry.file} as its checksum.`,
      );
    }
    const previous = steps.at(-1);
    if (previous?.kind === "sql" && previous.file === entry.file) {
      if (previous.sha256 !== entry.sha256) {
        throw new Error(`${entry.file} has more than one sha256 in schema-migrations.json.`);
      }
      steps[steps.length - 1] = {
        ...previous,
        migrations: [...previous.migrations, migration],
      };
      continue;
    }
    if (files.has(entry.file)) {
      throw new Error(`${entry.file} records database migrations that are not adjacent.`);
    }
    files.add(entry.file);
    steps.push({
      kind: "sql",
      migrations: [migration],
      file: entry.file,
      sha256: entry.sha256,
    });
  }
  const known = new Set(manifest.map((entry) => entry.version));
  const unknown = [...typescriptSteps.keys()].filter((version) => !known.has(version));
  if (unknown.length) {
    throw new Error(
      `TypeScript migration steps ${unknown.join(", ")} are not in schema-migrations.json.`,
    );
  }
  return steps;
}

export async function ensureDatabaseSchema() {
  if (!hasDatabaseUrl()) {
    return;
  }

  if (process.env.NODE_ENV !== "production") {
    return migrateDatabaseSchema();
  }

  if (!schemaReady) {
    schemaReady = verifyDatabaseSchema();
  }

  const pendingSchema = schemaReady;

  try {
    await pendingSchema;
  } catch (error) {
    // Do not let a late rejection from an older verification clear a newer
    // retry that another request has already started.
    if (schemaReady === pendingSchema) {
      schemaReady = null;
    }
    throw error;
  }
}

export async function migrateDatabaseSchema(
  options: { verifyRuntimeRole?: boolean } = {},
) {
  if (!hasDatabaseUrl()) {
    return;
  }

  if (!schemaMigrationReady) {
    const pg = getRawPg();
    schemaMigrationReady = (async () => {
      // A statement that waits too long for a table lock rolls the whole
      // transaction back, and the run starts again from the version check.
      await runWithMigrationLockRetry("Schema migration", () => pg.begin(async (tx) => {
        // Every version check and migration happens under one transaction-scoped
        // advisory lock, including upgrades from the legacy timestamp-only marker.
        await beginMigrationTransaction(tx, "ordered schema migration");
        const sql = wrapPg(tx, true);
        await tx`
          CREATE TABLE IF NOT EXISTS omni_schema_version (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `;
        // Legacy deployments created this table with applied_at only. Keep those
        // rows as historical markers, add real ordered versions, and rerun the
        // idempotent baseline once rather than guessing what was previously run.
        await tx`ALTER TABLE omni_schema_version ADD COLUMN IF NOT EXISTS version INTEGER`;
        await tx`ALTER TABLE omni_schema_version ADD COLUMN IF NOT EXISTS name TEXT`;
        await tx`ALTER TABLE omni_schema_version ADD COLUMN IF NOT EXISTS checksum TEXT`;
        await tx`
          CREATE UNIQUE INDEX IF NOT EXISTS omni_schema_version_version_idx
          ON omni_schema_version (version)
          WHERE version IS NOT NULL
        `;

        const appliedRows = await tx`
          SELECT version, name, checksum
          FROM omni_schema_version
          WHERE version IS NOT NULL
          ORDER BY version ASC
        `;
        const legacyMarkers = validateSchemaMigrationMarkers(
          appliedRows.map((row) => ({
            version: Number(row.version),
            name: row.name ? String(row.name) : null,
            checksum: row.checksum ? String(row.checksum) : null,
          })),
          { allowLegacyMissingValues: true },
        );
        for (const version of legacyMarkers) {
          const migration = databaseSchemaMigrations.find(
            (candidate) => candidate.version === version,
          );
          if (!migration) {
            throw new Error(`Unknown legacy database migration ${version}.`);
          }
          await tx`
            UPDATE omni_schema_version
            SET name = ${migration.name},
                checksum = ${migration.checksum}
            WHERE version = ${migration.version}
              AND (
                NULLIF(name, '') IS NULL
                OR NULLIF(checksum, '') IS NULL
              )
          `;
        }
        const pendingVersions = new Set<number>(
          getPendingSchemaMigrationVersions(appliedRows.map((row) => Number(row.version))),
        );
        if (pendingVersions.size) {
          await ensureMigrationGranteeRoles(tx);
        }

        for (const step of getSchemaMigrationSteps()) {
          const pending = step.migrations.filter((migration) =>
            pendingVersions.has(migration.version),
          );
          if (!pending.length) {
            continue;
          }
          const label = step.migrations
            .map((migration) => `${migration.version} (${migration.name})`)
            .join(", ");
          if (step.kind === "sql" && pending.length !== step.migrations.length) {
            throw new Error(
              `${step.file} records database migrations ${label} together, but only ${pending
                .map((migration) => migration.version)
                .join(", ")} of them ${pending.length === 1 ? "is" : "are"} pending, and the file cannot run in part.`,
            );
          }
          try {
            if (step.kind === "sql") {
              // The file must still have its manifest sha256. It writes its
              // own omni_schema_version rows, and the runner checks them
              // against the manifest.
              await applySqlMigrationFile(
                sql,
                await readSqlMigrationFile(step),
                step.migrations,
                MIGRATION_TRANSACTION_SETTINGS,
              );
            } else {
              await step.up(withMigrationStatementContext(sql));
            }
          } catch (error) {
            throw new Error(
              `Database migration${step.migrations.length > 1 ? "s" : ""} ${label} failed: ${
                error instanceof Error ? error.message : "unknown migration error"
              }`,
              { cause: error },
            );
          }
          if (step.kind === "typescript") {
            const [migration] = step.migrations;
            await tx`
              INSERT INTO omni_schema_version (version, name, checksum, applied_at)
              VALUES (
                ${migration.version},
                ${migration.name},
                ${migration.checksum},
                NOW()
              )
            `;
          }
        }
      }));
      // pgvector is optional acceleration, not a schema-version prerequisite.
      // Run it after the migration transaction so missing extension privileges
      // cannot abort and roll back otherwise-successful ordered migrations.
      try {
        await ensureVectorSchema(pg);
      } catch (error) {
        if (process.env.OMNIAGENT_LOG_PGVECTOR_FAILURES === "true") {
          console.info(
            "pgvector schema unavailable; continuing with JSON embeddings.",
            error instanceof Error ? error.message : error,
          );
        }
      }
      if (options.verifyRuntimeRole !== false) {
        await assertRuntimeDatabaseRoleSafety(pg);
        await assertMaintenanceDatabaseRoleSafety(pg);
      }
    })();
  }

  try {
    await schemaMigrationReady;
    schemaReady = Promise.resolve();
  } catch (error) {
    schemaMigrationReady = null;
    schemaReady = null;
    throw error;
  }
}

function withMigrationStatementContext(sql: SqlClient): SqlClient {
  let statementNumber = 0;
  const runStatement = async <T>(operation: () => Promise<T>) => {
    statementNumber += 1;
    const currentStatement = statementNumber;
    try {
      return await operation();
    } catch (error) {
      throw new Error(
        `migration statement ${currentStatement} failed: ${
          error instanceof Error ? error.message : "unknown statement error"
        }`,
        { cause: error },
      );
    }
  };

  return new Proxy(sql, {
    apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
      return runStatement(() => Reflect.apply(target, thisArg, args));
    },
    get(target, property, receiver) {
      if (property !== "query" && property !== "unsafe") {
        return Reflect.get(target, property, receiver);
      }
      const method = Reflect.get(target, property, target) as (
        text: string,
        params?: unknown[],
      ) => Promise<SqlRow[]>;
      return (text: string, params?: unknown[]) =>
        runStatement(() => method.call(target, text, params));
    },
  });
}

/** Creates, as placeholders, the grantee roles this database lacks. */
export async function ensureMigrationGranteeRoles(
  tx: postgres.TransactionSql<Record<string, never>>,
) {
  const existing = await tx`
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname = ANY(${[...MIGRATION_GRANTEE_ROLES]}::text[])
  `;
  const present = new Set(existing.map((row) => String(row.rolname)));
  for (const role of MIGRATION_GRANTEE_ROLES.filter((name) => !present.has(name))) {
    try {
      await tx.unsafe(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    } catch (error) {
      throw new Error(
        `Database role ${role} does not exist, and the migration role cannot create it. The migrations grant to ${MIGRATION_GRANTEE_ROLES.join(", ")}; create ${role} first, or migrate as a role with CREATEROLE.`,
        { cause: error },
      );
    }
  }
}

async function verifyDatabaseSchema() {
  const pg = getRawPg();
  await verifyDatabaseSchemaWithClient(pg);
  // Every production boot checks the serving role, not only a migration.
  await assertRuntimeDatabaseRoleSafety(
    pg,
    getDatabaseSchemaVerificationTimeoutMs(),
  );
}

/**
 * Checks a database this release has just migrated against the release
 * exactly: its ledger holds every migration in schema-migrations.json, by name
 * and checksum, and none later. A serving release accepts later versions, so
 * that it can run on a schema a newer release migrated. `inspect` then reads
 * the catalog in the same read-only transaction.
 */
export async function verifyMigratedDatabaseSchema<T>(
  inspect: (query: (text: string, params?: unknown[]) => Promise<SqlRow[]>) => Promise<T>,
): Promise<T> {
  return getRawPg().begin("READ ONLY", async (tx) => {
    await verifyDatabaseSchemaWithClient(tx, { allowFutureVersions: false });
    return inspect((text, params) => tx.unsafe(text, (params ?? []) as never[]));
  }) as Promise<T>;
}

export async function verifyDatabaseSchemaWithClient(
  pg: AnyPg,
  { allowFutureVersions = true }: { allowFutureVersions?: boolean } = {},
) {
  let appliedRows: Record<string, unknown>[];
  try {
    const pendingQuery = pg`
      SELECT version, name, checksum
      FROM omni_schema_version
      WHERE version IS NOT NULL
      ORDER BY version ASC
    `;
    appliedRows = await waitForSchemaVerificationQuery(
      pendingQuery,
      getDatabaseSchemaVerificationTimeoutMs(),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "42P01"
    ) {
      throw new Error(
        "Database schema is not initialized. Run the controlled database migration before serving traffic.",
        { cause: error },
      );
    }
    throw error;
  }
  validateSchemaMigrationMarkers(
    appliedRows.map((row) => ({
      version: Number(row.version),
      name: row.name ? String(row.name) : null,
      checksum: row.checksum ? String(row.checksum) : null,
    })),
    { allowFutureVersions },
  );
  const pending = getPendingSchemaMigrationVersions(
    appliedRows.map((row) => Number(row.version)),
    { allowFutureVersions },
  );
  if (pending.length) {
    throw new Error(
      `Database schema is behind (pending versions: ${pending.join(", ")}). ` +
        "Run the controlled database migration before serving this release.",
    );
  }
}

async function waitForSchemaVerificationQuery<T>(
  pendingQuery: PromiseLike<T> | T,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      let cancellationError: unknown;
      const cancel = (
        pendingQuery as { cancel?: () => unknown } | null | undefined
      )?.cancel;
      if (typeof cancel === "function") {
        try {
          const cancellation = cancel.call(pendingQuery);
          if (
            cancellation &&
            typeof (cancellation as PromiseLike<unknown>).then === "function"
          ) {
            void Promise.resolve(cancellation).catch(() => undefined);
          }
        } catch (error) {
          cancellationError = error;
        }
      }

      reject(
        new Error(
          `Database schema verification timed out after ${timeoutMs}ms.`,
          cancellationError === undefined
            ? undefined
            : { cause: cancellationError },
        ),
      );
    }, timeoutMs);

    void Promise.resolve(pendingQuery).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function assertRuntimeDatabaseRoleSafety(
  pg: postgres.Sql,
  timeoutMs?: number,
) {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  const role = await readRuntimeDatabaseRoleSafety(pg, timeoutMs);
  if (!role) {
    throw new Error("Unable to verify the runtime database role.");
  }
  if (role.superuser || role.bypassRls || role.ownsSchema) {
    throw new Error(
      `Unsafe runtime database role ${role.name}: production runtime roles must be non-owner, non-superuser, and unable to BYPASSRLS.`,
    );
  }
}

export async function getRuntimeDatabaseRoleSafety() {
  if (!hasDatabaseUrl()) {
    return {
      configured: false,
      safe: false,
    };
  }
  const role = await readRuntimeDatabaseRoleSafety(getRawPg());
  return {
    configured: true,
    safe: Boolean(
      role &&
      !role.superuser &&
      !role.bypassRls &&
      !role.ownsSchema
    ),
    role,
  };
}

export async function getMaintenanceDatabaseRoleSafety() {
  if (!hasDatabaseUrl() || !hasMaintenanceDatabaseUrl()) {
    return {
      configured: false,
      safe: false,
      sameDatabase: false,
    };
  }
  const runtimeIdentity = await readDatabaseIdentity(getRawPg());
  const maintenancePg = getRawMaintenancePg();
  const maintenanceIdentity = await readDatabaseIdentity(maintenancePg);
  const role = await readRuntimeDatabaseRoleSafety(maintenancePg);
  const sameDatabase = Boolean(
    runtimeIdentity &&
      maintenanceIdentity &&
      runtimeIdentity === maintenanceIdentity,
  );
  return {
    configured: true,
    safe: Boolean(
      role &&
        !role.superuser &&
        role.bypassRls &&
        !role.ownsSchema &&
        sameDatabase,
    ),
    sameDatabase,
    role,
  };
}

async function readRuntimeDatabaseRoleSafety(
  pg: postgres.Sql,
  timeoutMs?: number,
) {
  const query = pg`
    SELECT
      roles.rolname,
      roles.rolsuper,
      roles.rolbypassrls,
      current_user = pg_get_userbyid(schema_table.relowner) AS owns_schema
    FROM pg_roles roles
    CROSS JOIN pg_class schema_table
    WHERE roles.rolname = current_user
      AND schema_table.oid = 'omni_schema_version'::regclass
    LIMIT 1
  `;
  const rows = timeoutMs === undefined
    ? await query
    : await waitForSchemaVerificationQuery(query, timeoutMs);
  const role = rows[0];
  if (!role) {
    return undefined;
  }
  return {
    name: String(role.rolname),
    superuser: Boolean(role.rolsuper),
    bypassRls: Boolean(role.rolbypassrls),
    ownsSchema: Boolean(role.owns_schema),
  };
}

async function assertMaintenanceDatabaseRoleSafety(runtimePg: postgres.Sql) {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (!hasMaintenanceDatabaseUrl()) {
    throw new Error(
      "OMNIAGENT_MAINTENANCE_DATABASE_URL is required in production for audited all-tenant and opaque-identity database work.",
    );
  }
  const runtimeIdentity = await readDatabaseIdentity(runtimePg);
  const runtimeRole = await readRuntimeDatabaseRoleSafety(runtimePg);
  const maintenancePg = getRawMaintenancePg();
  const maintenanceIdentity = await readDatabaseIdentity(maintenancePg);
  const maintenanceRole = await readRuntimeDatabaseRoleSafety(maintenancePg);
  if (
    !runtimeIdentity ||
    !maintenanceIdentity ||
    runtimeIdentity !== maintenanceIdentity
  ) {
    throw new Error(
      "DATABASE_URL and OMNIAGENT_MAINTENANCE_DATABASE_URL must identify the same Asael database.",
    );
  }
  if (
    !maintenanceRole ||
    maintenanceRole.superuser ||
    !maintenanceRole.bypassRls ||
    maintenanceRole.ownsSchema ||
    maintenanceRole.name === runtimeRole?.name
  ) {
    throw new Error(
      "The production maintenance database role must be a dedicated non-owner, non-superuser role with BYPASSRLS.",
    );
  }
}

async function readDatabaseIdentity(pg: postgres.Sql) {
  const rows = await pg`
    SELECT id
    FROM omni_database_identity
    WHERE singleton = TRUE
    LIMIT 1
  `;
  return rows[0]?.id ? String(rows[0].id) : undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Use a permissive internal type to avoid fighting postgres's complex generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPg = any;

function getRawPg(): postgres.Sql {
  if (!hasDatabaseUrl()) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!sqlClient) {
    sqlClient = createPostgresClient(process.env.DATABASE_URL!, "DATABASE_URL");
  }

  return sqlClient;
}

function getRawMaintenancePg(): postgres.Sql {
  const databaseUrl = process.env.OMNIAGENT_MAINTENANCE_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("OMNIAGENT_MAINTENANCE_DATABASE_URL is not configured.");
  }
  if (!maintenanceSqlClient) {
    maintenanceSqlClient = createPostgresClient(
      databaseUrl,
      "OMNIAGENT_MAINTENANCE_DATABASE_URL",
    );
  }
  return maintenanceSqlClient;
}

function createPostgresClient(databaseUrl: string, label: string) {
  const client = postgres(databaseUrl, {
    prepare: false, // required for Supabase transaction-mode pooler (Supavisor)
    ssl: databaseSslConfiguration(databaseUrl, label),
    max: getDatabasePoolMax(),
    idle_timeout: getDatabasePoolIdleTimeoutSeconds(),
    max_lifetime: null,
    connect_timeout: 10,
    onclose: () => {
      retireClosedDatabaseClient(client, label);
    },
    // Under prepare:false (required by the pooler) the driver returns json/jsonb
    // columns as raw strings instead of parsed values. Parse them back to objects/
    // arrays here so every store reads structured data, not strings. Non-JSON
    // columns and already-parsed values pass through untouched.
    transform: {
      value: {
        from: (value: unknown, column?: { type?: number }) => {
          if (
            typeof value === "string" &&
            column &&
            (column.type === 114 /* json */ ||
              column.type === 3802 /* jsonb */)
          ) {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          }
          return value;
        },
      },
    },
  });
  getDatabasePoolLifecycle(client);
  return client;
}

function databaseSslConfiguration(databaseUrl: string, label: string) {
  let sslMode: string | null | undefined;
  try {
    sslMode = new URL(databaseUrl).searchParams
      .get("sslmode")
      ?.toLowerCase();
  } catch {
    // Let the database client report malformed connection URLs.
    return "require" as const;
  }
  if (sslMode === "disable") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`${label} cannot disable TLS in production.`);
    }
    return false;
  }
  if (sslMode === "verify-full") {
    return "verify-full" as const;
  }
  return "require" as const;
}

// Wraps a postgres.Sql instance (or transaction-scoped sql) into our SqlClient
// shape, adding the .query() alias expected by helpers throughout this file.
function wrapPg(pg: AnyPg, transactionScoped = false): SqlClient {
  // postgres.js tagged queries use the extended protocol even with prepared
  // statement caching disabled; interpolations remain bound parameters.
  const client = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    pg(strings, ...params)) as unknown as SqlClient;

  client.query = (text: string, params?: unknown[]) =>
    pg.unsafe(text, params ?? []);

  client.unsafe = (text: string, params?: unknown[]) =>
    pg.unsafe(text, params ?? []);

  client.transaction = () => {
    throw new Error("Use getSql().transaction() for external transactions.");
  };
  Object.defineProperty(client, "transactionScoped", {
    value: transactionScoped,
    enumerable: false,
  });

  return client;
}

// Tenant-scoped client: each operation applies the current tenant or explicit
// system scope with SET LOCAL so pooled connections cannot leak scope.
function createTenantScopedSqlClient(
  pg: AnyPg,
  scopeAlreadyApplied = false,
  resolvePool?: () => AnyPg,
): SqlClient {
  async function withTenant<T>(
    fn: (sql: AnyPg) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      if (scopeAlreadyApplied) {
        const capability = managedTransactionCapabilities.get(scoped);
        if (capability?.joined && joinedStatementDispatch.getStore() !== capability) {
          const error = joinedTransactionError("Use the joined client while its scoped transaction context is active.");
          capability.rollbackOnly ??= { reason: error };
          throw error;
        }
        if (capability) capability.inFlight += 1;
        try { return await fn(pg); }
        finally { if (capability) capability.inFlight -= 1; }
      }
      const scope = snapshotDatabaseScope(databaseScope.getStore());
      const execute = (pool: AnyPg) =>
        withReservedDatabaseTransaction(pool, scope, fn);
      const initialPool = await resolveSchemaReadyDatabasePool(pg, resolvePool);
      try {
        return await execute(initialPool);
      } catch (error) {
        if (
          !resolvePool ||
          !isExactDatabaseConnectionClosedError(error) ||
          !getDatabasePoolLifecycle(initialPool).retired
        ) {
          throw error;
        }
        const replacementPool = await resolveSchemaReadyDatabasePool(
          pg,
          resolvePool,
        );
        if (
          replacementPool === initialPool ||
          getDatabasePoolLifecycle(replacementPool).retired
        ) {
          throw error;
        }
        // The implicit transaction contains exactly one caller statement. A
        // close before COMMIT is known to have abandoned that transaction, so
        // it is safe to make one attempt on the replacement generation. The
        // explicit callback transaction below deliberately has no such retry.
        return execute(replacementPool);
      }
    } finally {
      recordDatabaseTiming(performance.now() - startedAt, mutation);
    }
  }

  const scoped = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    withTenant(
      (sql: AnyPg) => sql(strings, ...params),
      isDatabaseMutation(strings.join(" ")),
    )) as unknown as SqlClient;

  scoped.query = (text: string, params?: unknown[]) =>
    withTenant(
      (sql: AnyPg) => sql.unsafe(text, params ?? []),
      isDatabaseMutation(text),
    );

  scoped.unsafe = (text: string, params?: unknown[]) =>
    withTenant(
      (sql: AnyPg) => sql.unsafe(text, params ?? []),
      isDatabaseMutation(text),
    );

  Object.defineProperty(scoped, "transactionScoped", {
    value: scopeAlreadyApplied,
    enumerable: false,
  });

  // Only callback transactions are safe here. Promise arrays begin executing
  // before pg.begin can apply tenant scope and therefore cannot be atomic.
  scoped.transaction = (queriesOrFn: unknown) => {
    const parentCapability = managedTransactionCapabilities.get(scoped);
    if (parentCapability?.joined) {
      const error = joinedTransactionError("Use getSql().transaction() to join this active context.");
      parentCapability.rollbackOnly ??= { reason: error };
      return Promise.reject(error);
    }
    const scope = snapshotDatabaseScope(databaseScope.getStore());
    if (typeof queriesOrFn !== "function") {
      throw new Error("Database transactions require an async callback.");
    }
    return (async () => {
      const transactionPool = await resolveSchemaReadyDatabasePool(
        pg,
        resolvePool,
      );
      return withReservedDatabaseTransaction(transactionPool, scope, async (tx) => {
        const txScoped = createTenantScopedSqlClient(tx, true);
        const capability: ManagedTransactionCapability = { active: true, scope, joined: false, inFlight: 0 };
        managedTransactionCapabilities.set(txScoped, capability);
        try {
          const result = (queriesOrFn as (s: SqlClient) => unknown)(txScoped);
          const settled = Array.isArray(result) ? await Promise.all(result) : await result;
          if (capability.joined) capability.rollbackOnly ??= { reason: joinedTransactionError("The owner callback returned while an adopted transaction was active.", "DATABASE_RESERVATION_INFLIGHT") };
          if (capability.rollbackOnly) throw capability.rollbackOnly.reason;
          return settled;
        } finally {
          capability.active = false;
          managedTransactionCapabilities.delete(txScoped);
        }
      });
    })();
  };

  return scoped;
}

async function resolveSchemaReadyDatabasePool(
  transactionPool: AnyPg,
  resolvePool?: () => AnyPg,
) {
  if (!resolvePool) return transactionPool;

  while (true) {
    // Unit pool tests opt in by stubbing a runtime environment. Application
    // runtimes, including development, must finish schema readiness before the
    // admission gate can reserve their only connection.
    if (process.env.NODE_ENV === "test") {
      const selectedPool = resolvePool();
      if (
        getDatabasePoolLifecycle(selectedPool).retired ||
        resolvePool() !== selectedPool
      ) {
        continue;
      }
      return selectedPool;
    }

    let readiness: Promise<void> | null;
    let pendingReadiness: Promise<void>;
    if (process.env.NODE_ENV === "production" || !schemaReady) {
      pendingReadiness = ensureDatabaseSchema();
      readiness = schemaReady;
    } else {
      readiness = schemaReady;
      pendingReadiness = readiness;
    }
    const selectedPool = resolvePool();
    await pendingReadiness;

    // A waiter can resume from an already-resolved readiness promise after the
    // runtime generation retired and a new verification began. Accept neither
    // a readiness promise nor a pool generation that changed while waiting.
    if (
      !readiness ||
      schemaReady !== readiness ||
      getDatabasePoolLifecycle(selectedPool).retired
    ) {
      continue;
    }
    if (resolvePool() !== selectedPool || schemaReady !== readiness) continue;
    return selectedPool;
  }
}

function snapshotDatabaseScope(
  scope: DatabaseScope | undefined,
): DatabaseScope | undefined {
  if (scope?.kind === "tenant") {
    return {
      kind: "tenant",
      tenantId: scope.tenantId,
      actorIds: [...scope.actorIds],
    };
  }
  if (scope?.kind === "system") {
    return { kind: "system", reason: scope.reason };
  }
  return undefined;
}

function isExactDatabaseConnectionClosedError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "DATABASE_CONNECTION_CLOSED",
  );
}

async function withReservedDatabaseConnection<T>(
  pg: AnyPg,
  operation: (
    reserved: AnyPg,
    lease: DatabaseReservationLease,
  ) => Promise<T>,
): Promise<T> {
  const { reserved, releaseAdmission } = await reserveDatabaseConnection(pg);
  const lifecycle = getDatabasePoolLifecycle(pg);
  const lease: DatabaseReservationLease = {
    state: "active",
    inFlightUserOperations: new Set(),
    watchdog: createInactiveDatabaseReservationWatchdog(),
  };
  lifecycle.leases.add(lease);
  lease.watchdog = startDatabaseReservationWatchdog(pg, lease);
  try {
    return await settleOnDatabasePoolRetirement(
      pg,
      Promise.resolve().then(() => operation(reserved, lease)),
      lease,
    );
  } finally {
    lease.watchdog.stop();
    lifecycle.leases.delete(lease);
    if (lifecycle.retired) {
      lease.state = "retired";
    } else if (lease.state !== "settled") {
      lease.state = "settled";
    }
    releaseReservedDatabaseConnection(pg, reserved);
    releaseAdmission();
  }
}

function createDatabaseReservationUserClient(
  pg: AnyPg,
  reserved: AnyPg,
  lease: DatabaseReservationLease,
) {
  const execute = <T>(operation: () => Promise<T> | T): Promise<T> => {
    try {
      assertDatabaseReservationUserOperation(pg, lease);
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = settleOnDatabasePoolRetirement(
      pg,
      Promise.resolve().then(() => {
        assertDatabaseReservationUserOperation(pg, lease);
        return operation();
      }),
      lease,
    );
    lease.inFlightUserOperations.add(pending);
    void pending.then(
      () => {
        lease.inFlightUserOperations.delete(pending);
        lease.watchdog.refresh();
      },
      () => lease.inFlightUserOperations.delete(pending),
    );
    return pending;
  };
  const client = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    execute(() => {
      assertNotTransactionControlStatement(strings.join(" "));
      return reserved(strings, ...params);
    })) as AnyPg;
  client.unsafe = (text: string, params?: unknown[]) => execute(() => {
    assertNotTransactionControlStatement(text);
    return reserved.unsafe(
      text,
      params ?? [],
      DATABASE_SINGLE_STATEMENT_QUERY_OPTIONS,
    );
  });
  client.query = (text: string, params?: unknown[]) => execute(() => {
    assertNotTransactionControlStatement(text);
    return reserved.unsafe(
      text,
      params ?? [],
      DATABASE_SINGLE_STATEMENT_QUERY_OPTIONS,
    );
  });
  return client;
}

async function withReservedDatabaseTransaction<T>(
  pg: AnyPg,
  scope: DatabaseScope | undefined,
  operation: (reserved: AnyPg) => Promise<T>,
): Promise<T> {
  return withReservedDatabaseConnection(pg, async (reserved, lease) => {
    // The deletion barrier relies on a fresh statement snapshot after a
    // writer waits for the tenant graph lock. Pin managed transactions to
    // READ COMMITTED as they begin, before applyDatabaseScope performs its
    // first SELECT; inherited REPEATABLE READ/SERIALIZABLE defaults could
    // otherwise retain a pre-forget snapshot and resurrect descendant lineage.
    const begin = executeDatabaseReservationControl(
      pg,
      reserved,
      lease,
      "active",
      "BEGIN ISOLATION LEVEL READ COMMITTED",
    );
    const userClient = createDatabaseReservationUserClient(pg, reserved, lease);
    // The scope follows BEGIN on the connection without waiting for its
    // reply, so both share one round trip. The driver writes queries in the
    // order they are issued; if BEGIN fails, the scope ran on its own and its
    // transaction-local settings ended with it.
    const [begun, scoped] = await Promise.allSettled([
      begin,
      applyDatabaseScope(userClient, scope),
    ]);
    if (begun.status === "rejected") throw begun.reason;
    let result: T;
    try {
      if (scoped.status === "rejected") throw scoped.reason;
      result = await operation(userClient);
      assertNoInFlightDatabaseReservationOperations(pg, lease);
    } catch (error) {
      await rollbackDatabaseReservation(pg, reserved, lease);
      throw error;
    }
    transitionDatabaseReservation(pg, lease, "active", "committing");
    try {
      await executeDatabaseReservationControl(
        pg,
        reserved,
        lease,
        "committing",
        "COMMIT",
      );
      lease.state = "settled";
      return result;
    } catch (error) {
      if (isDatabaseConnectionClassError(error)) {
        const unknownOutcome = databaseCommitOutcomeUnknownError(
          error instanceof Error ? error : new Error(String(error)),
        );
        retireDatabaseClient(
          pg,
          databaseConnectionClosedError("Database"),
          { ownerLease: lease, ownerError: unknownOutcome },
        );
        throw unknownOutcome;
      }
      await rollbackDatabaseReservation(pg, reserved, lease);
      throw error;
    }
  });
}

async function executeDatabaseReservationControl(
  pg: AnyPg,
  reserved: AnyPg,
  lease: DatabaseReservationLease,
  requiredState: DatabaseReservationLeaseState,
  statement: string,
) {
  assertDatabaseReservationState(pg, lease, requiredState);
  const result = await settleOnDatabasePoolRetirement(
    pg,
    Promise.resolve().then(() => {
      assertDatabaseReservationState(pg, lease, requiredState);
      return reserved.unsafe(statement);
    }),
    lease,
  );
  lease.watchdog.refresh();
  return result;
}

async function rollbackDatabaseReservation(
  pg: AnyPg,
  reserved: AnyPg,
  lease: DatabaseReservationLease,
) {
  const lifecycle = getDatabasePoolLifecycle(pg);
  if (
    lifecycle.retired ||
    lease.state === "retired" ||
    lease.state === "settled"
  ) {
    return;
  }
  if (lease.state !== "active" && lease.state !== "committing") {
    return;
  }
  lease.state = "rolling_back";
  try {
    await executeDatabaseReservationControl(
      pg,
      reserved,
      lease,
      "rolling_back",
      "ROLLBACK",
    );
  } catch {
    // Preserve the original operation/commit error. A close retires the pool;
    // another rollback failure leaves this exact generation unavailable.
  } finally {
    lease.state = getDatabasePoolLifecycle(pg).retired ? "retired" : "settled";
  }
}

function transitionDatabaseReservation(
  pg: AnyPg,
  lease: DatabaseReservationLease,
  from: DatabaseReservationLeaseState,
  to: DatabaseReservationLeaseState,
) {
  assertDatabaseReservationState(pg, lease, from);
  lease.state = to;
}

function assertDatabaseReservationUserOperation(
  pg: AnyPg,
  lease: DatabaseReservationLease,
) {
  assertDatabaseReservationState(pg, lease, "active");
}

function assertNoInFlightDatabaseReservationOperations(
  pg: AnyPg,
  lease: DatabaseReservationLease,
) {
  assertDatabaseReservationState(pg, lease, "active");
  if (lease.inFlightUserOperations.size > 0) {
    throw Object.assign(
      new Error(
        "A database transaction callback returned while a query was still running.",
      ),
      { code: "DATABASE_RESERVATION_INFLIGHT" },
    );
  }
}

function assertDatabaseReservationState(
  pg: AnyPg,
  lease: DatabaseReservationLease,
  requiredState: DatabaseReservationLeaseState,
) {
  const lifecycle = getDatabasePoolLifecycle(pg);
  if (lifecycle.retired || lease.state === "retired") {
    throw lease.retirementError ||
      lifecycle.retirementError ||
      databaseConnectionClosedError("Database");
  }
  if (lease.state !== requiredState) {
    throw Object.assign(
      new Error("The database reservation is no longer active for this operation."),
      { code: "DATABASE_RESERVATION_INACTIVE" },
    );
  }
}

function assertNotTransactionControlStatement(statement: string) {
  // Raw calls use the extended protocol below, so PostgreSQL itself rejects
  // batches before executing any statement. This local guard only has to fence
  // a single transaction-control statement, after leading comments.
  const executable = statement.slice(skipLeadingDatabaseSqlTrivia(statement));
  if (
    /^(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|set\s+transaction)\b/i
      .test(executable.trimStart())
  ) {
    throw new Error(
      "Transaction control is reserved for the database reservation manager.",
    );
  }
}

function skipLeadingDatabaseSqlTrivia(statement: string) {
  let index = 0;
  while (index < statement.length) {
    while (/\s/.test(statement[index] || "")) index += 1;
    if (statement.startsWith("--", index)) {
      index += 2;
      while (
        index < statement.length &&
        statement[index] !== "\n" &&
        statement[index] !== "\r"
      ) {
        index += 1;
      }
      continue;
    }
    if (statement.startsWith("/*", index)) {
      index = skipNestedDatabaseBlockComment(statement, index);
      continue;
    }
    break;
  }
  return index;
}

function skipNestedDatabaseBlockComment(statement: string, start: number) {
  let depth = 1;
  let index = start + 2;
  while (index < statement.length && depth > 0) {
    if (statement.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (statement.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

type DatabaseAdmissionGate = {
  active: number;
  capacity: number;
  retired: boolean;
  retirementError?: Error;
  waiters: DatabaseAdmissionWaiter[];
};

type DatabaseAdmissionWaiter = {
  canceled: boolean;
  fail: (error: Error) => boolean;
  grant: () => boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type DatabaseAdmissionPermit = {
  release: () => void;
};

type DatabaseReservationLeaseState =
  | "active"
  | "committing"
  | "rolling_back"
  | "retired"
  | "settled";

type DatabaseReservationLease = {
  state: DatabaseReservationLeaseState;
  inFlightUserOperations: Set<Promise<unknown>>;
  retirementError?: Error;
  watchdog: DatabaseReservationWatchdog;
};

type DatabaseReservationWatchdog = {
  refresh: () => void;
  stop: () => void;
};

const databaseAdmissionGates = new WeakMap<object, DatabaseAdmissionGate>();

type DatabasePoolLifecycle = {
  retired: boolean;
  retirementError?: Error;
  listeners: Set<(error: Error) => void>;
  leases: Set<DatabaseReservationLease>;
};

const databasePoolLifecycles = new WeakMap<object, DatabasePoolLifecycle>();

function databaseAcquireTimeoutError(timeoutMs: number) {
  return Object.assign(
    new Error(
      `Database connection acquisition timed out after ${timeoutMs}ms.`,
    ),
    { code: "DATABASE_ACQUIRE_TIMEOUT" },
  );
}

function databaseReservationTimeoutError(
  timeoutMs: number,
  lease: DatabaseReservationLease,
) {
  if (lease.state === "committing") {
    return Object.assign(
      new Error(
        `Database commit timed out after ${timeoutMs}ms. Its outcome is unknown; automatic retry is forbidden.`,
      ),
      { code: "DATABASE_COMMIT_OUTCOME_UNKNOWN", retryable: false },
    );
  }
  return Object.assign(
    new Error(
      `Database reserved operation made no progress for ${timeoutMs}ms. Its transaction outcome is unknown; automatic retry is forbidden.`,
    ),
    { code: "DATABASE_RESERVATION_TIMEOUT", retryable: false },
  );
}

function startDatabaseReservationWatchdog(
  pg: AnyPg,
  lease: DatabaseReservationLease,
): DatabaseReservationWatchdog {
  const timeoutMs = getDatabaseReservationTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const refresh = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      const ownerError = databaseReservationTimeoutError(timeoutMs, lease);
      retireDatabaseClient(
        pg,
        databasePoolRetiredError("reservation watchdog expired"),
        { ownerLease: lease, ownerError },
      );
    }, timeoutMs);
  };
  refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function createInactiveDatabaseReservationWatchdog(): DatabaseReservationWatchdog {
  return {
    refresh: () => undefined,
    stop: () => undefined,
  };
}

function getDatabaseAdmissionGate(pg: AnyPg): DatabaseAdmissionGate {
  const key = pg as object;
  const existing = databaseAdmissionGates.get(key);
  if (existing) return existing;

  const gate = {
    active: 0,
    capacity: getDatabasePoolMax(),
    retired: false,
    waiters: [],
  } satisfies DatabaseAdmissionGate;
  databaseAdmissionGates.set(key, gate);
  return gate;
}

function getDatabasePoolLifecycle(pg: AnyPg): DatabasePoolLifecycle {
  const key = pg as object;
  const existing = databasePoolLifecycles.get(key);
  if (existing) return existing;
  const lifecycle = {
    retired: false,
    listeners: new Set<(error: Error) => void>(),
    leases: new Set<DatabaseReservationLease>(),
  } satisfies DatabasePoolLifecycle;
  databasePoolLifecycles.set(key, lifecycle);
  return lifecycle;
}

function settleOnDatabasePoolRetirement<T>(
  pg: AnyPg,
  operation: Promise<T>,
  lease?: DatabaseReservationLease,
): Promise<T> {
  const lifecycle = getDatabasePoolLifecycle(pg);
  if (lifecycle.retired) {
    // The caller may already have constructed a fenced promise. Observe its
    // rejection even though the generation-level error takes precedence.
    void operation.catch(() => undefined);
    return Promise.reject(
      lease?.retirementError ||
        lifecycle.retirementError ||
        databaseConnectionClosedError("Database"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => lifecycle.listeners.delete(onRetired);
    const onRetired = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(lease?.retirementError || error);
    };
    lifecycle.listeners.add(onRetired);
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    // Defend against future refactors that can retire the generation while a
    // listener is being installed. The current implementation is synchronous,
    // but the second check keeps the contract explicit.
    if (lifecycle.retired) {
      onRetired(
        lease?.retirementError ||
          lifecycle.retirementError ||
          databaseConnectionClosedError("Database"),
      );
    }
  });
}

function createDatabaseAdmissionPermit(
  gate: DatabaseAdmissionGate,
): DatabaseAdmissionPermit {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      gate.active = Math.max(0, gate.active - 1);
      drainDatabaseAdmissionGate(gate);
    },
  };
}

function drainDatabaseAdmissionGate(gate: DatabaseAdmissionGate) {
  if (gate.retired) {
    const error =
      gate.retirementError || databaseAcquireTimeoutError(getDatabaseAcquireTimeoutMs());
    while (gate.waiters.length > 0) {
      gate.waiters.shift()?.fail(error);
    }
    return;
  }
  while (gate.active < gate.capacity && gate.waiters.length > 0) {
    const waiter = gate.waiters.shift();
    if (!waiter || waiter.canceled) continue;
    if (!waiter.grant()) continue;
    gate.active += 1;
  }
}

function acquireDatabaseAdmission(
  pg: AnyPg,
  deadline: number,
  timeoutMs: number,
): Promise<DatabaseAdmissionPermit> {
  const gate = getDatabaseAdmissionGate(pg);
  if (gate.retired) {
    return Promise.reject(
      gate.retirementError || databaseAcquireTimeoutError(timeoutMs),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const waiter: DatabaseAdmissionWaiter = {
      canceled: false,
      fail: (error) => {
        if (settled) return false;
        settled = true;
        waiter.canceled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        reject(error);
        return true;
      },
      grant: () => {
        if (settled || Date.now() >= deadline) {
          waiter.fail(databaseAcquireTimeoutError(timeoutMs));
          return false;
        }
        settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve(createDatabaseAdmissionPermit(gate));
        return true;
      },
    };

    if (gate.active < gate.capacity && waiter.grant()) {
      gate.active += 1;
      return;
    }
    if (settled) return;

    gate.waiters.push(waiter);
    waiter.timer = setTimeout(() => {
      const waiterIndex = gate.waiters.indexOf(waiter);
      if (waiterIndex >= 0) gate.waiters.splice(waiterIndex, 1);
      waiter.fail(databaseAcquireTimeoutError(timeoutMs));
    }, Math.max(0, deadline - Date.now()));
  });
}

async function reserveDatabaseConnection(pg: AnyPg): Promise<{
  reserved: AnyPg;
  releaseAdmission: () => void;
}> {
  const timeoutMs = getDatabaseAcquireTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const admission = await acquireDatabaseAdmission(pg, deadline, timeoutMs);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    admission.release();
    throw databaseAcquireTimeoutError(timeoutMs);
  }
  const pendingReservation = settleOnDatabasePoolRetirement(
    pg,
    Promise.resolve().then(() => pg.reserve()),
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutError = databaseAcquireTimeoutError(timeoutMs);
      retireTimedOutDatabaseClient(pg, timeoutError);
      reject(timeoutError);
    }, remainingMs);

    void pendingReservation.then(
      (reserved) => {
        if (settled || Date.now() >= deadline) {
          // postgres.js does not expose cancellation for a queued reserve(). If
          // the pool grants this slot after our deadline, release it immediately
          // so a timed-out request cannot permanently consume pool capacity.
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const timeoutError = databaseAcquireTimeoutError(timeoutMs);
            retireTimedOutDatabaseClient(pg, timeoutError);
            reject(timeoutError);
          }
          releaseReservedDatabaseConnection(pg, reserved);
          admission.release();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ reserved, releaseAdmission: admission.release });
      },
      (error) => {
        admission.release();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          Date.now() >= deadline
            ? databaseAcquireTimeoutError(timeoutMs)
            : error,
        );
      },
    );
  });
}

function retireTimedOutDatabaseClient(pg: AnyPg, error: Error) {
  // A postgres.js reserve cannot be canceled independently. In any runtime, a
  // reserve caught behind a connection close can otherwise retain its admission
  // permit indefinitely. Rotate only the exact generation whose driver
  // reservation failed to settle; admission waiters never reach this path and
  // cannot retire valid owner work.
  retireDatabaseClient(pg, error);
}

function retireClosedDatabaseClient(pg: AnyPg, label: string) {
  const lifecycle = getDatabasePoolLifecycle(pg);
  const gate = databaseAdmissionGates.get(pg as object);
  const hasActiveGenerationWork =
    lifecycle.leases.size > 0 ||
    lifecycle.listeners.size > 0 ||
    Boolean(gate && (gate.active > 0 || gate.waiters.length > 0));
  if (!hasActiveGenerationWork) {
    // With local idle/lifetime timers disabled, an idle upstream close can be
    // reconnected by postgres.js without replacing the application generation.
    return;
  }
  retireDatabaseClient(pg, databaseConnectionClosedError(label));
}

function retireDatabaseClient(
  pg: AnyPg,
  error: Error,
  options: DatabasePoolRetirementOptions = {},
) {
  const runtimeClientRetired = sqlClient === pg;
  const maintenanceClientRetired = maintenanceSqlClient === pg;
  if (!runtimeClientRetired && !maintenanceClientRetired) return;
  const lifecycle = getDatabasePoolLifecycle(pg);
  if (lifecycle.retired) return;

  retireDatabasePoolLifecycle(pg, error, options);
  retireDatabaseAdmissionGate(pg, error);

  if (runtimeClientRetired) {
    sqlClient = null;
    scopedSqlClient = null;
    schemaReady = null;
  }
  if (maintenanceClientRetired) {
    maintenanceSqlClient = null;
    maintenanceScopedSqlClient = null;
  }

  try {
    // timeout: 0 makes postgres.js destroy the old pool and reject queued
    // reservations. Their existing rejection handlers release the admission
    // permits; the next getSql() call builds a fresh client and gate.
    void Promise.resolve(pg.end({ timeout: 0 })).catch(() => undefined);
  } catch {
    // The singleton is already detached. Preserve the acquisition-timeout
    // error even if a mocked or damaged client throws while being retired.
  }
}

type DatabasePoolRetirementOptions = {
  ownerLease?: DatabaseReservationLease;
  ownerError?: Error;
};

function retireDatabasePoolLifecycle(
  pg: AnyPg,
  error: Error,
  options: DatabasePoolRetirementOptions,
) {
  const lifecycle = getDatabasePoolLifecycle(pg);
  if (lifecycle.retired) return;
  lifecycle.retired = true;
  lifecycle.retirementError = error;
  for (const lease of lifecycle.leases) {
    const leaseState = lease.state;
    lease.retirementError =
      lease === options.ownerLease && options.ownerError
        ? options.ownerError
        : leaseState === "committing"
          ? databaseCommitOutcomeUnknownError(error)
          : error;
    lease.state = "retired";
    lease.watchdog.stop();
  }
  const listeners = [...lifecycle.listeners];
  lifecycle.listeners.clear();
  for (const listener of listeners) {
    listener(error);
  }
}

function retireDatabaseAdmissionGate(pg: AnyPg, error: Error) {
  const gate = databaseAdmissionGates.get(pg as object);
  if (!gate || gate.retired) return;
  gate.retired = true;
  gate.retirementError = error;
  while (gate.waiters.length > 0) {
    gate.waiters.shift()?.fail(error);
  }
}

function releaseReservedDatabaseConnection(pg: AnyPg, reserved: AnyPg) {
  if (getDatabasePoolLifecycle(pg).retired) {
    // postgres.js reserve handles retain their captured connection. Calling
    // release after onclose can move that closed connection back into the open
    // queue and strand the next query. The retired pool owns final cleanup.
    return;
  }
  try {
    reserved.release();
  } catch {
    // A closed/broken connection is already unavailable to the pool. Never let
    // release cleanup replace the query result or the acquisition-timeout error.
  }
}

function databaseConnectionClosedError(label: string) {
  return Object.assign(
    new Error(`${label} database connection closed; its pool was retired.`),
    { code: "DATABASE_CONNECTION_CLOSED" },
  );
}

function databasePoolRetiredError(reason: string) {
  return Object.assign(
    new Error(`The database pool was retired because ${reason}.`),
    { code: "DATABASE_POOL_RETIRED" },
  );
}

function databaseCommitOutcomeUnknownError(cause: Error) {
  return Object.assign(
    new Error(
      "The database connection failed while COMMIT was in flight. Its outcome is unknown; automatic retry is forbidden.",
      { cause },
    ),
    { code: "DATABASE_COMMIT_OUTCOME_UNKNOWN", retryable: false },
  );
}

function isDatabaseConnectionClassError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error
    ? String(error.code).trim().toUpperCase()
    : "";
  return (
    /^08[A-Z0-9]{3}$/.test(code) ||
    code.startsWith("CONNECTION_") ||
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETDOWN",
      "ENETRESET",
      "ENETUNREACH",
      "EPIPE",
      "ETIMEDOUT",
    ].includes(code)
  );
}

export function isDatabaseMutation(statement: string) {
  const executableSql = statement
    .replace(
      /\$([A-Za-z_][A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g,
      " ",
    )
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/'(?:''|[^'])*'/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
  if (
    /^\s*(?:insert|update|delete|merge|alter|create|drop|truncate|grant|revoke)\b/i.test(
      executableSql,
    )
  ) {
    return true;
  }
  return (
    /^\s*with\b/i.test(executableSql) &&
    /\b(?:insert\s+into|update\s+[\w".]+|delete\s+from|merge\s+into)\b/i.test(
      executableSql,
    )
  );
}

export async function applyDatabaseScope(sql: AnyPg, scope?: DatabaseScope) {
  const systemScope = scope?.kind === "system";
  const tenantId = systemScope ? "" : scope?.tenantId || "";
  const actorScope = systemScope
    ? ""
    : JSON.stringify({
        version: 1,
        tenantId,
        actorIds: scope?.kind === "tenant" ? scope.actorIds || [] : [],
      });
  const systemReason = systemScope ? scope.reason : "";
  const statementTimeoutMs = getDatabaseStatementTimeoutMs();
  const lockTimeoutMs = getDatabaseLockTimeoutMs(statementTimeoutMs);
  const idleTransactionTimeoutMs = getDatabaseIdleTransactionTimeoutMs();
  await sql`
    SELECT
      set_config('omni.tenant_id', ${tenantId}, true),
      set_config('omni.actor_scope_v1', ${actorScope}, true),
      set_config('omni.system_scope', ${systemScope ? "true" : "false"}, true),
      set_config('omni.system_reason', ${systemReason}, true),
      set_config('standard_conforming_strings', 'on', true),
      set_config('statement_timeout', ${String(statementTimeoutMs)}, true),
      set_config('lock_timeout', ${String(lockTimeoutMs)}, true),
      set_config('idle_in_transaction_session_timeout', ${String(idleTransactionTimeoutMs)}, true)
  `;
}

function normalizeDatabaseActorIds(actorIds: readonly string[]) {
  const normalized = [...new Set(actorIds.map((value) => value.trim()))]
    .filter(Boolean);
  if (!normalized.length || normalized.length > 8) {
    throw new Error("Actor-scoped database work requires one to eight actor ids.");
  }
  if (normalized.some((value) => value.length > 320 || value.includes("\0"))) {
    throw new Error("Actor-scoped database work received an invalid actor id.");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// pgvector schema
// ---------------------------------------------------------------------------

const VECTOR_TABLES = Object.freeze([
  { tableName: "omni_memories", indexName: "omni_memories_embedding_vector_idx" },
  { tableName: "omni_knowledge_chunks", indexName: "omni_knowledge_chunks_embedding_vector_idx" },
] as const);

/** The most rows one vector backfill transaction fills. */
const VECTOR_BACKFILL_BATCH_SIZE = 500;

/**
 * Adds the vector columns and their indexes in one short migration
 * transaction, then fills the columns from the JSON embeddings a batch at a
 * time, each batch in a migration transaction of its own, so no transaction
 * holds its locks for the whole backfill.
 */
async function ensureVectorSchema(pg: postgres.Sql) {
  const tableNames = await runWithMigrationLockRetry("Vector schema maintenance", () =>
    pg.begin(async (tx) => {
      await beginMigrationTransaction(tx, "optional vector schema maintenance");
      const sql = wrapPg(tx, true);
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      const ready: Array<"omni_memories" | "omni_knowledge_chunks"> = [];
      for (const table of VECTOR_TABLES) {
        if (await ensureVectorColumn({ sql, ...table })) {
          ready.push(table.tableName);
        }
      }
      return ready;
    }),
  );
  for (const tableName of tableNames) {
    await backfillVectorColumn(pg, tableName);
    if (VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS) {
      await ensureTenantVectorIndexes(pg, tableName);
    }
  }
}

/**
 * Gives each tenant holding enough vectors in a table an HNSW index of its own
 * (src/lib/db/tenant-vector-indexes.ts). Its searches then walk a graph of its
 * own vectors, where the shared index makes them pass every nearer vector of
 * other tenants first. One migration transaction reads the counts and the
 * catalog; then each drop and each build runs in a transaction of its own. A
 * build locks the table against writes while it runs, as the shared index's
 * does. A failure is logged, and the other drops and builds go on.
 */
async function ensureTenantVectorIndexes(
  pg: postgres.Sql,
  tableName: "omni_memories" | "omni_knowledge_chunks",
) {
  await maintainTenantVectorIndexes({
    table: tableName,
    plan: () =>
      runWithMigrationLockRetry(`Tenant vector indexes of ${tableName}`, () =>
        pg.begin(async (tx) => {
          await beginMigrationTransaction(tx, "optional vector schema maintenance");
          const tenants = await tx.unsafe(`
            SELECT tenant_id, count(*)::int AS rows
            FROM ${tableName}
            WHERE embedding_vector IS NOT NULL
            GROUP BY tenant_id
          `);
          const indexes = await tx`
            SELECT index_class.relname AS name, pg_index.indisvalid AS valid
            FROM pg_index
            JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
            JOIN pg_class table_class ON table_class.oid = pg_index.indrelid
            JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
            WHERE namespace.nspname = current_schema()
              AND table_class.relname = ${tableName}
              AND starts_with(index_class.relname::text, ${tenantVectorIndexPrefix(tableName)})
          `;
          return planTenantVectorIndexes({
            table: tableName,
            tenants: tenants.map((row) => ({
              tenantId: String(row.tenant_id),
              rows: Number(row.rows),
            })),
            indexes: indexes.map((row) => ({ name: String(row.name), valid: row.valid === true })),
            minRows: tenantVectorIndexMinRows(),
          });
        }),
      ),
    run: async (indexName, statement) => {
      await runWithMigrationLockRetry(`Tenant vector index ${indexName}`, () =>
        pg.begin(async (tx) => {
          await beginMigrationTransaction(tx, "optional vector schema maintenance");
          await tx.unsafe(statement);
        }),
      );
    },
  });
}

/**
 * Adds the vector column and its index when they are missing. Returns false,
 * leaving the table alone, when the column has other dimensions.
 */
async function ensureVectorColumn({
  sql,
  tableName,
  indexName,
}: {
  sql: SqlClient;
  tableName: "omni_memories" | "omni_knowledge_chunks";
  indexName: string;
}) {
  const dimensions = await getVectorColumnDimensions(sql, tableName);
  if (dimensions === undefined) {
    await sql.query(`ALTER TABLE ${tableName} ADD COLUMN embedding_vector vector(${VECTOR_INDEX_DIMENSIONS})`);
  } else if (dimensions !== VECTOR_INDEX_DIMENSIONS) {
    if (process.env.OMNIAGENT_LOG_PGVECTOR_FAILURES === "true") {
      console.info(
        `${tableName}.embedding_vector has ${dimensions} dimensions; expected ${VECTOR_INDEX_DIMENSIONS}. ` +
          "Leaving production vector data unchanged and using JSON embedding fallback.",
      );
    }
    return false;
  }

  if (VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS) {
    // CREATE INDEX locks the table against writes even when the index
    // exists, so it runs only when the catalog lacks the index. The backfill
    // runs later, so a new index is built over an empty column.
    const [index] = await sql.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1",
      [indexName],
    );
    if (!index) {
      await sql.query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${tableName}
        USING hnsw (embedding_vector vector_cosine_ops)
      `);
    }
  }
  return true;
}

async function getVectorColumnDimensions(
  sql: SqlClient,
  tableName: "omni_memories" | "omni_knowledge_chunks",
) {
  const rows = await sql.query(
    `
      SELECT CASE WHEN attribute.atttypmod >= 0 THEN attribute.atttypmod ELSE NULL END AS dimensions
      FROM pg_attribute attribute
      JOIN pg_class class ON class.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND class.relname = $1
        AND attribute.attname = 'embedding_vector'
        AND NOT attribute.attisdropped
      LIMIT 1
    `,
    [tableName],
  );

  return rows[0]?.dimensions === null || rows[0]?.dimensions === undefined
    ? undefined
    : Number(rows[0].dimensions);
}

/**
 * Fills a vector column from the JSON embeddings in id order, a batch per
 * migration transaction, each batch starting after the last id of the one
 * before. It skips rows another session has locked, since whoever writes an
 * embedding writes its vector too, and embeddings shorter than the column or
 * with an element that is not a number, which cannot become a vector. A later
 * run fills a locked row this run skipped.
 */
async function backfillVectorColumn(
  pg: postgres.Sql,
  tableName: "omni_memories" | "omni_knowledge_chunks",
) {
  const fillBatch = `
    WITH batch AS (
      SELECT id, embedding
      FROM ${tableName}
      WHERE ($1::text IS NULL OR id > $1::text)
        AND embedding_vector IS NULL
        AND CASE
          WHEN jsonb_typeof(embedding) = 'array'
          THEN jsonb_array_length(embedding) >= ${VECTOR_INDEX_DIMENSIONS}
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(embedding) WITH ORDINALITY AS item(value, ordinality)
              WHERE item.ordinality <= ${VECTOR_INDEX_DIMENSIONS}
                AND jsonb_typeof(item.value) <> 'number'
            )
          ELSE false
        END
      ORDER BY id
      LIMIT ${VECTOR_BACKFILL_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    ), filled AS (
      UPDATE ${tableName} target
      SET embedding_vector = (
        '[' || (
          SELECT string_agg(item.value::text, ',' ORDER BY item.ordinality)
          FROM jsonb_array_elements_text(batch.embedding) WITH ORDINALITY AS item(value, ordinality)
          WHERE item.ordinality <= ${VECTOR_INDEX_DIMENSIONS}
        ) || ']'
      )::vector
      FROM batch
      WHERE target.id = batch.id
      RETURNING target.id
    )
    SELECT count(*)::int AS rows, max(batch.id) AS last_id FROM batch
  `;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const batch: { rows: number; lastId: string } = await runWithMigrationLockRetry(
      `Vector backfill of ${tableName}`,
      () =>
        pg.begin(async (tx) => {
          await beginMigrationTransaction(tx, "optional vector schema maintenance");
          const [row] = await tx.unsafe(fillBatch, [cursor]);
          return { rows: Number(row?.rows ?? 0), lastId: String(row?.last_id ?? "") };
        }),
    );
    if (batch.rows < VECTOR_BACKFILL_BATCH_SIZE) {
      return;
    }
    after = batch.lastId;
  }
}

function normalizeTenantId(value?: string) {
  return value?.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || undefined;
}
