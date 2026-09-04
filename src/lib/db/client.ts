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
  readonly transactionScoped: boolean;
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

const DEFAULT_SCHEMA_VERIFICATION_TIMEOUT_MS = 10_000;
const MIN_SCHEMA_VERIFICATION_TIMEOUT_MS = 1_000;
const MAX_SCHEMA_VERIFICATION_TIMEOUT_MS = 60_000;
const DEFAULT_DATABASE_ACQUIRE_TIMEOUT_MS = 20_000;
const MIN_DATABASE_ACQUIRE_TIMEOUT_MS = 500;
const MAX_DATABASE_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 15_000;
const MIN_DATABASE_STATEMENT_TIMEOUT_MS = 1_000;
const MAX_DATABASE_STATEMENT_TIMEOUT_MS = 60_000;
const DEFAULT_DATABASE_LOCK_TIMEOUT_MS = 1_000;
const MIN_DATABASE_LOCK_TIMEOUT_MS = 100;
const MAX_DATABASE_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;
const MIN_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 1_000;
const MAX_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 60_000;
const DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS = 20;
// Vercel may freeze a function isolate while postgres.js's JavaScript idle
// timer is armed. When that isolate thaws after the deadline, the timer can
// close the sole pool connection while a new reserve is being queued. Disable
// the driver timer there and let the platform lifecycle or a connection error
// retire the socket; durable runtimes still reap idle connections normally.
const VERCEL_DATABASE_POOL_IDLE_TIMEOUT_SECONDS = 0;

// ---------------------------------------------------------------------------
// Public exports (unchanged API surface)
// ---------------------------------------------------------------------------

export const tenantRootPolicyTables = [
  "omni_memories",
  "omni_memory_deletion_receipts",
  "omni_source_adapter_output_receipts",
  "omni_source_items",
  "omni_source_sync_page_checkpoints",
  "omni_tenant_capability_rollouts",
  "omni_knowledge_documents",
  "omni_knowledge_chunks",
  "omni_retrieval_traces",
  "omni_agent_runs",
  "omni_threads",
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
  "omni_ai_usage",
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
  "omni_mobile_sessions",
  "omni_oauth_grants",
  "omni_today_items",
  "omni_today_preferences",
  "omni_daily_briefs",
  "omni_personal_notifications",
  "omni_projects",
  "omni_project_artifacts",
  "omni_missions",
  "omni_mission_tasks",
  "omni_mission_attempts",
  "omni_mission_artifacts",
  "omni_custom_skills",
  "omni_custom_agents",
  "omni_capture_recordings",
  "omni_capture_segments",
  "omni_capture_assets",
  "omni_provider_connections",
  "omni_model_catalog",
  "omni_model_assignments",
  "omni_service_api_keys",
  "omni_mcp_export_configurations",
] as const;

export const tenantChildPolicyTables = [
  "omni_source_revisions",
  "omni_source_tombstones",
  "omni_source_sync_heads",
  "omni_evidence_units",
  "omni_source_sync_page_items",
  "omni_agent_events",
  "omni_thread_turns",
  "omni_workflow_node_executions",
  "omni_workflow_trigger_events",
  "omni_workflow_steps",
  "omni_workflow_events",
  "omni_incident_events",
  "omni_project_tasks",
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
  return process.env.VERCEL
    ? VERCEL_DATABASE_POOL_IDLE_TIMEOUT_SECONDS
    : DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS;
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
    {
      ...databaseSchemaMigrations[11],
      up: async (sql) => {
        await ensureConversationThreads(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[12],
      up: ensureClaimBasedMemory,
    },
    {
      ...databaseSchemaMigrations[13],
      up: ensurePersistedAnswerGrounding,
    },
    {
      ...databaseSchemaMigrations[14],
      up: async (sql) => {
        await ensureOAuthGrants(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[15],
      up: ensureAgentAssignmentHistory,
    },
    {
      ...databaseSchemaMigrations[16],
      up: ensureAgentOutcomeFeedback,
    },
    {
      ...databaseSchemaMigrations[17],
      up: async (sql) => {
        await ensureTodayItems(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[18],
      up: async (sql) => {
        await ensureProactiveDailyBriefs(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[19],
      up: async (sql) => {
        await ensurePersonalNotificationCenter(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[20],
      up: async (sql) => {
        await ensurePersonalProjects(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[21],
      up: ensureAutonomousProjectExecution,
    },
    {
      ...databaseSchemaMigrations[22],
      up: async (sql) => {
        await ensureProjectArtifacts(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[23],
      up: ensureProjectArtifactReflections,
    },
    {
      ...databaseSchemaMigrations[24],
      up: ensureOAuthIncrementalSyncHealth,
    },
    {
      ...databaseSchemaMigrations[25],
      up: async (sql) => {
        await ensureAgentSkillStudio(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[26],
      up: async (sql) => {
        await ensureMissionKernel(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[27],
      up: async (sql) => {
        await ensureCaptureRecordings(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[28],
      up: ensureMissionKanbanTaskMetadata,
    },
    {
      ...databaseSchemaMigrations[29],
      up: async (sql) => {
        await ensureSettingsControlPlane(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[30],
      up: ensureMcpConnectorCredentialVault,
    },
    {
      ...databaseSchemaMigrations[31],
      up: async (sql) => {
        await ensureUnifiedAiUsageLedger(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[32],
      up: async (sql) => {
        await ensureUnifiedAiUsageLedgerCompatibility(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[33],
      up: async (sql) => {
        await ensureMobileSessions(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[34],
      up: ensureAsaelCanonicalIdentity,
    },
    {
      ...databaseSchemaMigrations[35],
      up: ensureGovernedToolEffectReceipts,
    },
    {
      ...databaseSchemaMigrations[36],
      up: async (sql) => {
        await ensureCanonicalSourceLineageShadow(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[37],
      up: async (sql) => {
        await ensureDriveSyncV2ShadowCheckpoints(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[38],
      up: async (sql) => {
        await ensureCanonicalSourceConvergenceFoundation(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[39],
      up: async (sql) => {
        await ensureTenantCapabilityRollouts(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[40],
      up: async (sql) => {
        await ensureDriveGeneration2RolloutBoundCheckpoints(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[41],
      up: async (sql) => {
        await ensureMemoryDeletionBarriers(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[42],
      up: async (sql) => {
        await ensureMemoryAccessScopeShadow(sql);
        await ensureTenantIsolationPolicies(sql);
      },
    },
    {
      ...databaseSchemaMigrations[43],
      up: ensureMemoryAccessSessionContractShadow,
    },
    {
      ...databaseSchemaMigrations[44],
      up: ensureMemoryAccessAuthorizationDenyHook,
    },
    {
      ...databaseSchemaMigrations[45],
      up: ensureCanonicalAuthUserActorIdsShadow,
    },
    {
      ...databaseSchemaMigrations[46],
      up: ensureMemoryPurposeCatalog,
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
      await pg.begin(async (tx) => {
        await setMigrationDatabaseRole(tx);
        const configuredTimeout = Number(
          process.env.OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS,
        );
        const statementTimeoutMs = Number.isFinite(configuredTimeout)
          ? Math.min(Math.max(configuredTimeout, 30_000), 3_600_000)
          : 600_000;
        await tx`SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`;
        const sql = wrapPg(tx, true);
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
          await setMigrationDatabaseRole(tx);
          await tx`SELECT set_config('omni.system_scope', 'true', true)`;
          await tx`SELECT set_config('omni.system_reason', 'optional vector schema maintenance', true)`;
          await ensureVectorSchema(wrapPg(tx, true));
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

async function setMigrationDatabaseRole(tx: postgres.TransactionSql<Record<string, never>>) {
  const role = process.env.MIGRATION_DATABASE_ROLE?.trim();
  if (!role) return;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) {
    throw new Error("MIGRATION_DATABASE_ROLE must be a valid PostgreSQL role name.");
  }
  await tx.unsafe(`SET LOCAL ROLE "${role}"`);
}

async function verifyDatabaseSchema() {
  return verifyDatabaseSchemaWithClient(getRawPg());
}

export async function verifyDatabaseSchemaWithClient(pg: AnyPg) {
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
    { allowFutureVersions: true },
  );
  const pending = getPendingSchemaMigrationVersions(
    appliedRows.map((row) => Number(row.version)),
    { allowFutureVersions: true },
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
  return postgres(databaseUrl, {
    prepare: false, // required for Supabase transaction-mode pooler (Supavisor)
    ssl: databaseSslConfiguration(databaseUrl, label),
    max: getDatabasePoolMax(),
    idle_timeout: getDatabasePoolIdleTimeoutSeconds(),
    // postgres.js implements max_lifetime with another JavaScript timer. As
    // with idle_timeout, that timer can expire while a Vercel isolate is
    // frozen and race the first reservation after thaw. Durable processes keep
    // the driver's randomized default so long-lived sockets are still rotated.
    ...(process.env.VERCEL ? { max_lifetime: null } : {}),
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
function wrapPg(pg: AnyPg, transactionScoped = false): SqlClient {
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
      return await withReservedDatabaseTransaction(pg, async (tx) => {
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

  Object.defineProperty(scoped, "transactionScoped", {
    value: scopeAlreadyApplied,
    enumerable: false,
  });

  // Only callback transactions are safe here. Promise arrays begin executing
  // before pg.begin can apply tenant scope and therefore cannot be atomic.
  scoped.transaction = (queriesOrFn: unknown) => {
    const scope = databaseScope.getStore();
    if (typeof queriesOrFn !== "function") {
      throw new Error("Database transactions require an async callback.");
    }
    return withReservedDatabaseTransaction(pg, async (tx) => {
      await applyDatabaseScope(tx, scope);
      const txScoped = createTenantScopedSqlClient(tx, true);
      const result = (queriesOrFn as (s: SqlClient) => unknown)(txScoped);
      return Array.isArray(result) ? Promise.all(result) : result;
    });
  };

  return scoped;
}

async function withReservedDatabaseConnection<T>(
  pg: AnyPg,
  operation: (reserved: AnyPg) => Promise<T>,
): Promise<T> {
  const { reserved, releaseAdmission } = await reserveDatabaseConnection(pg);
  try {
    return await operation(reserved);
  } finally {
    releaseReservedDatabaseConnection(reserved);
    releaseAdmission();
  }
}

async function withReservedDatabaseTransaction<T>(
  pg: AnyPg,
  operation: (reserved: AnyPg) => Promise<T>,
): Promise<T> {
  return withReservedDatabaseConnection(pg, async (reserved) => {
    await reserved.unsafe("BEGIN");
    try {
      // The deletion barrier relies on a fresh statement snapshot after a
      // writer waits for the tenant graph lock. Pin managed transactions to
      // READ COMMITTED before applyDatabaseScope performs its first SELECT;
      // inherited REPEATABLE READ/SERIALIZABLE defaults could otherwise retain
      // a pre-forget snapshot and resurrect descendant lineage.
      await reserved.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const result = await operation(reserved);
      await reserved.unsafe("COMMIT");
      return result;
    } catch (error) {
      try {
        await reserved.unsafe("ROLLBACK");
      } catch {
        // Preserve the operation/commit error. The reserved connection is
        // released below and postgres.js will discard it if it is unusable.
      }
      throw error;
    }
  });
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

const databaseAdmissionGates = new WeakMap<object, DatabaseAdmissionGate>();

function databaseAcquireTimeoutError(timeoutMs: number) {
  return Object.assign(
    new Error(
      `Database connection acquisition timed out after ${timeoutMs}ms.`,
    ),
    { code: "DATABASE_ACQUIRE_TIMEOUT" },
  );
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
  const pendingReservation = Promise.resolve().then(() => pg.reserve());

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutError = databaseAcquireTimeoutError(timeoutMs);
      retireTimedOutVercelDatabaseClient(pg, timeoutError);
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
            retireTimedOutVercelDatabaseClient(pg, timeoutError);
            reject(timeoutError);
          }
          releaseReservedDatabaseConnection(reserved);
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

function retireTimedOutVercelDatabaseClient(pg: AnyPg, error: Error) {
  // A postgres.js reserve cannot be canceled independently. On Vercel's
  // enforced one-slot pools, a reserve caught behind a thaw-time connection
  // close can otherwise retain the sole admission permit indefinitely. Rotate
  // only the exact poisoned singleton; durable and wider pools may have valid
  // concurrent work and must never be terminated by one caller's timeout.
  if (!process.env.VERCEL || getDatabasePoolMax() !== 1) return;

  const runtimeClientTimedOut = sqlClient === pg;
  const maintenanceClientTimedOut = maintenanceSqlClient === pg;
  if (!runtimeClientTimedOut && !maintenanceClientTimedOut) return;

  retireDatabaseAdmissionGate(pg, error);

  if (runtimeClientTimedOut) {
    sqlClient = null;
    scopedSqlClient = null;
    schemaReady = null;
  }
  if (maintenanceClientTimedOut) {
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

function retireDatabaseAdmissionGate(pg: AnyPg, error: Error) {
  const gate = databaseAdmissionGates.get(pg as object);
  if (!gate || gate.retired) return;
  gate.retired = true;
  gate.retirementError = error;
  while (gate.waiters.length > 0) {
    gate.waiters.shift()?.fail(error);
  }
}

function releaseReservedDatabaseConnection(reserved: AnyPg) {
  try {
    reserved.release();
  } catch {
    // A closed/broken connection is already unavailable to the pool. Never let
    // release cleanup replace the query result or the acquisition-timeout error.
  }
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
  const statementTimeoutMs = getDatabaseStatementTimeoutMs();
  const lockTimeoutMs = getDatabaseLockTimeoutMs(statementTimeoutMs);
  const idleTransactionTimeoutMs = getDatabaseIdleTransactionTimeoutMs();
  await sql`
    SELECT
      set_config('omni.tenant_id', ${tenantId}, true),
      set_config('omni.system_scope', ${systemScope ? "true" : "false"}, true),
      set_config('omni.system_reason', ${systemReason}, true),
      set_config('statement_timeout', ${String(statementTimeoutMs)}, true),
      set_config('lock_timeout', ${String(lockTimeoutMs)}, true),
      set_config('idle_in_transaction_session_timeout', ${String(idleTransactionTimeoutMs)}, true)
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
  await ensureClaimBasedMemory(sql);
  await ensureOAuthGrants(sql);
  await ensureTodayItems(sql);
  await ensureProactiveDailyBriefs(sql);
  await ensurePersonalNotificationCenter(sql);
  await ensurePersonalProjects(sql);
  await ensureCaptureRecordings(sql);
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
      agent_id TEXT NOT NULL DEFAULT 'atlas',
      specialist_ids TEXT[] NOT NULL DEFAULT '{}',
      feedback JSONB,
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
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS grounding JSONB`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'atlas'`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS specialist_ids TEXT[] NOT NULL DEFAULT '{}'`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS feedback JSONB`;
  await ensurePersistedAnswerGrounding(sql);
  await ensureAgentAssignmentHistory(sql);
  await ensureAgentOutcomeFeedback(sql);
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_started_at_idx ON omni_agent_runs (started_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_tenant_started_at_idx ON omni_agent_runs (tenant_id, started_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_status_idx ON omni_agent_runs (status)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_consolidated_at_idx ON omni_agent_runs (consolidated_at DESC)`;

  await ensureConversationThreads(sql);

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
      effect_receipt JSONB,
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
  await ensureGovernedToolEffectReceipts(sql);
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
      workflow_run_id TEXT,
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
      workflow_run_id TEXT,
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

  await ensureMobileSessions(sql);

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
  await ensureProjectArtifacts(sql);
  await ensurePlatformSafetyTables(sql);
}

async function ensureClaimBasedMemory(sql: SqlClient) {
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS claim_status TEXT NOT NULL DEFAULT 'active'`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS asserted_by TEXT NOT NULL DEFAULT 'system'`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS evidence_refs TEXT[] NOT NULL DEFAULT '{}'`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS supersedes_id TEXT`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS contradiction_of_id TEXT`;
  await sql`ALTER TABLE omni_memories ADD COLUMN IF NOT EXISTS forgotten_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_claim_status_idx ON omni_memories (tenant_id, claim_status, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_memories_supersedes_idx ON omni_memories (tenant_id, supersedes_id)`;
}

async function ensurePersistedAnswerGrounding(sql: SqlClient) {
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS grounding JSONB`;
}

async function ensureOAuthGrants(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_oauth_grants (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      sealed_tokens JSONB NOT NULL,
      expires_at TIMESTAMPTZ,
      sync_cursor TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, provider)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_oauth_grants_tenant_actor_idx ON omni_oauth_grants (tenant_id, actor_id, updated_at DESC)`;
}

async function ensureAgentAssignmentHistory(sql: SqlClient) {
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'atlas'`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS specialist_ids TEXT[] NOT NULL DEFAULT '{}'`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_tenant_agent_idx ON omni_agent_runs (tenant_id, agent_id, started_at DESC)`;
}

async function ensureAgentOutcomeFeedback(sql: SqlClient) {
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS feedback JSONB`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_tenant_feedback_idx ON omni_agent_runs (tenant_id, agent_id, started_at DESC) WHERE feedback IS NOT NULL`;
}

async function ensureTodayItems(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_today_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'task',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      due_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_today_items_tenant_actor_status_idx ON omni_today_items (tenant_id, actor_id, status, due_at, created_at DESC)`;
}

async function ensureProactiveDailyBriefs(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_today_preferences (
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      brief_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      brief_time TEXT NOT NULL DEFAULT '08:00',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      reminder_lead_minutes INTEGER NOT NULL DEFAULT 30,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, actor_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_today_preferences_schedule_idx ON omni_today_preferences (tenant_id, brief_enabled, updated_at)`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_daily_briefs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      content JSONB NOT NULL DEFAULT '{}',
      generated_by TEXT NOT NULL DEFAULT 'system',
      model TEXT,
      source_counts JSONB NOT NULL DEFAULT '{}',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, local_date)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_daily_briefs_tenant_actor_date_idx ON omni_daily_briefs (tenant_id, actor_id, local_date DESC)`;
}

async function ensurePersonalNotificationCenter(sql: SqlClient) {
  await ensureProactiveDailyBriefs(sql);
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS quiet_hours_start TEXT NOT NULL DEFAULT '22:00'`;
  await sql`ALTER TABLE omni_today_preferences ADD COLUMN IF NOT EXISTS quiet_hours_end TEXT NOT NULL DEFAULT '07:00'`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_personal_notifications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'reminder',
      source_type TEXT NOT NULL DEFAULT 'today_item',
      source_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      urgency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      due_at TIMESTAMPTZ NOT NULL,
      snoozed_until TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, source_type, source_id, occurrence_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_personal_notifications_inbox_idx ON omni_personal_notifications (tenant_id, actor_id, status, updated_at DESC)`;
}

async function ensurePersonalProjects(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      autonomy_mode TEXT NOT NULL DEFAULT 'manual',
      execution_status TEXT NOT NULL DEFAULT 'idle',
      task_budget INTEGER NOT NULL DEFAULT 12,
      tasks_dispatched INTEGER NOT NULL DEFAULT 0,
      max_parallel_tasks INTEGER NOT NULL DEFAULT 1,
      require_approval BOOLEAN NOT NULL DEFAULT TRUE,
      last_synced_at TIMESTAMPTZ,
      target_date TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_projects_owner_status_idx ON omni_projects (tenant_id, actor_id, status, updated_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_project_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES omni_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      agent_id TEXT NOT NULL DEFAULT 'atlas',
      position INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'manual',
      due_at TIMESTAMPTZ,
      dependency_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      workflow_run_id TEXT,
      workflow_status TEXT,
      execution_error TEXT,
      dispatched_at TIMESTAMPTZ,
      dispatch_attempt INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_tasks_project_position_idx ON omni_project_tasks (tenant_id, project_id, position, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_tasks_workflow_idx ON omni_project_tasks (tenant_id, workflow_run_id) WHERE workflow_run_id IS NOT NULL`;
}

async function ensureAutonomousProjectExecution(sql: SqlClient) {
  await ensurePersonalProjects(sql);
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS autonomy_mode TEXT NOT NULL DEFAULT 'manual'`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'idle'`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS task_budget INTEGER NOT NULL DEFAULT 12`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS tasks_dispatched INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS max_parallel_tasks INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE omni_projects ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS dependency_ids JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS workflow_run_id TEXT`;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'omni_project_tasks_workflow_run_fk'
      ) THEN
        ALTER TABLE omni_project_tasks
          ADD CONSTRAINT omni_project_tasks_workflow_run_fk
          FOREIGN KEY (workflow_run_id) REFERENCES omni_workflow_runs(id) ON DELETE SET NULL;
      END IF;
    END
    $migration$
  `;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS workflow_status TEXT`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS execution_error TEXT`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_project_tasks ADD COLUMN IF NOT EXISTS dispatch_attempt INTEGER NOT NULL DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_tasks_workflow_idx ON omni_project_tasks (tenant_id, workflow_run_id) WHERE workflow_run_id IS NOT NULL`;
}

async function ensureProjectArtifacts(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_project_artifacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES omni_projects(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES omni_project_tasks(id) ON DELETE CASCADE,
      workflow_run_id TEXT NOT NULL REFERENCES omni_workflow_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL,
      source_memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL,
      evidence_refs TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, workflow_run_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_artifacts_project_created_idx ON omni_project_artifacts (tenant_id, project_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_artifacts_task_idx ON omni_project_artifacts (tenant_id, task_id, created_at DESC)`;
}

async function ensureProjectArtifactReflections(sql: SqlClient) {
  await ensureProjectArtifacts(sql);
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS verdict TEXT`;
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS lesson TEXT`;
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS reflection_memory_id TEXT REFERENCES omni_memories(id) ON DELETE SET NULL`;
  await sql`ALTER TABLE omni_project_artifacts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS omni_project_artifacts_reviewed_idx ON omni_project_artifacts (tenant_id, agent_id, reviewed_at DESC) WHERE verdict IS NOT NULL`;
}

async function ensureCaptureRecordings(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_capture_assets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      extension TEXT NOT NULL DEFAULT '',
      byte_count INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      storage_kind TEXT NOT NULL DEFAULT 'database',
      content BYTEA NOT NULL,
      status TEXT NOT NULL DEFAULT 'stored',
      extraction_status TEXT NOT NULL DEFAULT 'pending',
      ingest_job_id TEXT,
      knowledge_document_id TEXT,
      error TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_assets_owner_updated_idx
    ON omni_capture_assets (tenant_id, actor_id, updated_at DESC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_capture_recordings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      language TEXT NOT NULL DEFAULT 'en-US',
      tags TEXT[] NOT NULL DEFAULT '{}',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      duration_ms BIGINT NOT NULL DEFAULT 0,
      byte_count BIGINT NOT NULL DEFAULT 0,
      segment_count INTEGER NOT NULL DEFAULT 0,
      transcript TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      knowledge_document_id TEXT,
      ingest_job_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_recordings_owner_updated_idx
    ON omni_capture_recordings (tenant_id, actor_id, updated_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_recordings_source_idx
    ON omni_capture_recordings (tenant_id, source)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_capture_segments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      recording_id TEXT NOT NULL REFERENCES omni_capture_recordings(id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      audio_sha256 TEXT NOT NULL,
      audio_data BYTEA NOT NULL,
      transcript TEXT NOT NULL DEFAULT '',
      transcription_status TEXT NOT NULL DEFAULT 'pending',
      transcription_model TEXT,
      transcription_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, recording_id, segment_index)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_capture_segments_recording_idx
    ON omni_capture_segments (tenant_id, actor_id, recording_id, segment_index ASC)
  `;
}

async function ensureOAuthIncrementalSyncHealth(sql: SqlClient) {
  await ensureOAuthGrants(sql);
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'idle'`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS sync_error TEXT`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_oauth_grants ADD COLUMN IF NOT EXISTS synced_items INTEGER NOT NULL DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS omni_oauth_grants_sync_health_idx ON omni_oauth_grants (tenant_id, actor_id, sync_status, last_synced_at DESC)`;
}

async function ensureAgentSkillStudio(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_custom_skills (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      tool_ids TEXT[] NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}',
      knowledge_tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, slug)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_custom_skills_owner_updated_idx ON omni_custom_skills (tenant_id, actor_id, updated_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_custom_agents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      accent TEXT NOT NULL DEFAULT 'emerald',
      model_policy TEXT NOT NULL DEFAULT 'auto',
      autonomy TEXT NOT NULL DEFAULT 'governed',
      approval_policy TEXT NOT NULL DEFAULT 'risk_based',
      memory_scope TEXT NOT NULL DEFAULT 'all',
      skill_ids TEXT[] NOT NULL DEFAULT '{}',
      tool_ids TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, slug)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_custom_agents_owner_updated_idx ON omni_custom_agents (tenant_id, actor_id, updated_at DESC)`;
}

async function ensureMissionKernel(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_missions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'archived')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      source TEXT NOT NULL DEFAULT 'user',
      source_key TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, source_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_missions_owner_status_idx ON omni_missions (tenant_id, actor_id, status, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mission_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      mission_id TEXT NOT NULL REFERENCES omni_missions(id) ON DELETE CASCADE,
      parent_task_id TEXT REFERENCES omni_mission_tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      definition_of_done TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('triage', 'pending', 'running', 'blocked', 'review', 'succeeded', 'failed', 'canceled')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      position INTEGER NOT NULL DEFAULT 0,
      source_key TEXT NOT NULL,
      dependency_ids TEXT[] NOT NULL DEFAULT '{}',
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, mission_id, source_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_tasks_mission_status_idx ON omni_mission_tasks (tenant_id, actor_id, mission_id, status, position, created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mission_attempts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      mission_id TEXT NOT NULL REFERENCES omni_missions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES omni_mission_tasks(id) ON DELETE CASCADE,
      executor_key TEXT NOT NULL,
      executor_type TEXT NOT NULL DEFAULT 'agent',
      executor_id TEXT NOT NULL,
      fence_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled')),
      agent_run_id TEXT REFERENCES omni_agent_runs(id) ON DELETE SET NULL,
      workflow_run_id TEXT REFERENCES omni_workflow_runs(id) ON DELETE SET NULL,
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      output JSONB,
      error TEXT,
      started_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, task_id, executor_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_attempts_mission_status_idx ON omni_mission_attempts (tenant_id, actor_id, mission_id, status, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_attempts_task_created_idx ON omni_mission_attempts (tenant_id, actor_id, task_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_attempts_executor_idx ON omni_mission_attempts (tenant_id, actor_id, executor_type, executor_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mission_artifacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      mission_id TEXT NOT NULL REFERENCES omni_missions(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES omni_mission_tasks(id) ON DELETE SET NULL,
      attempt_id TEXT REFERENCES omni_mission_attempts(id) ON DELETE SET NULL,
      source_key TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'result',
      title TEXT NOT NULL,
      uri TEXT,
      mime_type TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, mission_id, source_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_artifacts_mission_created_idx ON omni_mission_artifacts (tenant_id, actor_id, mission_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mission_artifacts_attempt_idx ON omni_mission_artifacts (tenant_id, actor_id, attempt_id) WHERE attempt_id IS NOT NULL`;
}

async function ensureMissionKanbanTaskMetadata(sql: SqlClient) {
  await sql`ALTER TABLE omni_mission_tasks ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`ALTER TABLE omni_mission_tasks DROP CONSTRAINT IF EXISTS omni_mission_tasks_status_check`;
  await sql`
    ALTER TABLE omni_mission_tasks
    ADD CONSTRAINT omni_mission_tasks_status_check
    CHECK (status IN ('triage', 'pending', 'running', 'blocked', 'review', 'succeeded', 'failed', 'canceled'))
  `;
}

async function ensureSettingsControlPlane(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_provider_connections (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      provider TEXT NOT NULL
        CHECK (provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'needs_validation'
        CHECK (status IN ('needs_validation', 'validating', 'connected', 'error', 'disabled', 'revoked')),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
      credential_key_id TEXT NOT NULL,
      credential_fingerprint TEXT,
      configured_fields TEXT[] NOT NULL DEFAULT '{}',
      sealed_credentials JSONB NOT NULL,
      last_validated_at TIMESTAMPTZ,
      validation_code TEXT,
      catalog_refreshed_at TIMESTAMPTZ,
      rotated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, provider)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_provider_connections_tenant_actor_idx ON omni_provider_connections (tenant_id, actor_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_model_catalog (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      provider TEXT NOT NULL
        CHECK (provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      capabilities TEXT[] NOT NULL DEFAULT '{}',
      lifecycle TEXT NOT NULL DEFAULT 'unknown'
        CHECK (lifecycle IN ('available', 'deprecated', 'retiring', 'unknown')),
      lifecycle_reason TEXT,
      lifecycle_checked_at TIMESTAMPTZ,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, provider, model_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_model_catalog_tenant_actor_provider_idx ON omni_model_catalog (tenant_id, actor_id, provider, lifecycle, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_model_assignments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      scope TEXT NOT NULL
        CHECK (scope IN ('main_agent', 'orchestrator', 'workflow', 'council', 'memory', 'embeddings', 'vision', 'audio')),
      provider TEXT NOT NULL
        CHECK (provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      model_id TEXT NOT NULL,
      fallback_provider TEXT
        CHECK (fallback_provider IS NULL OR fallback_provider IN ('openai', 'google', 'anthropic', 'aws_bedrock')),
      fallback_model_id TEXT,
      allow_cross_provider_fallback BOOLEAN NOT NULL DEFAULT FALSE,
      runtime_readiness TEXT NOT NULL DEFAULT 'configuration_only'
        CHECK (runtime_readiness = 'configuration_only'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, actor_id, scope),
      CHECK ((fallback_provider IS NULL) = (fallback_model_id IS NULL)),
      CHECK (
        fallback_provider IS NULL
        OR fallback_provider = provider
        OR allow_cross_provider_fallback
      )
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_model_assignments_tenant_actor_idx ON omni_model_assignments (tenant_id, actor_id, scope)`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_service_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      token_last_four TEXT NOT NULL CHECK (char_length(token_last_four) = 4),
      scopes TEXT[] NOT NULL DEFAULT '{}'
        CHECK (scopes <@ ARRAY[
          'mcp:discover', 'mcp:tools:list', 'mcp:tools:execute',
          'missions:read', 'missions:write', 'memory:read', 'memory:write',
          'runs:read', 'settings:read'
        ]::TEXT[]),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_service_api_keys_tenant_actor_idx ON omni_service_api_keys (tenant_id, actor_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_service_api_keys_expiry_idx ON omni_service_api_keys (expires_at) WHERE status = 'active'`;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_mcp_export_configurations (
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      server_name TEXT NOT NULL DEFAULT 'Asael',
      allowed_scopes TEXT[] NOT NULL DEFAULT '{mcp:discover,mcp:tools:list}'
        CHECK (allowed_scopes <@ ARRAY[
          'mcp:discover', 'mcp:tools:list', 'mcp:tools:execute',
          'missions:read', 'missions:write', 'memory:read', 'memory:write',
          'runs:read', 'settings:read'
        ]::TEXT[]),
      default_approval_mode TEXT NOT NULL DEFAULT 'governed'
        CHECK (default_approval_mode = 'governed'),
      expose_resources BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, actor_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mcp_export_configurations_tenant_actor_idx ON omni_mcp_export_configurations (tenant_id, actor_id)`;
}

async function ensureAsaelCanonicalIdentity(sql: SqlClient) {
  // Keep the physical omni_* schema stable for existing data and rollback;
  // migrate only the product identity stored in this user-visible setting.
  await sql`
    ALTER TABLE omni_mcp_export_configurations
    ALTER COLUMN server_name SET DEFAULT 'Asael'
  `;
  await sql`
    UPDATE omni_mcp_export_configurations
    SET server_name = 'Asael',
        updated_at = NOW()
    WHERE server_name = 'OmniAgent'
  `;
}

async function ensureGovernedToolEffectReceipts(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_tool_executions
    ADD COLUMN IF NOT EXISTS effect_receipt JSONB
  `;
}

async function ensureCanonicalSourceLineageShadow(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_source_contract_id_is_valid(value TEXT)
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT value IS NOT NULL
        AND value = btrim(value)
        AND char_length(value) BETWEEN 1 AND 240
        AND value ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_source_id_array_is_canonical(
      values_to_check TEXT[],
      maximum_entries INTEGER
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT values_to_check IS NOT NULL
        AND maximum_entries > 0
        AND cardinality(values_to_check) BETWEEN 1 AND maximum_entries
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT
              value,
              lag(value) OVER (ORDER BY ordinal_position) AS previous_value
            FROM unnest(values_to_check)
              WITH ORDINALITY AS entry(value, ordinal_position)
          ) ordered_values
          WHERE NOT omni_source_contract_id_is_valid(value)
            OR (
              previous_value IS NOT NULL
              AND value COLLATE "C" <= previous_value COLLATE "C"
            )
        )
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_jsonb_safe_integer(
      value_to_check JSONB,
      minimum_value BIGINT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(value_to_check) IS DISTINCT FROM 'number' THEN FALSE
        WHEN value_to_check #>> '{}' !~ '^(0|[1-9][0-9]*)$' THEN FALSE
        ELSE (value_to_check #>> '{}')::NUMERIC
          BETWEEN minimum_value AND 9007199254740991
      END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_jsonb_safe_integer_value(
      value_to_check JSONB
    )
    RETURNS NUMERIC
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT CASE
        WHEN omni_jsonb_safe_integer(value_to_check, 0)
          THEN (value_to_check #>> '{}')::NUMERIC
        ELSE NULL
      END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_evidence_locator_v1_is_allowlisted(
      locator_value JSONB
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(locator_value) <> 'object' THEN FALSE
        WHEN locator_value ->> 'kind' = 'text_span' THEN
          locator_value ?& ARRAY[
            'kind', 'offsetUnit', 'startOffset', 'endOffsetExclusive',
            'containerLength', 'containerSha256'
          ]
          AND locator_value - ARRAY[
            'kind', 'offsetUnit', 'startOffset', 'endOffsetExclusive',
            'containerLength', 'containerSha256'
          ] = '{}'::JSONB
          AND locator_value ->> 'offsetUnit' IN (
            'unicode_code_point', 'utf16_code_unit', 'utf8_byte'
          )
          AND omni_jsonb_safe_integer(locator_value -> 'startOffset', 0)
          AND omni_jsonb_safe_integer(locator_value -> 'endOffsetExclusive', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'containerLength', 1)
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endOffsetExclusive'
          ) > omni_jsonb_safe_integer_value(locator_value -> 'startOffset')
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endOffsetExclusive'
          ) <= omni_jsonb_safe_integer_value(locator_value -> 'containerLength')
          AND locator_value ->> 'containerSha256' ~ '^[0-9a-f]{64}$'
        WHEN locator_value ->> 'kind' = 'page' THEN
          locator_value ?& ARRAY['kind', 'pageNumber', 'pageCount']
          AND locator_value - ARRAY['kind', 'pageNumber', 'pageCount'] = '{}'::JSONB
          AND omni_jsonb_safe_integer(locator_value -> 'pageNumber', 1)
          AND (
            locator_value -> 'pageCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'pageCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'pageNumber'
              ) <= omni_jsonb_safe_integer_value(locator_value -> 'pageCount')
            )
          )
        WHEN locator_value ->> 'kind' = 'sheet_range' THEN
          locator_value ?& ARRAY[
            'kind', 'sheetKeySha256', 'startRow', 'endRowExclusive',
            'startColumn', 'endColumnExclusive', 'sheetRowCount',
            'sheetColumnCount'
          ]
          AND locator_value - ARRAY[
            'kind', 'sheetKeySha256', 'startRow', 'endRowExclusive',
            'startColumn', 'endColumnExclusive', 'sheetRowCount',
            'sheetColumnCount'
          ] = '{}'::JSONB
          AND locator_value ->> 'sheetKeySha256' ~ '^[0-9a-f]{64}$'
          AND omni_jsonb_safe_integer(locator_value -> 'startRow', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'endRowExclusive', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'startColumn', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'endColumnExclusive', 1)
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endRowExclusive'
          ) > omni_jsonb_safe_integer_value(locator_value -> 'startRow')
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endColumnExclusive'
          ) > omni_jsonb_safe_integer_value(locator_value -> 'startColumn')
          AND (
            locator_value -> 'sheetRowCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'sheetRowCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'endRowExclusive'
              ) <= omni_jsonb_safe_integer_value(
                locator_value -> 'sheetRowCount'
              ) + 1
            )
          )
          AND (
            locator_value -> 'sheetColumnCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'sheetColumnCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'endColumnExclusive'
              ) <= omni_jsonb_safe_integer_value(
                locator_value -> 'sheetColumnCount'
              ) + 1
            )
          )
        WHEN locator_value ->> 'kind' = 'slide' THEN
          locator_value ?& ARRAY[
            'kind', 'slideNumber', 'slideCount', 'elementKeySha256'
          ]
          AND locator_value - ARRAY[
            'kind', 'slideNumber', 'slideCount', 'elementKeySha256'
          ] = '{}'::JSONB
          AND omni_jsonb_safe_integer(locator_value -> 'slideNumber', 1)
          AND (
            locator_value -> 'slideCount' = 'null'::JSONB
            OR (
              omni_jsonb_safe_integer(locator_value -> 'slideCount', 1)
              AND omni_jsonb_safe_integer_value(
                locator_value -> 'slideNumber'
              ) <= omni_jsonb_safe_integer_value(locator_value -> 'slideCount')
            )
          )
          AND (
            locator_value -> 'elementKeySha256' = 'null'::JSONB
            OR locator_value ->> 'elementKeySha256' ~ '^[0-9a-f]{64}$'
          )
        WHEN locator_value ->> 'kind' = 'email_section' THEN
          locator_value ?& ARRAY[
            'kind', 'section', 'sectionIndex', 'partKeySha256'
          ]
          AND locator_value - ARRAY[
            'kind', 'section', 'sectionIndex', 'partKeySha256'
          ] = '{}'::JSONB
          AND locator_value ->> 'section' IN (
            'headers', 'subject', 'body', 'attachment'
          )
          AND omni_jsonb_safe_integer(locator_value -> 'sectionIndex', 0)
          AND (
            locator_value -> 'partKeySha256' = 'null'::JSONB
            OR locator_value ->> 'partKeySha256' ~ '^[0-9a-f]{64}$'
          )
        WHEN locator_value ->> 'kind' = 'image_region' THEN
          locator_value ?& ARRAY[
            'kind', 'coordinateUnit', 'x', 'y', 'width', 'height',
            'imageWidth', 'imageHeight'
          ]
          AND locator_value - ARRAY[
            'kind', 'coordinateUnit', 'x', 'y', 'width', 'height',
            'imageWidth', 'imageHeight'
          ] = '{}'::JSONB
          AND locator_value ->> 'coordinateUnit' = 'pixel'
          AND omni_jsonb_safe_integer(locator_value -> 'x', 0)
          AND omni_jsonb_safe_integer(locator_value -> 'y', 0)
          AND omni_jsonb_safe_integer(locator_value -> 'width', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'height', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'imageWidth', 1)
          AND omni_jsonb_safe_integer(locator_value -> 'imageHeight', 1)
          AND omni_jsonb_safe_integer_value(locator_value -> 'x')
            + omni_jsonb_safe_integer_value(locator_value -> 'width')
            <= omni_jsonb_safe_integer_value(locator_value -> 'imageWidth')
          AND omni_jsonb_safe_integer_value(locator_value -> 'y')
            + omni_jsonb_safe_integer_value(locator_value -> 'height')
            <= omni_jsonb_safe_integer_value(locator_value -> 'imageHeight')
        WHEN locator_value ->> 'kind' = 'media_time_range' THEN
          locator_value ?& ARRAY[
            'kind', 'mediaKind', 'startMilliseconds',
            'endMillisecondsExclusive', 'durationMilliseconds'
          ]
          AND locator_value - ARRAY[
            'kind', 'mediaKind', 'startMilliseconds',
            'endMillisecondsExclusive', 'durationMilliseconds'
          ] = '{}'::JSONB
          AND locator_value ->> 'mediaKind' IN ('audio', 'video')
          AND omni_jsonb_safe_integer(
            locator_value -> 'startMilliseconds',
            0
          )
          AND omni_jsonb_safe_integer(
            locator_value -> 'endMillisecondsExclusive',
            1
          )
          AND omni_jsonb_safe_integer(
            locator_value -> 'durationMilliseconds',
            1
          )
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endMillisecondsExclusive'
          ) > omni_jsonb_safe_integer_value(
            locator_value -> 'startMilliseconds'
          )
          AND omni_jsonb_safe_integer_value(
            locator_value -> 'endMillisecondsExclusive'
          ) <= omni_jsonb_safe_integer_value(
            locator_value -> 'durationMilliseconds'
          )
        ELSE FALSE
      END
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_adapter_output_receipts (
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_adapter_output_receipts_pkey
        PRIMARY KEY (tenant_id, adapter_output_id),
      CONSTRAINT omni_source_adapter_output_receipts_envelope_key
        UNIQUE (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        ),
      CONSTRAINT omni_source_adapter_output_receipts_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_adapter_output'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_source_adapter_output_receipts_required_ids_check CHECK (
        omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
      ),
      CONSTRAINT omni_source_adapter_output_receipts_hashes_check CHECK (
        adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_items (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      metadata_sha256 TEXT NOT NULL,
      source_created_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      extractor_id TEXT NOT NULL,
      extractor_version_id TEXT NOT NULL,
      extractor_config_sha256 TEXT NOT NULL,
      model_version_id TEXT,
      source_item_sha256 TEXT NOT NULL,
      current_revision_id TEXT,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_items_tenant_id_id_key
        UNIQUE (tenant_id, id),
      CONSTRAINT omni_source_items_tenant_scope_key
        UNIQUE (tenant_id, id, owner_actor_id, connection_id),
      CONSTRAINT omni_source_items_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_items_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_item'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_source_items_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_items_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_source_items_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_source_items_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_source_items_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(extractor_id)
        AND omni_source_contract_id_is_valid(extractor_version_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          model_version_id IS NULL
          OR omni_source_contract_id_is_valid(model_version_id)
        )
        AND (
          current_revision_id IS NULL
          OR omni_source_contract_id_is_valid(current_revision_id)
        )
      ),
      CONSTRAINT omni_source_items_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_source_items_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND metadata_sha256 ~ '^[0-9a-f]{64}$'
        AND extractor_config_sha256 ~ '^[0-9a-f]{64}$'
        AND source_item_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_items_source_timestamps_check CHECK (
        source_created_at IS NULL
        OR source_updated_at IS NULL
        OR source_created_at <= source_updated_at
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_revisions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      previous_source_revision_id TEXT,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      provider_revision_key_sha256 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      content_byte_length BIGINT NOT NULL,
      media_type TEXT NOT NULL,
      metadata_sha256 TEXT NOT NULL,
      source_created_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      extractor_id TEXT NOT NULL,
      extractor_version_id TEXT NOT NULL,
      extractor_config_sha256 TEXT NOT NULL,
      model_version_id TEXT,
      source_revision_sha256 TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_revisions_tenant_id_id_key
        UNIQUE (tenant_id, id),
      CONSTRAINT omni_source_revisions_tenant_item_key
        UNIQUE (tenant_id, id, source_item_id),
      CONSTRAINT omni_source_revisions_tenant_scope_key
        UNIQUE (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        ),
      CONSTRAINT omni_source_revisions_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_revisions_source_item_fkey
        FOREIGN KEY (tenant_id, source_item_id, owner_actor_id, connection_id)
        REFERENCES omni_source_items (
          tenant_id,
          id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_revisions_previous_revision_fkey
        FOREIGN KEY (tenant_id, previous_source_revision_id, source_item_id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT omni_source_revisions_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_revision'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_source_revisions_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_revisions_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_source_revisions_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_source_revisions_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_source_revisions_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(extractor_id)
        AND omni_source_contract_id_is_valid(extractor_version_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          previous_source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(previous_source_revision_id)
        )
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          model_version_id IS NULL
          OR omni_source_contract_id_is_valid(model_version_id)
        )
      ),
      CONSTRAINT omni_source_revisions_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_source_revisions_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_revision_key_sha256 ~ '^[0-9a-f]{64}$'
        AND content_sha256 ~ '^[0-9a-f]{64}$'
        AND metadata_sha256 ~ '^[0-9a-f]{64}$'
        AND extractor_config_sha256 ~ '^[0-9a-f]{64}$'
        AND source_revision_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_revisions_content_length_check
        CHECK (content_byte_length BETWEEN 0 AND 9007199254740991),
      CONSTRAINT omni_source_revisions_previous_revision_check CHECK (
        previous_source_revision_id IS NULL
        OR previous_source_revision_id <> id
      ),
      CONSTRAINT omni_source_revisions_media_type_check CHECK (
        char_length(media_type) BETWEEN 3 AND 160
        AND media_type ~* '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'
      ),
      CONSTRAINT omni_source_revisions_source_timestamps_check CHECK (
        source_created_at IS NULL
        OR source_updated_at IS NULL
        OR source_created_at <= source_updated_at
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_evidence_units (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_revision_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      evidence_content_sha256 TEXT NOT NULL,
      evidence_byte_length BIGINT NOT NULL,
      locator JSONB NOT NULL,
      locator_sha256 TEXT NOT NULL,
      source_created_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      extracted_at TIMESTAMPTZ NOT NULL,
      extractor_id TEXT NOT NULL,
      extractor_version_id TEXT NOT NULL,
      extractor_config_sha256 TEXT NOT NULL,
      model_version_id TEXT,
      evidence_unit_sha256 TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_evidence_units_tenant_id_id_key
        UNIQUE (tenant_id, id),
      CONSTRAINT omni_evidence_units_tenant_revision_key
        UNIQUE (tenant_id, id, source_revision_id),
      CONSTRAINT omni_evidence_units_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_evidence_units_revision_fkey
        FOREIGN KEY (
          tenant_id,
          source_revision_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_revisions (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_evidence_units_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'evidence_unit'
        AND adapter_operation = 'upsert'
      ),
      CONSTRAINT omni_evidence_units_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_evidence_units_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_evidence_units_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_evidence_units_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_evidence_units_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(source_revision_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(extractor_id)
        AND omni_source_contract_id_is_valid(extractor_version_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          model_version_id IS NULL
          OR omni_source_contract_id_is_valid(model_version_id)
        )
      ),
      CONSTRAINT omni_evidence_units_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_evidence_units_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND evidence_content_sha256 ~ '^[0-9a-f]{64}$'
        AND locator_sha256 ~ '^[0-9a-f]{64}$'
        AND extractor_config_sha256 ~ '^[0-9a-f]{64}$'
        AND evidence_unit_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_evidence_units_content_length_check
        CHECK (evidence_byte_length BETWEEN 0 AND 9007199254740991),
      CONSTRAINT omni_evidence_units_locator_check
        CHECK (omni_evidence_locator_v1_is_allowlisted(locator)),
      CONSTRAINT omni_evidence_units_source_timestamps_check CHECK (
        source_created_at IS NULL
        OR source_updated_at IS NULL
        OR source_created_at <= source_updated_at
      )
    )
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_items_current_revision_fkey'
          AND conrelid = 'omni_source_items'::regclass
      ) THEN
        ALTER TABLE omni_source_items
        ADD CONSTRAINT omni_source_items_current_revision_fkey
        FOREIGN KEY (tenant_id, current_revision_id, id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_revision_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM omni_source_items source_item
        WHERE source_item.tenant_id = NEW.tenant_id
          AND source_item.id = NEW.source_item_id
          AND source_item.owner_actor_id = NEW.owner_actor_id
          AND source_item.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
          AND source_item.project_id IS NOT DISTINCT FROM NEW.project_id
          AND source_item.mission_id IS NOT DISTINCT FROM NEW.mission_id
          AND source_item.connection_id = NEW.connection_id
          AND source_item.visibility = NEW.visibility
          AND source_item.sensitivity = NEW.sensitivity
          AND source_item.source_kind = NEW.source_kind
          AND source_item.provider_item_key_sha256 = NEW.provider_item_key_sha256
          AND source_item.source_created_at IS NOT DISTINCT FROM NEW.source_created_at
          AND source_item.source_updated_at IS NOT DISTINCT FROM NEW.source_updated_at
          AND source_item.captured_at = NEW.captured_at
          AND NEW.permission_grant_ids <@ source_item.permission_grant_ids
          AND NEW.allowed_purpose_ids <@ source_item.allowed_purpose_ids
          AND NEW.retention_policy_id = source_item.retention_policy_id
          AND (
            source_item.retention_expires_at IS NULL
            OR (
              NEW.retention_expires_at IS NOT NULL
              AND NEW.retention_expires_at <= source_item.retention_expires_at
            )
          )
      ) THEN
        RAISE EXCEPTION 'Source revision binding does not match its source item'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_evidence_unit_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM omni_source_revisions source_revision
        WHERE source_revision.tenant_id = NEW.tenant_id
          AND source_revision.id = NEW.source_revision_id
          AND source_revision.source_item_id = NEW.source_item_id
          AND source_revision.owner_actor_id = NEW.owner_actor_id
          AND source_revision.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
          AND source_revision.project_id IS NOT DISTINCT FROM NEW.project_id
          AND source_revision.mission_id IS NOT DISTINCT FROM NEW.mission_id
          AND source_revision.connection_id = NEW.connection_id
          AND source_revision.visibility = NEW.visibility
          AND source_revision.sensitivity = NEW.sensitivity
          AND source_revision.source_kind = NEW.source_kind
          AND source_revision.provider_item_key_sha256 = NEW.provider_item_key_sha256
          AND source_revision.source_created_at IS NOT DISTINCT FROM NEW.source_created_at
          AND source_revision.source_updated_at IS NOT DISTINCT FROM NEW.source_updated_at
          AND source_revision.captured_at = NEW.captured_at
          AND source_revision.adapter_output_id = NEW.adapter_output_id
          AND source_revision.adapter_output_sha256 = NEW.adapter_output_sha256
          AND source_revision.adapter_id = NEW.adapter_id
          AND source_revision.adapter_version_id = NEW.adapter_version_id
          AND source_revision.adapter_config_sha256 = NEW.adapter_config_sha256
          AND source_revision.adapter_event_key_sha256 = NEW.adapter_event_key_sha256
          AND source_revision.adapter_observed_at = NEW.adapter_observed_at
          AND NEW.permission_grant_ids <@ source_revision.permission_grant_ids
          AND NEW.allowed_purpose_ids <@ source_revision.allowed_purpose_ids
          AND NEW.retention_policy_id = source_revision.retention_policy_id
          AND (
            source_revision.retention_expires_at IS NULL
            OR (
              NEW.retention_expires_at IS NOT NULL
              AND NEW.retention_expires_at <= source_revision.retention_expires_at
            )
          )
      ) THEN
        RAISE EXCEPTION 'Evidence unit binding does not match its source revision'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_revisions_validate_binding'
          AND tgrelid = 'omni_source_revisions'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_revisions_validate_binding
        BEFORE INSERT ON omni_source_revisions
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_revision_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_evidence_units_validate_binding'
          AND tgrelid = 'omni_evidence_units'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_evidence_units_validate_binding
        BEFORE INSERT ON omni_evidence_units
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_evidence_unit_binding();
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_knowledge_documents
    ADD COLUMN IF NOT EXISTS source_item_id TEXT
  `;
  await sql`
    ALTER TABLE omni_knowledge_documents
    ADD COLUMN IF NOT EXISTS source_revision_id TEXT
  `;
  await sql`
    ALTER TABLE omni_knowledge_chunks
    ADD COLUMN IF NOT EXISTS source_revision_id TEXT
  `;
  await sql`
    ALTER TABLE omni_knowledge_chunks
    ADD COLUMN IF NOT EXISTS evidence_unit_id TEXT
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_id_id_idx
    ON omni_knowledge_documents (tenant_id, id)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_revision_idx
    ON omni_knowledge_documents (tenant_id, id, source_revision_id)
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_documents_lineage_pair_check'
          AND conrelid = 'omni_knowledge_documents'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_documents
        ADD CONSTRAINT omni_knowledge_documents_lineage_pair_check
        CHECK (
          (source_item_id IS NULL AND source_revision_id IS NULL)
          OR (source_item_id IS NOT NULL AND source_revision_id IS NOT NULL)
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_documents_source_revision_fkey'
          AND conrelid = 'omni_knowledge_documents'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_documents
        ADD CONSTRAINT omni_knowledge_documents_source_revision_fkey
        FOREIGN KEY (tenant_id, source_revision_id, source_item_id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT;
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_lineage_pair_check'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_lineage_pair_check
        CHECK (
          (source_revision_id IS NULL AND evidence_unit_id IS NULL)
          OR (source_revision_id IS NOT NULL AND evidence_unit_id IS NOT NULL)
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_tenant_document_fkey'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_tenant_document_fkey
        FOREIGN KEY (tenant_id, document_id)
        REFERENCES omni_knowledge_documents (tenant_id, id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_document_revision_fkey'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_document_revision_fkey
        FOREIGN KEY (tenant_id, document_id, source_revision_id)
        REFERENCES omni_knowledge_documents (tenant_id, id, source_revision_id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_knowledge_chunks_evidence_revision_fkey'
          AND conrelid = 'omni_knowledge_chunks'::regclass
      ) THEN
        ALTER TABLE omni_knowledge_chunks
        ADD CONSTRAINT omni_knowledge_chunks_evidence_revision_fkey
        FOREIGN KEY (tenant_id, evidence_unit_id, source_revision_id)
        REFERENCES omni_evidence_units (tenant_id, id, source_revision_id)
        ON DELETE RESTRICT;
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_immutable_source_lineage_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% rows are immutable; % is not permitted',
        TG_TABLE_NAME,
        TG_OP
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_adapter_output_receipt_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% rows are immutable; % is not permitted',
        TG_TABLE_NAME,
        TG_OP
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_adapter_output_receipts_immutable'
          AND tgrelid = 'omni_source_adapter_output_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_adapter_output_receipts_immutable
        BEFORE UPDATE OR DELETE ON omni_source_adapter_output_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_adapter_output_receipt_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_adapter_output_receipts_no_truncate'
          AND tgrelid = 'omni_source_adapter_output_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_adapter_output_receipts_no_truncate
        BEFORE TRUNCATE ON omni_source_adapter_output_receipts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_adapter_output_receipt_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_revisions_immutable'
          AND tgrelid = 'omni_source_revisions'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_revisions_immutable
        BEFORE UPDATE OR DELETE ON omni_source_revisions
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_revisions_no_truncate'
          AND tgrelid = 'omni_source_revisions'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_revisions_no_truncate
        BEFORE TRUNCATE ON omni_source_revisions
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_evidence_units_immutable'
          AND tgrelid = 'omni_evidence_units'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_evidence_units_immutable
        BEFORE UPDATE OR DELETE ON omni_evidence_units
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_evidence_units_no_truncate'
          AND tgrelid = 'omni_evidence_units'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_evidence_units_no_truncate
        BEFORE TRUNCATE ON omni_evidence_units
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;
    END
    $migration$
  `;

  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_actor_updated_idx ON omni_source_items (tenant_id, owner_actor_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_scope_idx ON omni_source_items (tenant_id, workspace_id, project_id, mission_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_provider_key_idx ON omni_source_items (tenant_id, connection_id, provider_item_key_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_current_revision_idx ON omni_source_items (tenant_id, current_revision_id) WHERE current_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_tenant_adapter_output_idx ON omni_source_items (tenant_id, adapter_output_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_items_retention_expiry_idx ON omni_source_items (retention_expires_at) WHERE retention_expires_at IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_item_captured_idx ON omni_source_revisions (tenant_id, source_item_id, captured_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_content_hash_idx ON omni_source_revisions (tenant_id, content_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_provider_revision_idx ON omni_source_revisions (tenant_id, source_item_id, provider_revision_key_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_previous_idx ON omni_source_revisions (tenant_id, previous_source_revision_id) WHERE previous_source_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_tenant_adapter_output_idx ON omni_source_revisions (tenant_id, adapter_output_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_source_revisions_retention_expiry_idx ON omni_source_revisions (retention_expires_at) WHERE retention_expires_at IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_tenant_revision_locator_idx ON omni_evidence_units (tenant_id, source_revision_id, locator_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_tenant_content_hash_idx ON omni_evidence_units (tenant_id, evidence_content_sha256)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_tenant_adapter_output_idx ON omni_evidence_units (tenant_id, adapter_output_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_permission_grants_idx ON omni_evidence_units USING GIN (permission_grant_ids)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_evidence_units_retention_expiry_idx ON omni_evidence_units (retention_expires_at) WHERE retention_expires_at IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_documents_tenant_source_revision_idx ON omni_knowledge_documents (tenant_id, source_revision_id) WHERE source_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tenant_source_revision_idx ON omni_knowledge_chunks (tenant_id, source_revision_id) WHERE source_revision_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_knowledge_chunks_tenant_evidence_unit_idx ON omni_knowledge_chunks (tenant_id, evidence_unit_id) WHERE evidence_unit_id IS NOT NULL`;

  // New lineage tables inherit only the DML capabilities already granted on
  // the existing knowledge-document boundary. This keeps dedicated runtime,
  // maintenance, and backup roles working without hard-coding role names.
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
      target_table TEXT;
    BEGIN
      FOREACH target_table IN ARRAY ARRAY[
        'omni_source_adapter_output_receipts',
        'omni_source_revisions',
        'omni_evidence_units'
      ] LOOP
        FOR grant_record IN
          SELECT DISTINCT grantee, privilege_type
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name = 'omni_knowledge_documents'
            AND privilege_type IN ('SELECT', 'INSERT')
            AND grantee <> current_user
            AND grantee <> 'PUBLIC'
        LOOP
          EXECUTE format(
            'GRANT %s ON TABLE %I.%I TO %I',
            grant_record.privilege_type,
            current_schema(),
            target_table,
            grant_record.grantee
          );
        END LOOP;
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_knowledge_documents'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_source_items TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
}

async function ensureDriveSyncV2ShadowCheckpoints(sql: SqlClient) {
  await ensureOAuthGrants(sql);

  await sql`
    ALTER TABLE omni_oauth_grants
    ADD COLUMN IF NOT EXISTS authorization_generation BIGINT
  `;
  await sql`
    UPDATE omni_oauth_grants
    SET authorization_generation = 1
    WHERE authorization_generation IS NULL
       OR authorization_generation < 1
  `;
  await sql`
    ALTER TABLE omni_oauth_grants
    ALTER COLUMN authorization_generation SET DEFAULT 1
  `;
  await sql`
    ALTER TABLE omni_oauth_grants
    ALTER COLUMN authorization_generation SET NOT NULL
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_oauth_grants_authorization_generation_check'
          AND conrelid = 'omni_oauth_grants'::regclass
      ) THEN
        ALTER TABLE omni_oauth_grants
        ADD CONSTRAINT omni_oauth_grants_authorization_generation_check
        CHECK (authorization_generation >= 1);
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_oauth_grants_connection_scope_key'
          AND conrelid = 'omni_oauth_grants'::regclass
      ) THEN
        ALTER TABLE omni_oauth_grants
        ADD CONSTRAINT omni_oauth_grants_connection_scope_key
        UNIQUE (tenant_id, id, actor_id, provider);
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_oauth_grants_authorization_scope_key'
          AND conrelid = 'omni_oauth_grants'::regclass
      ) THEN
        ALTER TABLE omni_oauth_grants
        ADD CONSTRAINT omni_oauth_grants_authorization_scope_key
        UNIQUE (
          tenant_id,
          id,
          actor_id,
          provider,
          authorization_generation
        );
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_source_adapter_output_receipts
    DROP CONSTRAINT IF EXISTS omni_source_adapter_output_receipts_schema_check
  `;
  await sql`
    ALTER TABLE omni_source_adapter_output_receipts
    ADD CONSTRAINT omni_source_adapter_output_receipts_schema_check CHECK (
      schema_version = 1
      AND contract_kind = 'source_adapter_output'
      AND adapter_operation IN ('upsert', 'delete')
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_adapter_output_receipts_tenant_output_digest_idx
    ON omni_source_adapter_output_receipts (
      tenant_id,
      adapter_output_id,
      adapter_output_sha256
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_sync_page_checkpoints (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'google',
      source_id TEXT NOT NULL DEFAULT 'drive',
      engine_version TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      authorization_generation BIGINT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      phase TEXT NOT NULL,
      page_sequence BIGINT NOT NULL,
      request_cursor_sealed JSONB,
      request_cursor_sha256 TEXT,
      fence_cursor_sha256 TEXT,
      observed_at TIMESTAMPTZ,
      manifest_sha256 TEXT,
      item_count INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      lease_owner_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      lease_generation BIGINT NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      failure_code TEXT,
      failure_sha256 TEXT,
      committed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_sync_page_checkpoints_scope_key
        UNIQUE (
          tenant_id,
          id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          engine_version,
          authorization_generation,
          rollout_generation,
          page_sequence
        ),
      CONSTRAINT omni_source_sync_page_checkpoints_page_key
        UNIQUE (
          tenant_id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          authorization_generation,
          rollout_generation,
          page_sequence
        ),
      CONSTRAINT omni_source_sync_page_checkpoints_oauth_scope_fkey
        FOREIGN KEY (
          tenant_id,
          connection_id,
          owner_actor_id,
          provider
        )
        REFERENCES omni_oauth_grants (
          tenant_id,
          id,
          actor_id,
          provider
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_page_checkpoints_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_source_check CHECK (
        provider = 'google'
        AND source_id = 'drive'
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(provider)
        AND omni_source_contract_id_is_valid(source_id)
        AND omni_source_contract_id_is_valid(engine_version)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          lease_owner_id IS NULL
          OR omni_source_contract_id_is_valid(lease_owner_id)
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_hashes_check CHECK (
        adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          request_cursor_sha256 IS NULL
          OR request_cursor_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          fence_cursor_sha256 IS NULL
          OR fence_cursor_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          manifest_sha256 IS NULL
          OR manifest_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          failure_sha256 IS NULL
          OR failure_sha256 ~ '^[0-9a-f]{64}$'
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_cursor_pair_check CHECK (
        (
          request_cursor_sealed IS NULL
          AND request_cursor_sha256 IS NULL
          AND fence_cursor_sha256 IS NULL
        )
        OR (
          request_cursor_sealed IS NOT NULL
          AND (
            request_cursor_sha256 IS NOT NULL
            OR fence_cursor_sha256 IS NOT NULL
          )
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_sealed_cursor_check CHECK (
        request_cursor_sealed IS NULL
        OR (
          jsonb_typeof(request_cursor_sealed) = 'object'
          AND request_cursor_sealed ?& ARRAY[
            'version', 'algorithm', 'iv', 'ciphertext', 'tag'
          ]
          AND request_cursor_sealed - ARRAY[
            'version', 'algorithm', 'iv', 'ciphertext', 'tag'
          ] = '{}'::JSONB
          AND jsonb_typeof(request_cursor_sealed -> 'version') = 'number'
          AND request_cursor_sealed ->> 'version' = '1'
          AND jsonb_typeof(request_cursor_sealed -> 'algorithm') = 'string'
          AND request_cursor_sealed ->> 'algorithm' = 'aes-256-gcm'
          AND jsonb_typeof(request_cursor_sealed -> 'iv') = 'string'
          AND request_cursor_sealed ->> 'iv' ~ '^[A-Za-z0-9_-]{16}$'
          AND jsonb_typeof(request_cursor_sealed -> 'tag') = 'string'
          AND request_cursor_sealed ->> 'tag' ~ '^[A-Za-z0-9_-]{22}$'
          AND jsonb_typeof(request_cursor_sealed -> 'ciphertext') = 'string'
          AND request_cursor_sealed ->> 'ciphertext' ~ '^[A-Za-z0-9_-]*$'
          AND char_length(request_cursor_sealed ->> 'ciphertext') <= 32768
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_phase_check CHECK (
        phase IN ('backfill', 'changes')
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_status_check CHECK (
        status IN (
          'open', 'leased', 'observed', 'committed',
          'dead_letter', 'superseded'
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_counts_check CHECK (
        authorization_generation >= 1
        AND rollout_generation >= 1
        AND page_sequence >= 0
        AND lease_generation >= 0
        AND attempts >= 0
        AND (
          item_count IS NULL
          OR item_count BETWEEN 0 AND 1000
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_observation_check CHECK (
        (
          observed_at IS NULL
          AND manifest_sha256 IS NULL
          AND item_count IS NULL
        )
        OR (
          observed_at IS NOT NULL
          AND manifest_sha256 IS NOT NULL
          AND item_count IS NOT NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_lease_check CHECK (
        (
          status IN ('leased', 'observed')
          AND lease_owner_id IS NOT NULL
          AND lease_expires_at IS NOT NULL
        )
        OR (
          status NOT IN ('leased', 'observed')
          AND lease_owner_id IS NULL
          AND lease_expires_at IS NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_failure_check CHECK (
        (failure_code IS NULL) = (failure_sha256 IS NULL)
        AND (
          failure_code IS NULL
          OR (
            char_length(failure_code) BETWEEN 1 AND 120
            AND failure_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
          )
        )
        AND (
          status <> 'dead_letter'
          OR failure_code IS NOT NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_commit_check CHECK (
        (
          status = 'committed'
          AND committed_at IS NOT NULL
          AND observed_at IS NOT NULL
          AND manifest_sha256 IS NOT NULL
          AND item_count IS NOT NULL
          AND request_cursor_sealed IS NOT NULL
          AND fence_cursor_sha256 IS NOT NULL
        )
        OR (
          status <> 'committed'
          AND committed_at IS NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_checkpoints_timestamps_check CHECK (
        created_at <= updated_at
        AND (committed_at IS NULL OR committed_at <= updated_at)
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_sync_page_items (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'google',
      source_id TEXT NOT NULL DEFAULT 'drive',
      engine_version TEXT NOT NULL,
      authorization_generation BIGINT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      phase_rank SMALLINT NOT NULL,
      page_sequence BIGINT NOT NULL,
      ordinal INTEGER NOT NULL,
      operation TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      provider_revision_key_sha256 TEXT,
      adapter_event_key_sha256 TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      manifest_item_sha256 TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'shadow_observed',
      source_item_id TEXT,
      source_revision_id TEXT,
      adapter_output_id TEXT,
      adapter_output_sha256 TEXT,
      delete_reason_code TEXT,
      last_known_revision_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_sha256 TEXT,
      next_retry_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_sync_page_items_checkpoint_ordinal_key
        UNIQUE (tenant_id, checkpoint_id, ordinal),
      CONSTRAINT omni_source_sync_page_items_checkpoint_event_key
        UNIQUE (tenant_id, checkpoint_id, adapter_event_key_sha256),
      CONSTRAINT omni_source_sync_page_items_checkpoint_fkey
        FOREIGN KEY (
          tenant_id,
          checkpoint_id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          engine_version,
          authorization_generation,
          rollout_generation,
          page_sequence
        )
        REFERENCES omni_source_sync_page_checkpoints (
          tenant_id,
          id,
          owner_actor_id,
          connection_id,
          provider,
          source_id,
          engine_version,
          authorization_generation,
          rollout_generation,
          page_sequence
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_page_items_adapter_output_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_page_items_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_source_sync_page_items_source_check CHECK (
        provider = 'google'
        AND source_id = 'drive'
      ),
      CONSTRAINT omni_source_sync_page_items_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(checkpoint_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(provider)
        AND omni_source_contract_id_is_valid(source_id)
        AND omni_source_contract_id_is_valid(engine_version)
        AND (
          source_item_id IS NULL
          OR omni_source_contract_id_is_valid(source_item_id)
        )
        AND (
          source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(source_revision_id)
        )
        AND (
          adapter_output_id IS NULL
          OR omni_source_contract_id_is_valid(adapter_output_id)
        )
        AND (
          last_known_revision_id IS NULL
          OR omni_source_contract_id_is_valid(last_known_revision_id)
        )
      ),
      CONSTRAINT omni_source_sync_page_items_hashes_check CHECK (
        provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          provider_revision_key_sha256 IS NULL
          OR provider_revision_key_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
        AND manifest_item_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          adapter_output_sha256 IS NULL
          OR adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        )
        AND (
          error_sha256 IS NULL
          OR error_sha256 ~ '^[0-9a-f]{64}$'
        )
      ),
      CONSTRAINT omni_source_sync_page_items_order_check CHECK (
        authorization_generation >= 1
        AND rollout_generation >= 1
        AND phase_rank IN (0, 1)
        AND page_sequence >= 0
        AND ordinal BETWEEN 0 AND 999
        AND attempts >= 0
      ),
      CONSTRAINT omni_source_sync_page_items_operation_check CHECK (
        operation IN ('upsert', 'delete')
      ),
      CONSTRAINT omni_source_sync_page_items_outcome_check CHECK (
        outcome IN (
          'shadow_observed', 'pending', 'applied', 'noop', 'dead_letter'
        )
      ),
      CONSTRAINT omni_source_sync_page_items_adapter_output_pair_check CHECK (
        (adapter_output_id IS NULL) = (adapter_output_sha256 IS NULL)
      ),
      CONSTRAINT omni_source_sync_page_items_delete_check CHECK (
        (
          operation = 'upsert'
          AND delete_reason_code IS NULL
          AND last_known_revision_id IS NULL
        )
        OR (
          operation = 'delete'
          AND (
            delete_reason_code IS NULL
            OR delete_reason_code IN (
              'provider_deleted', 'access_revoked',
              'connection_removed', 'source_missing'
            )
          )
        )
      ),
      CONSTRAINT omni_source_sync_page_items_error_check CHECK (
        (error_code IS NULL) = (error_sha256 IS NULL)
        AND (
          error_code IS NULL
          OR (
            char_length(error_code) BETWEEN 1 AND 120
            AND error_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
          )
        )
        AND (
          outcome = 'dead_letter'
          OR (
            error_code IS NULL
            AND next_retry_at IS NULL
          )
        )
        AND (
          outcome <> 'dead_letter'
          OR error_code IS NOT NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_items_applied_check CHECK (
        (
          outcome = 'applied'
          AND applied_at IS NOT NULL
          AND source_item_id IS NOT NULL
          AND adapter_output_id IS NOT NULL
          AND (
            (operation = 'upsert' AND source_revision_id IS NOT NULL)
            OR (operation = 'delete' AND delete_reason_code IS NOT NULL)
          )
        )
        OR (
          outcome = 'noop'
          AND applied_at IS NOT NULL
          AND source_item_id IS NOT NULL
        )
        OR (
          outcome NOT IN ('applied', 'noop')
          AND applied_at IS NULL
        )
      ),
      CONSTRAINT omni_source_sync_page_items_timestamps_check CHECK (
        created_at <= updated_at
        AND (applied_at IS NULL OR applied_at <= updated_at)
      )
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_one_nonterminal_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation
    )
    WHERE status NOT IN ('committed', 'superseded')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_checkpoints_due_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      status,
      lease_expires_at,
      updated_at
    )
    WHERE status NOT IN ('committed', 'superseded')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_items_outcome_idx
    ON omni_source_sync_page_items (
      tenant_id,
      checkpoint_id,
      outcome,
      ordinal
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_items_source_order_idx
    ON omni_source_sync_page_items (
      tenant_id,
      owner_actor_id,
      connection_id,
      source_item_id,
      authorization_generation DESC,
      rollout_generation DESC,
      phase_rank DESC,
      page_sequence DESC,
      ordinal DESC
    )
    WHERE source_item_id IS NOT NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_checkpoint_scope()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM 1
      FROM omni_oauth_grants grant_record
      WHERE grant_record.tenant_id = NEW.tenant_id
        AND grant_record.id = NEW.connection_id
        AND grant_record.actor_id = NEW.owner_actor_id
        AND grant_record.provider = NEW.provider
        AND grant_record.status = 'active'
        AND grant_record.authorization_generation =
          NEW.authorization_generation
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Source sync checkpoint authorization is stale'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_checkpoint()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      stored_item_count BIGINT;
      unresolved_item_count BIGINT;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF OLD.status IN ('committed', 'superseded') THEN
        RAISE EXCEPTION '% terminal rows are immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.adapter_version_id IS DISTINCT FROM OLD.adapter_version_id
        OR NEW.adapter_config_sha256 IS DISTINCT FROM OLD.adapter_config_sha256
        OR NEW.authorization_generation IS DISTINCT FROM OLD.authorization_generation
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.phase IS DISTINCT FROM OLD.phase
        OR NEW.page_sequence IS DISTINCT FROM OLD.page_sequence
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF (OLD.request_cursor_sealed IS NOT NULL AND
          NEW.request_cursor_sealed IS DISTINCT FROM OLD.request_cursor_sealed)
        OR (OLD.request_cursor_sha256 IS NOT NULL AND
          NEW.request_cursor_sha256 IS DISTINCT FROM OLD.request_cursor_sha256)
        OR (OLD.fence_cursor_sha256 IS NOT NULL AND
          NEW.fence_cursor_sha256 IS DISTINCT FROM OLD.fence_cursor_sha256)
        OR (
          OLD.manifest_sha256 IS NOT NULL
          AND (
            NEW.observed_at IS DISTINCT FROM OLD.observed_at
            OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
            OR NEW.item_count IS DISTINCT FROM OLD.item_count
          )
        )
      THEN
        RAISE EXCEPTION '% initialized cursor or manifest is immutable',
          TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.lease_generation < OLD.lease_generation
        OR NEW.attempts < OLD.attempts
      THEN
        RAISE EXCEPTION '% counters cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF OLD.status <> 'committed' AND NEW.status = 'committed' THEN
        SELECT
          COUNT(*),
          COUNT(*) FILTER (
            WHERE item.outcome IN ('pending', 'dead_letter')
          )
        INTO stored_item_count, unresolved_item_count
        FROM omni_source_sync_page_items item
        WHERE item.tenant_id = NEW.tenant_id
          AND item.checkpoint_id = NEW.id
          AND item.owner_actor_id = NEW.owner_actor_id
          AND item.connection_id = NEW.connection_id
          AND item.provider = NEW.provider
          AND item.source_id = NEW.source_id
          AND item.engine_version = NEW.engine_version
          AND item.authorization_generation = NEW.authorization_generation
          AND item.rollout_generation = NEW.rollout_generation
          AND item.page_sequence = NEW.page_sequence;

        IF NEW.item_count IS NULL
          OR stored_item_count <> NEW.item_count
          OR unresolved_item_count <> 0
        THEN
          RAISE EXCEPTION 'Source sync committed page manifest is incomplete'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_page_item_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checkpoint_phase TEXT;
      checkpoint_status TEXT;
      expected_phase_rank SMALLINT;
    BEGIN
      SELECT checkpoint.phase, checkpoint.status
      INTO checkpoint_phase, checkpoint_status
      FROM omni_source_sync_page_checkpoints checkpoint
      WHERE checkpoint.tenant_id = NEW.tenant_id
        AND checkpoint.id = NEW.checkpoint_id
        AND checkpoint.owner_actor_id = NEW.owner_actor_id
        AND checkpoint.connection_id = NEW.connection_id
        AND checkpoint.provider = NEW.provider
        AND checkpoint.source_id = NEW.source_id
        AND checkpoint.engine_version = NEW.engine_version
        AND checkpoint.authorization_generation = NEW.authorization_generation
        AND checkpoint.rollout_generation = NEW.rollout_generation
        AND checkpoint.page_sequence = NEW.page_sequence
      FOR UPDATE;

      IF checkpoint_phase = 'backfill' THEN
        expected_phase_rank := 0;
      ELSIF checkpoint_phase = 'changes' THEN
        expected_phase_rank := 1;
      ELSE
        expected_phase_rank := -1;
      END IF;

      IF checkpoint_phase IS NULL
        OR NEW.phase_rank <> expected_phase_rank
      THEN
        RAISE EXCEPTION 'Source sync page item does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'INSERT' AND checkpoint_status <> 'leased' THEN
        RAISE EXCEPTION 'Source sync page items require an active page lease'
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_page_item()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF OLD.outcome IN ('shadow_observed', 'applied', 'noop') THEN
        RAISE EXCEPTION '% terminal outcomes are immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.authorization_generation IS DISTINCT FROM OLD.authorization_generation
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.phase_rank IS DISTINCT FROM OLD.phase_rank
        OR NEW.page_sequence IS DISTINCT FROM OLD.page_sequence
        OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
        OR NEW.operation IS DISTINCT FROM OLD.operation
        OR NEW.provider_item_key_sha256 IS DISTINCT FROM OLD.provider_item_key_sha256
        OR NEW.provider_revision_key_sha256 IS DISTINCT FROM OLD.provider_revision_key_sha256
        OR NEW.adapter_event_key_sha256 IS DISTINCT FROM OLD.adapter_event_key_sha256
        OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
        OR NEW.manifest_item_sha256 IS DISTINCT FROM OLD.manifest_item_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF (OLD.source_item_id IS NOT NULL AND
          NEW.source_item_id IS DISTINCT FROM OLD.source_item_id)
        OR (OLD.source_revision_id IS NOT NULL AND
          NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id)
        OR (OLD.adapter_output_id IS NOT NULL AND
          NEW.adapter_output_id IS DISTINCT FROM OLD.adapter_output_id)
        OR (OLD.adapter_output_sha256 IS NOT NULL AND
          NEW.adapter_output_sha256 IS DISTINCT FROM OLD.adapter_output_sha256)
        OR (OLD.delete_reason_code IS NOT NULL AND
          NEW.delete_reason_code IS DISTINCT FROM OLD.delete_reason_code)
        OR (OLD.last_known_revision_id IS NOT NULL AND
          NEW.last_known_revision_id IS DISTINCT FROM OLD.last_known_revision_id)
      THEN
        RAISE EXCEPTION '% initialized outcome bindings are immutable',
          TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION '% attempts cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_checkpoints_validate_scope'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_checkpoints_validate_scope
        BEFORE INSERT ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_checkpoint_scope();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_checkpoints_protect'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_checkpoints_protect
        BEFORE UPDATE OR DELETE ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_source_sync_checkpoint();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_checkpoints_no_truncate'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_checkpoints_no_truncate
        BEFORE TRUNCATE ON omni_source_sync_page_checkpoints
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_source_sync_checkpoint();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_validate_binding'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_validate_binding
        BEFORE INSERT OR UPDATE ON omni_source_sync_page_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_page_item_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_protect'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_protect
        BEFORE UPDATE OR DELETE ON omni_source_sync_page_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_source_sync_page_item();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_no_truncate'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_no_truncate
        BEFORE TRUNCATE ON omni_source_sync_page_items
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_source_sync_page_item();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
      grant_mapping RECORD;
    BEGIN
      FOR grant_mapping IN
        SELECT *
        FROM (VALUES
          ('omni_source_sync_page_checkpoints', 'omni_oauth_grants'),
          ('omni_source_sync_page_items', 'omni_source_items')
        ) AS mappings(target_table, source_table)
      LOOP
        FOR grant_record IN
          SELECT DISTINCT grantee, privilege_type
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name = grant_mapping.source_table
            AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
            AND grantee <> current_user
            AND grantee <> 'PUBLIC'
        LOOP
          EXECUTE format(
            'GRANT %s ON TABLE %I.%I TO %I',
            grant_record.privilege_type,
            current_schema(),
            grant_mapping.target_table,
            grant_record.grantee
          );
        END LOOP;
      END LOOP;
    END
    $migration$
  `);
}

async function ensureCanonicalSourceConvergenceFoundation(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_tombstones (
      id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      contract_kind TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      connection_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      permission_grant_ids TEXT[] NOT NULL,
      allowed_purpose_ids TEXT[] NOT NULL,
      retention_policy_id TEXT NOT NULL,
      retention_expires_at TIMESTAMPTZ,
      permission_set_sha256 TEXT NOT NULL,
      purpose_set_sha256 TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      last_known_source_revision_id TEXT,
      delete_reason TEXT NOT NULL,
      tombstone_sha256 TEXT NOT NULL,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      adapter_operation TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version_id TEXT NOT NULL,
      adapter_config_sha256 TEXT NOT NULL,
      adapter_event_key_sha256 TEXT NOT NULL,
      adapter_observed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_tombstones_pkey
        PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_source_tombstones_tenant_item_key
        UNIQUE (tenant_id, id, source_item_id),
      CONSTRAINT omni_source_tombstones_adapter_output_key
        UNIQUE (tenant_id, adapter_output_id),
      CONSTRAINT omni_source_tombstones_source_item_fkey
        FOREIGN KEY (
          tenant_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_items (
          tenant_id,
          id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_tombstones_last_known_revision_fkey
        FOREIGN KEY (
          tenant_id,
          last_known_source_revision_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_revisions (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_tombstones_adapter_output_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256,
          connection_id,
          adapter_operation,
          adapter_id,
          adapter_version_id,
          adapter_config_sha256,
          adapter_event_key_sha256,
          adapter_observed_at
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_tombstones_schema_check CHECK (
        schema_version = 1
        AND contract_kind = 'source_tombstone'
        AND adapter_operation = 'delete'
      ),
      CONSTRAINT omni_source_tombstones_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_tombstones_visibility_check CHECK (
        visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
      ),
      CONSTRAINT omni_source_tombstones_sensitivity_check CHECK (
        sensitivity IN ('public', 'internal', 'confidential', 'restricted')
      ),
      CONSTRAINT omni_source_tombstones_visibility_scope_check CHECK (
        (visibility <> 'workspace_shared' OR workspace_id IS NOT NULL)
        AND (visibility <> 'project_shared' OR project_id IS NOT NULL)
        AND (visibility <> 'mission_shared' OR mission_id IS NOT NULL)
      ),
      CONSTRAINT omni_source_tombstones_required_ids_check CHECK (
        omni_source_contract_id_is_valid(id)
        AND omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(retention_policy_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND omni_source_contract_id_is_valid(adapter_id)
        AND omni_source_contract_id_is_valid(adapter_version_id)
        AND (
          workspace_id IS NULL
          OR omni_source_contract_id_is_valid(workspace_id)
        )
        AND (
          project_id IS NULL
          OR omni_source_contract_id_is_valid(project_id)
        )
        AND (
          mission_id IS NULL
          OR omni_source_contract_id_is_valid(mission_id)
        )
        AND (
          last_known_source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(last_known_source_revision_id)
        )
      ),
      CONSTRAINT omni_source_tombstones_grants_check CHECK (
        omni_source_id_array_is_canonical(permission_grant_ids, 128)
        AND omni_source_id_array_is_canonical(allowed_purpose_ids, 64)
      ),
      CONSTRAINT omni_source_tombstones_hashes_check CHECK (
        permission_set_sha256 ~ '^[0-9a-f]{64}$'
        AND purpose_set_sha256 ~ '^[0-9a-f]{64}$'
        AND provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND tombstone_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_config_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_event_key_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_tombstones_delete_reason_check CHECK (
        delete_reason IN (
          'provider_deleted', 'access_revoked',
          'connection_removed', 'source_missing'
        )
      )
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_source_sync_heads (
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      provider_item_key_sha256 TEXT NOT NULL,
      absence_observed BOOLEAN NOT NULL DEFAULT FALSE,
      authorization_generation BIGINT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      phase_rank SMALLINT NOT NULL,
      page_sequence BIGINT NOT NULL,
      ordinal INTEGER NOT NULL,
      operation TEXT NOT NULL,
      source_revision_id TEXT,
      source_tombstone_id TEXT,
      adapter_output_id TEXT NOT NULL,
      adapter_output_sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_source_sync_heads_pkey
        PRIMARY KEY (tenant_id, source_item_id),
      CONSTRAINT omni_source_sync_heads_source_revision_fkey
        FOREIGN KEY (
          tenant_id,
          source_revision_id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        REFERENCES omni_source_revisions (
          tenant_id,
          id,
          source_item_id,
          owner_actor_id,
          connection_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_heads_source_tombstone_fkey
        FOREIGN KEY (tenant_id, source_tombstone_id, source_item_id)
        REFERENCES omni_source_tombstones (tenant_id, id, source_item_id)
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_heads_adapter_output_fkey
        FOREIGN KEY (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        REFERENCES omni_source_adapter_output_receipts (
          tenant_id,
          adapter_output_id,
          adapter_output_sha256
        )
        ON DELETE RESTRICT,
      CONSTRAINT omni_source_sync_heads_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_source_sync_heads_required_ids_check CHECK (
        omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(source_item_id)
        AND omni_source_contract_id_is_valid(owner_actor_id)
        AND omni_source_contract_id_is_valid(connection_id)
        AND omni_source_contract_id_is_valid(adapter_output_id)
        AND (
          source_revision_id IS NULL
          OR omni_source_contract_id_is_valid(source_revision_id)
        )
        AND (
          source_tombstone_id IS NULL
          OR omni_source_contract_id_is_valid(source_tombstone_id)
        )
      ),
      CONSTRAINT omni_source_sync_heads_source_kind_check CHECK (
        source_kind IN (
          'document', 'spreadsheet', 'presentation', 'email',
          'calendar_event', 'message', 'webpage', 'image', 'audio',
          'video', 'record', 'file', 'capture'
        )
      ),
      CONSTRAINT omni_source_sync_heads_hashes_check CHECK (
        provider_item_key_sha256 ~ '^[0-9a-f]{64}$'
        AND adapter_output_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_source_sync_heads_order_check CHECK (
        authorization_generation BETWEEN 1 AND 9007199254740991
        AND rollout_generation BETWEEN 1 AND 9007199254740991
        AND phase_rank IN (0, 1)
        AND page_sequence BETWEEN 0 AND 9007199254740991
        AND ordinal BETWEEN 0 AND 999
      ),
      CONSTRAINT omni_source_sync_heads_target_check CHECK (
        (
          absence_observed
          AND operation = 'delete'
          AND source_revision_id IS NULL
          AND source_tombstone_id IS NULL
        )
        OR (
          NOT absence_observed
          AND (
            (
              operation = 'upsert'
              AND source_revision_id IS NOT NULL
              AND source_tombstone_id IS NULL
            )
            OR (
              operation = 'delete'
              AND source_revision_id IS NULL
              AND source_tombstone_id IS NOT NULL
            )
          )
        )
      ),
      CONSTRAINT omni_source_sync_heads_timestamps_check CHECK (
        created_at <= updated_at
      )
    )
  `;

  await sql`
    ALTER TABLE omni_source_sync_page_items
    ADD COLUMN IF NOT EXISTS source_tombstone_id TEXT
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_items
    ADD COLUMN IF NOT EXISTS noop_reason_code TEXT
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_source_item_fkey'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_source_item_fkey
        FOREIGN KEY (tenant_id, source_item_id)
        REFERENCES omni_source_items (tenant_id, id)
        ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_source_revision_fkey'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_source_revision_fkey
        FOREIGN KEY (tenant_id, source_revision_id, source_item_id)
        REFERENCES omni_source_revisions (tenant_id, id, source_item_id)
        ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_source_tombstone_fkey'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_source_tombstone_fkey
        FOREIGN KEY (tenant_id, source_tombstone_id, source_item_id)
        REFERENCES omni_source_tombstones (tenant_id, id, source_item_id)
        ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_convergence_ids_check'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_convergence_ids_check
        CHECK (
          source_tombstone_id IS NULL
          OR omni_source_contract_id_is_valid(source_tombstone_id)
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_source_sync_page_items_noop_reason_check'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_noop_reason_check
        CHECK (
          noop_reason_code IS NULL
          OR noop_reason_code IN ('stale', 'duplicate', 'not_found')
        );
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_source_sync_page_items
    DROP CONSTRAINT IF EXISTS omni_source_sync_page_items_applied_check
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_items
    ADD CONSTRAINT omni_source_sync_page_items_applied_check CHECK (
      (
        outcome = 'applied'
        AND applied_at IS NOT NULL
        AND source_item_id IS NOT NULL
        AND adapter_output_id IS NOT NULL
        AND noop_reason_code IS NULL
        AND (
          (
            operation = 'upsert'
            AND source_revision_id IS NOT NULL
            AND source_tombstone_id IS NULL
            AND delete_reason_code IS NULL
          )
          OR (
            operation = 'delete'
            AND source_revision_id IS NULL
            AND source_tombstone_id IS NOT NULL
            AND delete_reason_code IS NOT NULL
          )
        )
      )
      OR (
        outcome = 'noop'
        AND applied_at IS NOT NULL
        AND source_revision_id IS NULL
        AND source_tombstone_id IS NULL
        AND noop_reason_code IS NOT NULL
        AND (
          (
            noop_reason_code = 'stale'
            AND adapter_output_id IS NULL
          )
          OR (
            noop_reason_code = 'duplicate'
            AND adapter_output_id IS NOT NULL
            AND (
              operation = 'delete'
              OR source_item_id IS NOT NULL
            )
          )
          OR (
            noop_reason_code = 'not_found'
            AND adapter_output_id IS NOT NULL
            AND operation = 'delete'
            AND source_item_id IS NULL
          )
        )
      )
      OR (
        outcome NOT IN ('applied', 'noop')
        AND applied_at IS NULL
        AND source_tombstone_id IS NULL
        AND noop_reason_code IS NULL
      )
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_page_item_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checkpoint_phase TEXT;
      checkpoint_status TEXT;
      checkpoint_adapter_version_id TEXT;
      checkpoint_adapter_config_sha256 TEXT;
      expected_phase_rank SMALLINT;
    BEGIN
      SELECT
        checkpoint.phase,
        checkpoint.status,
        checkpoint.adapter_version_id,
        checkpoint.adapter_config_sha256
      INTO
        checkpoint_phase,
        checkpoint_status,
        checkpoint_adapter_version_id,
        checkpoint_adapter_config_sha256
      FROM omni_source_sync_page_checkpoints checkpoint
      WHERE checkpoint.tenant_id = NEW.tenant_id
        AND checkpoint.id = NEW.checkpoint_id
        AND checkpoint.owner_actor_id = NEW.owner_actor_id
        AND checkpoint.connection_id = NEW.connection_id
        AND checkpoint.provider = NEW.provider
        AND checkpoint.source_id = NEW.source_id
        AND checkpoint.engine_version = NEW.engine_version
        AND checkpoint.authorization_generation = NEW.authorization_generation
        AND checkpoint.rollout_generation = NEW.rollout_generation
        AND checkpoint.page_sequence = NEW.page_sequence
      FOR UPDATE;

      IF checkpoint_phase = 'backfill' THEN
        expected_phase_rank := 0;
      ELSIF checkpoint_phase = 'changes' THEN
        expected_phase_rank := 1;
      ELSE
        expected_phase_rank := -1;
      END IF;

      IF checkpoint_phase IS NULL
        OR NEW.phase_rank <> expected_phase_rank
      THEN
        RAISE EXCEPTION 'Source sync page item does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'INSERT' AND checkpoint_status <> 'leased' THEN
        RAISE EXCEPTION 'Source sync page items require an active page lease'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.adapter_output_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM omni_source_adapter_output_receipts receipt
          WHERE receipt.tenant_id = NEW.tenant_id
            AND receipt.connection_id = NEW.connection_id
            AND receipt.adapter_output_id = NEW.adapter_output_id
            AND receipt.adapter_output_sha256 = NEW.adapter_output_sha256
            AND receipt.adapter_operation = NEW.operation
            AND receipt.adapter_version_id = checkpoint_adapter_version_id
            AND receipt.adapter_config_sha256 =
              checkpoint_adapter_config_sha256
            AND receipt.adapter_event_key_sha256 =
              NEW.adapter_event_key_sha256
            AND receipt.adapter_observed_at = NEW.observed_at
        )
      THEN
        RAISE EXCEPTION 'Source sync page receipt binding is incoherent'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.outcome = 'applied' AND NEW.operation = 'upsert' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_revisions source_revision
          WHERE source_revision.tenant_id = NEW.tenant_id
            AND source_revision.id = NEW.source_revision_id
            AND source_revision.source_item_id = NEW.source_item_id
            AND source_revision.owner_actor_id = NEW.owner_actor_id
            AND source_revision.connection_id = NEW.connection_id
            AND source_revision.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND source_revision.provider_revision_key_sha256 IS NOT DISTINCT
              FROM NEW.provider_revision_key_sha256
            AND source_revision.adapter_output_id = NEW.adapter_output_id
            AND source_revision.adapter_output_sha256 =
              NEW.adapter_output_sha256
            AND source_revision.adapter_operation = 'upsert'
            AND source_revision.adapter_version_id =
              checkpoint_adapter_version_id
            AND source_revision.adapter_config_sha256 =
              checkpoint_adapter_config_sha256
            AND source_revision.adapter_event_key_sha256 =
              NEW.adapter_event_key_sha256
            AND source_revision.adapter_observed_at = NEW.observed_at
        ) THEN
          RAISE EXCEPTION 'Source sync applied revision binding is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.outcome = 'applied' AND NEW.operation = 'delete' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_tombstones tombstone
          WHERE tombstone.tenant_id = NEW.tenant_id
            AND tombstone.id = NEW.source_tombstone_id
            AND tombstone.source_item_id = NEW.source_item_id
            AND tombstone.owner_actor_id = NEW.owner_actor_id
            AND tombstone.connection_id = NEW.connection_id
            AND tombstone.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND tombstone.last_known_source_revision_id IS NOT DISTINCT FROM
              NEW.last_known_revision_id
            AND tombstone.delete_reason = NEW.delete_reason_code
            AND tombstone.adapter_output_id = NEW.adapter_output_id
            AND tombstone.adapter_output_sha256 = NEW.adapter_output_sha256
            AND tombstone.adapter_operation = 'delete'
            AND tombstone.adapter_version_id = checkpoint_adapter_version_id
            AND tombstone.adapter_config_sha256 =
              checkpoint_adapter_config_sha256
            AND tombstone.adapter_event_key_sha256 =
              NEW.adapter_event_key_sha256
            AND tombstone.adapter_observed_at = NEW.observed_at
        ) THEN
          RAISE EXCEPTION 'Source sync applied tombstone binding is incoherent'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.outcome = 'applied' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_sync_heads head
          WHERE head.tenant_id = NEW.tenant_id
            AND head.source_item_id = NEW.source_item_id
            AND head.owner_actor_id = NEW.owner_actor_id
            AND head.connection_id = NEW.connection_id
            AND head.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND head.authorization_generation = NEW.authorization_generation
            AND head.rollout_generation = NEW.rollout_generation
            AND head.phase_rank = NEW.phase_rank
            AND head.page_sequence = NEW.page_sequence
            AND head.ordinal = NEW.ordinal
            AND NOT head.absence_observed
            AND head.operation = NEW.operation
            AND head.source_revision_id IS NOT DISTINCT FROM
              NEW.source_revision_id
            AND head.source_tombstone_id IS NOT DISTINCT FROM
              NEW.source_tombstone_id
            AND head.adapter_output_id = NEW.adapter_output_id
            AND head.adapter_output_sha256 = NEW.adapter_output_sha256
        ) THEN
          RAISE EXCEPTION 'Source sync applied head order is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.outcome = 'noop'
        AND NEW.noop_reason_code IN ('duplicate', 'not_found')
      THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_sync_heads head
          WHERE head.tenant_id = NEW.tenant_id
            AND head.owner_actor_id = NEW.owner_actor_id
            AND head.connection_id = NEW.connection_id
            AND head.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND head.authorization_generation = NEW.authorization_generation
            AND head.rollout_generation = NEW.rollout_generation
            AND head.phase_rank = NEW.phase_rank
            AND head.page_sequence = NEW.page_sequence
            AND head.ordinal = NEW.ordinal
            AND head.operation = NEW.operation
            AND head.adapter_output_id = NEW.adapter_output_id
            AND head.adapter_output_sha256 = NEW.adapter_output_sha256
            AND (
              NEW.source_item_id IS NULL
              OR head.source_item_id = NEW.source_item_id
            )
            AND (
              NEW.source_item_id IS NOT NULL
              OR head.absence_observed
            )
            AND (
              NEW.noop_reason_code <> 'not_found'
              OR head.absence_observed
            )
        ) THEN
          RAISE EXCEPTION 'Source sync duplicate or absence head is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.outcome = 'noop' AND NEW.noop_reason_code = 'stale' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_sync_heads head
          WHERE head.tenant_id = NEW.tenant_id
            AND head.owner_actor_id = NEW.owner_actor_id
            AND head.connection_id = NEW.connection_id
            AND head.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND (
              NEW.source_item_id IS NULL
              OR head.source_item_id = NEW.source_item_id
            )
            AND (
              NEW.source_item_id IS NOT NULL
              OR head.absence_observed
            )
            AND ROW(
              head.authorization_generation,
              head.rollout_generation,
              head.phase_rank,
              head.page_sequence,
              head.ordinal
            ) > ROW(
              NEW.authorization_generation,
              NEW.rollout_generation,
              NEW.phase_rank,
              NEW.page_sequence,
              NEW.ordinal
            )
        ) THEN
          RAISE EXCEPTION 'Source sync stale head order is incoherent'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_page_item()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF OLD.outcome IN ('shadow_observed', 'applied', 'noop') THEN
        RAISE EXCEPTION '% terminal outcomes are immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.authorization_generation IS DISTINCT FROM OLD.authorization_generation
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.phase_rank IS DISTINCT FROM OLD.phase_rank
        OR NEW.page_sequence IS DISTINCT FROM OLD.page_sequence
        OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
        OR NEW.operation IS DISTINCT FROM OLD.operation
        OR NEW.provider_item_key_sha256 IS DISTINCT FROM OLD.provider_item_key_sha256
        OR NEW.provider_revision_key_sha256 IS DISTINCT FROM OLD.provider_revision_key_sha256
        OR NEW.adapter_event_key_sha256 IS DISTINCT FROM OLD.adapter_event_key_sha256
        OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
        OR NEW.manifest_item_sha256 IS DISTINCT FROM OLD.manifest_item_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF (OLD.source_item_id IS NOT NULL AND
          NEW.source_item_id IS DISTINCT FROM OLD.source_item_id)
        OR (OLD.source_revision_id IS NOT NULL AND
          NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id)
        OR (OLD.source_tombstone_id IS NOT NULL AND
          NEW.source_tombstone_id IS DISTINCT FROM OLD.source_tombstone_id)
        OR (OLD.adapter_output_id IS NOT NULL AND
          NEW.adapter_output_id IS DISTINCT FROM OLD.adapter_output_id)
        OR (OLD.adapter_output_sha256 IS NOT NULL AND
          NEW.adapter_output_sha256 IS DISTINCT FROM OLD.adapter_output_sha256)
        OR (OLD.delete_reason_code IS NOT NULL AND
          NEW.delete_reason_code IS DISTINCT FROM OLD.delete_reason_code)
        OR (OLD.noop_reason_code IS NOT NULL AND
          NEW.noop_reason_code IS DISTINCT FROM OLD.noop_reason_code)
        OR (OLD.last_known_revision_id IS NOT NULL AND
          NEW.last_known_revision_id IS DISTINCT FROM OLD.last_known_revision_id)
      THEN
        RAISE EXCEPTION '% initialized outcome bindings are immutable',
          TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION '% attempts cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_tenant_item_created_idx
    ON omni_source_tombstones (tenant_id, source_item_id, created_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_tenant_source_idx
    ON omni_source_tombstones (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider_item_key_sha256,
      created_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_last_revision_idx
    ON omni_source_tombstones (tenant_id, last_known_source_revision_id)
    WHERE last_known_source_revision_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_retention_expiry_idx
    ON omni_source_tombstones (retention_expires_at)
    WHERE retention_expires_at IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_tombstones_permission_grants_idx
    ON omni_source_tombstones USING GIN (permission_grant_ids)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_source_order_idx
    ON omni_source_sync_heads (
      tenant_id,
      owner_actor_id,
      connection_id,
      authorization_generation DESC,
      rollout_generation DESC,
      phase_rank DESC,
      page_sequence DESC,
      ordinal DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_provider_item_idx
    ON omni_source_sync_heads (
      tenant_id,
      connection_id,
      provider_item_key_sha256
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_revision_idx
    ON omni_source_sync_heads (tenant_id, source_revision_id)
    WHERE source_revision_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_heads_tombstone_idx
    ON omni_source_sync_heads (tenant_id, source_tombstone_id)
    WHERE source_tombstone_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_source_sync_page_items_tombstone_idx
    ON omni_source_sync_page_items (tenant_id, source_tombstone_id)
    WHERE source_tombstone_id IS NOT NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_lock_source_item_identity()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.id)
      );
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_head_end_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checked_tenant_id TEXT;
      checked_source_item_id TEXT;
      head_absence_observed BOOLEAN;
      source_item_exists BOOLEAN;
    BEGIN
      IF TG_TABLE_NAME = 'omni_source_items' THEN
        IF TG_OP = 'DELETE' THEN
          checked_tenant_id := OLD.tenant_id;
          checked_source_item_id := OLD.id;
        ELSE
          checked_tenant_id := NEW.tenant_id;
          checked_source_item_id := NEW.id;
        END IF;
      ELSE
        IF TG_OP = 'DELETE' THEN
          checked_tenant_id := OLD.tenant_id;
          checked_source_item_id := OLD.source_item_id;
        ELSE
          checked_tenant_id := NEW.tenant_id;
          checked_source_item_id := NEW.source_item_id;
        END IF;
      END IF;

      SELECT head.absence_observed
      INTO head_absence_observed
      FROM omni_source_sync_heads head
      WHERE head.tenant_id = checked_tenant_id
        AND head.source_item_id = checked_source_item_id;

      IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END IF;

      SELECT EXISTS (
        SELECT 1
        FROM omni_source_items source_item
        WHERE source_item.tenant_id = checked_tenant_id
          AND source_item.id = checked_source_item_id
      )
      INTO source_item_exists;

      IF head_absence_observed AND source_item_exists THEN
        RAISE EXCEPTION 'Source absence head cannot coexist with a source item'
          USING ERRCODE = '23514';
      END IF;
      IF NOT head_absence_observed AND NOT source_item_exists THEN
        RAISE EXCEPTION 'Source convergence head requires its source item'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_tombstone_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM 1
      FROM omni_source_items source_item
      WHERE source_item.tenant_id = NEW.tenant_id
        AND source_item.id = NEW.source_item_id
        AND source_item.owner_actor_id = NEW.owner_actor_id
        AND source_item.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
        AND source_item.project_id IS NOT DISTINCT FROM NEW.project_id
        AND source_item.mission_id IS NOT DISTINCT FROM NEW.mission_id
        AND source_item.connection_id = NEW.connection_id
        AND source_item.visibility = NEW.visibility
        AND source_item.sensitivity = NEW.sensitivity
        AND source_item.permission_grant_ids = NEW.permission_grant_ids
        AND source_item.allowed_purpose_ids = NEW.allowed_purpose_ids
        AND source_item.retention_policy_id = NEW.retention_policy_id
        AND source_item.retention_expires_at IS NOT DISTINCT FROM
          NEW.retention_expires_at
        AND source_item.permission_set_sha256 = NEW.permission_set_sha256
        AND source_item.purpose_set_sha256 = NEW.purpose_set_sha256
        AND source_item.source_kind = NEW.source_kind
        AND source_item.provider_item_key_sha256 =
          NEW.provider_item_key_sha256
        AND source_item.current_revision_id IS NOT DISTINCT FROM
          NEW.last_known_source_revision_id
      FOR KEY SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Source tombstone binding does not match its source item'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.last_known_source_revision_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM omni_source_revisions source_revision
          WHERE source_revision.tenant_id = NEW.tenant_id
            AND source_revision.id = NEW.last_known_source_revision_id
            AND source_revision.source_item_id = NEW.source_item_id
            AND source_revision.owner_actor_id = NEW.owner_actor_id
            AND source_revision.workspace_id IS NOT DISTINCT FROM
              NEW.workspace_id
            AND source_revision.project_id IS NOT DISTINCT FROM
              NEW.project_id
            AND source_revision.mission_id IS NOT DISTINCT FROM
              NEW.mission_id
            AND source_revision.connection_id = NEW.connection_id
            AND source_revision.visibility = NEW.visibility
            AND source_revision.sensitivity = NEW.sensitivity
            AND source_revision.permission_grant_ids <@
              NEW.permission_grant_ids
            AND source_revision.allowed_purpose_ids <@
              NEW.allowed_purpose_ids
            AND source_revision.retention_policy_id =
              NEW.retention_policy_id
            AND (
              NEW.retention_expires_at IS NULL
              OR (
                source_revision.retention_expires_at IS NOT NULL
                AND source_revision.retention_expires_at <=
                  NEW.retention_expires_at
              )
            )
            AND source_revision.source_kind = NEW.source_kind
            AND source_revision.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
        )
      THEN
        RAISE EXCEPTION 'Source tombstone last-known revision is incoherent'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_head_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.source_item_id)
      );

      IF NEW.absence_observed THEN
        IF EXISTS (
          SELECT 1
          FROM omni_source_items source_item
          WHERE source_item.tenant_id = NEW.tenant_id
            AND source_item.id = NEW.source_item_id
        ) THEN
          RAISE EXCEPTION 'Source absence head conflicts with a source item'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        PERFORM 1
        FROM omni_source_items source_item
        WHERE source_item.tenant_id = NEW.tenant_id
          AND source_item.id = NEW.source_item_id
          AND source_item.owner_actor_id = NEW.owner_actor_id
          AND source_item.connection_id = NEW.connection_id
          AND source_item.source_kind = NEW.source_kind
          AND source_item.provider_item_key_sha256 =
            NEW.provider_item_key_sha256
        FOR KEY SHARE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Source sync head does not match its source item'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM omni_source_adapter_output_receipts receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.adapter_output_id = NEW.adapter_output_id
          AND receipt.adapter_output_sha256 = NEW.adapter_output_sha256
          AND receipt.connection_id = NEW.connection_id
          AND receipt.adapter_operation = NEW.operation
      ) THEN
        RAISE EXCEPTION 'Source sync head adapter receipt is incoherent'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.absence_observed THEN
        RETURN NEW;
      END IF;

      IF NEW.operation = 'upsert' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_revisions source_revision
          WHERE source_revision.tenant_id = NEW.tenant_id
            AND source_revision.id = NEW.source_revision_id
            AND source_revision.source_item_id = NEW.source_item_id
            AND source_revision.owner_actor_id = NEW.owner_actor_id
            AND source_revision.connection_id = NEW.connection_id
            AND source_revision.source_kind = NEW.source_kind
            AND source_revision.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND source_revision.adapter_output_id = NEW.adapter_output_id
            AND source_revision.adapter_output_sha256 =
              NEW.adapter_output_sha256
            AND source_revision.adapter_operation = NEW.operation
            AND source_revision.id = (
              SELECT current_source_item.current_revision_id
              FROM omni_source_items current_source_item
              WHERE current_source_item.tenant_id = NEW.tenant_id
                AND current_source_item.id = NEW.source_item_id
            )
        ) THEN
          RAISE EXCEPTION 'Source sync head revision target is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.operation = 'delete' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM omni_source_tombstones tombstone
          WHERE tombstone.tenant_id = NEW.tenant_id
            AND tombstone.id = NEW.source_tombstone_id
            AND tombstone.source_item_id = NEW.source_item_id
            AND tombstone.owner_actor_id = NEW.owner_actor_id
            AND tombstone.connection_id = NEW.connection_id
            AND tombstone.source_kind = NEW.source_kind
            AND tombstone.provider_item_key_sha256 =
              NEW.provider_item_key_sha256
            AND tombstone.adapter_output_id = NEW.adapter_output_id
            AND tombstone.adapter_output_sha256 =
              NEW.adapter_output_sha256
            AND tombstone.adapter_operation = NEW.operation
            AND tombstone.last_known_source_revision_id IS NOT DISTINCT FROM (
              SELECT current_source_item.current_revision_id
              FROM omni_source_items current_source_item
              WHERE current_source_item.tenant_id = NEW.tenant_id
                AND current_source_item.id = NEW.source_item_id
            )
        ) THEN
          RAISE EXCEPTION 'Source sync head tombstone target is incoherent'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'Source sync head operation is invalid'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_source_sync_head()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.source_item_id IS DISTINCT FROM OLD.source_item_id
        OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
        OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
        OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.provider_item_key_sha256 IS DISTINCT FROM
          OLD.provider_item_key_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF ROW(
        NEW.authorization_generation,
        NEW.rollout_generation,
        NEW.phase_rank,
        NEW.page_sequence,
        NEW.ordinal
      ) < ROW(
        OLD.authorization_generation,
        OLD.rollout_generation,
        OLD.phase_rank,
        OLD.page_sequence,
        OLD.ordinal
      ) THEN
        RAISE EXCEPTION '% order cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      IF ROW(
        NEW.authorization_generation,
        NEW.rollout_generation,
        NEW.phase_rank,
        NEW.page_sequence,
        NEW.ordinal
      ) = ROW(
        OLD.authorization_generation,
        OLD.rollout_generation,
        OLD.phase_rank,
        OLD.page_sequence,
        OLD.ordinal
      )
        AND (
          NEW.absence_observed IS DISTINCT FROM OLD.absence_observed
          OR NEW.operation IS DISTINCT FROM OLD.operation
          OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id
          OR NEW.source_tombstone_id IS DISTINCT FROM OLD.source_tombstone_id
          OR NEW.adapter_output_id IS DISTINCT FROM OLD.adapter_output_id
          OR NEW.adapter_output_sha256 IS DISTINCT FROM
            OLD.adapter_output_sha256
        )
      THEN
        RAISE EXCEPTION '% equal order is bound to different data',
          TG_TABLE_NAME
          USING ERRCODE = '23514';
      END IF;

      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION '% updated_at cannot move backwards', TG_TABLE_NAME
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_items_lock_insert_identity'
          AND tgrelid = 'omni_source_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_items_lock_insert_identity
        BEFORE INSERT ON omni_source_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_lock_source_item_identity();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_items_validate_head_end_state'
          AND tgrelid = 'omni_source_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER omni_source_items_validate_head_end_state
        AFTER INSERT OR UPDATE OR DELETE ON omni_source_items
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_head_end_state();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_tombstones_validate_binding'
          AND tgrelid = 'omni_source_tombstones'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_tombstones_validate_binding
        BEFORE INSERT ON omni_source_tombstones
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_tombstone_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_tombstones_immutable'
          AND tgrelid = 'omni_source_tombstones'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_tombstones_immutable
        BEFORE UPDATE OR DELETE ON omni_source_tombstones
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_tombstones_no_truncate'
          AND tgrelid = 'omni_source_tombstones'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_tombstones_no_truncate
        BEFORE TRUNCATE ON omni_source_tombstones
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_source_lineage_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_protect'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_heads_protect
        BEFORE UPDATE OR DELETE ON omni_source_sync_heads
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_source_sync_head();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_validate_end_state'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER omni_source_sync_heads_validate_end_state
        AFTER INSERT OR UPDATE OR DELETE ON omni_source_sync_heads
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_head_end_state();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_validate_binding'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_heads_validate_binding
        BEFORE INSERT OR UPDATE ON omni_source_sync_heads
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_head_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_heads_no_truncate'
          AND tgrelid = 'omni_source_sync_heads'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_heads_no_truncate
        BEFORE TRUNCATE ON omni_source_sync_heads
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_source_sync_head();
      END IF;
    END
    $migration$
  `;

  // Tombstones inherit append-only lineage permissions; the mutable head
  // projection inherits the source-item upsert capabilities. Role names stay
  // deployment-owned and are discovered from the existing grant boundary.
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_source_revisions'
          AND privilege_type IN ('SELECT', 'INSERT')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_source_tombstones TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_source_items'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_source_sync_heads TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

    END
    $migration$
  `);
}

async function ensureTenantCapabilityRollouts(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_capability_rollouts (
      schema_version INTEGER NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      rollout_generation BIGINT NOT NULL,
      engine_version TEXT NOT NULL,
      contract_version_id TEXT NOT NULL,
      configuration_sha256 TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      activated_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tenant_capability_rollouts_pkey
        PRIMARY KEY (tenant_id, capability_id, rollout_generation),
      CONSTRAINT omni_tenant_capability_rollouts_schema_check CHECK (
        schema_version = 1
      ),
      CONSTRAINT omni_tenant_capability_rollouts_ids_check CHECK (
        omni_source_contract_id_is_valid(tenant_id)
        AND omni_source_contract_id_is_valid(capability_id)
        AND omni_source_contract_id_is_valid(engine_version)
        AND omni_source_contract_id_is_valid(contract_version_id)
        AND omni_source_contract_id_is_valid(created_by_actor_id)
        AND (
          activated_by_actor_id IS NULL
          OR omni_source_contract_id_is_valid(activated_by_actor_id)
        )
      ),
      CONSTRAINT omni_tenant_capability_rollouts_generation_check CHECK (
        rollout_generation BETWEEN 1 AND 9007199254740991
        AND lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND (
          (status = 'registered' AND lifecycle_revision = 0)
          OR (status <> 'registered' AND lifecycle_revision >= 1)
        )
      ),
      CONSTRAINT omni_tenant_capability_rollouts_hash_check CHECK (
        configuration_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT omni_tenant_capability_rollouts_mode_check CHECK (
        mode IN ('shadow', 'canary', 'enabled')
      ),
      CONSTRAINT omni_tenant_capability_rollouts_status_check CHECK (
        status IN ('registered', 'active', 'paused', 'superseded')
      ),
      CONSTRAINT omni_tenant_capability_rollouts_activation_check CHECK (
        (activated_by_actor_id IS NULL) = (activated_at IS NULL)
        AND (
          (status = 'registered' AND activated_at IS NULL)
          OR (status IN ('active', 'paused') AND activated_at IS NOT NULL)
          OR status = 'superseded'
        )
      ),
      CONSTRAINT omni_tenant_capability_rollouts_superseded_check CHECK (
        (status = 'superseded') = (superseded_at IS NOT NULL)
      ),
      CONSTRAINT omni_tenant_capability_rollouts_timestamps_check CHECK (
        created_at <= updated_at
        AND (activated_at IS NULL OR created_at <= activated_at)
        AND (activated_at IS NULL OR activated_at <= updated_at)
        AND (superseded_at IS NULL OR created_at <= superseded_at)
        AND (superseded_at IS NULL OR superseded_at <= updated_at)
        AND (activated_at IS NULL OR superseded_at IS NULL
          OR activated_at <= superseded_at)
      )
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_tenant_capability_rollouts_one_current_idx
    ON omni_tenant_capability_rollouts (tenant_id, capability_id)
    WHERE status <> 'superseded'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS
      omni_tenant_capability_rollouts_active_idx
    ON omni_tenant_capability_rollouts (
      tenant_id,
      status,
      capability_id,
      rollout_generation DESC
    )
    WHERE status IN ('active', 'paused')
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_capability_rollout_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.capability_id)
      );

      IF NEW.status <> 'registered'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.superseded_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Capability rollouts must be inserted as registered'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_tenant_capability_rollouts rollout
        WHERE rollout.tenant_id = NEW.tenant_id
          AND rollout.capability_id = NEW.capability_id
          AND rollout.rollout_generation >= NEW.rollout_generation
      ) THEN
        RAISE EXCEPTION 'Capability rollout generation must increase'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.status <> 'superseded' AND EXISTS (
        SELECT 1
        FROM omni_tenant_capability_rollouts rollout
        WHERE rollout.tenant_id = NEW.tenant_id
          AND rollout.capability_id = NEW.capability_id
          AND rollout.status <> 'superseded'
      ) THEN
        RAISE EXCEPTION 'Capability already has a current rollout generation'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_capability_rollout()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION '% rows cannot be changed with %', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.capability_id)
      );

      IF OLD.status = 'superseded' THEN
        RAISE EXCEPTION 'Superseded capability rollouts are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.capability_id IS DISTINCT FROM OLD.capability_id
        OR NEW.rollout_generation IS DISTINCT FROM OLD.rollout_generation
        OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
        OR NEW.contract_version_id IS DISTINCT FROM OLD.contract_version_id
        OR NEW.configuration_sha256 IS DISTINCT FROM OLD.configuration_sha256
        OR NEW.mode IS DISTINCT FROM OLD.mode
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Capability rollout contract is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.status = 'registered' AND NEW.status IN ('active', 'superseded'))
        OR (OLD.status = 'active' AND NEW.status IN ('paused', 'superseded'))
        OR (OLD.status = 'paused' AND NEW.status IN ('active', 'superseded'))
      ) THEN
        RAISE EXCEPTION 'Capability rollout status transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
        RAISE EXCEPTION 'Capability rollout lifecycle revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      IF OLD.activated_at IS NOT NULL AND (
        NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.activated_by_actor_id IS DISTINCT FROM
          OLD.activated_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Capability rollout activation identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL
        AND NEW.activated_at IS NOT NULL
        AND NOT (OLD.status = 'registered' AND NEW.status = 'active')
      THEN
        RAISE EXCEPTION 'Capability rollout activation metadata is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF OLD.superseded_at IS NOT NULL
        AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
      THEN
        RAISE EXCEPTION 'Capability rollout supersession time is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Capability rollout updated_at must increase'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_tenant_capability_rollouts_validate_insert'
          AND tgrelid = 'omni_tenant_capability_rollouts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_tenant_capability_rollouts_validate_insert
        BEFORE INSERT ON omni_tenant_capability_rollouts
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_capability_rollout_insert();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_tenant_capability_rollouts_protect'
          AND tgrelid = 'omni_tenant_capability_rollouts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_tenant_capability_rollouts_protect
        BEFORE UPDATE OR DELETE ON omni_tenant_capability_rollouts
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_capability_rollout();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_tenant_capability_rollouts_no_truncate'
          AND tgrelid = 'omni_tenant_capability_rollouts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_tenant_capability_rollouts_no_truncate
        BEFORE TRUNCATE ON omni_tenant_capability_rollouts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_capability_rollout();
      END IF;
    END
    $migration$
  `;

  // Mirror the existing mutable tenant-control-plane grants without naming a
  // deployment-owned runtime role in application schema code.
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_provider_connections'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_tenant_capability_rollouts TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
}

async function ensureDriveGeneration2RolloutBoundCheckpoints(sql: SqlClient) {
  // This release is the first writer of rollout-bound Drive checkpoints. Refuse
  // to infer a capability, adapter, or lifecycle revision for pre-existing work.
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_checkpoints_rollout_binding_check'
          AND conrelid = 'omni_source_sync_page_checkpoints'::regclass
      ) AND EXISTS (
        SELECT 1
        FROM omni_source_sync_page_checkpoints checkpoint
        WHERE checkpoint.rollout_generation > 1
      ) THEN
        RAISE EXCEPTION
          'Cannot bind pre-existing generation-2 source sync checkpoints'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    ADD COLUMN IF NOT EXISTS rollout_capability_id TEXT
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    ADD COLUMN IF NOT EXISTS adapter_id TEXT
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    ADD COLUMN IF NOT EXISTS rollout_lifecycle_revision BIGINT
  `;

  // Generation 1 retains its original uniqueness semantics. Canonical
  // generations include capability and adapter identity so independently
  // governed streams cannot collide at the database boundary.
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    DROP CONSTRAINT IF EXISTS omni_source_sync_page_checkpoints_page_key
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_generation1_page_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation,
      page_sequence
    )
    WHERE rollout_generation = 1
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_canonical_page_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation,
      rollout_capability_id,
      adapter_id,
      page_sequence
    )
    WHERE rollout_generation > 1
  `;
  await sql`
    DROP INDEX IF EXISTS
      omni_source_sync_page_checkpoints_one_nonterminal_idx
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_generation1_one_nonterminal_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation
    )
    WHERE rollout_generation = 1
      AND status NOT IN ('committed', 'superseded')
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_source_sync_page_checkpoints_canonical_one_nonterminal_idx
    ON omni_source_sync_page_checkpoints (
      tenant_id,
      owner_actor_id,
      connection_id,
      provider,
      source_id,
      authorization_generation,
      rollout_generation,
      rollout_capability_id,
      adapter_id
    )
    WHERE rollout_generation > 1
      AND status NOT IN ('committed', 'superseded')
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_checkpoints_rollout_binding_check'
          AND conrelid = 'omni_source_sync_page_checkpoints'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_checkpoints
        ADD CONSTRAINT
          omni_source_sync_page_checkpoints_rollout_binding_check
        CHECK (
          (
            rollout_generation = 1
            AND rollout_capability_id IS NULL
            AND adapter_id IS NULL
            AND rollout_lifecycle_revision IS NULL
          )
          OR (
            rollout_generation > 1
            AND rollout_capability_id IS NOT NULL
            AND adapter_id IS NOT NULL
            AND omni_source_contract_id_is_valid(rollout_capability_id)
            AND omni_source_contract_id_is_valid(adapter_id)
            AND (
              (
                status = 'open'
                AND rollout_lifecycle_revision IS NULL
              )
              OR (
                status <> 'open'
                AND rollout_lifecycle_revision IS NOT NULL
                AND rollout_lifecycle_revision BETWEEN 1 AND 9007199254740991
              )
            )
          )
        ) NOT VALID;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_checkpoints_rollout_fkey'
          AND conrelid = 'omni_source_sync_page_checkpoints'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_checkpoints
        ADD CONSTRAINT omni_source_sync_page_checkpoints_rollout_fkey
        FOREIGN KEY (
          tenant_id,
          rollout_capability_id,
          rollout_generation
        )
        REFERENCES omni_tenant_capability_rollouts (
          tenant_id,
          capability_id,
          rollout_generation
        )
        ON DELETE RESTRICT
        NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    VALIDATE CONSTRAINT
      omni_source_sync_page_checkpoints_rollout_binding_check
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_checkpoints
    VALIDATE CONSTRAINT omni_source_sync_page_checkpoints_rollout_fkey
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'omni_source_sync_page_items_rollout_outcome_check'
          AND conrelid = 'omni_source_sync_page_items'::regclass
      ) THEN
        ALTER TABLE omni_source_sync_page_items
        ADD CONSTRAINT omni_source_sync_page_items_rollout_outcome_check
        CHECK (
          (rollout_generation = 1 AND outcome = 'shadow_observed')
          OR (
            rollout_generation > 1
            AND outcome IN ('pending', 'applied', 'noop', 'dead_letter')
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_source_sync_page_items
    VALIDATE CONSTRAINT omni_source_sync_page_items_rollout_outcome_check
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_source_sync_checkpoint_rollout()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      active_lifecycle_revision BIGINT;
      requires_lifecycle_match BOOLEAN;
      requires_rollout_validation BOOLEAN;
    BEGIN
      IF NEW.rollout_generation = 1 THEN
        RETURN NEW;
      END IF;

      IF TG_OP = 'INSERT' THEN
        requires_rollout_validation := TRUE;
      ELSE
        requires_rollout_validation :=
          NEW.status IN ('leased', 'committed')
          OR (
            OLD.status = 'open'
            AND NEW.status = 'dead_letter'
          );
      END IF;

      IF requires_rollout_validation THEN
        SELECT rollout.lifecycle_revision
        INTO active_lifecycle_revision
        FROM omni_tenant_capability_rollouts rollout
        WHERE rollout.tenant_id = NEW.tenant_id
          AND rollout.capability_id = NEW.rollout_capability_id
          AND rollout.rollout_generation = NEW.rollout_generation
          AND rollout.engine_version = NEW.engine_version
          AND rollout.contract_version_id = NEW.adapter_version_id
          AND rollout.configuration_sha256 = NEW.adapter_config_sha256
          AND rollout.mode IN ('canary', 'enabled')
          AND rollout.status = 'active'
        FOR SHARE;

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'Source sync checkpoint rollout is not active or exact'
            USING ERRCODE = '23514';
        END IF;

        requires_lifecycle_match := NEW.status <> 'open';
        IF requires_lifecycle_match AND
          NEW.rollout_lifecycle_revision IS DISTINCT FROM
            active_lifecycle_revision
        THEN
          RAISE EXCEPTION
            'Source sync checkpoint rollout lifecycle is stale'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_protect_source_sync_checkpoint_rollout_binding()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.rollout_capability_id IS DISTINCT FROM
          OLD.rollout_capability_id
        OR NEW.adapter_id IS DISTINCT FROM OLD.adapter_id
      THEN
        RAISE EXCEPTION 'Source sync checkpoint rollout binding is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.rollout_lifecycle_revision IS DISTINCT FROM
          OLD.rollout_lifecycle_revision
      THEN
        IF OLD.rollout_lifecycle_revision IS NULL
          AND NEW.rollout_lifecycle_revision IS NOT NULL
        THEN
          IF NOT (
            OLD.status = 'open'
            AND (
              (
                NEW.status = 'leased'
                AND NEW.lease_generation = OLD.lease_generation + 1
              )
              OR (
                NEW.status = 'dead_letter'
                AND NEW.lease_generation = OLD.lease_generation
              )
            )
          ) THEN
            RAISE EXCEPTION
              'Source sync rollout lifecycle may bind only on claim or exhaustion'
              USING ERRCODE = '55000';
          END IF;
        ELSIF OLD.rollout_lifecycle_revision IS NOT NULL
          AND NEW.rollout_lifecycle_revision IS NULL
        THEN
          IF NOT (
            OLD.status IN ('leased', 'observed', 'dead_letter')
            AND NEW.status = 'open'
            AND NEW.lease_generation = OLD.lease_generation
          ) THEN
            RAISE EXCEPTION
              'Source sync rollout lifecycle may clear only on reopen'
              USING ERRCODE = '55000';
          END IF;
        ELSIF NOT (
          OLD.status IN ('leased', 'observed')
          AND NEW.status = 'leased'
          AND NEW.lease_generation = OLD.lease_generation + 1
        ) THEN
          RAISE EXCEPTION
            'Source sync rollout lifecycle may change only on a new lease'
            USING ERRCODE = '55000';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_validate_source_sync_page_item_adapter_id()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      checkpoint_adapter_id TEXT;
    BEGIN
      IF NEW.rollout_generation = 1 THEN
        RETURN NEW;
      END IF;

      SELECT checkpoint.adapter_id
      INTO checkpoint_adapter_id
      FROM omni_source_sync_page_checkpoints checkpoint
      WHERE checkpoint.tenant_id = NEW.tenant_id
        AND checkpoint.id = NEW.checkpoint_id
        AND checkpoint.owner_actor_id = NEW.owner_actor_id
        AND checkpoint.connection_id = NEW.connection_id
        AND checkpoint.provider = NEW.provider
        AND checkpoint.source_id = NEW.source_id
        AND checkpoint.engine_version = NEW.engine_version
        AND checkpoint.authorization_generation = NEW.authorization_generation
        AND checkpoint.rollout_generation = NEW.rollout_generation
        AND checkpoint.page_sequence = NEW.page_sequence
      FOR UPDATE;

      IF checkpoint_adapter_id IS NULL THEN
        RAISE EXCEPTION
          'Generation-2 source sync page item has no checkpoint adapter'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.adapter_output_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM omni_source_adapter_output_receipts receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.adapter_output_id = NEW.adapter_output_id
          AND receipt.adapter_output_sha256 = NEW.adapter_output_sha256
          AND receipt.adapter_id = checkpoint_adapter_id
      ) THEN
        RAISE EXCEPTION
          'Source sync page receipt adapter does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.source_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM omni_source_revisions source_revision
        WHERE source_revision.tenant_id = NEW.tenant_id
          AND source_revision.id = NEW.source_revision_id
          AND source_revision.source_item_id = NEW.source_item_id
          AND source_revision.adapter_id = checkpoint_adapter_id
      ) THEN
        RAISE EXCEPTION
          'Source sync page revision adapter does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.source_tombstone_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM omni_source_tombstones tombstone
        WHERE tombstone.tenant_id = NEW.tenant_id
          AND tombstone.id = NEW.source_tombstone_id
          AND tombstone.source_item_id = NEW.source_item_id
          AND tombstone.adapter_id = checkpoint_adapter_id
      ) THEN
        RAISE EXCEPTION
          'Source sync page tombstone adapter does not match its checkpoint'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname =
          'omni_source_sync_page_checkpoints_validate_rollout'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER
          omni_source_sync_page_checkpoints_validate_rollout
        BEFORE INSERT OR UPDATE ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_checkpoint_rollout();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname =
          'omni_source_sync_page_checkpoints_protect_rollout_binding'
          AND tgrelid = 'omni_source_sync_page_checkpoints'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER
          omni_source_sync_page_checkpoints_protect_rollout_binding
        BEFORE UPDATE ON omni_source_sync_page_checkpoints
        FOR EACH ROW
        EXECUTE FUNCTION
          omni_protect_source_sync_checkpoint_rollout_binding();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_source_sync_page_items_validate_adapter_id'
          AND tgrelid = 'omni_source_sync_page_items'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_source_sync_page_items_validate_adapter_id
        BEFORE INSERT OR UPDATE ON omni_source_sync_page_items
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_source_sync_page_item_adapter_id();
      END IF;
    END
    $migration$
  `;
}

async function ensureMcpConnectorCredentialVault(sql: SqlClient) {
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_version INTEGER`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_key_id TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_fingerprint TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_origin TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS sealed_credential JSONB`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_created_by TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_rotated_by TEXT`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_created_at TIMESTAMPTZ`;
  await sql`ALTER TABLE omni_mcp_connectors ADD COLUMN IF NOT EXISTS credential_rotated_at TIMESTAMPTZ`;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_mcp_connectors_credential_version_check'
          AND conrelid = 'omni_mcp_connectors'::regclass
      ) THEN
        ALTER TABLE omni_mcp_connectors
        ADD CONSTRAINT omni_mcp_connectors_credential_version_check
        CHECK (credential_version IS NULL OR credential_version > 0);
      END IF;
    END
    $migration$
  `;
}

async function ensureMobileSessions(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_mobile_sessions (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES omni_auth_users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES omni_auth_tenants(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      app_version TEXT,
      access_token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      consumed_refresh_token_hashes JSONB NOT NULL DEFAULT '[]',
      access_expires_at TIMESTAMPTZ NOT NULL,
      refresh_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_access_idx ON omni_mobile_sessions (access_token_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_refresh_idx ON omni_mobile_sessions (refresh_token_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_consumed_refresh_idx ON omni_mobile_sessions USING GIN (consumed_refresh_token_hashes)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_user_device_idx ON omni_mobile_sessions (user_id, device_id)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_mobile_sessions_expiry_idx ON omni_mobile_sessions (refresh_expires_at)`;
}

async function ensureUnifiedAiUsageLedger(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_ai_usage (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source_stream_id TEXT NOT NULL,
      source_event_id TEXT,
      correlation_id TEXT,
      causation_id TEXT,
      execution_scope JSONB CHECK (
        execution_scope IS NULL OR jsonb_typeof(execution_scope) = 'object'
      ),
      operation TEXT NOT NULL
        CONSTRAINT omni_ai_usage_operation_check CHECK (operation IN (
          'text_generation', 'structured_generation', 'tool_turn',
          'embedding', 'web_search', 'ocr', 'image_generation',
          'transcription', 'speech_synthesis', 'browser_automation'
        )),
      purpose TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      usage JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(usage) = 'object'),
      call_receipts JSONB NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT omni_ai_usage_call_receipts_check
        CHECK (jsonb_typeof(call_receipts) = 'array'),
      provider_call_count INTEGER NOT NULL DEFAULT 1
        CHECK (provider_call_count >= 0),
      attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 0),
      failed_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (failed_attempt_count >= 0 AND failed_attempt_count <= attempt_count),
      latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
      estimated_cost_microusd BIGINT CHECK (
        estimated_cost_microusd IS NULL OR estimated_cost_microusd >= 0
      ),
      pricing_source TEXT,
      pricing_version TEXT,
      provider_request_id TEXT,
      assignment_id TEXT,
      credential_source TEXT CHECK (
        credential_source IS NULL
        OR credential_source IN ('tenant_vault', 'deployment_environment')
      ),
      failure_kind TEXT,
      retryable BOOLEAN,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (btrim(tenant_id) <> ''),
      CHECK (btrim(actor_id) <> ''),
      CHECK (btrim(source_stream_id) <> ''),
      CHECK (btrim(purpose) <> ''),
      CHECK (btrim(provider) <> ''),
      CHECK (btrim(model) <> ''),
      CONSTRAINT omni_ai_usage_provider_attempt_check
        CHECK (provider_call_count <= attempt_count)
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_ai_usage_tenant_source_event_idx
    ON omni_ai_usage (tenant_id, source_event_id)
    WHERE source_event_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_tenant_recorded_idx
    ON omni_ai_usage (tenant_id, recorded_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_tenant_actor_recorded_idx
    ON omni_ai_usage (tenant_id, actor_id, recorded_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_tenant_purpose_recorded_idx
    ON omni_ai_usage (tenant_id, purpose, recorded_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_ai_usage_retention_idx
    ON omni_ai_usage (recorded_at ASC)
  `;
}

async function ensureUnifiedAiUsageLedgerCompatibility(sql: SqlClient) {
  await ensureUnifiedAiUsageLedger(sql);
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS correlation_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS causation_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS execution_scope JSONB`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS call_receipts JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS provider_request_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS assignment_id TEXT`;
  await sql`ALTER TABLE omni_ai_usage ADD COLUMN IF NOT EXISTS credential_source TEXT`;
  await sql`ALTER TABLE omni_ai_usage DROP CONSTRAINT IF EXISTS omni_ai_usage_operation_check`;
  await sql`
    ALTER TABLE omni_ai_usage
    ADD CONSTRAINT omni_ai_usage_operation_check CHECK (operation IN (
      'text_generation', 'structured_generation', 'tool_turn',
      'embedding', 'web_search', 'ocr', 'image_generation',
      'transcription', 'speech_synthesis', 'browser_automation'
    ))
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_call_receipts_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_call_receipts_check
        CHECK (jsonb_typeof(call_receipts) = 'array');
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_provider_attempt_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_provider_attempt_check
        CHECK (provider_call_count <= attempt_count);
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_execution_scope_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_execution_scope_check
        CHECK (execution_scope IS NULL OR jsonb_typeof(execution_scope) = 'object');
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_ai_usage_credential_source_check'
          AND conrelid = 'omni_ai_usage'::regclass
      ) THEN
        ALTER TABLE omni_ai_usage
        ADD CONSTRAINT omni_ai_usage_credential_source_check
        CHECK (
          credential_source IS NULL
          OR credential_source IN ('tenant_vault', 'deployment_environment')
        );
      END IF;
    END
    $migration$
  `;
}

async function ensureConversationThreads(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_threads (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      actor_id TEXT NOT NULL,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'orchestrate',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_threads_tenant_updated_idx ON omni_threads (tenant_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS omni_threads_actor_updated_idx ON omni_threads (tenant_id, actor_id, updated_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_thread_turns (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      thread_id TEXT NOT NULL REFERENCES omni_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      run_id TEXT REFERENCES omni_agent_runs(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS omni_thread_turns_thread_created_idx ON omni_thread_turns (tenant_id, thread_id, created_at ASC)`;
  await sql`ALTER TABLE omni_agent_runs ADD COLUMN IF NOT EXISTS thread_id TEXT REFERENCES omni_threads(id) ON DELETE SET NULL`;
  await sql`CREATE INDEX IF NOT EXISTS omni_agent_runs_thread_idx ON omni_agent_runs (tenant_id, thread_id, started_at DESC)`;
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

async function ensureMemoryDeletionBarriers(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_deletion_receipts (
      id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      contract_kind TEXT NOT NULL DEFAULT 'memory_deletion',
      tenant_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      attribution_kind TEXT NOT NULL,
      initiating_actor_id TEXT,
      executing_principal_type TEXT,
      executing_principal_id TEXT,
      correlation_id TEXT,
      causation_id TEXT,
      purpose TEXT,
      execution_scope JSONB,
      execution_scope_sha256 TEXT,
      receipt_sha256 TEXT,
      delete_reason TEXT NOT NULL,
      descendant_memory_ids TEXT[] NOT NULL DEFAULT '{}',
      retrieval_trace_ids TEXT[] NOT NULL DEFAULT '{}',
      graph_node_ids TEXT[] NOT NULL DEFAULT '{}',
      graph_edge_ids TEXT[] NOT NULL DEFAULT '{}',
      descendant_memory_count INTEGER NOT NULL DEFAULT 0,
      retrieval_trace_count INTEGER NOT NULL DEFAULT 0,
      graph_node_count INTEGER NOT NULL DEFAULT 0,
      graph_edge_count INTEGER NOT NULL DEFAULT 0,
      descendant_manifest_sha256 TEXT,
      forgotten_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_deletion_receipts_pkey
        PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_memory_deletion_receipts_memory_key
        UNIQUE (tenant_id, memory_id),
      CONSTRAINT omni_memory_deletion_receipts_hash_key
        UNIQUE (tenant_id, receipt_sha256),
      CONSTRAINT omni_memory_deletion_receipts_contract_check CHECK (
        schema_version = 1
        AND contract_kind = 'memory_deletion'
        AND char_length(id) BETWEEN 1 AND 240
        AND char_length(tenant_id) BETWEEN 1 AND 240
        AND char_length(memory_id) BETWEEN 1 AND 240
      ),
      CONSTRAINT omni_memory_deletion_receipts_counts_check CHECK (
        descendant_memory_count = cardinality(descendant_memory_ids)
        AND retrieval_trace_count = cardinality(retrieval_trace_ids)
        AND graph_node_count = cardinality(graph_node_ids)
        AND graph_edge_count = cardinality(graph_edge_ids)
      ),
      CONSTRAINT omni_memory_deletion_receipts_attribution_check CHECK (
        (
          attribution_kind = 'scope_bound'
          AND initiating_actor_id IS NOT NULL
          AND initiating_actor_id <> ''
          AND executing_principal_type IS NOT NULL
          AND executing_principal_type IN ('user', 'agent', 'system')
          AND correlation_id IS NOT NULL
          AND correlation_id <> ''
          AND purpose IS NOT NULL
          AND purpose <> ''
          AND execution_scope IS NOT NULL
          AND jsonb_typeof(execution_scope) = 'object'
          AND execution_scope ->> 'version' = '1'
          AND execution_scope ->> 'tenantId' = tenant_id
          AND execution_scope ->> 'initiatingActorId' = initiating_actor_id
          AND execution_scope ->> 'executingPrincipalType' =
            executing_principal_type
          AND (execution_scope ->> 'executingPrincipalId')
            IS NOT DISTINCT FROM executing_principal_id
          AND execution_scope ->> 'correlationId' = correlation_id
          AND (execution_scope ->> 'causationId')
            IS NOT DISTINCT FROM causation_id
          AND execution_scope ->> 'purpose' = purpose
          AND execution_scope_sha256 IS NOT NULL
          AND execution_scope_sha256 ~ '^[0-9a-f]{64}$'
          AND receipt_sha256 IS NOT NULL
          AND receipt_sha256 ~ '^[0-9a-f]{64}$'
          AND descendant_manifest_sha256 IS NOT NULL
          AND descendant_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND delete_reason = 'explicit_forget'
        )
        OR (
          attribution_kind = 'legacy_unattributed'
          AND initiating_actor_id IS NULL
          AND executing_principal_type IS NULL
          AND executing_principal_id IS NULL
          AND correlation_id IS NULL
          AND causation_id IS NULL
          AND purpose IS NULL
          AND execution_scope IS NULL
          AND execution_scope_sha256 IS NULL
          AND receipt_sha256 IS NULL
          AND descendant_manifest_sha256 IS NULL
          AND delete_reason = 'legacy_unattributed'
        )
      )
    )
  `;

  await sql`
    ALTER TABLE omni_retrieval_traces
    ADD COLUMN IF NOT EXISTS memory_ids TEXT[]
  `;
  // Re-running this idempotent migration must be able to recompute historical
  // closure. DDL is transactional, so the committed barrier is never absent.
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memories
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_retrieval_traces
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_retrieval_traces_memory_lineage
    ON omni_retrieval_traces
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_retrieval_traces_validate_deletion_barrier
    ON omni_retrieval_traces
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_retrieval_traces_graph_lock
    ON omni_retrieval_traces
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_nodes_memory_lineage
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_nodes_validate_deletion_barrier
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_nodes_graph_lock
    ON omni_memory_graph_nodes
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_edges_memory_lineage
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_edges_validate_deletion_barrier
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memory_graph_edges_graph_lock
    ON omni_memory_graph_edges
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_graph_lock
    ON omni_memories
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_deletion_barrier
    ON omni_memories
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_memories_validate_canonical_forget
    ON omni_memories
  `;

  // Receipts require a stable forget timestamp. Establish only that field
  // before computing legacy lineage so outbound references remain available
  // to the conservative descendant manifest.
  await sql`
    UPDATE omni_memories
    SET forgotten_at = COALESCE(updated_at, created_at, NOW()),
        updated_at = COALESCE(updated_at, created_at, NOW())
    WHERE claim_status = 'forgotten'
      AND forgotten_at IS NULL
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_direct_trace_memory_ids(trace_results JSONB)
    RETURNS TEXT[]
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT COALESCE(
        ARRAY_AGG(
          DISTINCT (result ->> 'id') COLLATE "C"
          ORDER BY (result ->> 'id') COLLATE "C"
        ),
        '{}'::TEXT[]
      )
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(trace_results) = 'array' THEN trace_results
          ELSE '[]'::JSONB
        END
      ) result
      WHERE result ->> 'kind' = 'memory'
        AND NULLIF(BTRIM(result ->> 'id'), '') IS NOT NULL
    $function$
  `;

  // Existing lineage must not cross a tenant boundary. Missing legacy targets
  // are possible because the old retention sweep physically deleted memories;
  // clear only those dangling pointers before the permanent barrier is active.
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_memories child
        CROSS JOIN LATERAL (
          SELECT child.supersedes_id AS memory_id
          UNION ALL
          SELECT child.contradiction_of_id AS memory_id
          UNION ALL
          SELECT substring(evidence_ref FROM 8) AS memory_id
          FROM unnest(COALESCE(child.evidence_refs, '{}'::TEXT[])) evidence_ref
          WHERE evidence_ref LIKE 'memory:%'
            AND char_length(evidence_ref) > 7
        ) reference
        WHERE reference.memory_id IS NOT NULL
          AND reference.memory_id <> child.id
          AND EXISTS (
            SELECT 1
            FROM omni_memories target
            WHERE target.id = reference.memory_id
              AND target.tenant_id <> child.tenant_id
          )
      ) THEN
        RAISE EXCEPTION
          'Cannot install memory deletion barriers over cross-tenant memory lineage'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_retrieval_traces trace
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(trace.results) = 'array' THEN trace.results
            ELSE '[]'::JSONB
          END
        ) result
        JOIN omni_memories memory ON memory.id = result ->> 'id'
        WHERE result ->> 'kind' = 'memory'
          AND memory.tenant_id <> trace.tenant_id
      ) THEN
        RAISE EXCEPTION
          'Cannot install memory deletion barriers over cross-tenant trace lineage'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes node
        CROSS JOIN LATERAL unnest(node.memory_ids) memory_id
        JOIN omni_memories memory ON memory.id = memory_id
        WHERE memory.tenant_id <> node.tenant_id
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_edges edge
        CROSS JOIN LATERAL unnest(edge.memory_ids) memory_id
        JOIN omni_memories memory ON memory.id = memory_id
        WHERE memory.tenant_id <> edge.tenant_id
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_edges edge
        WHERE EXISTS (
          SELECT 1
          FROM omni_memory_graph_nodes source_node
          WHERE source_node.id = edge.source_node_id
            AND source_node.tenant_id <> edge.tenant_id
        ) OR EXISTS (
          SELECT 1
          FROM omni_memory_graph_nodes target_node
          WHERE target_node.id = edge.target_node_id
            AND target_node.tenant_id <> edge.tenant_id
        )
      ) THEN
        RAISE EXCEPTION
          'Cannot install memory deletion barriers over cross-tenant graph lineage'
          USING ERRCODE = '23514';
      END IF;
    END
    $migration$
  `;

  // Older partial graph cleanup could leave an edge whose endpoint is gone.
  // Cross-tenant endpoints were rejected above; remove only globally missing
  // endpoint rows so deterministic rebuilds cannot collide with hidden debris.
  await sql`
    DELETE FROM omni_memory_graph_edges edge
    WHERE NOT EXISTS (
      SELECT 1
      FROM omni_memory_graph_nodes source_node
      WHERE source_node.id = edge.source_node_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM omni_memory_graph_nodes target_node
      WHERE target_node.id = edge.target_node_id
    )
  `;

  await sql`
    UPDATE omni_memories child
    SET supersedes_id = CASE
          WHEN child.supersedes_id IS NULL
            OR child.supersedes_id = child.id
            OR EXISTS (
              SELECT 1
              FROM omni_memories target
              WHERE target.tenant_id = child.tenant_id
                AND target.id = child.supersedes_id
            )
          THEN child.supersedes_id
          ELSE NULL
        END,
        contradiction_of_id = CASE
          WHEN child.contradiction_of_id IS NULL
            OR child.contradiction_of_id = child.id
            OR EXISTS (
              SELECT 1
              FROM omni_memories target
              WHERE target.tenant_id = child.tenant_id
                AND target.id = child.contradiction_of_id
            )
          THEN child.contradiction_of_id
          ELSE NULL
        END,
        evidence_refs = ARRAY(
          SELECT evidence_ref
          FROM unnest(COALESCE(child.evidence_refs, '{}'::TEXT[]))
            WITH ORDINALITY AS reference(evidence_ref, position)
          WHERE reference.evidence_ref NOT LIKE 'memory:%'
            OR char_length(reference.evidence_ref) <= 7
            OR substring(reference.evidence_ref FROM 8) = child.id
            OR EXISTS (
              SELECT 1
              FROM omni_memories target
              WHERE target.tenant_id = child.tenant_id
                AND target.id = substring(reference.evidence_ref FROM 8)
            )
          ORDER BY reference.position
        )
    WHERE (
      child.supersedes_id IS NOT NULL
      AND child.supersedes_id <> child.id
      AND NOT EXISTS (
        SELECT 1
        FROM omni_memories target
        WHERE target.tenant_id = child.tenant_id
          AND target.id = child.supersedes_id
      )
    ) OR (
      child.contradiction_of_id IS NOT NULL
      AND child.contradiction_of_id <> child.id
      AND NOT EXISTS (
        SELECT 1
        FROM omni_memories target
        WHERE target.tenant_id = child.tenant_id
          AND target.id = child.contradiction_of_id
      )
    ) OR EXISTS (
      SELECT 1
      FROM unnest(COALESCE(child.evidence_refs, '{}'::TEXT[])) evidence_ref
      WHERE evidence_ref LIKE 'memory:%'
        AND char_length(evidence_ref) > 7
        AND substring(evidence_ref FROM 8) <> child.id
        AND NOT EXISTS (
          SELECT 1
          FROM omni_memories target
          WHERE target.tenant_id = child.tenant_id
            AND target.id = substring(evidence_ref FROM 8)
        )
    )
  `;

  // Seed direct trace lineage. Malformed results and unresolved graph result
  // references conservatively inherit every known memory id in their tenant.
  await sql`
    UPDATE omni_retrieval_traces trace
    SET memory_ids = CASE
      WHEN jsonb_typeof(trace.results) <> 'array'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(trace.results) = 'array'
                THEN trace.results
              ELSE '[]'::JSONB
            END
          ) result
          WHERE jsonb_typeof(result) <> 'object'
            OR COALESCE(result ->> 'kind', '') NOT IN (
              'memory', 'knowledge', 'graph'
            )
            OR NULLIF(BTRIM(result ->> 'id'), '') IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(trace.results) = 'array'
                THEN trace.results
              ELSE '[]'::JSONB
            END
          ) result
          WHERE result ->> 'kind' = 'graph'
            AND NOT EXISTS (
              SELECT 1
              FROM omni_memory_graph_nodes node
              WHERE node.id = result ->> 'id'
                AND node.tenant_id = trace.tenant_id
            )
        )
      THEN ARRAY(
        SELECT lineage.memory_id
        FROM (
          SELECT memory.id COLLATE "C" AS memory_id
          FROM omni_memories memory
          WHERE memory.tenant_id = trace.tenant_id
          UNION
          SELECT unnest(
            omni_direct_trace_memory_ids(trace.results)
          ) COLLATE "C"
        ) lineage
        ORDER BY lineage.memory_id COLLATE "C"
      )
      ELSE omni_direct_trace_memory_ids(trace.results)
    END
  `;

  // Materialize the trace/graph closure to a fixed point. Existing graph
  // rows can derive from traces and traces can cite graph nodes, so one pass
  // is insufficient. Missing legacy trace references conservatively taint a
  // graph row with every known memory id in its tenant.
  await sql`
    DO $migration$
    DECLARE
      changed_rows INTEGER;
      total_changed INTEGER;
      pass INTEGER := 0;
    BEGIN
      LOOP
        pass := pass + 1;
        total_changed := 0;

        WITH closure AS (
          SELECT trace.id,
                 ARRAY_AGG(
                   DISTINCT lineage.memory_id COLLATE "C"
                   ORDER BY lineage.memory_id COLLATE "C"
                 )
                   AS memory_ids
          FROM omni_retrieval_traces trace
          CROSS JOIN LATERAL (
            SELECT unnest(COALESCE(trace.memory_ids, '{}'::TEXT[])) AS memory_id
            UNION ALL
            SELECT unnest(node.memory_ids) AS memory_id
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(trace.results) = 'array'
                  THEN trace.results
                ELSE '[]'::JSONB
              END
            ) result
            JOIN omni_memory_graph_nodes node
              ON node.id = result ->> 'id'
             AND node.tenant_id = trace.tenant_id
            WHERE result ->> 'kind' = 'graph'
          ) lineage
          GROUP BY trace.id
        )
        UPDATE omni_retrieval_traces trace
        SET memory_ids = closure.memory_ids
        FROM closure
        WHERE trace.id = closure.id
          AND trace.memory_ids IS DISTINCT FROM closure.memory_ids;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;
        total_changed := total_changed + changed_rows;

        WITH closure AS (
          SELECT node.id,
                 ARRAY_AGG(
                   DISTINCT lineage.memory_id COLLATE "C"
                   ORDER BY lineage.memory_id COLLATE "C"
                 )
                   AS memory_ids
          FROM omni_memory_graph_nodes node
          CROSS JOIN LATERAL (
            SELECT unnest(node.memory_ids) AS memory_id
            UNION ALL
            SELECT unnest(trace.memory_ids) AS memory_id
            FROM omni_retrieval_traces trace
            WHERE trace.tenant_id = node.tenant_id
              AND trace.id = ANY(node.trace_ids)
            UNION ALL
            SELECT memory.id AS memory_id
            FROM omni_memories memory
            WHERE memory.tenant_id = node.tenant_id
              AND EXISTS (
                SELECT 1
                FROM unnest(node.trace_ids) trace_id
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM omni_retrieval_traces trace
                  WHERE trace.id = trace_id
                    AND trace.tenant_id = node.tenant_id
                )
              )
          ) lineage
          GROUP BY node.id
        )
        UPDATE omni_memory_graph_nodes node
        SET memory_ids = closure.memory_ids
        FROM closure
        WHERE node.id = closure.id
          AND node.memory_ids IS DISTINCT FROM closure.memory_ids;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;
        total_changed := total_changed + changed_rows;

        WITH closure AS (
          SELECT edge.id,
                 ARRAY_AGG(
                   DISTINCT lineage.memory_id COLLATE "C"
                   ORDER BY lineage.memory_id COLLATE "C"
                 )
                   AS memory_ids
          FROM omni_memory_graph_edges edge
          CROSS JOIN LATERAL (
            SELECT unnest(edge.memory_ids) AS memory_id
            UNION ALL
            SELECT unnest(trace.memory_ids) AS memory_id
            FROM omni_retrieval_traces trace
            WHERE trace.tenant_id = edge.tenant_id
              AND trace.id = ANY(edge.trace_ids)
            UNION ALL
            SELECT unnest(endpoint.memory_ids) AS memory_id
            FROM omni_memory_graph_nodes endpoint
            WHERE endpoint.tenant_id = edge.tenant_id
              AND endpoint.id = ANY(
                ARRAY[edge.source_node_id, edge.target_node_id]
              )
            UNION ALL
            SELECT memory.id AS memory_id
            FROM omni_memories memory
            WHERE memory.tenant_id = edge.tenant_id
              AND EXISTS (
                SELECT 1
                FROM unnest(edge.trace_ids) trace_id
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM omni_retrieval_traces trace
                  WHERE trace.id = trace_id
                    AND trace.tenant_id = edge.tenant_id
                )
              )
          ) lineage
          GROUP BY edge.id
        )
        UPDATE omni_memory_graph_edges edge
        SET memory_ids = closure.memory_ids
        FROM closure
        WHERE edge.id = closure.id
          AND edge.memory_ids IS DISTINCT FROM closure.memory_ids;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;
        total_changed := total_changed + changed_rows;

        EXIT WHEN total_changed = 0;
        IF pass >= 128 THEN
          RAISE EXCEPTION
            'Memory deletion lineage closure did not converge after 128 passes'
            USING ERRCODE = '54000';
        END IF;
      END LOOP;
    END
    $migration$
  `;

  await sql`
    UPDATE omni_retrieval_traces
    SET memory_ids = '{}'::TEXT[]
    WHERE memory_ids IS NULL
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces
    ALTER COLUMN memory_ids SET DEFAULT '{}'::TEXT[]
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces
    ALTER COLUMN memory_ids SET NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_retrieval_traces_memory_ids_idx
    ON omni_retrieval_traces USING GIN (memory_ids)
  `;

  // Existing forgotten rows predate execution-scope binding. Preserve that
  // fact explicitly while recording the conservative descendant manifest;
  // never synthesize an actor, scope, correlation id, or authenticated hash.
  await sql`
    WITH RECURSIVE lineage AS (
      SELECT root.tenant_id COLLATE "C" AS tenant_id,
             root.id COLLATE "C" AS root_memory_id,
             root.id COLLATE "C" AS current_memory_id
      FROM omni_memories root
      WHERE root.claim_status = 'forgotten'
      UNION
      SELECT lineage.tenant_id,
             lineage.root_memory_id,
             child.id
      FROM lineage
      JOIN omni_memories child
        ON child.tenant_id = lineage.tenant_id
       AND (
         child.supersedes_id = lineage.current_memory_id
         OR child.contradiction_of_id = lineage.current_memory_id
         OR ('memory:' || lineage.current_memory_id) = ANY(child.evidence_refs)
       )
    ),
    manifests AS (
      SELECT root.tenant_id,
             root.id AS memory_id,
             root.forgotten_at,
             ARRAY(
               SELECT descendant.current_memory_id
               FROM lineage descendant
               WHERE descendant.tenant_id = root.tenant_id
                 AND descendant.root_memory_id = root.id
                 AND descendant.current_memory_id <> root.id
               ORDER BY descendant.current_memory_id COLLATE "C"
             ) AS descendant_memory_ids,
             ARRAY(
               SELECT trace.id
               FROM omni_retrieval_traces trace
               WHERE trace.tenant_id = root.tenant_id
                 AND trace.memory_ids && ARRAY(
                   SELECT blocked.current_memory_id
                   FROM lineage blocked
                   WHERE blocked.tenant_id = root.tenant_id
                     AND blocked.root_memory_id = root.id
                 )
               ORDER BY trace.id COLLATE "C"
             ) AS retrieval_trace_ids,
             ARRAY(
               SELECT node.id
               FROM omni_memory_graph_nodes node
               WHERE node.tenant_id = root.tenant_id
                 AND node.memory_ids && ARRAY(
                   SELECT blocked.current_memory_id
                   FROM lineage blocked
                   WHERE blocked.tenant_id = root.tenant_id
                     AND blocked.root_memory_id = root.id
                 )
               ORDER BY node.id COLLATE "C"
             ) AS graph_node_ids,
             ARRAY(
               SELECT edge.id
               FROM omni_memory_graph_edges edge
               WHERE edge.tenant_id = root.tenant_id
                 AND edge.memory_ids && ARRAY(
                   SELECT blocked.current_memory_id
                   FROM lineage blocked
                   WHERE blocked.tenant_id = root.tenant_id
                     AND blocked.root_memory_id = root.id
                 )
               ORDER BY edge.id COLLATE "C"
             ) AS graph_edge_ids
      FROM omni_memories root
      WHERE root.claim_status = 'forgotten'
    )
    INSERT INTO omni_memory_deletion_receipts (
      id, schema_version, contract_kind, tenant_id, memory_id,
      attribution_kind, initiating_actor_id, executing_principal_type,
      executing_principal_id, correlation_id, causation_id, purpose,
      execution_scope, execution_scope_sha256, receipt_sha256, delete_reason,
      descendant_memory_ids, retrieval_trace_ids, graph_node_ids,
      graph_edge_ids, descendant_memory_count, retrieval_trace_count,
      graph_node_count, graph_edge_count, descendant_manifest_sha256,
      forgotten_at
    )
    SELECT 'legacy:' || md5(manifest.tenant_id || ':' || manifest.memory_id),
           1,
           'memory_deletion',
           manifest.tenant_id,
           manifest.memory_id,
           'legacy_unattributed',
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           'legacy_unattributed',
           manifest.descendant_memory_ids,
           manifest.retrieval_trace_ids,
           manifest.graph_node_ids,
           manifest.graph_edge_ids,
           cardinality(manifest.descendant_memory_ids),
           cardinality(manifest.retrieval_trace_ids),
           cardinality(manifest.graph_node_ids),
           cardinality(manifest.graph_edge_ids),
           NULL,
           manifest.forgotten_at
    FROM manifests manifest
    WHERE NOT EXISTS (
      SELECT 1
      FROM omni_memory_deletion_receipts receipt
      WHERE receipt.tenant_id = manifest.tenant_id
        AND receipt.memory_id = manifest.memory_id
    )
    ON CONFLICT (tenant_id, memory_id) DO NOTHING
  `;

  // Remove every derived row captured by a legacy receipt before clearing the
  // root's outbound references. Keeping these hidden rows would make later
  // deterministic graph upserts collide with an immutable deletion barrier.
  await sql`
    DELETE FROM omni_memory_graph_edges edge
    USING omni_memory_deletion_receipts receipt
    WHERE edge.tenant_id = receipt.tenant_id
      AND edge.id = ANY(receipt.graph_edge_ids)
  `;
  await sql`
    DELETE FROM omni_memory_graph_nodes node
    USING omni_memory_deletion_receipts receipt
    WHERE node.tenant_id = receipt.tenant_id
      AND node.id = ANY(receipt.graph_node_ids)
  `;
  await sql`
    DELETE FROM omni_retrieval_traces trace
    USING omni_memory_deletion_receipts receipt
    WHERE trace.tenant_id = receipt.tenant_id
      AND trace.id = ANY(receipt.retrieval_trace_ids)
  `;
  await sql`
    INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
      tenant_id, requested_at, attempts, last_error, updated_at, generation
    )
    SELECT DISTINCT receipt.tenant_id, NOW(), 0, NULL, NOW(), 1
    FROM omni_memory_deletion_receipts receipt
    ON CONFLICT (tenant_id) DO UPDATE SET
      requested_at = NOW(),
      attempts = 0,
      last_error = NULL,
      updated_at = NOW(),
      generation = rebuild.generation + 1
  `;

  // Capture legacy lineage in the immutable receipt before clearing the
  // forgotten shell's outbound references, then enforce the same canonical
  // scrub required for newly governed forgets.
  await sql`
    UPDATE omni_memories
    SET title = '[forgotten]',
        content = '',
        tags = '{}'::TEXT[],
        source = '[forgotten]',
        embedding = NULL,
        evidence_refs = '{}'::TEXT[],
        supersedes_id = NULL,
        contradiction_of_id = NULL,
        forgotten_at = COALESCE(forgotten_at, updated_at, created_at, NOW()),
        updated_at = COALESCE(forgotten_at, updated_at, created_at, NOW())
    WHERE claim_status = 'forgotten'
      AND (
        title <> '[forgotten]'
        OR content <> ''
        OR cardinality(tags) <> 0
        OR source <> '[forgotten]'
        OR embedding IS NOT NULL
        OR cardinality(evidence_refs) <> 0
        OR supersedes_id IS NOT NULL
        OR contradiction_of_id IS NOT NULL
        OR forgotten_at IS NULL
      )
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND column_name = 'embedding_vector'
      ) THEN
        EXECUTE
          'UPDATE omni_memories SET embedding_vector = NULL ' ||
          'WHERE claim_status = ''forgotten'' AND embedding_vector IS NOT NULL';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_deletion_ids_are_canonical(ids TEXT[])
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    AS $function$
      SELECT COALESCE(ids, '{}'::TEXT[]) = ARRAY(
        SELECT DISTINCT id COLLATE "C"
        FROM unnest(COALESCE(ids, '{}'::TEXT[])) id
        WHERE NULLIF(BTRIM(id), '') IS NOT NULL
        ORDER BY id COLLATE "C"
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_ids_have_deletion_barrier(
      row_tenant_id TEXT,
      row_memory_ids TEXT[]
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    AS $function$
      SELECT EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts receipt
        WHERE receipt.tenant_id = row_tenant_id
          AND (
            ARRAY[receipt.memory_id] || receipt.descendant_memory_ids
          ) && COALESCE(row_memory_ids, '{}'::TEXT[])
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_immutable_memory_deletion_receipt()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Memory deletion receipts are immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION
        'Memory rows are permanent shells; use the governed canonical forget path'
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_lock_memory_graph_for_statement()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      active_tenant_id TEXT;
    BEGIN
      active_tenant_id := NULLIF(
        current_setting('omni.tenant_id', true),
        ''
      );
      IF active_tenant_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended('memory-graph:' || active_tenant_id, 0)
        );
      ELSE
        -- Serialize every unscoped/system lock-set enumeration. Tenant rows can
        -- appear between statements, so a mutable full-set scan alone cannot
        -- establish a global A/B ordering across concurrent maintenance work.
        PERFORM pg_advisory_xact_lock(
          hashtextextended('memory-graph-lock-order:global', 0)
        );
        -- Owner/system maintenance may span tenants. Lock the existing tenant
        -- graph domains in canonical order before PostgreSQL acquires any row
        -- locks; this preserves graph->row ordering against explicit forgets.
        FOR active_tenant_id IN EXECUTE format(
          'SELECT DISTINCT tenant_id COLLATE "C" FROM %I.%I ' ||
          'WHERE tenant_id IS NOT NULL ' ||
          'ORDER BY tenant_id COLLATE "C"',
          TG_TABLE_SCHEMA,
          TG_TABLE_NAME
        )
        LOOP
          PERFORM pg_advisory_xact_lock(
            hashtextextended('memory-graph:' || active_tenant_id, 0)
          );
        END LOOP;
      END IF;
      RETURN NULL;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_deletion_receipt()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      memory omni_memories%ROWTYPE;
      expected_descendant_memory_ids TEXT[];
      blocked_memory_ids TEXT[];
      expected_retrieval_trace_ids TEXT[];
      expected_graph_node_ids TEXT[];
      expected_graph_edge_ids TEXT[];
      deleted_row_count INTEGER;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext('memory:' || NEW.memory_id)
      );

      IF EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts receipt
        WHERE receipt.tenant_id = NEW.tenant_id
          AND receipt.memory_id = NEW.memory_id
      ) THEN
        RETURN NEW;
      END IF;

      IF NEW.attribution_kind <> 'scope_bound' THEN
        RAISE EXCEPTION
          'Only scope-bound memory deletion receipts may be created after migration'
          USING ERRCODE = '23514';
      END IF;

      SELECT stored_memory.*
      INTO memory
      FROM omni_memories stored_memory
      WHERE stored_memory.tenant_id = NEW.tenant_id
        AND stored_memory.id = NEW.memory_id
      FOR KEY SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Memory deletion receipt target does not exist'
          USING ERRCODE = '23503';
      END IF;

      IF NOT omni_memory_deletion_ids_are_canonical(NEW.descendant_memory_ids)
        OR NOT omni_memory_deletion_ids_are_canonical(NEW.retrieval_trace_ids)
        OR NOT omni_memory_deletion_ids_are_canonical(NEW.graph_node_ids)
        OR NOT omni_memory_deletion_ids_are_canonical(NEW.graph_edge_ids)
        OR NEW.memory_id COLLATE "C" = ANY(NEW.descendant_memory_ids)
      THEN
        RAISE EXCEPTION 'Memory deletion receipt manifest ids are not canonical'
          USING ERRCODE = '23514';
      END IF;

      WITH RECURSIVE lineage AS (
        SELECT NEW.memory_id COLLATE "C" AS current_memory_id
        UNION
        SELECT child.id
        FROM lineage
        JOIN omni_memories child
          ON child.tenant_id = NEW.tenant_id
         AND (
           child.supersedes_id = lineage.current_memory_id
           OR child.contradiction_of_id = lineage.current_memory_id
           OR ('memory:' || lineage.current_memory_id) = ANY(child.evidence_refs)
         )
      )
      SELECT ARRAY_AGG(
               current_memory_id COLLATE "C"
               ORDER BY current_memory_id COLLATE "C"
             )
               FILTER (WHERE current_memory_id <> NEW.memory_id),
             ARRAY_AGG(
               current_memory_id COLLATE "C"
               ORDER BY current_memory_id COLLATE "C"
             )
      INTO expected_descendant_memory_ids, blocked_memory_ids
      FROM lineage;

      expected_descendant_memory_ids := COALESCE(
        expected_descendant_memory_ids,
        '{}'::TEXT[]
      );
      blocked_memory_ids := COALESCE(
        blocked_memory_ids,
        ARRAY[NEW.memory_id]
      );

      IF NEW.descendant_memory_ids IS DISTINCT FROM
           expected_descendant_memory_ids
      THEN
        RAISE EXCEPTION 'Memory deletion receipt descendant closure is stale'
          USING ERRCODE = '40001';
      END IF;

      SELECT COALESCE(
        ARRAY_AGG(trace.id COLLATE "C" ORDER BY trace.id COLLATE "C"),
        '{}'::TEXT[]
      )
      INTO expected_retrieval_trace_ids
      FROM omni_retrieval_traces trace
      WHERE trace.tenant_id = NEW.tenant_id
        AND (
          trace.memory_ids && blocked_memory_ids
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(trace.results) = 'array'
                  THEN trace.results
                ELSE '[]'::JSONB
              END
            ) result
            WHERE result ->> 'kind' = 'memory'
              AND result ->> 'id' = ANY(blocked_memory_ids)
          )
        );

      SELECT COALESCE(
        ARRAY_AGG(node.id COLLATE "C" ORDER BY node.id COLLATE "C"),
        '{}'::TEXT[]
      )
      INTO expected_graph_node_ids
      FROM omni_memory_graph_nodes node
      WHERE node.tenant_id = NEW.tenant_id
        AND (
          node.memory_ids && blocked_memory_ids
          OR node.trace_ids && expected_retrieval_trace_ids
        );

      SELECT COALESCE(
        ARRAY_AGG(edge.id COLLATE "C" ORDER BY edge.id COLLATE "C"),
        '{}'::TEXT[]
      )
      INTO expected_graph_edge_ids
      FROM omni_memory_graph_edges edge
      WHERE edge.tenant_id = NEW.tenant_id
        AND (
          edge.memory_ids && blocked_memory_ids
          OR edge.trace_ids && expected_retrieval_trace_ids
          OR edge.source_node_id = ANY(expected_graph_node_ids)
          OR edge.target_node_id = ANY(expected_graph_node_ids)
        );

      IF NEW.retrieval_trace_ids IS DISTINCT FROM expected_retrieval_trace_ids
        OR NEW.graph_node_ids IS DISTINCT FROM expected_graph_node_ids
        OR NEW.graph_edge_ids IS DISTINCT FROM expected_graph_edge_ids
      THEN
        RAISE EXCEPTION 'Memory deletion receipt derived lineage is stale'
          USING ERRCODE = '40001';
      END IF;

      -- Delete the exact validated manifest before NEW becomes visible. Once
      -- the receipt exists, restrictive SELECT policies intentionally hide
      -- these rows and an invoker-side DELETE could otherwise affect zero.
      DELETE FROM omni_memory_graph_edges edge
      WHERE edge.tenant_id = NEW.tenant_id
        AND edge.id = ANY(NEW.graph_edge_ids);
      GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
      IF deleted_row_count <> NEW.graph_edge_count THEN
        RAISE EXCEPTION 'Memory deletion graph-edge manifest changed'
          USING ERRCODE = '40001';
      END IF;

      DELETE FROM omni_memory_graph_nodes node
      WHERE node.tenant_id = NEW.tenant_id
        AND node.id = ANY(NEW.graph_node_ids);
      GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
      IF deleted_row_count <> NEW.graph_node_count THEN
        RAISE EXCEPTION 'Memory deletion graph-node manifest changed'
          USING ERRCODE = '40001';
      END IF;

      DELETE FROM omni_retrieval_traces trace
      WHERE trace.tenant_id = NEW.tenant_id
        AND trace.id = ANY(NEW.retrieval_trace_ids);
      GET DIAGNOSTICS deleted_row_count = ROW_COUNT;
      IF deleted_row_count <> NEW.retrieval_trace_count THEN
        RAISE EXCEPTION 'Memory deletion trace manifest changed'
          USING ERRCODE = '40001';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_enforce_memory_deletion_barrier()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      referenced_memory_ids TEXT[];
      locked_memory_id TEXT;
      canonical_forget BOOLEAN := FALSE;
    BEGIN
      -- Every memory mutation participates in the tenant graph lock before
      -- taking narrower memory locks. This serializes new transitive lineage
      -- with receipt closure snapshots and keeps lock order deterministic.
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );

      IF TG_OP = 'UPDATE'
        AND (
          NEW.id IS DISTINCT FROM OLD.id
          OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        )
      THEN
        RAISE EXCEPTION 'Memory tenant and id are immutable'
          USING ERRCODE = '23514';
      END IF;

      referenced_memory_ids := ARRAY[
        NEW.id,
        NEW.supersedes_id,
        NEW.contradiction_of_id
      ] || ARRAY(
        SELECT substring(evidence_ref FROM 8)
        FROM unnest(COALESCE(NEW.evidence_refs, '{}'::TEXT[])) evidence_ref
        WHERE evidence_ref LIKE 'memory:%'
          AND char_length(evidence_ref) > 7
      );
      referenced_memory_ids := array_remove(referenced_memory_ids, NULL);

      FOR locked_memory_id IN
        SELECT DISTINCT memory_id COLLATE "C" AS memory_id
        FROM unnest(referenced_memory_ids) memory_id
        ORDER BY memory_id COLLATE "C"
      LOOP
        PERFORM pg_advisory_xact_lock(
          hashtext(NEW.tenant_id),
          hashtext('memory:' || locked_memory_id)
        );
      END LOOP;

      IF TG_OP = 'UPDATE'
        AND OLD.claim_status <> 'forgotten'
        AND NEW.claim_status = 'forgotten'
        AND NEW.title = '[forgotten]'
        AND NEW.content = ''
        AND cardinality(NEW.tags) = 0
        AND NEW.source = '[forgotten]'
        AND NEW.embedding IS NULL
        AND cardinality(NEW.evidence_refs) = 0
        AND NEW.supersedes_id IS NULL
        AND NEW.contradiction_of_id IS NULL
        AND NEW.forgotten_at IS NOT NULL
        AND COALESCE(
          to_jsonb(NEW) -> 'embedding_vector',
          'null'::JSONB
        ) = 'null'::JSONB
        AND EXISTS (
          SELECT 1
          FROM omni_memory_deletion_receipts receipt
          WHERE receipt.tenant_id = NEW.tenant_id
            AND receipt.memory_id = NEW.id
            AND receipt.forgotten_at = NEW.forgotten_at
        )
      THEN
        canonical_forget := TRUE;
      END IF;

      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        referenced_memory_ids
      ) AND NOT canonical_forget THEN
        RAISE EXCEPTION 'Memory write intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_canonical_memory_forget()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      final_memory omni_memories%ROWTYPE;
      final_referenced_memory_ids TEXT[];
      canonical_shell BOOLEAN := FALSE;
      canonical_forget BOOLEAN := FALSE;
    BEGIN
      -- Prefer the final stored row when it remains selectable. A row that a
      -- concurrently committed barrier now hides from RLS must still be
      -- rejected, so retain the queued NEW image as the fail-closed fallback.
      final_memory := NEW;
      SELECT stored_memory.*
      INTO final_memory
      FROM omni_memories stored_memory
      WHERE stored_memory.tenant_id = NEW.tenant_id
        AND stored_memory.id = NEW.id;

      IF NOT FOUND THEN
        final_memory := NEW;
      END IF;

      final_referenced_memory_ids := ARRAY[
        final_memory.id,
        final_memory.supersedes_id,
        final_memory.contradiction_of_id
      ] || ARRAY(
        SELECT substring(evidence_ref FROM 8)
        FROM unnest(
          COALESCE(final_memory.evidence_refs, '{}'::TEXT[])
        ) evidence_ref
        WHERE evidence_ref LIKE 'memory:%'
          AND char_length(evidence_ref) > 7
      );
      final_referenced_memory_ids := array_remove(
        final_referenced_memory_ids,
        NULL
      );

      IF EXISTS (
        SELECT 1
        FROM unnest(final_referenced_memory_ids) reference(memory_id)
        WHERE reference.memory_id <> final_memory.id
          AND NOT EXISTS (
            SELECT 1
            FROM omni_memories target
            WHERE target.tenant_id = final_memory.tenant_id
              AND target.id = reference.memory_id
          )
      ) THEN
        RAISE EXCEPTION
          'Memory lineage references an unknown or cross-tenant memory'
          USING ERRCODE = '23503';
      END IF;

      canonical_shell := COALESCE(
        final_memory.claim_status = 'forgotten'
        AND final_memory.title = '[forgotten]'
        AND final_memory.content = ''
        AND cardinality(final_memory.tags) = 0
        AND final_memory.source = '[forgotten]'
        AND final_memory.embedding IS NULL
        AND cardinality(final_memory.evidence_refs) = 0
        AND final_memory.supersedes_id IS NULL
        AND final_memory.contradiction_of_id IS NULL
        AND final_memory.forgotten_at IS NOT NULL
        AND COALESCE(
          to_jsonb(final_memory) -> 'embedding_vector',
          'null'::JSONB
        ) = 'null'::JSONB,
        FALSE
      );
      canonical_forget := canonical_shell AND EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts receipt
        WHERE receipt.tenant_id = final_memory.tenant_id
          AND receipt.memory_id = final_memory.id
          AND receipt.forgotten_at = final_memory.forgotten_at
      );

      IF omni_memory_ids_have_deletion_barrier(
        final_memory.tenant_id,
        final_referenced_memory_ids
      ) AND NOT canonical_forget THEN
        RAISE EXCEPTION
          'Final memory state intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      IF final_memory.claim_status <> 'forgotten' THEN
        RETURN NEW;
      END IF;

      IF NOT canonical_shell THEN
        RAISE EXCEPTION 'Forgotten memory is not canonically scrubbed'
          USING ERRCODE = '23514';
      END IF;

      IF NOT canonical_forget THEN
        RAISE EXCEPTION 'Forgotten memory is missing its deletion receipt'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_derived_memory_barrier()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      -- The BEFORE lineage trigger can wait behind a concurrent forget after
      -- its statement snapshot was chosen. Re-check from this deferred trigger
      -- so the transaction observes the committed receipt before it can finish.
      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        COALESCE(NEW.memory_ids, '{}'::TEXT[])
      ) THEN
        RAISE EXCEPTION
          'Final derived memory row intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_deletion_receipt_end_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM omni_memories memory
        WHERE memory.tenant_id = NEW.tenant_id
          AND memory.id = NEW.memory_id
          AND memory.claim_status = 'forgotten'
          AND memory.title = '[forgotten]'
          AND memory.content = ''
          AND cardinality(memory.tags) = 0
          AND memory.source = '[forgotten]'
          AND memory.embedding IS NULL
          AND cardinality(memory.evidence_refs) = 0
          AND memory.supersedes_id IS NULL
          AND memory.contradiction_of_id IS NULL
          AND memory.forgotten_at = NEW.forgotten_at
          AND COALESCE(
            to_jsonb(memory) -> 'embedding_vector',
            'null'::JSONB
          ) = 'null'::JSONB
      ) THEN
        RAISE EXCEPTION 'Memory deletion receipt did not commit a canonical forget'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_retrieval_traces trace
        WHERE trace.tenant_id = NEW.tenant_id
          AND trace.id = ANY(NEW.retrieval_trace_ids)
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes node
        WHERE node.tenant_id = NEW.tenant_id
          AND node.id = ANY(NEW.graph_node_ids)
      ) OR EXISTS (
        SELECT 1
        FROM omni_memory_graph_edges edge
        WHERE edge.tenant_id = NEW.tenant_id
          AND edge.id = ANY(NEW.graph_edge_ids)
      ) THEN
        RAISE EXCEPTION
          'Memory deletion receipt retained rows from its derived manifest'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql.query(`
    REVOKE ALL ON FUNCTION
      omni_validate_memory_deletion_receipt_end_state()
    FROM PUBLIC
  `);

  await sql`
    CREATE OR REPLACE FUNCTION omni_materialize_trace_memory_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      graph_reference_count INTEGER;
      resolved_graph_count INTEGER;
      direct_memory_ids TEXT[];
      materialized_memory_ids TEXT[];
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );

      IF jsonb_typeof(NEW.results) <> 'array'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(NEW.results) = 'array'
                THEN NEW.results
              ELSE '[]'::JSONB
            END
          ) result
          WHERE jsonb_typeof(result) <> 'object'
            OR COALESCE(result ->> 'kind', '') NOT IN (
              'memory', 'knowledge', 'graph'
            )
            OR NULLIF(BTRIM(result ->> 'id'), '') IS NULL
        )
      THEN
        RAISE EXCEPTION 'Retrieval trace results have invalid lineage'
          USING ERRCODE = '23514';
      END IF;

      direct_memory_ids := omni_direct_trace_memory_ids(NEW.results);
      IF EXISTS (
        SELECT 1
        FROM unnest(direct_memory_ids) memory_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM omni_memories memory
          WHERE memory.id = memory_id
            AND memory.tenant_id = NEW.tenant_id
        )
      ) THEN
        RAISE EXCEPTION 'Retrieval trace references an unknown tenant memory'
          USING ERRCODE = '23503';
      END IF;

      SELECT COUNT(DISTINCT (result ->> 'id') COLLATE "C")
      INTO graph_reference_count
      FROM jsonb_array_elements(NEW.results) result
      WHERE result ->> 'kind' = 'graph';

      SELECT COUNT(DISTINCT node.id COLLATE "C")
      INTO resolved_graph_count
      FROM jsonb_array_elements(NEW.results) result
      JOIN omni_memory_graph_nodes node
        ON node.id = result ->> 'id'
       AND node.tenant_id = NEW.tenant_id
      WHERE result ->> 'kind' = 'graph';

      IF graph_reference_count <> resolved_graph_count THEN
        RAISE EXCEPTION 'Retrieval trace references an unknown tenant graph node'
          USING ERRCODE = '23503';
      END IF;

      SELECT COALESCE(
        ARRAY_AGG(
          DISTINCT lineage.memory_id COLLATE "C"
          ORDER BY lineage.memory_id COLLATE "C"
        ),
        '{}'::TEXT[]
      )
      INTO materialized_memory_ids
      FROM (
        SELECT unnest(direct_memory_ids) AS memory_id
        UNION ALL
        SELECT unnest(node.memory_ids) AS memory_id
        FROM jsonb_array_elements(NEW.results) result
        JOIN omni_memory_graph_nodes node
          ON node.id = result ->> 'id'
         AND node.tenant_id = NEW.tenant_id
        WHERE result ->> 'kind' = 'graph'
      ) lineage;

      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        materialized_memory_ids
      ) THEN
        RAISE EXCEPTION 'Retrieval trace intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      NEW.memory_ids := materialized_memory_ids;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_materialize_graph_memory_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      trace_reference_count INTEGER;
      resolved_trace_count INTEGER;
      endpoint_reference_count INTEGER;
      resolved_endpoint_count INTEGER;
      materialized_memory_ids TEXT[];
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('memory-graph:' || NEW.tenant_id, 0)
      );

      IF EXISTS (
        SELECT 1
        FROM unnest(COALESCE(NEW.memory_ids, '{}'::TEXT[])) memory_id
        WHERE NULLIF(BTRIM(memory_id), '') IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM omni_memories memory
            WHERE memory.id = memory_id
              AND memory.tenant_id = NEW.tenant_id
          )
      ) THEN
        RAISE EXCEPTION 'Memory graph row references an unknown tenant memory'
          USING ERRCODE = '23503';
      END IF;

      SELECT COUNT(DISTINCT trace_id COLLATE "C")
      INTO trace_reference_count
      FROM unnest(COALESCE(NEW.trace_ids, '{}'::TEXT[])) trace_id;

      SELECT COUNT(DISTINCT trace.id COLLATE "C")
      INTO resolved_trace_count
      FROM omni_retrieval_traces trace
      WHERE trace.tenant_id = NEW.tenant_id
        AND trace.id = ANY(COALESCE(NEW.trace_ids, '{}'::TEXT[]));

      IF trace_reference_count <> resolved_trace_count THEN
        RAISE EXCEPTION 'Memory graph row references an unknown tenant trace'
          USING ERRCODE = '23503';
      END IF;

      IF TG_TABLE_NAME = 'omni_memory_graph_edges' THEN
        SELECT COUNT(DISTINCT endpoint_id COLLATE "C")
        INTO endpoint_reference_count
        FROM unnest(
          ARRAY[NEW.source_node_id, NEW.target_node_id]
        ) endpoint_id;

        SELECT COUNT(DISTINCT endpoint.id COLLATE "C")
        INTO resolved_endpoint_count
        FROM omni_memory_graph_nodes endpoint
        WHERE endpoint.tenant_id = NEW.tenant_id
          AND endpoint.id = ANY(
            ARRAY[NEW.source_node_id, NEW.target_node_id]
          );

        IF endpoint_reference_count <> resolved_endpoint_count THEN
          RAISE EXCEPTION
            'Memory graph edge references an unknown or cross-tenant endpoint'
            USING ERRCODE = '23503';
        END IF;
      END IF;

      SELECT COALESCE(
        ARRAY_AGG(
          DISTINCT lineage.memory_id COLLATE "C"
          ORDER BY lineage.memory_id COLLATE "C"
        ),
        '{}'::TEXT[]
      )
      INTO materialized_memory_ids
      FROM (
        SELECT unnest(COALESCE(NEW.memory_ids, '{}'::TEXT[])) AS memory_id
        UNION ALL
        SELECT unnest(trace.memory_ids) AS memory_id
        FROM omni_retrieval_traces trace
        WHERE trace.tenant_id = NEW.tenant_id
          AND trace.id = ANY(COALESCE(NEW.trace_ids, '{}'::TEXT[]))
      ) lineage;

      IF TG_TABLE_NAME = 'omni_memory_graph_edges' THEN
        SELECT COALESCE(
          ARRAY_AGG(
            DISTINCT lineage.memory_id COLLATE "C"
            ORDER BY lineage.memory_id COLLATE "C"
          ),
          '{}'::TEXT[]
        )
        INTO materialized_memory_ids
        FROM (
          SELECT unnest(materialized_memory_ids) AS memory_id
          UNION ALL
          SELECT unnest(endpoint.memory_ids) AS memory_id
          FROM omni_memory_graph_nodes endpoint
          WHERE endpoint.tenant_id = NEW.tenant_id
            AND endpoint.id = ANY(
              ARRAY[NEW.source_node_id, NEW.target_node_id]
            )
        ) lineage;
      END IF;

      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        materialized_memory_ids
      ) THEN
        RAISE EXCEPTION 'Memory graph row intersects a permanent deletion barrier'
          USING ERRCODE = '55000';
      END IF;

      NEW.memory_ids := materialized_memory_ids;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_validate'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_deletion_receipts_validate
        BEFORE INSERT ON omni_memory_deletion_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_memory_deletion_receipt();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_immutable'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_deletion_receipts_immutable
        BEFORE UPDATE OR DELETE ON omni_memory_deletion_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_immutable_memory_deletion_receipt();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_no_truncate'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_deletion_receipts_no_truncate
        BEFORE TRUNCATE ON omni_memory_deletion_receipts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_immutable_memory_deletion_receipt();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_deletion_receipts_validate_end_state'
          AND tgrelid = 'omni_memory_deletion_receipts'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_memory_deletion_receipts_validate_end_state
        AFTER INSERT ON omni_memory_deletion_receipts
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_memory_deletion_receipt_end_state();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_graph_lock'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_graph_lock
        BEFORE INSERT OR UPDATE ON omni_memories
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_deletion_barrier'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_deletion_barrier
        BEFORE INSERT OR UPDATE ON omni_memories
        FOR EACH ROW
        EXECUTE FUNCTION omni_enforce_memory_deletion_barrier();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_no_delete'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_no_delete
        BEFORE DELETE ON omni_memories
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_memory_delete();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_no_truncate'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_no_truncate
        BEFORE TRUNCATE ON omni_memories
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_memory_delete();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memories_validate_canonical_forget'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER omni_memories_validate_canonical_forget
        AFTER INSERT OR UPDATE ON omni_memories
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_canonical_memory_forget();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_retrieval_traces_memory_lineage'
          AND tgrelid = 'omni_retrieval_traces'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_retrieval_traces_memory_lineage
        BEFORE INSERT OR UPDATE OF tenant_id, results, memory_ids
        ON omni_retrieval_traces
        FOR EACH ROW
        EXECUTE FUNCTION omni_materialize_trace_memory_lineage();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_retrieval_traces_graph_lock'
          AND tgrelid = 'omni_retrieval_traces'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_retrieval_traces_graph_lock
        BEFORE INSERT OR UPDATE ON omni_retrieval_traces
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_retrieval_traces_validate_deletion_barrier'
          AND tgrelid = 'omni_retrieval_traces'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_retrieval_traces_validate_deletion_barrier
        AFTER INSERT OR UPDATE ON omni_retrieval_traces
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_derived_memory_barrier();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_nodes_memory_lineage'
          AND tgrelid = 'omni_memory_graph_nodes'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_nodes_memory_lineage
        BEFORE INSERT OR UPDATE OF tenant_id, memory_ids, trace_ids
        ON omni_memory_graph_nodes
        FOR EACH ROW
        EXECUTE FUNCTION omni_materialize_graph_memory_lineage();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_nodes_graph_lock'
          AND tgrelid = 'omni_memory_graph_nodes'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_nodes_graph_lock
        BEFORE INSERT OR UPDATE ON omni_memory_graph_nodes
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_nodes_validate_deletion_barrier'
          AND tgrelid = 'omni_memory_graph_nodes'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_memory_graph_nodes_validate_deletion_barrier
        AFTER INSERT OR UPDATE ON omni_memory_graph_nodes
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_derived_memory_barrier();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_edges_memory_lineage'
          AND tgrelid = 'omni_memory_graph_edges'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_edges_memory_lineage
        BEFORE INSERT OR UPDATE OF tenant_id, source_node_id, target_node_id,
          memory_ids, trace_ids
        ON omni_memory_graph_edges
        FOR EACH ROW
        EXECUTE FUNCTION omni_materialize_graph_memory_lineage();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_edges_graph_lock'
          AND tgrelid = 'omni_memory_graph_edges'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_graph_edges_graph_lock
        BEFORE INSERT OR UPDATE ON omni_memory_graph_edges
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_lock_memory_graph_for_statement();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'omni_memory_graph_edges_validate_deletion_barrier'
          AND tgrelid = 'omni_memory_graph_edges'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE CONSTRAINT TRIGGER
          omni_memory_graph_edges_validate_deletion_barrier
        AFTER INSERT OR UPDATE ON omni_memory_graph_edges
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_derived_memory_barrier();
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_deletion_receipts_actor_created_idx
    ON omni_memory_deletion_receipts (
      tenant_id, initiating_actor_id, created_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_deletion_receipts_descendants_idx
    ON omni_memory_deletion_receipts USING GIN (descendant_memory_ids)
  `;

  await sql`
    ALTER TABLE omni_memory_deletion_receipts ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_deletion_receipts FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_retrieval_traces FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_nodes ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_nodes FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_edges ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_memory_graph_edges FORCE ROW LEVEL SECURITY
  `;

  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memories
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_memories
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, ARRAY[id])
      OR EXISTS (
        SELECT 1
        FROM omni_memory_deletion_receipts pending_receipt
        WHERE pending_receipt.tenant_id = omni_memories.tenant_id
          AND pending_receipt.memory_id = omni_memories.id
      )
      OR (
        claim_status = 'forgotten'
        AND title = '[forgotten]'
        AND content = ''
        AND cardinality(tags) = 0
        AND source = '[forgotten]'
        AND embedding IS NULL
        AND cardinality(evidence_refs) = 0
        AND supersedes_id IS NULL
        AND contradiction_of_id IS NULL
        AND forgotten_at IS NOT NULL
        AND COALESCE(
          to_jsonb(omni_memories) -> 'embedding_vector',
          'null'::JSONB
        ) = 'null'::JSONB
      )
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_retrieval_traces
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_retrieval_traces
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, memory_ids)
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_nodes
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_memory_graph_nodes
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, memory_ids)
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_memory_deletion_barrier
    ON omni_memory_graph_edges
  `;
  await sql`
    CREATE POLICY omni_memory_deletion_barrier
    ON omni_memory_graph_edges
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(tenant_id, memory_ids)
      AND EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes source_endpoint
        WHERE source_endpoint.tenant_id = omni_memory_graph_edges.tenant_id
          AND source_endpoint.id = omni_memory_graph_edges.source_node_id
      )
      AND EXISTS (
        SELECT 1
        FROM omni_memory_graph_nodes target_endpoint
        WHERE target_endpoint.tenant_id = omni_memory_graph_edges.tenant_id
          AND target_endpoint.id = omni_memory_graph_edges.target_node_id
      )
    )
  `;

  await sql.query(`
    REVOKE ALL ON TABLE omni_memory_deletion_receipts FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND privilege_type IN ('SELECT', 'INSERT')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'GRANT %s ON TABLE %I.omni_memory_deletion_receipts TO %I',
          grant_record.privilege_type,
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      -- A serving role capable of the full memory mutation boundary must also
      -- be able to invalidate tenant-scoped derived rows in the same forget
      -- transaction. Read-only and partial roles receive no new capability.
      FOR grant_record IN
        SELECT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
        GROUP BY grantee
        HAVING COUNT(DISTINCT privilege_type) = 3
      LOOP
        EXECUTE format(
          'GRANT DELETE ON TABLE %I.omni_retrieval_traces, ' ||
          '%I.omni_memory_graph_edges, %I.omni_memory_graph_nodes TO %I',
          current_schema(),
          current_schema(),
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
}

async function ensureMemoryAccessScopeShadow(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_contract_version SMALLINT NOT NULL DEFAULT 0
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_state TEXT NOT NULL DEFAULT 'legacy_unattributed'
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS owner_actor_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS owner_agent_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS workspace_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS project_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS mission_id TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS visibility TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS sensitivity TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS origin_purpose TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS allowed_purpose_ids TEXT[]
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_scope_sha256 TEXT
  `;
  await sql`
    ALTER TABLE omni_memories
    ADD COLUMN IF NOT EXISTS access_bound_at TIMESTAMPTZ
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_contract_check'
          AND conrelid = 'omni_memories'::regclass
      ) THEN
        ALTER TABLE omni_memories
        ADD CONSTRAINT omni_memories_access_contract_check CHECK (
          (
            access_contract_version = 0
            AND access_state = 'legacy_unattributed'
            AND owner_actor_id IS NULL
            AND owner_agent_id IS NULL
            AND workspace_id IS NULL
            AND project_id IS NULL
            AND mission_id IS NULL
            AND visibility IS NULL
            AND sensitivity IS NULL
            AND origin_purpose IS NULL
            AND allowed_purpose_ids IS NULL
            AND access_scope_sha256 IS NULL
            AND access_bound_at IS NULL
          )
          OR (
            access_contract_version = 1
            AND access_state = 'scope_bound'
            AND omni_source_contract_id_is_valid(owner_actor_id)
            AND visibility IS NOT NULL
            AND visibility IN (
              'agent_private', 'user_private', 'mission_shared',
              'project_shared', 'workspace_shared'
            )
            AND sensitivity IS NOT NULL
            AND sensitivity IN (
              'public', 'internal', 'confidential', 'restricted'
            )
            AND NULLIF(BTRIM(origin_purpose), '') IS NOT NULL
            AND char_length(origin_purpose) <= 500
            AND allowed_purpose_ids IS NOT NULL
            AND array_ndims(allowed_purpose_ids) = 1
            AND array_lower(allowed_purpose_ids, 1) = 1
            AND cardinality(allowed_purpose_ids) BETWEEN 1 AND 32
            AND omni_source_id_array_is_canonical(allowed_purpose_ids, 32)
            AND access_scope_sha256 IS NOT NULL
            AND access_scope_sha256 ~ '^[0-9a-f]{64}$'
            AND access_bound_at IS NOT NULL
            AND (
              visibility <> 'agent_private'
              OR omni_source_contract_id_is_valid(owner_agent_id)
            )
            AND (
              visibility <> 'mission_shared'
              OR omni_source_contract_id_is_valid(mission_id)
            )
            AND (
              visibility <> 'project_shared'
              OR omni_source_contract_id_is_valid(project_id)
            )
            AND (
              visibility <> 'workspace_shared'
              OR omni_source_contract_id_is_valid(workspace_id)
            )
            AND (
              owner_agent_id IS NULL
              OR omni_source_contract_id_is_valid(owner_agent_id)
            )
            AND (
              workspace_id IS NULL
              OR omni_source_contract_id_is_valid(workspace_id)
            )
            AND (
              project_id IS NULL
              OR omni_source_contract_id_is_valid(project_id)
            )
            AND (
              mission_id IS NULL
              OR omni_source_contract_id_is_valid(mission_id)
            )
          )
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_memories
    VALIDATE CONSTRAINT omni_memories_access_contract_check
  `;

  // RLS does not constrain the maintenance connection. Keep the access
  // contract completely dormant until the later atomic runtime cutover drops
  // this enrollment lock in the same migration that activates every reader.
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
      ) THEN
        ALTER TABLE omni_memories
        ADD CONSTRAINT omni_memories_access_enrollment_hold_check CHECK (
          access_contract_version = 0
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_memories
    VALIDATE CONSTRAINT omni_memories_access_enrollment_hold_check
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_bound_memory_access_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.access_contract_version = 1
        AND ROW(
          OLD.tenant_id,
          OLD.access_contract_version,
          OLD.access_state,
          OLD.owner_actor_id,
          OLD.owner_agent_id,
          OLD.workspace_id,
          OLD.project_id,
          OLD.mission_id,
          OLD.visibility,
          OLD.sensitivity,
          OLD.origin_purpose,
          OLD.allowed_purpose_ids,
          OLD.access_scope_sha256,
          OLD.access_bound_at
        ) IS DISTINCT FROM ROW(
          NEW.tenant_id,
          NEW.access_contract_version,
          NEW.access_state,
          NEW.owner_actor_id,
          NEW.owner_agent_id,
          NEW.workspace_id,
          NEW.project_id,
          NEW.mission_id,
          NEW.visibility,
          NEW.sensitivity,
          NEW.origin_purpose,
          NEW.allowed_purpose_ids,
          NEW.access_scope_sha256,
          NEW.access_bound_at
        )
      THEN
        RAISE EXCEPTION 'Bound memory access scope is immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'omni_memories_access_scope_immutable'
          AND tgrelid = 'omni_memories'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memories_access_scope_immutable
        BEFORE UPDATE OF
          tenant_id, access_contract_version, access_state, owner_actor_id,
          owner_agent_id, workspace_id, project_id, mission_id,
          visibility, sensitivity, origin_purpose, allowed_purpose_ids,
          access_scope_sha256, access_bound_at
        ON omni_memories
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_bound_memory_access_change();
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_access_scope_idx
    ON omni_memories (
      tenant_id, visibility, owner_actor_id, owner_agent_id,
      workspace_id, project_id, mission_id, updated_at DESC
    )
    WHERE access_contract_version = 1
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memories_allowed_purposes_idx
    ON omni_memories USING GIN (allowed_purpose_ids)
    WHERE access_contract_version = 1
  `;

  // A v1 access envelope is deliberately inert until every memory, RAG,
  // graph, export, and worker path enters the same actor-aware database scope.
  // Rollback binaries continue to create version-0 compatibility rows.
  await sql`
    DROP POLICY IF EXISTS omni_memory_access_scope_holdback
    ON omni_memories
  `;
  await sql`
    CREATE POLICY omni_memory_access_scope_holdback
    ON omni_memories
    AS RESTRICTIVE
    FOR ALL
    USING (
      access_contract_version = 0
      OR omni_system_scope_enabled()
    )
    WITH CHECK (
      access_contract_version = 0
      OR omni_system_scope_enabled()
    )
  `;

  // Default privileges on a newly created table may grant more than the
  // receipt runtime needs. Triggers already reject mutation; remove the
  // unnecessary capabilities as a second independent control.
  await sql.query(`
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON TABLE omni_memory_deletion_receipts
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_deletion_receipts'
          AND privilege_type IN (
            'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
          )
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ' ||
          'ON TABLE %I.omni_memory_deletion_receipts FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      -- Table-level revocation does not remove privileges granted directly on
      -- individual columns. Remove those independent mutation paths too.
      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_deletion_receipts'
          AND privilege_type IN ('UPDATE', 'REFERENCES')
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE %I.omni_memory_deletion_receipts FROM %s',
          grant_record.privilege_type,
          grant_record.column_name,
          current_schema(),
          CASE
            WHEN grant_record.grantee = 'PUBLIC' THEN 'PUBLIC'
            ELSE quote_ident(grant_record.grantee)
          END
        );
      END LOOP;
    END
    $migration$
  `);
}

async function ensureMemoryAccessSessionContractShadow(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_grant_ids_v1_are_canonical(
      value_to_check JSONB,
      maximum_entries INTEGER
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(value_to_check) IS DISTINCT FROM 'array' THEN FALSE
        WHEN maximum_entries NOT BETWEEN 0 AND 256 THEN FALSE
        WHEN jsonb_array_length(value_to_check) > maximum_entries THEN FALSE
        ELSE NOT EXISTS (
          SELECT 1
          FROM (
            SELECT
              entry.value,
              CASE
                WHEN jsonb_typeof(entry.value) = 'string'
                  THEN entry.value #>> '{}'
                ELSE NULL
              END AS id,
              lag(
                CASE
                  WHEN jsonb_typeof(entry.value) = 'string'
                    THEN entry.value #>> '{}'
                  ELSE NULL
                END
              ) OVER (ORDER BY entry.ordinal_position) AS previous_id
            FROM jsonb_array_elements(value_to_check)
              WITH ORDINALITY AS entry(value, ordinal_position)
          ) ordered_ids
          WHERE jsonb_typeof(ordered_ids.value) IS DISTINCT FROM 'string'
            OR NOT public.omni_source_contract_id_is_valid(ordered_ids.id)
            OR (
              ordered_ids.previous_id IS NOT NULL
              AND ordered_ids.id COLLATE "C"
                <= ordered_ids.previous_id COLLATE "C"
            )
        )
      END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_scope_v1_is_valid(
      candidate JSONB
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT CASE
        WHEN jsonb_typeof(candidate) IS DISTINCT FROM 'object' THEN FALSE
        ELSE COALESCE((
          candidate ?& ARRAY[
            'version', 'tenantId', 'initiatingActorId',
            'executingPrincipalType', 'executingPrincipalId',
            'workspaceId', 'projectId', 'missionId',
            'contextGrantIds', 'capabilityGrantIds',
            'purposeId', 'purpose'
          ]
          AND candidate - ARRAY[
            'version', 'tenantId', 'initiatingActorId',
            'executingPrincipalType', 'executingPrincipalId',
            'workspaceId', 'projectId', 'missionId',
            'contextGrantIds', 'capabilityGrantIds',
            'purposeId', 'purpose'
          ] = '{}'::JSONB
          AND public.omni_jsonb_safe_integer(candidate -> 'version', 1)
          AND public.omni_jsonb_safe_integer_value(
            candidate -> 'version'
          ) = 1
          AND jsonb_typeof(candidate -> 'tenantId') = 'string'
          AND public.omni_source_contract_id_is_valid(candidate ->> 'tenantId')
          AND jsonb_typeof(candidate -> 'initiatingActorId') = 'string'
          AND public.omni_source_contract_id_is_valid(
            candidate ->> 'initiatingActorId'
          )
          AND jsonb_typeof(candidate -> 'executingPrincipalType') = 'string'
          AND candidate ->> 'executingPrincipalType' IN (
            'user', 'agent', 'system'
          )
          AND jsonb_typeof(candidate -> 'executingPrincipalId') = 'string'
          AND public.omni_source_contract_id_is_valid(
            candidate ->> 'executingPrincipalId'
          )
          AND (
            candidate ->> 'executingPrincipalType' <> 'user'
            OR candidate ->> 'executingPrincipalId'
              = candidate ->> 'initiatingActorId'
          )
          AND CASE
            WHEN candidate -> 'workspaceId' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'workspaceId') = 'string' THEN
              public.omni_source_contract_id_is_valid(
                candidate ->> 'workspaceId'
              )
            ELSE FALSE
          END
          AND CASE
            WHEN candidate -> 'projectId' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'projectId') = 'string' THEN
              public.omni_source_contract_id_is_valid(
                candidate ->> 'projectId'
              )
            ELSE FALSE
          END
          AND CASE
            WHEN candidate -> 'missionId' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'missionId') = 'string' THEN
              public.omni_source_contract_id_is_valid(
                candidate ->> 'missionId'
              )
            ELSE FALSE
          END
          AND public.omni_memory_access_grant_ids_v1_are_canonical(
            candidate -> 'contextGrantIds',
            256
          )
          AND public.omni_memory_access_grant_ids_v1_are_canonical(
            candidate -> 'capabilityGrantIds',
            256
          )
          AND jsonb_typeof(candidate -> 'purposeId') = 'string'
          AND public.omni_source_contract_id_is_valid(candidate ->> 'purposeId')
          AND CASE
            WHEN candidate -> 'purpose' = 'null'::JSONB THEN TRUE
            WHEN jsonb_typeof(candidate -> 'purpose') = 'string' THEN
              candidate ->> 'purpose' = btrim(candidate ->> 'purpose')
              AND char_length(candidate ->> 'purpose') BETWEEN 1 AND 500
            ELSE FALSE
          END
        ), FALSE)
      END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_current_memory_access_scope_v1()
    RETURNS JSONB
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      raw_scope TEXT;
      parsed_scope JSONB;
    BEGIN
      raw_scope := NULLIF(
        current_setting('omni.memory_access_scope_v1', TRUE),
        ''
      );
      IF raw_scope IS NULL OR octet_length(raw_scope) > 262144 THEN
        RETURN NULL;
      END IF;

      BEGIN
        parsed_scope := raw_scope::JSONB;
      EXCEPTION
        WHEN data_exception OR program_limit_exceeded THEN
          RETURN NULL;
      END;

      IF public.omni_memory_access_scope_v1_is_valid(parsed_scope)
        IS DISTINCT FROM TRUE
      THEN
        RETURN NULL;
      END IF;
      IF public.omni_current_tenant() IS NULL
        OR parsed_scope ->> 'tenantId'
          IS DISTINCT FROM public.omni_current_tenant()
      THEN
        RETURN NULL;
      END IF;
      IF current_setting('omni.system_scope', TRUE) IS DISTINCT FROM 'false' THEN
        RETURN NULL;
      END IF;

      RETURN parsed_scope;
    END
    $function$
  `;

  // Keep the shadow contract unavailable to serving roles until one later
  // cutover sets it transaction-locally and all memory-derived paths enforce it.
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_access_grant_ids_v1_are_canonical(JSONB, INTEGER)
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_access_scope_v1_is_valid(JSONB)
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_current_memory_access_scope_v1()
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_memory_access_grant_ids_v1_are_canonical(JSONB, INTEGER), ' ||
          '%I.omni_memory_access_scope_v1_is_valid(JSONB), ' ||
          '%I.omni_current_memory_access_scope_v1() FROM %I',
          current_schema(),
          current_schema(),
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // v44 is additive only. Abort if the v43 enrollment and RLS barriers have
  // drifted; this migration must not silently repair or relax either boundary.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:contract_check',
        'initiatingActorId', 'actor:contract_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:contract_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', jsonb_build_array('grant:a', 'grant:b'),
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory:contract_check',
        'purpose', 'Memory access contract self-check'
      );

      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
      THEN
        RAISE EXCEPTION 'Memory access session contract rejected a valid scope'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(
        jsonb_set(
          valid_scope,
          '{executingPrincipalType}',
          '"system"'::JSONB
        )
      ) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Memory access session contract rejected an actor-bound system principal'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope - 'purposeId')
        IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope || jsonb_build_object('extra', TRUE)
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid('[]'::JSONB)
          IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          jsonb_set(
            valid_scope,
            '{executingPrincipalId}',
            '"actor:other"'::JSONB
          )
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:a', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:b', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Memory access session contract accepted a non-canonical scope'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid)
            = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment hold is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memories'::regclass
          AND attribute.attname = 'access_contract_version'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('0', '0::smallint', '(0)::smallint')
      ) THEN
        RAISE EXCEPTION 'Memory access contract version default has drifted'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version <> 0
      ) THEN
        RAISE EXCEPTION 'Memory access scope shadow contains an enrollment'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory access scope shadow requires forced RLS'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability trigger is missing or disabled'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND polqual IS NOT NULL
          AND polwithcheck IS NOT NULL
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access RLS holdback is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
      ) THEN
        RAISE EXCEPTION 'A row policy depends on the dormant memory access contract'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_memory_access_grant_ids_v1_are_canonical(jsonb,integer)'
        )
          AND prorettype = 'boolean'::regtype
          AND provolatile = 'i'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_valid(jsonb)'
        )
          AND prorettype = 'boolean'::regtype
          AND provolatile = 'i'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_current_memory_access_scope_v1()'
        )
          AND prorettype = 'jsonb'::regtype
          AND provolatile = 's'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) THEN
        RAISE EXCEPTION 'Memory access session function metadata is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory access session functions have serving grants'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

async function ensureMemoryAccessAuthorizationDenyHook(sql: SqlClient) {
  // Establish the eventual authorization boundary without fabricating
  // authority from OAuth grants, rollout state, or free-form purpose text.
  // The real resolver must replace this body and lock every authoritative
  // membership, principal, target, purpose, and grant row before activation.
  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_scope_v1_is_authorized(
      candidate JSONB
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    VOLATILE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT FALSE
    $function$
  `;

  // Serving roles cannot call the held hook until its authoritative inputs,
  // same-transaction locks, installer composition, and all-surface cutover
  // are complete.
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_access_scope_v1_is_authorized(JSONB)
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_memory_access_scope_v1_is_authorized(JSONB) FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // v45 is an additive, always-deny seam. Abort on any drift that would make
  // the hook reachable, enroll a v1 memory, or relax the v43 safety barriers.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:authorization_check',
        'initiatingActorId', 'actor:authorization_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:authorization_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory:authorization_check',
        'purpose', 'Memory authorization deny-hook self-check'
      );

      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
      THEN
        RAISE EXCEPTION 'Memory authorization self-check scope is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_authorized(valid_scope)
        IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization hook did not deny'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig @> ARRAY['search_path=pg_catalog, public']
          AND language.lanname = 'sql'
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook metadata is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook has serving grants'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid)
            = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment hold is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version <> 0
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook found an enrolled memory'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory authorization hook requires forced RLS'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability trigger is missing or disabled'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND polqual IS NOT NULL
          AND polwithcheck IS NOT NULL
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access RLS holdback is missing or invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
      ) THEN
        RAISE EXCEPTION 'A row policy depends on the dormant authorization hook'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

async function ensureCanonicalAuthUserActorIdsShadow(sql: SqlClient) {
  // A browser/mobile actor is still the historical email-shaped owner key.
  // Add a stable, non-email pseudonymous identity without changing any served
  // context, ownership query, ciphertext AAD, durable scope, or receipt.
  await sql`
    DO $migration$
    DECLARE
      actor_attribute RECORD;
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE id !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR NOT public.omni_source_contract_id_is_valid('actor:' || id)
      ) THEN
        RAISE EXCEPTION 'An auth-user ID is not an opaque canonical UUID'
          USING ERRCODE = '55000';
      END IF;

      SELECT
        attribute.atttypid,
        attribute.attgenerated,
        pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
          AS generation_expression
      INTO actor_attribute
      FROM pg_attribute attribute
      LEFT JOIN pg_attrdef attribute_default
        ON attribute_default.adrelid = attribute.attrelid
        AND attribute_default.adnum = attribute.attnum
      WHERE attribute.attrelid = 'omni_auth_users'::regclass
        AND attribute.attname = 'actor_id'
        AND NOT attribute.attisdropped;

      IF FOUND AND (
        actor_attribute.atttypid <> 'text'::regtype
        OR actor_attribute.attgenerated <> 's'
        OR actor_attribute.generation_expression
          IS DISTINCT FROM '(''actor:''::text || id)'
      ) THEN
        RAISE EXCEPTION 'Existing auth-user actor identity column is incompatible'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_auth_users
    ADD COLUMN IF NOT EXISTS actor_id TEXT
      GENERATED ALWAYS AS ('actor:'::TEXT || id) STORED
  `;
  await sql`
    ALTER TABLE omni_auth_users
    ALTER COLUMN actor_id SET NOT NULL
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
      ) THEN
        ALTER TABLE omni_auth_users
        ADD CONSTRAINT omni_auth_users_id_uuid_check CHECK (
          id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_auth_users
    VALIDATE CONSTRAINT omni_auth_users_id_uuid_check
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user UUID check is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
      ) THEN
        ALTER TABLE omni_auth_users
        ADD CONSTRAINT omni_auth_users_actor_id_contract_check CHECK (
          omni_source_contract_id_is_valid(actor_id)
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_auth_users
    VALIDATE CONSTRAINT omni_auth_users_actor_id_contract_check
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_key'
          AND conrelid = 'omni_auth_users'::regclass
      ) THEN
        ALTER TABLE omni_auth_users
        ADD CONSTRAINT omni_auth_users_actor_id_key UNIQUE (actor_id);
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_auth_user_identity_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Canonical auth-user identity is immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_users'::regclass
          AND tgname = 'omni_auth_users_actor_identity_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_auth_users_actor_identity_immutable
        BEFORE UPDATE OF id OR DELETE ON omni_auth_users
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_auth_user_identity_change();
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_users'::regclass
          AND tgname = 'omni_auth_users_actor_identity_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_auth_users_actor_identity_no_truncate
        BEFORE TRUNCATE ON omni_auth_users
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_auth_user_identity_change();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_auth_user_identity_change()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE DELETE, TRUNCATE
    ON TABLE omni_auth_users
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_auth_user_identity_change() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_users'
          AND privilege_type IN ('DELETE', 'TRUNCATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE DELETE, TRUNCATE ON TABLE %I.omni_auth_users FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // v46 must create identity only. It neither maps a legacy owner nor makes
  // the still-denying memory authorization hook reachable.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_auth_users'::regclass
          AND attribute.attname = 'actor_id'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'text'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = 's'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '(''actor:''::text || id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity column is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_source_contract_id_is_valid(actor_id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity check is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname = 'omni_auth_users_actor_id_key'
          AND constraint_record.conrelid = 'omni_auth_users'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_users'::regclass
                AND attname = 'actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity uniqueness is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE actor_id IS DISTINCT FROM 'actor:' || id
          OR NOT public.omni_source_contract_id_is_valid(actor_id)
      ) OR (
        SELECT count(*) FROM omni_auth_users
      ) IS DISTINCT FROM (
        SELECT count(DISTINCT actor_id) FROM omni_auth_users
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity mapping is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 27
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = (
            SELECT attnum::TEXT
            FROM pg_attribute
            WHERE attrelid = 'omni_auth_users'::regclass
              AND attname = 'id'
              AND NOT attisdropped
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_reject_auth_user_identity_change()'
        )
          AND prorettype = 'trigger'::regtype
          AND provolatile = 'v'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity function is exposed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_users'
          AND privilege_type IN ('DELETE', 'TRUNCATE')
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identities remain removable'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_auth_memberships membership
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = membership.user_id
        WHERE auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_sessions session_record
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = session_record.user_id
        WHERE auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_mobile_sessions mobile_session
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = mobile_session.user_id
        WHERE auth_user.id IS NULL
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity has orphaned references'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_auth_users'::regclass
          AND (relrowsecurity OR relforcerowsecurity)
      ) THEN
        RAISE EXCEPTION 'Auth users cannot require tenant scope before login'
          USING ERRCODE = '55000';
      END IF;

      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:actor_identity_check',
        'initiatingActorId', 'actor:actor_identity_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:actor_identity_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory:actor_identity_check',
        'purpose', 'Canonical actor identity self-check'
      );
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig @> ARRAY['search_path=pg_catalog, public']
          AND language.lanname = 'sql'
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook metadata changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook has serving grants'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
      ) THEN
        RAISE EXCEPTION 'A row policy uses the dormant authorization hook'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid)
            = '(access_contract_version = 0)'
      ) OR EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version <> 0
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory access forced RLS boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND polqual IS NOT NULL
          AND polwithcheck IS NOT NULL
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access restrictive holdback changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

async function ensureMemoryPurposeCatalog(sql: SqlClient) {
  // Ordered security migrations must run as the stable schema owner. Failing
  // before CREATE OR REPLACE avoids transferring trust to a rotated role.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory purpose migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_purpose_catalog_row_is_valid(
      candidate_purpose_id TEXT,
      candidate_contract_version SMALLINT,
      candidate_operation_class TEXT,
      candidate_description TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$SELECT public.omni_source_contract_id_is_valid(candidate_purpose_id) AND candidate_contract_version BETWEEN 1 AND 32767 AND candidate_operation_class IN ('read', 'retrieve', 'write', 'correct', 'forget', 'formation', 'maintenance', 'export') AND candidate_purpose_id = 'memory.' || candidate_operation_class || '.v' || candidate_contract_version::TEXT AND candidate_description = btrim(candidate_description) AND char_length(candidate_description) BETWEEN 1 AND 500$function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_purpose_catalog (
      purpose_id TEXT PRIMARY KEY,
      contract_version SMALLINT NOT NULL,
      operation_class TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_purpose_catalog_operation_version_key
        UNIQUE (operation_class, contract_version),
      CONSTRAINT omni_memory_purpose_catalog_contract_check CHECK (
        omni_memory_purpose_catalog_row_is_valid(
          purpose_id,
          contract_version,
          operation_class,
          description
        )
      )
    )
  `;

  await sql`
    INSERT INTO omni_memory_purpose_catalog (
      purpose_id,
      contract_version,
      operation_class,
      description
    )
    VALUES
      (
        'memory.read.v1', 1, 'read',
        'Inspect authorized memory records without selecting them for model context.'
      ),
      (
        'memory.retrieve.v1', 1, 'retrieve',
        'Search and select authorized memory content for a bounded context or RAG operation.'
      ),
      (
        'memory.write.v1', 1, 'write',
        'Create or import an explicit authorized memory record.'
      ),
      (
        'memory.correct.v1', 1, 'correct',
        'Supersede, contradict, or revise an authorized memory claim.'
      ),
      (
        'memory.forget.v1', 1, 'forget',
        'Explicitly and irreversibly delete or scrub authorized memory and its descendants.'
      ),
      (
        'memory.formation.v1', 1, 'formation',
        'Derive a candidate episode, claim, or summary from authorized evidence.'
      ),
      (
        'memory.maintenance.v1', 1, 'maintenance',
        'Run authorized retention, rebuild, reindex, or repair work.'
      ),
      (
        'memory.export.v1', 1, 'export',
        'Export an authorized memory set through portable or bulk egress.'
      )
    ON CONFLICT (purpose_id) DO NOTHING
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_purpose_catalog_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$BEGIN RAISE EXCEPTION 'Memory purpose contracts are append-only' USING ERRCODE = '55000'; END$function$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memory_purpose_catalog'::regclass
          AND tgname = 'omni_memory_purpose_catalog_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_purpose_catalog_immutable
        BEFORE UPDATE OR DELETE ON omni_memory_purpose_catalog
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_memory_purpose_catalog_change();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memory_purpose_catalog'::regclass
          AND tgname = 'omni_memory_purpose_catalog_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_purpose_catalog_no_truncate
        BEFORE TRUNCATE ON omni_memory_purpose_catalog
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_memory_purpose_catalog_change();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE omni_memory_purpose_catalog
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_purpose_catalog_row_is_valid(
      TEXT,
      SMALLINT,
      TEXT,
      TEXT
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_memory_purpose_catalog_change()
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_memory_purpose_catalog FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE %I.omni_memory_purpose_catalog FROM %s',
          grant_record.privilege_type,
          grant_record.column_name,
          current_schema(),
          CASE
            WHEN grant_record.grantee = 'PUBLIC' THEN 'PUBLIC'
            ELSE quote_ident(grant_record.grantee)
          END
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_purpose_catalog_row_is_valid',
            'omni_reject_memory_purpose_catalog_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_memory_purpose_catalog_row_is_valid(' ||
          'TEXT, SMALLINT, TEXT, TEXT) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_memory_purpose_catalog_change() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // The catalog defines vocabulary only. It grants no tenant, actor, agent,
  // workflow, or maintenance process permission to use a purpose.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_memory_purpose_catalog'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND NOT relation.relrowsecurity
          AND NOT relation.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog relation is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            array_agg(attribute.attname ORDER BY attribute.attnum) AS names,
            bool_and(attribute.attnotnull) AS all_not_null,
            bool_and(attribute.attgenerated = '') AS none_generated,
            count(*) AS column_count
          FROM pg_attribute attribute
          WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'purpose_id', 'contract_version', 'operation_class',
            'description', 'created_at'
          ]
          AND columns.all_not_null
          AND columns.none_generated
          AND columns.column_count = 5
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'purpose_id'
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'contract_version'
          AND atttypid = 'smallint'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname IN ('operation_class', 'description')
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
        GROUP BY attrelid
        HAVING count(*) = 2
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attribute.attname = 'created_at'
          AND attribute.atttypid = 'timestamp with time zone'::regtype
          AND NOT attribute.attisdropped
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog columns are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_pkey'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'p'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'purpose_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_operation_version_key'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'operation_class'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'contract_version'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND NOT index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memory_purpose_catalog_contract_check'
          AND conrelid = 'omni_memory_purpose_catalog'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_memory_purpose_catalog_row_is_valid(purpose_id, contract_version, operation_class, description)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog constraints are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (SELECT count(*) FROM omni_memory_purpose_catalog) <> 8
        OR EXISTS (
          SELECT 1
          FROM omni_memory_purpose_catalog actual
          LEFT JOIN (
            VALUES
              ('memory.read.v1', 1::SMALLINT, 'read',
                'Inspect authorized memory records without selecting them for model context.'),
              ('memory.retrieve.v1', 1::SMALLINT, 'retrieve',
                'Search and select authorized memory content for a bounded context or RAG operation.'),
              ('memory.write.v1', 1::SMALLINT, 'write',
                'Create or import an explicit authorized memory record.'),
              ('memory.correct.v1', 1::SMALLINT, 'correct',
                'Supersede, contradict, or revise an authorized memory claim.'),
              ('memory.forget.v1', 1::SMALLINT, 'forget',
                'Explicitly and irreversibly delete or scrub authorized memory and its descendants.'),
              ('memory.formation.v1', 1::SMALLINT, 'formation',
                'Derive a candidate episode, claim, or summary from authorized evidence.'),
              ('memory.maintenance.v1', 1::SMALLINT, 'maintenance',
                'Run authorized retention, rebuild, reindex, or repair work.'),
              ('memory.export.v1', 1::SMALLINT, 'export',
                'Export an authorized memory set through portable or bulk egress.')
          ) expected(purpose_id, contract_version, operation_class, description)
            ON expected.purpose_id = actual.purpose_id
            AND expected.contract_version = actual.contract_version
            AND expected.operation_class = actual.operation_class
            AND expected.description = actual.description
          WHERE expected.purpose_id IS NULL
        )
      THEN
        RAISE EXCEPTION 'Memory purpose catalog seed contracts are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
          )
          AND trigger_record.tgtype = 27
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_purpose_catalog_row_is_valid(text,smallint,text,text)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'sql'
          AND procedure.prosrc = $expected$SELECT public.omni_source_contract_id_is_valid(candidate_purpose_id) AND candidate_contract_version BETWEEN 1 AND 32767 AND candidate_operation_class IN ('read', 'retrieve', 'write', 'correct', 'forget', 'formation', 'maintenance', 'export') AND candidate_purpose_id = 'memory.' || candidate_operation_class || '.v' || candidate_contract_version::TEXT AND candidate_description = btrim(candidate_description) AND char_length(candidate_description) BETWEEN 1 AND 500$expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_memory_purpose_catalog_change()'
        )
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc =
            $expected$BEGIN RAISE EXCEPTION 'Memory purpose contracts are append-only' USING ERRCODE = '55000'; END$expected$
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_purpose_catalog_row_is_valid',
            'omni_reject_memory_purpose_catalog_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog is exposed to a serving role'
          USING ERRCODE = '55000';
      END IF;

      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:purpose_catalog_check',
        'initiatingActorId', 'actor:purpose_catalog_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:purpose_catalog_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory.read.v1',
        'purpose', 'Memory purpose catalog self-check'
      );
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(
        jsonb_set(
          valid_scope,
          '{executingPrincipalType}',
          '"system"'::JSONB
        )
      ) IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope - 'purposeId'
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope || jsonb_build_object('extra', TRUE)
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid('[]'::JSONB)
          IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          jsonb_set(
            valid_scope,
            '{executingPrincipalId}',
            '"actor:other"'::JSONB
          )
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:a', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:b', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory access validator changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
      ) THEN
        RAISE EXCEPTION 'A row policy uses the dormant access contract'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_grant_ids_v1_are_canonical(jsonb,integer)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'sql'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_valid(jsonb)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'sql'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_current_memory_access_scope_v1()'
        )
          AND procedure.prorettype = 'jsonb'::regtype
          AND procedure.provolatile = 's'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory access functions changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'sql'
          AND btrim(regexp_replace(
            procedure.prosrc,
            '[[:space:]]+',
            ' ',
            'g'
          )) = 'SELECT FALSE'
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
      ) THEN
        RAISE EXCEPTION 'A row policy uses the dormant authorization hook'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(access_contract_version = 0)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memories'::regclass
          AND attribute.attname = 'access_contract_version'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'smallint'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = ''
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('0', '0::smallint', '(0)::smallint')
      ) OR EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version IS DISTINCT FROM 0
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_auth_users'::regclass
          AND attribute.attname = 'actor_id'
          AND attribute.atttypid = 'text'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = 's'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '(''actor:''::text || id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_source_contract_id_is_valid(actor_id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity checks changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname = 'omni_auth_users_actor_id_key'
          AND constraint_record.conrelid = 'omni_auth_users'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_users'::regclass
                AND attname = 'actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity uniqueness changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE actor_id IS DISTINCT FROM 'actor:' || id
          OR NOT public.omni_source_contract_id_is_valid(actor_id)
      ) OR (
        SELECT count(*) FROM omni_auth_users
      ) IS DISTINCT FROM (
        SELECT count(DISTINCT actor_id) FROM omni_auth_users
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity mapping changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 27
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = (
            SELECT attnum::TEXT
            FROM pg_attribute
            WHERE attrelid = 'omni_auth_users'::regclass
              AND attname = 'id'
              AND NOT attisdropped
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity triggers changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_auth_user_identity_change()'
        )
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity function changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_auth_users'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity owner changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_users'
          AND privilege_type IN ('DELETE', 'TRUNCATE')
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identities remain removable'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_auth_memberships membership
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = membership.user_id
        WHERE auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_sessions session_record
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = session_record.user_id
        WHERE auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_mobile_sessions mobile_session
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = mobile_session.user_id
        WHERE auth_user.id IS NULL
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity has orphaned references'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_auth_users'::regclass
          AND (relrowsecurity OR relforcerowsecurity)
      ) THEN
        RAISE EXCEPTION 'Auth users cannot require tenant scope before login'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
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

  // Keep policy application inside one server-side block. Besides avoiding
  // hundreds of pooler round-trips during upgrades, this lets earlier
  // migrations safely skip tables that are only introduced by later ones.
  const policyTableArray = tenantPolicyTables
    .map((tableName) => `'${tableName.replaceAll("'", "''")}'`)
    .join(", ");
  await sql.query(`
    DO $migration$
    DECLARE
      policy_table TEXT;
      policy_schema TEXT := current_schema();
    BEGIN
      FOREACH policy_table IN ARRAY ARRAY[${policyTableArray}] LOOP
        IF to_regclass(format('%I.%I', policy_schema, policy_table)) IS NULL THEN
          CONTINUE;
        END IF;

        EXECUTE format(
          'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
          policy_schema,
          policy_table
        );
        EXECUTE format(
          'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
          policy_schema,
          policy_table
        );

        IF EXISTS (
          SELECT 1
          FROM pg_policy policy
          JOIN pg_class relation ON relation.oid = policy.polrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = policy_schema
            AND relation.relname = policy_table
            AND policy.polname = 'omni_tenant_isolation'
        ) THEN
          EXECUTE format(
            'ALTER POLICY omni_tenant_isolation ON %I.%I ' ||
            'USING (omni_tenant_visible(tenant_id)) ' ||
            'WITH CHECK (omni_tenant_visible(tenant_id))',
            policy_schema,
            policy_table
          );
        ELSE
          EXECUTE format(
            'CREATE POLICY omni_tenant_isolation ON %I.%I FOR ALL ' ||
            'USING (omni_tenant_visible(tenant_id)) ' ||
            'WITH CHECK (omni_tenant_visible(tenant_id))',
            policy_schema,
            policy_table
          );
        END IF;
      END LOOP;
    END
    $migration$
  `);
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
