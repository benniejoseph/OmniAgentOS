import {
  ensureDatabaseSchema,
  getSql,
  getStorageBackend,
  hasDatabaseUrl,
  migrationScopedTenantTables,
  tenantChildPolicyTables,
  tenantIsolationExemptTables,
  tenantPolicyTables,
} from "@/lib/db/client";
import { getEvalRunDetail, listEvalRuns } from "@/lib/evaluations/store";

type IsolationTableReport = {
  tableName: string;
  category: "root" | "child";
  exists: boolean;
  tenantColumn: boolean;
  rlsEnabled: boolean;
  forceRls: boolean;
  policyPresent: boolean;
  status: "pass" | "fail";
};

type IsolationPolicyEvidence = {
  tableName: string;
  policyName: string;
  permissive: boolean;
  command: string;
};

/** Tables whose one permissive policy is `<table>_actor`. */
const ACTOR_POLICY_TABLES = new Set([
  "omni_mobile_push_registrations",
  "omni_mobile_push_deliveries",
  "omni_person_contact_policies",
  "omni_communication_intents",
  "omni_message_drafts",
  "omni_delivery_receipts",
  "omni_conversation_links",
  "omni_inbound_communications",
  "omni_ap2_signing_credentials",
  "omni_ap2_mandate_reviews",
  "omni_ap2_mandate_authorizations",
  "omni_ap2_credential_grants",
  "omni_ap2_credential_claims",
  "omni_ap2_payment_transactions",
  "omni_ap2_payment_receipts",
  "omni_ap2_reconciliation_observations",
  "omni_ap2_reconciliation_jobs",
]);

/** Tables whose one permissive policy is `<table>_actor_scope`. */
const ACTOR_SCOPE_POLICY_TABLES = new Set([
  "omni_personal_context_consents",
  "omni_app_builder_sessions",
  "omni_app_builder_checkpoints",
  "omni_app_builder_verifications",
  "omni_app_builder_repository_bindings",
  "omni_app_builder_deliveries",
  "omni_app_builder_deployments",
  "omni_app_builder_releases",
  "omni_app_builder_events",
  "omni_market_macro_events",
  "omni_market_macro_event_events",
  "omni_market_macro_event_schedules",
  "omni_market_macro_event_schedule_events",
  "omni_market_macro_observations",
  "omni_market_macro_observation_events",
  "omni_market_price_snapshots",
  "omni_market_price_snapshot_events",
  "omni_market_event_replays",
  "omni_market_event_replay_events",
  "omni_market_backtests",
  "omni_market_backtest_events",
  "omni_local_computer_commands",
  "omni_local_computer_devices",
  "omni_local_computer_sessions",
  "omni_market_analysis_events",
  "omni_market_analysis_versions",
  "omni_market_forecast_events",
  "omni_market_forecast_outcomes",
  "omni_market_forward_forecasts",
]);

/**
 * Tables whose permissive omni_tenant_isolation policy admits the tenant's
 * rows, each with the restrictive policy that narrows them to the actor's own.
 */
const RESTRICTIVE_ACTOR_POLICIES = new Map<string, string>([
  ...[
    "omni_companion_preferences",
    "omni_companion_preference_mutations",
    "omni_responsibilities",
    "omni_responsibility_mutations",
    "omni_responsibility_observations",
    "omni_responsibility_baselines",
    "omni_responsibility_changes",
    "omni_responsibility_lifecycles",
    "omni_responsibility_wakes",
    "omni_responsibility_runtime_receipts",
    "omni_responsibility_budget_entries",
    "omni_responsibility_notification_admissions",
    "omni_responsibility_notification_candidates",
    "omni_responsibility_notification_receipts",
    "omni_a2a_exchanges",
    "omni_a2a_peer_rollouts",
    "omni_a2a_safety_reservations",
    "omni_a2a_task_mappings",
    "omni_a2a_tool_call_claims",
    "omni_agent_adaptations",
    "omni_agent_definition_versions",
    "omni_agent_learning_cycles",
    "omni_agent_learning_observations",
    "omni_agent_principal_policies",
    "omni_agent_release_channels",
    "omni_agent_release_evaluations",
    "omni_approval_grant_claims",
    "omni_approval_grants",
    "omni_browser_profile_bindings",
    "omni_browser_profiles",
    "omni_browser_takeovers",
    "omni_delegation_budget_ledgers",
    "omni_delegation_executions",
    "omni_delegation_tasks",
    "omni_generated_artifact_mutations",
    "omni_generated_artifact_versions",
    "omni_generated_artifacts",
    "omni_mobile_push_delivery_receipts",
    "omni_moltbook_activities",
    "omni_moltbook_authority_versions",
    "omni_moltbook_autonomy_action_claims",
    "omni_moltbook_autonomy_cycles",
    "omni_moltbook_autonomy_enrollments",
    "omni_moltbook_autonomy_events",
    "omni_moltbook_connections",
    "omni_moltbook_effect_receipts",
    "omni_moltbook_interest_observations",
    "omni_notification_digest_deliveries",
    "omni_notification_digest_watermarks",
    "omni_notification_dispositions",
    "omni_plugin_install_previews",
    "omni_plugin_installations",
    "omni_plugin_mutation_receipts",
    "omni_policy_lease_consumptions",
    "omni_policy_leases",
    "omni_prompt_queue_items",
    "omni_trash_effect_receipts",
    "omni_trash_items",
    "omni_workflow_schedule_occurrence_receipts",
    "omni_workflow_schedule_occurrences",
    "omni_workflow_schedule_shadow_events",
  ].map((tableName): [string, string] => [tableName, `${tableName}_actor`]),
  ["omni_meeting_commitment_resolution_intents", "omni_meeting_commitment_resolution_intents_owner"],
  ["omni_meeting_commitment_resolution_progress", "omni_meeting_commitment_resolution_progress_owner"],
  ["omni_tenant_memory_access_grants", "omni_memory_access_grant_actor"],
  ["omni_workflow_triggers", "omni_workflow_triggers_schedule_actor"],
]);

export function expectedTenantIsolationPolicyName(tableName: string) {
  if (ACTOR_SCOPE_POLICY_TABLES.has(tableName)) {
    return `${tableName}_actor_scope`;
  }
  if (ACTOR_POLICY_TABLES.has(tableName)) {
    return `${tableName}_actor`;
  }
  return "omni_tenant_isolation";
}

/**
 * The expected policy must be the table's only permissive policy, and it must
 * cover every command. Permissive policies combine with OR, so a second one
 * would admit rows the expected policy refuses.
 */
export function hasExpectedTenantIsolationPolicy(
  tableName: string,
  policies: IsolationPolicyEvidence[],
) {
  const tablePolicies = policies.filter((policy) => policy.tableName === tableName);
  const [permissive, ...otherPermissive] = tablePolicies.filter((policy) => policy.permissive);
  if (
    !permissive
    || otherPermissive.length
    || permissive.policyName !== expectedTenantIsolationPolicyName(tableName)
    || permissive.command !== "*"
  ) {
    return false;
  }
  // The table's one permissive policy is omni_tenant_isolation, so a policy
  // with the restrictive policy's name is restrictive.
  const restrictivePolicyName = RESTRICTIVE_ACTOR_POLICIES.get(tableName);
  return !restrictivePolicyName
    || tablePolicies.some((policy) =>
      policy.policyName === restrictivePolicyName && policy.command === "*"
    );
}

const CLASSIFIED_TABLES = new Set<string>([
  ...tenantPolicyTables,
  ...migrationScopedTenantTables,
  ...Object.keys(tenantIsolationExemptTables),
]);

/** The tables that are neither tenant tables nor exempt from tenant policy. */
export function unclassifiedTenantIsolationTables(tableNames: Iterable<string>) {
  return [...new Set(tableNames)]
    .filter((tableName) => !CLASSIFIED_TABLES.has(tableName))
    .sort();
}

type LatestTenantIsolationEval = {
  runId: string;
  runStatus: string;
  resultStatus: string;
  score: number;
  createdAt: string;
  completedAt?: string;
};

export type TenantIsolationReport = {
  tenantId: string;
  checkedAt: string;
  storageBackend: string;
  databaseConfigured: boolean;
  status: "passing" | "degraded" | "not_configured";
  summary: {
    expectedTables: number;
    protectedTables: number;
    childTables: number;
    failingTables: number;
    unclassifiedTables: string[];
    missingTables: string[];
    missingTenantColumns: string[];
    rlsDisabled: string[];
    forceRlsDisabled: string[];
    missingPolicies: string[];
  };
  tables: IsolationTableReport[];
  latestEval?: LatestTenantIsolationEval;
  recommendations: string[];
};

export type TenantIsolationCatalog = {
  tables: IsolationTableReport[];
  unclassifiedTables: string[];
  missingTables: string[];
  missingTenantColumns: string[];
  rlsDisabled: string[];
  forceRlsDisabled: string[];
  missingPolicies: string[];
};

/**
 * Reads from the catalog whether each tenant table exists with a tenant column,
 * enables and forces row security, and has its expected policy, and which app
 * tables no isolation class covers. `query` binds `$1`, `$2`, … to `params`.
 */
export async function readTenantIsolationCatalog(
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
): Promise<TenantIsolationCatalog> {
  const expectedTables = [...tenantPolicyTables, ...migrationScopedTenantTables];
  const childTables = new Set<string>(tenantChildPolicyTables);
  const placeholders = expectedTables.map((_, index) => `$${index + 1}`).join(", ");
  // Every app table, so that one no isolation class covers is reported.
  const catalogRows = await query(
    `
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS force_rls
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind IN ('r', 'p')
        AND c.relname LIKE 'omni\\_%'
    `,
  );
  // information_schema hides columns when the caller intentionally has no
  // table privilege. Read the non-sensitive system catalogs so owner-only
  // tenant authorities are still represented without widening their ACLs.
  const columnRows = await query(
    `
      SELECT relation.relname AS table_name
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relkind = 'r'
        AND relation.relname IN (${placeholders})
        AND attribute.attname = 'tenant_id'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    `,
    expectedTables,
  );
  const policyRows = await query(
    `
      SELECT relation.relname AS table_name,
             policy.polname AS policy_name,
             policy.polpermissive AS permissive,
             policy.polcmd AS command
      FROM pg_policy policy
      INNER JOIN pg_class relation ON relation.oid = policy.polrelid
      INNER JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname IN (${placeholders})
    `,
    expectedTables,
  );

  const catalogByTable = new Map(catalogRows.map((row) => [String(row.table_name), row]));
  const tenantColumnTables = new Set(columnRows.map((row) => String(row.table_name)));
  const policies = policyRows.map<IsolationPolicyEvidence>((row) => ({
    tableName: String(row.table_name),
    policyName: String(row.policy_name),
    permissive: Boolean(row.permissive),
    command: String(row.command),
  }));

  const tables = expectedTables.map<IsolationTableReport>((tableName) => {
    const row = catalogByTable.get(tableName);
    const category: IsolationTableReport["category"] = childTables.has(tableName) ? "child" : "root";
    const report = {
      tableName: String(tableName),
      category,
      exists: Boolean(row),
      tenantColumn: tenantColumnTables.has(tableName),
      rlsEnabled: Boolean(row?.relrowsecurity ?? row?.rls_enabled),
      forceRls: Boolean(row?.relforcerowsecurity ?? row?.force_rls),
      policyPresent: hasExpectedTenantIsolationPolicy(tableName, policies),
    };
    return {
      ...report,
      status: report.exists && report.tenantColumn && report.rlsEnabled && report.forceRls && report.policyPresent
        ? "pass"
        : "fail",
    };
  });

  return {
    tables,
    unclassifiedTables: unclassifiedTenantIsolationTables(catalogByTable.keys()),
    missingTables: tables.filter((table) => !table.exists).map((table) => table.tableName),
    missingTenantColumns: tables.filter((table) => !table.tenantColumn).map((table) => table.tableName),
    rlsDisabled: tables.filter((table) => !table.rlsEnabled).map((table) => table.tableName),
    forceRlsDisabled: tables.filter((table) => !table.forceRls).map((table) => table.tableName),
    missingPolicies: tables.filter((table) => !table.policyPresent).map((table) => table.tableName),
  };
}

/**
 * The isolation problems a catalog read found, one entry for each kind. A
 * missing table is listed only as missing.
 */
export function describeTenantIsolationProblems(catalog: TenantIsolationCatalog) {
  const missing = new Set(catalog.missingTables);
  const present = (tables: string[]) => tables.filter((table) => !missing.has(table));
  return ([
    ["tables no isolation class covers", catalog.unclassifiedTables],
    ["missing tables", catalog.missingTables],
    ["tables without a tenant column", present(catalog.missingTenantColumns)],
    ["tables without row security", present(catalog.rlsDisabled)],
    ["tables that do not force row security", present(catalog.forceRlsDisabled)],
    ["tables without their expected policy", present(catalog.missingPolicies)],
  ] as const)
    .filter(([, tables]) => tables.length > 0)
    .map(([kind, tables]) => `${kind}: ${tables.join(", ")}`);
}

export async function getTenantIsolationReport(tenantId: string): Promise<TenantIsolationReport> {
  const checkedAt = new Date().toISOString();
  const expectedTables = [...tenantPolicyTables, ...migrationScopedTenantTables];
  const childTables = new Set<string>(tenantChildPolicyTables);

  if (!hasDatabaseUrl()) {
    return {
      tenantId,
      checkedAt,
      storageBackend: getStorageBackend(),
      databaseConfigured: false,
      status: "not_configured",
      summary: {
        expectedTables: expectedTables.length,
        protectedTables: 0,
        childTables: tenantChildPolicyTables.length,
        failingTables: expectedTables.length,
        unclassifiedTables: [],
        missingTables: expectedTables,
        missingTenantColumns: expectedTables,
        rlsDisabled: expectedTables,
        forceRlsDisabled: expectedTables,
        missingPolicies: expectedTables,
      },
      tables: expectedTables.map((tableName) => ({
        tableName,
        category: childTables.has(tableName) ? "child" : "root",
        exists: false,
        tenantColumn: false,
        rlsEnabled: false,
        forceRls: false,
        policyPresent: false,
        status: "fail",
      })),
      latestEval: await latestFileTenantIsolationEval(tenantId),
      recommendations: [
        "Configure DATABASE_URL for durable Postgres storage before relying on DB-enforced tenant isolation.",
        "Run the security.tenant_isolation evaluation after database configuration.",
      ],
    };
  }

  await ensureDatabaseSchema();
  const { catalog, latestEval } = await getSql().transaction(async (
    sql: ReturnType<typeof getSql>,
  ) => ({
    catalog: await readTenantIsolationCatalog((text, params) => sql.query(text, params)),
    latestEval: await latestDatabaseTenantIsolationEval(sql),
  })) as {
    catalog: TenantIsolationCatalog;
    latestEval: LatestTenantIsolationEval | undefined;
  };
  const {
    tables,
    unclassifiedTables,
    missingTables,
    missingTenantColumns,
    rlsDisabled,
    forceRlsDisabled,
    missingPolicies,
  } = catalog;
  const failingTables = tables.filter((table) => table.status === "fail");

  return {
    tenantId,
    checkedAt,
    storageBackend: getStorageBackend(),
    databaseConfigured: true,
    status: failingTables.length || unclassifiedTables.length ? "degraded" : "passing",
    summary: {
      expectedTables: expectedTables.length,
      protectedTables: tables.length - failingTables.length,
      childTables: tables.filter((table) => table.category === "child" && table.status === "pass").length,
      failingTables: failingTables.length,
      unclassifiedTables,
      missingTables,
      missingTenantColumns,
      rlsDisabled,
      forceRlsDisabled,
      missingPolicies,
    },
    tables,
    latestEval,
    recommendations: buildRecommendations({
      unclassifiedTables,
      missingTables,
      missingTenantColumns,
      rlsDisabled,
      forceRlsDisabled,
      missingPolicies,
      latestEval,
    }),
  };
}

async function latestDatabaseTenantIsolationEval(
  sql: ReturnType<typeof getSql> = getSql(),
): Promise<LatestTenantIsolationEval | undefined> {
  const rows = await sql`
    SELECT result.eval_run_id,
           result.status AS result_status,
           result.score,
           result.created_at,
           run.status AS run_status,
           run.completed_at
    FROM omni_eval_results result
    INNER JOIN omni_eval_runs run ON run.id = result.eval_run_id
    WHERE result.case_id = 'security.tenant_isolation'
    ORDER BY result.created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return undefined;
  }

  return {
    runId: String(row.eval_run_id),
    runStatus: String(row.run_status),
    resultStatus: String(row.result_status),
    score: Number(row.score || 0),
    createdAt: normalizeDate(row.created_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
  };
}

async function latestFileTenantIsolationEval(tenantId: string): Promise<LatestTenantIsolationEval | undefined> {
  const runs = await listEvalRuns(20, { tenantId });
  for (const run of runs) {
    const detail = await getEvalRunDetail(run.id, { tenantId });
    const result = detail?.results.find((item) => item.caseId === "security.tenant_isolation");
    if (result) {
      return {
        runId: run.id,
        runStatus: run.status,
        resultStatus: result.status,
        score: result.score,
        createdAt: result.createdAt,
        completedAt: run.completedAt,
      };
    }
  }
  return undefined;
}

function buildRecommendations({
  unclassifiedTables,
  missingTables,
  missingTenantColumns,
  rlsDisabled,
  forceRlsDisabled,
  missingPolicies,
  latestEval,
}: {
  unclassifiedTables: string[];
  missingTables: string[];
  missingTenantColumns: string[];
  rlsDisabled: string[];
  forceRlsDisabled: string[];
  missingPolicies: string[];
  latestEval?: LatestTenantIsolationEval;
}) {
  const recommendations: string[] = [];
  if (unclassifiedTables.length) {
    recommendations.push("Classify each new table in tenant-isolation.ts as a tenant table with its row security, or as exempt with the reason it holds no tenant's rows.");
  }
  if (missingTables.length || missingTenantColumns.length) {
    recommendations.push("Run database schema migration during deployment startup and verify all tenant tables include tenant_id.");
  }
  if (rlsDisabled.length || forceRlsDisabled.length || missingPolicies.length) {
    recommendations.push("Apply every pending database migration, which forces RLS and gives each table its expected policies.");
  }
  if (!latestEval) {
    recommendations.push("Run the security.tenant_isolation evaluation as a production release gate.");
  } else if (latestEval.resultStatus !== "pass") {
    recommendations.push("Investigate the latest security.tenant_isolation evaluation before promoting new releases.");
  }
  if (!recommendations.length) {
    recommendations.push("Keep security.tenant_isolation in scheduled production smoke validation.");
  }
  return recommendations;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
