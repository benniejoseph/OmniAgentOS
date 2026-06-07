import {
  ensureDatabaseSchema,
  getSql,
  getStorageBackend,
  hasDatabaseUrl,
  tenantChildPolicyTables,
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

export async function getTenantIsolationReport(tenantId: string): Promise<TenantIsolationReport> {
  const checkedAt = new Date().toISOString();
  const expectedTables = [...tenantPolicyTables];
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
  const sql = getSql();
  const placeholders = expectedTables.map((_, index) => `$${index + 1}`).join(", ");

  const [catalogRows, columnRows, policyRows, latestEval] = await Promise.all([
    sql.query(
      `
        SELECT c.relname AS table_name,
               c.relrowsecurity AS rls_enabled,
               c.relforcerowsecurity AS force_rls
        FROM pg_class c
        INNER JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind = 'r'
          AND c.relname IN (${placeholders})
      `,
      expectedTables,
    ),
    sql.query(
      `
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'tenant_id'
          AND table_name IN (${placeholders})
      `,
      expectedTables,
    ),
    sql.query(
      `
        SELECT tablename AS table_name
        FROM pg_policies
        WHERE schemaname = current_schema()
          AND policyname = 'omni_tenant_isolation'
          AND tablename IN (${placeholders})
      `,
      expectedTables,
    ),
    latestDatabaseTenantIsolationEval(),
  ]);

  const catalogByTable = new Map(catalogRows.map((row) => [String(row.table_name), row]));
  const tenantColumnTables = new Set(columnRows.map((row) => String(row.table_name)));
  const policyTables = new Set(policyRows.map((row) => String(row.table_name)));

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
      policyPresent: policyTables.has(tableName),
    };
    return {
      ...report,
      status: report.exists && report.tenantColumn && report.rlsEnabled && report.forceRls && report.policyPresent
        ? "pass"
        : "fail",
    };
  });

  const missingTables = tables.filter((table) => !table.exists).map((table) => table.tableName);
  const missingTenantColumns = tables.filter((table) => !table.tenantColumn).map((table) => table.tableName);
  const rlsDisabled = tables.filter((table) => !table.rlsEnabled).map((table) => table.tableName);
  const forceRlsDisabled = tables.filter((table) => !table.forceRls).map((table) => table.tableName);
  const missingPolicies = tables.filter((table) => !table.policyPresent).map((table) => table.tableName);
  const failingTables = tables.filter((table) => table.status === "fail");

  return {
    tenantId,
    checkedAt,
    storageBackend: getStorageBackend(),
    databaseConfigured: true,
    status: failingTables.length ? "degraded" : "passing",
    summary: {
      expectedTables: expectedTables.length,
      protectedTables: tables.length - failingTables.length,
      childTables: tables.filter((table) => table.category === "child" && table.status === "pass").length,
      failingTables: failingTables.length,
      missingTables,
      missingTenantColumns,
      rlsDisabled,
      forceRlsDisabled,
      missingPolicies,
    },
    tables,
    latestEval,
    recommendations: buildRecommendations({
      missingTables,
      missingTenantColumns,
      rlsDisabled,
      forceRlsDisabled,
      missingPolicies,
      latestEval,
    }),
  };
}

async function latestDatabaseTenantIsolationEval(): Promise<LatestTenantIsolationEval | undefined> {
  const rows = await getSql()`
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
  missingTables,
  missingTenantColumns,
  rlsDisabled,
  forceRlsDisabled,
  missingPolicies,
  latestEval,
}: {
  missingTables: string[];
  missingTenantColumns: string[];
  rlsDisabled: string[];
  forceRlsDisabled: string[];
  missingPolicies: string[];
  latestEval?: LatestTenantIsolationEval;
}) {
  const recommendations: string[] = [];
  if (missingTables.length || missingTenantColumns.length) {
    recommendations.push("Run database schema migration during deployment startup and verify all tenant tables include tenant_id.");
  }
  if (rlsDisabled.length || forceRlsDisabled.length || missingPolicies.length) {
    recommendations.push("Re-run ensureDatabaseSchema to enable forced RLS and recreate omni_tenant_isolation policies.");
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
