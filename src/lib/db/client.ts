import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { PGVECTOR_HNSW_MAX_DIMENSIONS, VECTOR_INDEX_DIMENSIONS } from "@/lib/config";
import {
  appendServerTiming,
  recordDatabaseTiming,
  runWithRequestTiming,
} from "@/lib/observability/request-timing";
import schemaMigrationManifest from "../../../schema-migrations.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

// Internal client shape — mirrors the methods used across this file and by
// the functions that receive a `sql` argument (ensureTenantIsolationPolicies,
// ensureVectorSchema, etc.).
type SqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
};

type DatabaseScope =
  | { kind: "tenant"; tenantId: string }
  | { kind: "system"; reason: string };

type SchemaMigration = {
  version: number;
  name: string;
  checksum: string;
  up: (sql: SqlClient) => Promise<void>;
};

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

// ---------------------------------------------------------------------------
// Public exports (unchanged API surface)
// ---------------------------------------------------------------------------

export const tenantRootPolicyTables = [
  "omni_memories",
  "omni_knowledge_documents",
  "omni_knowledge_chunks",
  "omni_retrieval_traces",
  "omni_agent_runs",
  "omni_tool_executions",
  "omni_mcp_connectors",
  "omni_mcp_tools",
  "omni_openapi_connectors",
  "omni_openapi_operations",
  "omni_workflow_runs",
  "omni_workflow_plans",
  "omni_eval_runs",
  "omni_eval_results",
  "omni_eval_reports",
  "omni_security_audits",
  "omni_observability_events",
  "omni_observability_slo_policy_changes",
  "omni_trust_profiles",
  "omni_events",
  "omni_memory_graph_nodes",
  "omni_memory_graph_edges",
  "omni_memory_graph_builds",
  "omni_memory_graph_rebuild_queue",
  "omni_workflow_triggers",
  "omni_operation_jobs",
  "omni_system_health_checks",
  "omni_incidents",
  "omni_alert_deliveries",
  "omni_observability_slo_policies",
  "omni_access_requests",
  "omni_auth_memberships",
  "omni_auth_sessions",
] as const;

export const tenantChildPolicyTables = [
  "omni_agent_events",
  "omni_workflow_node_executions",
  "omni_workflow_trigger_events",
  "omni_workflow_steps",
  "omni_workflow_events",
  "omni_incident_events",
] as const;

export const tenantPolicyTables = [
  ...tenantRootPolicyTables,
  ...tenantChildPolicyTables,
] as const;

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function hasMaintenanceDatabaseUrl() {
  return Boolean(process.env.OMNIAGENT_MAINTENANCE_DATABASE_URL?.trim());
}

export function getDatabasePoolMax() {
  const configured = Number(process.env.OMNIAGENT_DATABASE_POOL_MAX);
  if (Number.isInteger(configured) && configured > 0) {
    return Math.min(configured, 20);
  }
  // Production runtimes can serve overlapping requests in one process. A
  // single connection lets a long workflow tick starve unrelated reads.
  return process.env.NODE_ENV === "production" ? 4 : 1;
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
  const scope = databaseScope.getStore();
  if (scope?.kind === "system") {
    if (hasMaintenanceDatabaseUrl()) {
      if (!maintenanceScopedSqlClient) {
        maintenanceScopedSqlClient = createTenantScopedSqlClient(
          getRawMaintenancePg(),
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
    scopedSqlClient = createTenantScopedSqlClient(getRawPg());
  }
  return scopedSqlClient;
}

export function enterDatabaseTenantContext(tenantId?: string) {
  const normalized = normalizeTenantId(tenantId) || "";
  const existing = databaseScope.getStore();
  if (existing?.kind === "tenant") {
    existing.tenantId = normalized;
    return;
  }
  databaseScope.enterWith({ kind: "tenant", tenantId: normalized });
}

export function getDatabaseTenantContext() {
  const scope = databaseScope.getStore();
  return scope?.kind === "tenant" ? scope.tenantId || undefined : undefined;
}

export function runWithDatabaseTenantScope<T>(
  tenantId: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const normalized = normalizeTenantId(tenantId);
  if (!normalized) {
    throw new Error("A tenant id is required for tenant-scoped database work.");
  }
  return Promise.resolve(databaseScope.run({ kind: "tenant", tenantId: normalized }, operation));
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
        { kind: "tenant", tenantId: "" },
        () => handler(...args),
      );
      return (
        result instanceof Response
          ? appendServerTiming(result, request)
          : result
      ) as TResult;
    }, request);
  };
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

export const databaseSchemaMigrations = schemaMigrationManifest.map(
  (migration) => Object.freeze({ ...migration }),
);

export function getPendingSchemaMigrationVersions(appliedVersions: Iterable<number>) {
  const applied = new Set(Array.from(appliedVersions));
  const knownVersions = new Set(
    databaseSchemaMigrations.map((migration) => migration.version),
  );
  const unknown = [...applied]
    .filter((version) => !knownVersions.has(version))
    .sort((left, right) => left - right);
  if (unknown.length) {
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
  options: { allowLegacyMissingValues?: boolean } = {},
) {
  getPendingSchemaMigrationVersions(rows.map((row) => Number(row.version)));
  const known = new Map(
    databaseSchemaMigrations.map((migration) => [migration.version, migration]),
  );
  const missing: number[] = [];
  for (const row of rows) {
    const expected = known.get(Number(row.version));
    if (!expected) {
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

function schemaMigrations(): SchemaMigration[] {
  return [
    {
      ...databaseSchemaMigrations[0],
      up: runTableMigrations,
    },
    {
      ...databaseSchemaMigrations[1],
      up: ensureTenantOwnedOperationalSchema,
    },
    {
      ...databaseSchemaMigrations[2],
      up: ensureTenantIsolationPolicies,
    },
    {
      ...databaseSchemaMigrations[3],
      up: ensurePlatformSafetyControls,
    },
    {
      ...databaseSchemaMigrations[4],
      up: ensureSensitiveDataRetention,
    },
    {
      ...databaseSchemaMigrations[5],
      up: async (sql) => {
        await ensureTenantOwnedOperationalSchema(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[6],
      up: async (sql) => {
        await ensureMemoryGraphRebuildQueue(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[7],
      up: ensureAgentRunCancellationRetention,
    },
    {
      ...databaseSchemaMigrations[8],
      up: async (sql) => {
        await ensureMemoryGraphRebuildGenerationLeases(sql);
        await reconcileLegacyMemoryGraphOwnership(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[9],
      up: ensureDatabaseIdentity,
    },
    {
      ...databaseSchemaMigrations[10],
      up: normalizeLegacyJsonbStorage,
    },
  ];
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

  try {
    await schemaReady;
  } catch (error) {
    schemaReady = null;
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
      await pg.begin(async (tx) => {
        const configuredTimeout = Number(
          process.env.OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS,
        );
        const statementTimeoutMs = Number.isFinite(configuredTimeout)
          ? Math.min(Math.max(configuredTimeout, 30_000), 3_600_000)
          : 600_000;
        await tx`SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`;
        const sql = wrapPg(tx);
        // Every version check and migration happens under one transaction-scoped
        // advisory lock, including upgrades from the legacy timestamp-only marker.
        await tx`SELECT pg_advisory_xact_lock(271828182)`;
        await tx`SELECT set_config('omni.system_scope', 'true', true)`;
        await tx`SELECT set_config('omni.system_reason', 'ordered schema migration', true)`;
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

        for (const migration of schemaMigrations()) {
          if (!pendingVersions.has(migration.version)) {
            continue;
          }
          await migration.up(sql);
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
      });
      // pgvector is optional acceleration, not a schema-version prerequisite.
      // Run it after the migration transaction so missing extension privileges
      // cannot abort and roll back otherwise-successful ordered migrations.
      try {
        await pg.begin(async (tx) => {
          await tx`SELECT set_config('omni.system_scope', 'true', true)`;
          await tx`SELECT set_config('omni.system_reason', 'optional vector schema maintenance', true)`;
          await ensureVectorSchema(wrapPg(tx));
        });
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

async function verifyDatabaseSchema() {
  return verifyDatabaseSchemaWithClient(getRawPg());
}

export async function verifyDatabaseSchemaWithClient(pg: AnyPg) {
  let appliedRows: Record<string, unknown>[];
  try {
    appliedRows = await pg`
      SELECT version, name, checksum
      FROM omni_schema_version
      WHERE version IS NOT NULL
      ORDER BY version ASC
    `;
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
  );
  const pending = getPendingSchemaMigrationVersions(
    appliedRows.map((row) => Number(row.version)),
  );
  if (pending.length) {
    throw new Error(
      `Database schema is behind (pending versions: ${pending.join(", ")}). ` +
        "Run the controlled database migration before serving this release.",
    );
  }
}

async function assertRuntimeDatabaseRoleSafety(pg: postgres.Sql) {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  const role = await readRuntimeDatabaseRoleSafety(pg);
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

async function readRuntimeDatabaseRoleSafety(pg: postgres.Sql) {
  const rows = await pg`
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
      "DATABASE_URL and OMNIAGENT_MAINTENANCE_DATABASE_URL must identify the same OmniAgent database.",
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
  return postgres(databaseUrl, {
    prepare: false, // required for Supabase transaction-mode pooler (Supavisor)
    ssl: databaseSslConfiguration(databaseUrl, label),
    max: getDatabasePoolMax(),
    idle_timeout: 20,
    connect_timeout: 10,
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
function wrapPg(pg: AnyPg): SqlClient {
  const client = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    pg(strings, ...params)) as unknown as SqlClient;

  client.query = (text: string, params?: unknown[]) =>
    pg.unsafe(text, params ?? []);

  client.unsafe = (text: string, params?: unknown[]) =>
    pg.unsafe(text, params ?? []);

  client.transaction = () => {
    throw new Error("Use getSql().transaction() for external transactions.");
  };

  return client;
}

// Tenant-scoped client: each operation applies the current tenant or explicit
// system scope with SET LOCAL so pooled connections cannot leak scope.
function createTenantScopedSqlClient(pg: AnyPg, scopeAlreadyApplied = false): SqlClient {
  async function withTenant<T>(
    fn: (sql: AnyPg) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      if (scopeAlreadyApplied) {
        return await fn(pg);
      }
      const scope = databaseScope.getStore();
      return await pg.begin(async (tx: AnyPg) => {
        await applyDatabaseScope(tx, scope);
        return fn(tx);
      });
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

  // Only callback transactions are safe here. Promise arrays begin executing
  // before pg.begin can apply tenant scope and therefore cannot be atomic.
  scoped.transaction = (queriesOrFn: unknown) => {
    const scope = databaseScope.getStore();
    if (typeof queriesOrFn !== "function") {
      throw new Error("Database transactions require an async callback.");
    }
    return pg.begin(async (tx: AnyPg) => {
      await applyDatabaseScope(tx, scope);
      const txScoped = createTenantScopedSqlClient(tx, true);
      return (queriesOrFn as (s: SqlClient) => unknown)(txScoped);
    });
  };

  return scoped;
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
  const systemReason = systemScope ? scope.reason : "";
  await sql`
    SELECT
      set_config('omni.tenant_id', ${tenantId}, true),
      set_config('omni.system_scope', ${systemScope ? "true" : "false"}, true),
      set_config('omni.system_reason', ${systemReason}, true)
  `;
}

// ---------------------------------------------------------------------------
// Table migrations (idempotent, runs inside a transaction)
// ---------------------------------------------------------------------------

async function runTableMigrations(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_memories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      embedding JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_tenant_updated_at_idx ON omni_memories (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_type_idx ON omni_memories (type)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_updated_at_idx ON omni_memories (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_tags_idx ON omni_memories USING GIN (tags)`;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_text_idx
    ON omni_memories
    USING GIN (to_tsvector('english', title || ' ' || content))
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_knowledge_documents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'text',
      tags TEXT[] NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      total_characters INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_knowledge_documents ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_updated_at_idx ON omni_knowledge_documents (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_updated_at_idx ON omni_knowledge_documents (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_source_idx ON omni_knowledge_documents (source)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_tags_idx ON omni_knowledge_documents USING GIN (tags)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_knowledge_chunks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      document_id TEXT NOT NULL REFERENCES omni_knowledge_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      character_count INTEGER NOT NULL DEFAULT 0,
      embedding JSONB,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_knowledge_chunks ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tenant_updated_at_idx ON omni_knowledge_chunks (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_document_id_idx ON omni_knowledge_chunks (document_id, chunk_index ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_updated_at_idx ON omni_knowledge_chunks (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tags_idx ON omni_knowledge_chunks USING GIN (tags)`;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_text_idx
    ON omni_knowledge_chunks
    USING GIN (to_tsvector('english', title || ' ' || content))
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_retrieval_traces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      query TEXT NOT NULL,
      profile JSONB NOT NULL DEFAULT '{}',
      result_count INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      results JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_retrieval_traces ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_retrieval_traces_created_at_idx ON omni_retrieval_traces (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_retrieval_traces_tenant_created_at_idx ON omni_retrieval_traces (tenant_id, created_at DESC)`;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_retrieval_traces_mode_idx
    ON omni_retrieval_traces ((profile->>'mode'))
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_graph_nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      aliases TEXT[] NOT NULL DEFAULT '{}',
      summary TEXT NOT NULL DEFAULT '',
      weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      source_count INTEGER NOT NULL DEFAULT 0,
      memory_ids TEXT[] NOT NULL DEFAULT '{}',
      trace_ids TEXT[] NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_kind_idx ON omni_memory_graph_nodes (kind)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_updated_at_idx ON omni_memory_graph_nodes (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_tags_idx ON omni_memory_graph_nodes USING GIN (tags)`;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_text_idx
    ON omni_memory_graph_nodes
    USING GIN (to_tsvector('english', label || ' ' || summary))
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_graph_edges (
      id TEXT PRIMARY KEY,
      source_node_id TEXT NOT NULL REFERENCES omni_memory_graph_nodes(id) ON DELETE CASCADE,
      target_node_id TEXT NOT NULL REFERENCES omni_memory_graph_nodes(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      memory_ids TEXT[] NOT NULL DEFAULT '{}',
      trace_ids TEXT[] NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_source_idx ON omni_memory_graph_edges (source_node_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_target_idx ON omni_memory_graph_edges (target_node_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_relation_idx ON omni_memory_graph_edges (relation)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_memory_graph_edges_unique_idx
    ON omni_memory_graph_edges (source_node_id, target_node_id, relation)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_graph_builds (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      memory_count INTEGER NOT NULL DEFAULT 0,
      trace_count INTEGER NOT NULL DEFAULT 0,
      node_count INTEGER NOT NULL DEFAULT 0,
      edge_count INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_builds_created_at_idx ON omni_memory_graph_builds (created_at DESC)`;
  await ensureMemoryGraphRebuildQueue(sql);

  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]',
      model TEXT,
      memory_context_count INTEGER NOT NULL DEFAULT 0,
      consolidation_count INTEGER NOT NULL DEFAULT 0,
      response TEXT,
      error TEXT,
      continuation JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      consolidated_at TIMESTAMPTZ,
      consolidation_error TEXT
    )
  `;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidation_count INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS consolidation_error TEXT`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS continuation JSONB`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_started_at_idx ON omni_agent_runs (started_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_tenant_started_at_idx ON omni_agent_runs (tenant_id, started_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_status_idx ON omni_agent_runs (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_consolidated_at_idx ON omni_agent_runs (consolidated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_agent_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES omni_agent_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_agent_events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`
    UPDATE omni_agent_events event
    SET tenant_id = run.tenant_id
    FROM omni_agent_runs run
    WHERE event.run_id = run.id
      AND event.tenant_id <> run.tenant_id
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_events_run_id_idx ON omni_agent_events (run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_events_tenant_run_idx ON omni_agent_events (tenant_id, run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_events_type_idx ON omni_agent_events (type)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_tool_executions (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      risk_level INTEGER NOT NULL,
      status TEXT NOT NULL,
      dry_run BOOLEAN NOT NULL DEFAULT FALSE,
      approval_required BOOLEAN NOT NULL DEFAULT FALSE,
      tenant_id TEXT,
      actor_id TEXT,
      input JSONB NOT NULL DEFAULT '{}',
      output JSONB,
      reason TEXT,
      approval_decision TEXT,
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      approval_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS tenant_id TEXT`;
  await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS actor_id TEXT`;
  await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approval_decision TEXT`;
  await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approved_by TEXT`;
  await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approval_reason TEXT`;
  await sql`ALTER TABLE omni_tool_executions ADD COLUMN IF NOT EXISTS approvals JSONB`;
  await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_tool_id_idx ON omni_tool_executions (tool_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_status_idx ON omni_tool_executions (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_created_at_idx ON omni_tool_executions (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_tool_executions_tenant_status_idx ON omni_tool_executions (tenant_id, status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mcp_connectors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'streamable_http',
      auth_type TEXT NOT NULL DEFAULT 'none',
      auth_token_env TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      default_risk_level INTEGER NOT NULL DEFAULT 2,
      approval_required BOOLEAN NOT NULL DEFAULT TRUE,
      tool_count INTEGER NOT NULL DEFAULT 0,
      capabilities JSONB NOT NULL DEFAULT '{}',
      instructions TEXT,
      server_version JSONB,
      last_discovered_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_status_idx ON omni_mcp_connectors (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_updated_at_idx ON omni_mcp_connectors (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_connectors_tenant_updated_at_idx ON omni_mcp_connectors (tenant_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mcp_tools (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      connector_id TEXT NOT NULL REFERENCES omni_mcp_connectors(id) ON DELETE CASCADE,
      connector_name TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      description TEXT,
      input_schema JSONB NOT NULL DEFAULT '{}',
      output_schema JSONB,
      annotations JSONB,
      risk_level INTEGER NOT NULL DEFAULT 2,
      approval_required BOOLEAN NOT NULL DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_mcp_tools ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_connector_id_idx ON omni_mcp_tools (connector_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_status_idx ON omni_mcp_tools (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_tools_tenant_connector_idx ON omni_mcp_tools (tenant_id, connector_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_mcp_tools_connector_name_idx ON omni_mcp_tools (connector_id, name)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_openapi_connectors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      spec_url TEXT,
      spec_hash TEXT,
      base_url TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'none',
      auth_token_env TEXT,
      auth_header_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      default_risk_level INTEGER NOT NULL DEFAULT 2,
      approval_required BOOLEAN NOT NULL DEFAULT TRUE,
      operation_count INTEGER NOT NULL DEFAULT 0,
      info JSONB NOT NULL DEFAULT '{}',
      last_imported_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_openapi_connectors ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_status_idx ON omni_openapi_connectors (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_updated_at_idx ON omni_openapi_connectors (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_openapi_connectors_tenant_updated_at_idx ON omni_openapi_connectors (tenant_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_openapi_operations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      connector_id TEXT NOT NULL REFERENCES omni_openapi_connectors(id) ON DELETE CASCADE,
      connector_name TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT,
      description TEXT,
      input_schema JSONB NOT NULL DEFAULT '{}',
      request_content_type TEXT,
      response_content_types TEXT[] NOT NULL DEFAULT '{}',
      risk_level INTEGER NOT NULL DEFAULT 2,
      approval_required BOOLEAN NOT NULL DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_openapi_operations ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_connector_id_idx ON omni_openapi_operations (connector_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_status_idx ON omni_openapi_operations (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_openapi_operations_tenant_connector_idx ON omni_openapi_operations (tenant_id, connector_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_openapi_operations_connector_operation_idx ON omni_openapi_operations (connector_id, operation_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_workflow_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      workflow_type TEXT NOT NULL,
      status TEXT NOT NULL,
      goal TEXT NOT NULL,
      input JSONB NOT NULL DEFAULT '{}',
      current_step TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      approval_required BOOLEAN NOT NULL DEFAULT FALSE,
      approved_at TIMESTAMPTZ,
      paused_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      error TEXT,
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`ALTER TABLE omni_workflow_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_status_idx ON omni_workflow_runs (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_updated_at_idx ON omni_workflow_runs (updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_tenant_updated_at_idx ON omni_workflow_runs (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_runs_workflow_type_idx ON omni_workflow_runs (workflow_type)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_workflow_plans (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      workflow_run_id TEXT REFERENCES omni_workflow_runs(id) ON DELETE SET NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      planner TEXT NOT NULL,
      model TEXT,
      plan JSONB NOT NULL DEFAULT '{}',
      validation JSONB NOT NULL DEFAULT '{}',
      context_trace_id TEXT,
      highest_risk_level INTEGER NOT NULL DEFAULT 0,
      approval_required BOOLEAN NOT NULL DEFAULT FALSE,
      confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_workflow_plans ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_run_id_idx ON omni_workflow_plans (workflow_run_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_status_idx ON omni_workflow_plans (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_created_at_idx ON omni_workflow_plans (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_tenant_created_at_idx ON omni_workflow_plans (tenant_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_plans_risk_idx ON omni_workflow_plans (highest_risk_level DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_workflow_node_executions (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES omni_workflow_plans(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      node_label TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      policy TEXT NOT NULL,
      risk_level INTEGER NOT NULL DEFAULT 0,
      approval_required BOOLEAN NOT NULL DEFAULT FALSE,
      tool_execution_ids TEXT[] NOT NULL DEFAULT '{}',
      input JSONB NOT NULL DEFAULT '{}',
      output JSONB,
      error TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_workflow_node_executions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`
    UPDATE omni_workflow_node_executions execution
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE execution.workflow_run_id = run.id
      AND execution.tenant_id <> run.tenant_id
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_run_idx ON omni_workflow_node_executions (workflow_run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_tenant_run_idx ON omni_workflow_node_executions (tenant_id, workflow_run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_plan_idx ON omni_workflow_node_executions (plan_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_status_idx ON omni_workflow_node_executions (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_node_exec_updated_idx ON omni_workflow_node_executions (updated_at DESC)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_workflow_node_exec_plan_node_idx
    ON omni_workflow_node_executions (plan_id, node_id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_workflow_triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      auth_mode TEXT NOT NULL DEFAULT 'hmac_sha256',
      secret_env_var TEXT,
      goal_template TEXT NOT NULL,
      workflow_mode TEXT NOT NULL DEFAULT 'orchestrate',
      require_approval BOOLEAN NOT NULL DEFAULT TRUE,
      metadata JSONB NOT NULL DEFAULT '{}',
      trigger_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_status_idx ON omni_workflow_triggers (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_source_idx ON omni_workflow_triggers (source)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_updated_idx ON omni_workflow_triggers (updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_operation_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      dedupe_key TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_status_run_at_idx ON omni_operation_jobs (status, run_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_type_status_idx ON omni_operation_jobs (type, status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_updated_at_idx ON omni_operation_jobs (updated_at DESC)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_operation_jobs_dedupe_key_idx
    ON omni_operation_jobs (dedupe_key)
    WHERE dedupe_key IS NOT NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_workflow_trigger_events (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL REFERENCES omni_workflow_triggers(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT,
      signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
      workflow_run_id TEXT REFERENCES omni_workflow_runs(id) ON DELETE SET NULL,
      queue_job_id TEXT REFERENCES omni_operation_jobs(id) ON DELETE SET NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      headers JSONB NOT NULL DEFAULT '{}',
      error TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_workflow_trigger_events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`
    UPDATE omni_workflow_trigger_events event
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE event.workflow_run_id = run.id
      AND event.tenant_id <> run.tenant_id
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_trigger_idx ON omni_workflow_trigger_events (trigger_id, received_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_tenant_received_idx ON omni_workflow_trigger_events (tenant_id, received_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_status_idx ON omni_workflow_trigger_events (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_received_idx ON omni_workflow_trigger_events (received_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      input JSONB NOT NULL DEFAULT '{}',
      output JSONB,
      error TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_workflow_steps ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`
    UPDATE omni_workflow_steps step
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE step.workflow_run_id = run.id
      AND step.tenant_id <> run.tenant_id
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_steps_run_id_idx ON omni_workflow_steps (workflow_run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_steps_tenant_run_idx ON omni_workflow_steps (tenant_id, workflow_run_id, created_at ASC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_workflow_steps_run_step_idx ON omni_workflow_steps (workflow_run_id, step_key)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_workflow_events (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_workflow_events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`
    UPDATE omni_workflow_events event
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE event.workflow_run_id = run.id
      AND event.tenant_id <> run.tenant_id
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_events_run_id_idx ON omni_workflow_events (workflow_run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_events_tenant_run_idx ON omni_workflow_events (tenant_id, workflow_run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_events_type_idx ON omni_workflow_events (type)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_system_health_checks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      components JSONB NOT NULL DEFAULT '[]',
      metrics JSONB NOT NULL DEFAULT '{}',
      incidents JSONB NOT NULL DEFAULT '[]',
      recovery_actions JSONB NOT NULL DEFAULT '[]',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_system_health_checks_status_idx ON omni_system_health_checks (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_system_health_checks_created_idx ON omni_system_health_checks (created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_incidents (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      component_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      last_check_id TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by TEXT,
      acknowledgement_reason TEXT,
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT,
      resolution TEXT,
      alert_targets JSONB NOT NULL DEFAULT '[]',
      playbook_ids TEXT[] NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_status_idx ON omni_incidents (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_component_idx ON omni_incidents (component_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_severity_idx ON omni_incidents (severity)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_updated_idx ON omni_incidents (updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_incident_events (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES omni_incidents(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_id TEXT,
      message TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_incident_events_incident_idx ON omni_incident_events (incident_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incident_events_created_idx ON omni_incident_events (created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_alert_deliveries (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES omni_incidents(id) ON DELETE CASCADE,
      incident_event_id TEXT,
      target_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload JSONB NOT NULL DEFAULT '{}',
      response JSONB,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_status_run_idx ON omni_alert_deliveries (status, run_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_incident_idx ON omni_alert_deliveries (incident_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_target_idx ON omni_alert_deliveries (target_id, status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_updated_idx ON omni_alert_deliveries (updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_eval_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      suite TEXT NOT NULL,
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      warnings INTEGER NOT NULL DEFAULT 0,
      average_latency_ms INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_eval_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_status_idx ON omni_eval_runs (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_created_at_idx ON omni_eval_runs (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_runs_tenant_created_at_idx ON omni_eval_runs (tenant_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_eval_results (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      eval_run_id TEXT NOT NULL REFERENCES omni_eval_runs(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL,
      case_name TEXT NOT NULL,
      case_type TEXT NOT NULL,
      status TEXT NOT NULL,
      score DOUBLE PRECISION NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      input JSONB NOT NULL DEFAULT '{}',
      output JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE omni_eval_results ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_run_id_idx ON omni_eval_results (eval_run_id, created_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_case_id_idx ON omni_eval_results (case_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_results_tenant_run_idx ON omni_eval_results (tenant_id, eval_run_id, created_at ASC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_eval_reports (
      id TEXT PRIMARY KEY,
      eval_run_id TEXT NOT NULL REFERENCES omni_eval_runs(id) ON DELETE CASCADE,
      format TEXT NOT NULL,
      report_version TEXT NOT NULL,
      report JSONB NOT NULL DEFAULT '{}',
      signature JSONB NOT NULL DEFAULT '{}',
      tenant_id TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_reports_run_created_idx ON omni_eval_reports (eval_run_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_reports_created_idx ON omni_eval_reports (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_eval_reports_tenant_run_created_idx ON omni_eval_reports (tenant_id, eval_run_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_auth_tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_tenants_slug_idx ON omni_auth_tenants (slug)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_auth_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_users_email_idx ON omni_auth_users (email)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_users_status_idx ON omni_auth_users (status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_auth_memberships (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES omni_auth_tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES omni_auth_users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS omni_auth_memberships_tenant_user_idx ON omni_auth_memberships (tenant_id, user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_memberships_user_idx ON omni_auth_memberships (user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_memberships_role_idx ON omni_auth_memberships (role)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES omni_auth_users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES omni_auth_tenants(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_sessions_token_hash_idx ON omni_auth_sessions (token_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_sessions_user_idx ON omni_auth_sessions (user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_auth_sessions_expires_idx ON omni_auth_sessions (expires_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_security_audits (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      risk_level INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_security_audits_tenant_created_idx ON omni_security_audits (tenant_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_security_audits_action_idx ON omni_security_audits (action)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_security_audits_decision_idx ON omni_security_audits (decision)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_observability_events (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      route TEXT,
      method TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      request_id TEXT,
      correlation_id TEXT NOT NULL,
      tenant_id TEXT,
      actor_id TEXT,
      resource_type TEXT,
      resource_id TEXT,
      message TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_level_created_idx ON omni_observability_events (level, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_category_created_idx ON omni_observability_events (category, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_correlation_idx ON omni_observability_events (correlation_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_route_created_idx ON omni_observability_events (route, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_resource_created_idx ON omni_observability_events (resource_type, resource_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_events_tenant_created_idx ON omni_observability_events (tenant_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_trust_profiles (
      tenant_id TEXT NOT NULL,
      action_class TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      risk_level INTEGER NOT NULL DEFAULT 0,
      reversible BOOLEAN NOT NULL DEFAULT FALSE,
      total INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      rejections INTEGER NOT NULL DEFAULT 0,
      human_approvals INTEGER NOT NULL DEFAULT 0,
      clean_streak INTEGER NOT NULL DEFAULT 0,
      last_outcome_at TIMESTAMPTZ,
      last_failure_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, action_class)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_trust_profiles_streak_idx ON omni_trust_profiles (tenant_id, clean_streak DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_events (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      stream_id TEXT NOT NULL,
      type TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL DEFAULT 'system',
      payload JSONB NOT NULL DEFAULT '{}',
      causation_id TEXT,
      correlation_id TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_events_stream_idx ON omni_events (stream_id, seq ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_events_tenant_at_idx ON omni_events (tenant_id, at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_events_type_idx ON omni_events (type, at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_observability_slo_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      metric TEXT NOT NULL,
      comparator TEXT NOT NULL,
      warning_threshold DOUBLE PRECISION NOT NULL,
      critical_threshold DOUBLE PRECISION NOT NULL,
      warning_severity TEXT NOT NULL DEFAULT 'warning',
      critical_severity TEXT NOT NULL DEFAULT 'critical',
      unit TEXT NOT NULL,
      component_id TEXT NOT NULL DEFAULT 'observability',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      alert_target_ids TEXT[] NOT NULL DEFAULT '{}',
      suppression_minutes INTEGER NOT NULL DEFAULT 120,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_enabled_idx ON omni_observability_slo_policies (enabled, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_metric_idx ON omni_observability_slo_policies (metric)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_observability_slo_policy_changes (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      risk_level INTEGER NOT NULL DEFAULT 2,
      tenant_id TEXT,
      requested_by TEXT,
      reviewed_by TEXT,
      reason TEXT,
      review_reason TEXT,
      before_policy JSONB,
      after_policy JSONB,
      rollback_change_id TEXT,
      approval_policy JSONB NOT NULL DEFAULT '{}',
      approvals JSONB NOT NULL DEFAULT '[]',
      evidence_hash TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ
    )
  `;
  await sql`ALTER TABLE omni_observability_slo_policy_changes ADD COLUMN IF NOT EXISTS approval_policy JSONB NOT NULL DEFAULT '{}'`;
  await sql`ALTER TABLE omni_observability_slo_policy_changes ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '[]'`;
  await sql`ALTER TABLE omni_observability_slo_policy_changes ADD COLUMN IF NOT EXISTS evidence_hash TEXT NOT NULL DEFAULT ''`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_policy_idx ON omni_observability_slo_policy_changes (policy_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_status_idx ON omni_observability_slo_policy_changes (status, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_action_idx ON omni_observability_slo_policy_changes (action)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policy_changes_tenant_status_idx ON omni_observability_slo_policy_changes (tenant_id, status, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_observability_slo_approval_policies (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      rules JSONB NOT NULL DEFAULT '[]',
      break_glass JSONB NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      updated_by TEXT,
      update_reason TEXT,
      evidence_hash TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_observability_slo_approval_policy_versions (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      policy JSONB NOT NULL DEFAULT '{}',
      changed_by TEXT,
      change_reason TEXT,
      previous_hash TEXT,
      evidence_hash TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_approval_policy_versions_policy_idx ON omni_observability_slo_approval_policy_versions (policy_id, version DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_approval_policy_versions_created_idx ON omni_observability_slo_approval_policy_versions (created_at DESC)`;
  await ensurePlatformSafetyTables(sql);
}

// ---------------------------------------------------------------------------
// Additive tenant ownership migration
// ---------------------------------------------------------------------------

async function ensureMemoryGraphRebuildQueue(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_graph_rebuild_queue (
      tenant_id TEXT PRIMARY KEY,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_graph_rebuild_queue_requested_idx
    ON omni_memory_graph_rebuild_queue (requested_at ASC)
  `;
}

async function ensureMemoryGraphRebuildGenerationLeases(sql: SqlClient) {
  await ensureMemoryGraphRebuildQueue(sql);
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ADD COLUMN IF NOT EXISTS generation BIGINT
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ADD COLUMN IF NOT EXISTS lease_owner TEXT
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
  `;
  await sql`
    UPDATE omni_memory_graph_rebuild_queue
    SET generation = 1
    WHERE generation IS NULL OR generation < 1
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ALTER COLUMN generation SET DEFAULT 1
  `;
  await sql`
    ALTER TABLE omni_memory_graph_rebuild_queue
    ALTER COLUMN generation SET NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_graph_rebuild_queue_lease_idx
    ON omni_memory_graph_rebuild_queue (lease_expires_at, requested_at)
  `;
}

async function reconcileLegacyMemoryGraphOwnership(sql: SqlClient) {
  // Legacy graph rows could combine evidence from more than one tenant before
  // graph IDs and slugs were tenant-namespaced. Reassigning those snapshots
  // would preserve cross-tenant summaries, so discard every legacy projection
  // and durably queue a clean per-tenant rebuild from authoritative memories.
  await sql`
    INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
      tenant_id, requested_at, attempts, last_error, updated_at, generation
    )
    SELECT tenant_id, NOW(), 0, NULL, NOW(), 1
    FROM (
      SELECT tenant_id
      FROM omni_memories
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
      UNION
      SELECT tenant_id
      FROM omni_retrieval_traces
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
    ) tenants
    ON CONFLICT (tenant_id) DO UPDATE SET
      requested_at = NOW(),
      attempts = 0,
      last_error = NULL,
      updated_at = NOW(),
      generation = rebuild.generation + 1
  `;
  await sql`DELETE FROM omni_memory_graph_edges`;
  await sql`DELETE FROM omni_memory_graph_nodes`;
}

async function ensureTenantOwnedOperationalSchema(sql: SqlClient) {
  const tenantTables = [
    "omni_memory_graph_nodes",
    "omni_memory_graph_edges",
    "omni_memory_graph_builds",
    "omni_memory_graph_rebuild_queue",
    "omni_workflow_triggers",
    "omni_workflow_trigger_events",
    "omni_operation_jobs",
    "omni_system_health_checks",
    "omni_incidents",
    "omni_incident_events",
    "omni_alert_deliveries",
    "omni_observability_slo_policies",
    "omni_observability_slo_policy_changes",
    "omni_tool_executions",
    "omni_eval_reports",
    "omni_observability_events",
  ] as const;

  // Add columns without constraints first, preserve all legacy rows as the
  // default tenant, then enforce ownership. This ordering is safe for deployed
  // databases and never drops or rewrites a table.
  for (const tableName of tenantTables) {
    await sql.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
  }

  // Recover ownership from tenant-aware parents before assigning the legacy
  // default. Mixed-version deployments can already contain non-default runs,
  // memories, traces, or evals while their newer child tables are unowned.
  await sql`
    UPDATE omni_operation_jobs job
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE job.payload->>'workflowRunId' = run.id
      AND run.tenant_id IS NOT NULL
      AND (
        job.tenant_id IS NULL
        OR job.tenant_id = ''
        OR (job.tenant_id = 'default' AND run.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_workflow_trigger_events event
    SET tenant_id = run.tenant_id
    FROM omni_workflow_runs run
    WHERE event.workflow_run_id = run.id
      AND run.tenant_id IS NOT NULL
      AND (
        event.tenant_id IS NULL
        OR event.tenant_id = ''
        OR (event.tenant_id = 'default' AND run.tenant_id <> 'default')
      )
  `;
  await sql`
    WITH trigger_ownership AS (
      SELECT trigger_id, MIN(tenant_id) AS tenant_id
      FROM omni_workflow_trigger_events
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
      GROUP BY trigger_id
      HAVING COUNT(DISTINCT tenant_id) = 1
    )
    UPDATE omni_workflow_triggers trigger
    SET tenant_id = ownership.tenant_id
    FROM trigger_ownership ownership
    WHERE trigger.id = ownership.trigger_id
      AND (
        trigger.tenant_id IS NULL
        OR trigger.tenant_id = ''
        OR (trigger.tenant_id = 'default' AND ownership.tenant_id <> 'default')
      )
  `;
  await sql`
    WITH graph_evidence AS (
      SELECT node.id AS node_id, memory.tenant_id
      FROM omni_memory_graph_nodes node
      CROSS JOIN LATERAL unnest(node.memory_ids) memory_id
      JOIN omni_memories memory ON memory.id = memory_id
      UNION ALL
      SELECT node.id AS node_id, trace.tenant_id
      FROM omni_memory_graph_nodes node
      CROSS JOIN LATERAL unnest(node.trace_ids) trace_id
      JOIN omni_retrieval_traces trace ON trace.id = trace_id
    ),
    graph_ownership AS (
      SELECT node_id, MIN(tenant_id) AS tenant_id
      FROM graph_evidence
      WHERE tenant_id IS NOT NULL AND tenant_id <> ''
      GROUP BY node_id
      HAVING COUNT(DISTINCT tenant_id) = 1
    )
    UPDATE omni_memory_graph_nodes node
    SET tenant_id = ownership.tenant_id
    FROM graph_ownership ownership
    WHERE node.id = ownership.node_id
      AND (
        node.tenant_id IS NULL
        OR node.tenant_id = ''
        OR (node.tenant_id = 'default' AND ownership.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_observability_slo_policy_changes policy_change
    SET tenant_id = policy.tenant_id
    FROM omni_observability_slo_policies policy
    WHERE policy_change.policy_id = policy.id
      AND policy.tenant_id IS NOT NULL
      AND (
        policy_change.tenant_id IS NULL
        OR policy_change.tenant_id = ''
        OR (policy_change.tenant_id = 'default' AND policy.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_eval_reports report
    SET tenant_id = run.tenant_id
    FROM omni_eval_runs run
    WHERE report.eval_run_id = run.id
      AND run.tenant_id IS NOT NULL
      AND (
        report.tenant_id IS NULL
        OR report.tenant_id = ''
        OR (report.tenant_id = 'default' AND run.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_memory_graph_edges edge
    SET tenant_id = node.tenant_id
    FROM omni_memory_graph_nodes node
    WHERE edge.source_node_id = node.id
      AND node.tenant_id IS NOT NULL
      AND (
        edge.tenant_id IS NULL
        OR edge.tenant_id = ''
        OR (edge.tenant_id = 'default' AND node.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_incident_events event
    SET tenant_id = incident.tenant_id
    FROM omni_incidents incident
    WHERE event.incident_id = incident.id
      AND incident.tenant_id IS NOT NULL
      AND (
        event.tenant_id IS NULL
        OR event.tenant_id = ''
        OR (event.tenant_id = 'default' AND incident.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_alert_deliveries delivery
    SET tenant_id = incident.tenant_id
    FROM omni_incidents incident
    WHERE delivery.incident_id = incident.id
      AND incident.tenant_id IS NOT NULL
      AND (
        delivery.tenant_id IS NULL
        OR delivery.tenant_id = ''
        OR (delivery.tenant_id = 'default' AND incident.tenant_id <> 'default')
      )
  `;
  await sql`
    UPDATE omni_workflow_trigger_events event
    SET tenant_id = trigger.tenant_id
    FROM omni_workflow_triggers trigger
    WHERE event.trigger_id = trigger.id
      AND trigger.tenant_id IS NOT NULL
      AND (
        event.tenant_id IS NULL
        OR event.tenant_id = ''
        OR (event.tenant_id = 'default' AND trigger.tenant_id <> 'default')
      )
  `;

  for (const tableName of tenantTables) {
    await sql.query(`
      UPDATE ${tableName}
      SET tenant_id = 'default'
      WHERE tenant_id IS NULL OR tenant_id = ''
    `);
    await sql.query(`ALTER TABLE ${tableName} ALTER COLUMN tenant_id SET DEFAULT 'default'`);
    await sql.query(`ALTER TABLE ${tableName} ALTER COLUMN tenant_id SET NOT NULL`);
  }

  // New writes namespace dedupe keys by tenant. Bring inferred non-default
  // legacy jobs onto the same key shape without colliding with an already
  // migrated row.
  await sql`
    UPDATE omni_operation_jobs job
    SET dedupe_key = NULL
    WHERE job.tenant_id <> 'default'
      AND job.dedupe_key IS NOT NULL
      AND job.dedupe_key NOT LIKE job.tenant_id || '/%'
      AND EXISTS (
        SELECT 1
        FROM omni_operation_jobs migrated
        WHERE migrated.id <> job.id
          AND migrated.dedupe_key = job.tenant_id || '/' || job.dedupe_key
      )
  `;
  await sql`
    UPDATE omni_operation_jobs
    SET dedupe_key = tenant_id || '/' || dedupe_key
    WHERE tenant_id <> 'default'
      AND dedupe_key IS NOT NULL
      AND dedupe_key NOT LIKE tenant_id || '/%'
  `;

  await sql`ALTER TABLE omni_workflow_trigger_events ADD COLUMN IF NOT EXISTS delivery_key TEXT`;
  await sql`ALTER TABLE omni_workflow_trigger_events ADD COLUMN IF NOT EXISTS signature_digest TEXT`;

  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_tenant_updated_idx ON omni_memory_graph_nodes (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_nodes_tenant_kind_idx ON omni_memory_graph_nodes (tenant_id, kind)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_tenant_updated_idx ON omni_memory_graph_edges (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_edges_tenant_source_idx ON omni_memory_graph_edges (tenant_id, source_node_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memory_graph_builds_tenant_created_idx ON omni_memory_graph_builds (tenant_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_triggers_tenant_updated_idx ON omni_workflow_triggers (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_workflow_trigger_events_tenant_trigger_idx ON omni_workflow_trigger_events (tenant_id, trigger_id, received_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_tenant_status_run_idx ON omni_operation_jobs (tenant_id, status, run_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_operation_jobs_tenant_updated_idx ON omni_operation_jobs (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_system_health_checks_tenant_created_idx ON omni_system_health_checks (tenant_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_tenant_status_updated_idx ON omni_incidents (tenant_id, status, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incidents_tenant_fingerprint_idx ON omni_incidents (tenant_id, fingerprint)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_incident_events_tenant_incident_idx ON omni_incident_events (tenant_id, incident_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_tenant_status_run_idx ON omni_alert_deliveries (tenant_id, status, run_at ASC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_alert_deliveries_tenant_incident_idx ON omni_alert_deliveries (tenant_id, incident_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_tenant_updated_idx ON omni_observability_slo_policies (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_observability_slo_policies_tenant_enabled_idx ON omni_observability_slo_policies (tenant_id, enabled, updated_at DESC)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_workflow_trigger_events_delivery_idx
    ON omni_workflow_trigger_events (tenant_id, trigger_id, delivery_key)
    WHERE delivery_key IS NOT NULL
  `;
}

async function ensurePlatformSafetyTables(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_rate_limits (
      key_hash TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_rate_limits_expires_idx
    ON omni_rate_limits (expires_at ASC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_access_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      use_case TEXT NOT NULL,
      timeline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      reviewed_by TEXT,
      review_note TEXT,
      reviewed_at TIMESTAMPTZ,
      provisioned_user_id TEXT,
      provisioned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_tenant_status_created_idx
    ON omni_access_requests (tenant_id, status, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_tenant_email_idx
    ON omni_access_requests (tenant_id, email)
  `;
}

async function ensurePlatformSafetyControls(sql: SqlClient) {
  await ensurePlatformSafetyTables(sql);
  // Existing deployments may already have completed the RLS migration before
  // this table was introduced. Re-running the idempotent policy installer
  // closes the new table in the same transaction as its creation.
  await ensureTenantIsolationPolicies(sql);
}

async function ensureSensitiveDataRetention(sql: SqlClient) {
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_generated_retention_idx
    ON omni_memories (updated_at ASC)
    WHERE source IN ('agent', 'consolidator')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_pending_retention_idx
    ON omni_access_requests (created_at ASC)
    WHERE status = 'pending_review'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_access_requests_reviewed_retention_idx
    ON omni_access_requests (updated_at ASC)
    WHERE status IN ('provisioned', 'declined')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_runs_waiting_retention_idx
    ON omni_agent_runs (started_at ASC)
    WHERE status = 'waiting_approval'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_workflow_runs_terminal_retention_idx
    ON omni_workflow_runs (COALESCE(completed_at, updated_at) ASC)
    WHERE status IN ('completed', 'failed', 'canceled')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_workflow_plans_retention_idx
    ON omni_workflow_plans (updated_at ASC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_operation_jobs_terminal_retention_idx
    ON omni_operation_jobs (COALESCE(completed_at, updated_at) ASC)
    WHERE status IN ('completed', 'failed', 'canceled')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_agent_runs_terminal_retention_idx
    ON omni_agent_runs (completed_at ASC)
    WHERE status IN ('completed', 'failed')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_tool_executions_pending_retention_idx
    ON omni_tool_executions (created_at ASC)
    WHERE status = 'approval_required'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_tool_executions_terminal_retention_idx
    ON omni_tool_executions (COALESCE(completed_at, created_at) ASC)
    WHERE status IN ('dry_run', 'executed', 'blocked', 'failed', 'rejected')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_events_retention_idx
    ON omni_events (at ASC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_observability_events_retention_idx
    ON omni_observability_events (created_at ASC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_security_audits_retention_idx
    ON omni_security_audits (created_at ASC)
  `;
  // Reconcile policy definitions for tables added to tenant isolation after
  // earlier schema versions had already shipped.
  await ensureTenantIsolationPolicies(sql);
}

async function ensureAgentRunCancellationRetention(sql: SqlClient) {
  await sql`DROP INDEX IF EXISTS omni_agent_runs_terminal_retention_idx`;
  await sql`
    CREATE INDEX omni_agent_runs_terminal_retention_idx
    ON omni_agent_runs (completed_at ASC)
    WHERE status IN ('completed', 'failed', 'canceled')
  `;
}

async function ensureDatabaseIdentity(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_database_identity (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      id TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    INSERT INTO omni_database_identity (singleton, id)
    VALUES (
      TRUE,
      md5(
        random()::text ||
        clock_timestamp()::text ||
        current_database() ||
        pg_backend_pid()::text
      )
    )
    ON CONFLICT (singleton) DO NOTHING
  `;
}

async function normalizeLegacyJsonbStorage(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION pg_temp.omni_decode_legacy_jsonb(value JSONB)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      decoded JSONB;
    BEGIN
      IF value IS NULL OR jsonb_typeof(value) <> 'string' THEN
        RETURN value;
      END IF;
      BEGIN
        decoded := (value #>> '{}')::jsonb;
        RETURN decoded;
      EXCEPTION WHEN OTHERS THEN
        RETURN value;
      END;
    END
    $function$
  `;
  await sql`
    DO $migration$
    DECLARE
      json_column RECORD;
    BEGIN
      FOR json_column IN
        SELECT table_schema, table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name LIKE 'omni\_%' ESCAPE '\'
          AND data_type = 'jsonb'
        ORDER BY table_name, ordinal_position
      LOOP
        EXECUTE format(
          'UPDATE %I.%I SET %I = pg_temp.omni_decode_legacy_jsonb(%I) ' ||
          'WHERE jsonb_typeof(%I) = ''string''',
          json_column.table_schema,
          json_column.table_name,
          json_column.column_name,
          json_column.column_name,
          json_column.column_name
        );
      END LOOP;
    END
    $migration$
  `;
  await sql`
    UPDATE omni_operation_jobs
    SET payload =
      pg_temp.omni_decode_legacy_jsonb(payload -> 0) ||
      (payload -> 1)
    WHERE jsonb_typeof(payload) = 'array'
      AND jsonb_array_length(payload) = 2
      AND jsonb_typeof(pg_temp.omni_decode_legacy_jsonb(payload -> 0)) = 'object'
      AND jsonb_typeof(payload -> 1) = 'object'
      AND payload -> 1 ? '__rerunRequested'
  `;
}

// ---------------------------------------------------------------------------
// RLS tenant isolation
// ---------------------------------------------------------------------------

async function ensureTenantIsolationPolicies(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_current_tenant()
    RETURNS TEXT
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT NULLIF(current_setting('omni.tenant_id', true), '')
    $$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_system_scope_enabled()
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT COALESCE(current_setting('omni.system_scope', true), '') = 'true'
        AND NULLIF(current_setting('omni.system_reason', true), '') IS NOT NULL
        AND current_user = (
          SELECT pg_get_userbyid(relowner)
          FROM pg_class
          WHERE oid = 'omni_schema_version'::regclass
        )
    $$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_tenant_visible(row_tenant TEXT)
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    AS $$
      SELECT omni_system_scope_enabled()
        OR (
          omni_current_tenant() IS NOT NULL
          AND row_tenant IS NOT NULL
          AND row_tenant = omni_current_tenant()
        )
    $$
  `;

  for (const tableName of tenantPolicyTables) {
    await sql.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
    await sql.query(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);
    await sql.query(`
      DO $$
      BEGIN
        CREATE POLICY omni_tenant_isolation ON ${tableName}
        FOR ALL
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      EXCEPTION WHEN duplicate_object THEN
        ALTER POLICY omni_tenant_isolation ON ${tableName}
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      END
      $$
    `);
  }
}

// ---------------------------------------------------------------------------
// pgvector schema
// ---------------------------------------------------------------------------

async function ensureVectorSchema(sql: SqlClient) {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await ensureVectorColumn({
    sql,
    tableName: "omni_memories",
    indexName: "omni_memories_embedding_vector_idx",
  });
  await ensureVectorColumn({
    sql,
    tableName: "omni_knowledge_chunks",
    indexName: "omni_knowledge_chunks_embedding_vector_idx",
  });
}

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
    return;
  }

  await backfillVectorColumn(sql, tableName);

  if (VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS) {
    await sql.query(`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON ${tableName}
      USING hnsw (embedding_vector vector_cosine_ops)
    `);
  }
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

async function backfillVectorColumn(
  sql: SqlClient,
  tableName: "omni_memories" | "omni_knowledge_chunks",
) {
  await sql.query(`
    UPDATE ${tableName}
    SET embedding_vector = (
      '[' || (
        SELECT string_agg(item.value::text, ',' ORDER BY item.ordinality)
        FROM jsonb_array_elements_text(embedding) WITH ORDINALITY AS item(value, ordinality)
        WHERE item.ordinality <= ${VECTOR_INDEX_DIMENSIONS}
      ) || ']'
    )::vector
    WHERE embedding_vector IS NULL
      AND CASE
        WHEN jsonb_typeof(embedding) = 'array'
        THEN jsonb_array_length(embedding) >= ${VECTOR_INDEX_DIMENSIONS}
        ELSE false
      END
  `);
}

function normalizeTenantId(value?: string) {
  return value?.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || undefined;
}
