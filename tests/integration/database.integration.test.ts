import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { VECTOR_INDEX_DIMENSIONS } from "@/lib/config";
import {
  databaseSchemaMigrations,
  ensureDatabaseSchema,
  getSchemaMigrationSteps,
  getSql,
  getVectorStoreStatus,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
  tenantPolicyTables,
} from "@/lib/db/client";
import { sqlMigrationFileDigest } from "@/lib/db/sql-migration-files";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import { rebuildMemoryGraph } from "@/lib/memory/graph";
import {
  recordHeldMemoryDataRightRequestV1,
  type MemoryDataRightRequestWriterSql,
  type RecordHeldMemoryDataRightRequestResultV1,
} from "@/lib/memory/data-right-request-writer";
import { saveMemories } from "@/lib/memory/store";
import { createKnowledgeDocument } from "@/lib/rag/store";
import {
  cancelOperationJobByDedupeKey,
  completeOperationJob,
  deferOperationJob,
  enqueueOperationJob,
  failOperationJob,
  getAgentResumeJobDedupeKey,
  leaseOperationJobByDedupeKey,
  leaseOperationJobs,
  listActiveWorkflowTickRunIds,
  listRunnableOperationDispatchTenants,
  repairExpiredOperationJobs,
  wakeOperationJobByDedupeKey,
} from "@/lib/operations/job-queue";
import { runEventCursor } from "@/lib/runs/event-cursor";
import {
  AgentRunAlreadyExistsError,
  appendRunEvent,
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  listAgentRunEventsAfter,
  markAgentRunResuming,
} from "@/lib/runs/store";
import { getTenantIsolationReport } from "@/lib/security/isolation-report";
import { sweepExpiredSensitiveData } from "@/lib/security/retention";
import {
  appendThreadTurn,
  createThread,
  getThread,
  listThreadTurns,
} from "@/lib/threads/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { approvalMaterialBindingSha256 } from "@/lib/tools/approval-binding";
import {
  approveAndClaimToolExecution,
  claimIdempotentToolExecution,
  completeClaimedToolExecution,
  createToolExecutionRecord,
  getToolExecution,
  getToolExecutionEffectIntentV2,
  persistClaimedToolEffectIntentV2,
  publicToolExecution,
  saveToolExecution,
  sealToolExecutionInput,
} from "@/lib/tools/audit-store";
import {
  buildEffectIntentV2,
  finalizeEffectIntentV2,
} from "@/lib/tools/effect-intent-v2";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import {
  appendWorkflowEvent,
  createWorkflowRun,
  getWorkflowRun,
  listRunnableWorkflowRuns,
  recordWorkflowSpecialistsPending,
} from "@/lib/workflows/store";
import {
  createWorkflowTrigger,
  listDueWorkflowScheduleOwners,
  processActorWorkflowSchedules,
  processDueWorkflowSchedules,
  processDueWorkflowSchedulesForTenant,
} from "@/lib/workflows/triggers";

const databaseUrl = process.env.DATABASE_URL;
const resetAllowed = process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true";
const requirePgvector =
  process.env.OMNIAGENT_INTEGRATION_REQUIRE_PGVECTOR !== "false";
const databaseDescribe = databaseUrl && resetAllowed ? describe : describe.skip;
const rlsRole = "omniagent_integration_rls";
const runtimeRole = "omniagent_integration_runtime";
const maintenanceRole = "omniagent_integration_maintenance";
const lineageRuntimeRole = "omniagent_integration_lineage_runtime";
const lineageMaintenanceRole = "omniagent_integration_lineage_maintenance";
const scopeProbeRole = "omniagent_integration_scope_probe";
// Serving roles verify rather than migrate the schema only in production, and
// production refuses a connection that disables TLS.
const databaseTlsDisabled = Boolean(
  databaseUrl && new URL(databaseUrl).searchParams.get("sslmode") === "disable",
);
const actorRlsRepairTables = [
  "omni_a2a_peer_rollouts",
  "omni_a2a_task_mappings",
  "omni_a2a_exchanges",
  "omni_a2a_safety_reservations",
  "omni_a2a_tool_call_claims",
  "omni_trash_items",
  "omni_trash_effect_receipts",
  "omni_approval_grants",
  "omni_approval_grant_claims",
  "omni_browser_profiles",
  "omni_browser_profile_bindings",
  "omni_browser_takeovers",
] as const;
// The roles the migrations grant to by name.
const migrationGranteeRoles = ["omni_backup", "omni_maintenance", "omni_runtime"];

databaseDescribe("Postgres schema integration", () => {
  let admin: ReturnType<typeof postgres>;
  let granteeRolesBeforeBootstrap: string[] = [];

  beforeAll(async () => {
    admin = postgres(databaseUrl!, {
      ssl:
        new URL(databaseUrl!).searchParams.get("sslmode") === "disable"
          ? false
          : "require",
      max: 1,
      prepare: false,
    });
    // Roles belong to the whole cluster, so the reset below leaves them alone.
    granteeRolesBeforeBootstrap = (
      await admin`
        SELECT rolname FROM pg_roles
        WHERE rolname = ANY(${migrationGranteeRoles}::text[])
      `
    ).map((role) => String(role.rolname));

    await dropDatabaseRole(admin, rlsRole);
    await dropDatabaseRole(admin, runtimeRole);
    await dropDatabaseRole(admin, maintenanceRole);
    await dropDatabaseRole(admin, lineageRuntimeRole);
    await dropDatabaseRole(admin, lineageMaintenanceRole);
    await dropDatabaseRole(admin, scopeProbeRole);
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await admin`
      CREATE TABLE omni_schema_version (
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await admin`INSERT INTO omni_schema_version DEFAULT VALUES`;
    await admin`
      CREATE TABLE omni_jsonb_migration_fixture (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL
      )
    `;
    const legacyJson = JSON.stringify({ native: true });
    await admin`
      INSERT INTO omni_jsonb_migration_fixture (id, payload)
      VALUES ('double-encoded', ${legacyJson}::jsonb)
    `;
  });

  afterAll(async () => {
    await dropDatabaseRole(admin, rlsRole);
    await dropDatabaseRole(admin, runtimeRole);
    await dropDatabaseRole(admin, maintenanceRole);
    await dropDatabaseRole(admin, lineageRuntimeRole);
    await dropDatabaseRole(admin, lineageMaintenanceRole);
    await dropDatabaseRole(admin, scopeProbeRole);
    await admin.end();
  });

  test("upgrades the legacy marker and bootstraps pgvector idempotently", async () => {
    await ensureDatabaseSchema();
    await ensureDatabaseSchema();

    const markers = await admin`
      SELECT version, name, checksum
      FROM omni_schema_version
      WHERE version IS NOT NULL
      ORDER BY version ASC
    `;
    const [tables] = await admin`
      SELECT COUNT(*)::int AS count
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename LIKE 'omni_%'
    `;
    const rebuildQueueColumns = await admin`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'omni_memory_graph_rebuild_queue'
        AND column_name IN ('generation', 'lease_owner', 'lease_expires_at')
      ORDER BY column_name
    `;
    const vectorStatus = await getVectorStoreStatus();
    const [jsonbFixture] = await admin`
      SELECT jsonb_typeof(payload) AS payload_type, payload
      FROM omni_jsonb_migration_fixture
      WHERE id = 'double-encoded'
    `;
    const granteeRoles = await admin`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = ANY(${migrationGranteeRoles}::text[])
      ORDER BY rolname
    `;

    expect(markers).toEqual(databaseSchemaMigrations);
    // The runner creates the roles a database lacks as placeholders that
    // cannot log in, so every database carries the same grants.
    expect(granteeRoles.map((role) => role.rolname)).toEqual(migrationGranteeRoles);
    expect(
      granteeRoles.filter(
        (role) => !granteeRolesBeforeBootstrap.includes(role.rolname),
      ),
    ).toEqual(
      migrationGranteeRoles
        .filter((role) => !granteeRolesBeforeBootstrap.includes(role))
        .map((rolname) => ({
          rolname,
          rolcanlogin: false,
          rolsuper: false,
          rolbypassrls: false,
        })),
    );
    expect(Number(tables.count)).toBeGreaterThan(20);
    expect(rebuildQueueColumns).toEqual([
      { column_name: "generation" },
      { column_name: "lease_expires_at" },
      { column_name: "lease_owner" },
    ]);
    expect(jsonbFixture).toEqual({
      payload_type: "object",
      payload: { native: true },
    });
    if (requirePgvector) {
      expect(vectorStatus).toMatchObject({
        configured: true,
        extensionInstalled: true,
        memoryIndexed: true,
        knowledgeIndexed: true,
      });
    } else {
      expect(vectorStatus.dimensions).toBeGreaterThan(0);
    }
  });

  test("refuses to run part of a migration file that records two versions", async () => {
    const [recorded] = await admin`
      SELECT version, name, checksum, applied_at
      FROM omni_schema_version
      WHERE version = 118
    `;
    await admin`DELETE FROM omni_schema_version WHERE version = 118`;
    vi.resetModules();
    try {
      const client = await import("@/lib/db/client");
      try {
        await expect(client.ensureDatabaseSchema()).rejects.toThrow(
          "20260907011100_p8_6_a2a.sql records database migrations 117 (a2a_peer_rollouts_v1), 118 (a2a_task_mappings_v1) together, but only 118 of them is pending, and the file cannot run in part.",
        );
      } finally {
        await client.closeDatabaseClient();
      }
      const [ledger] = await admin`
        SELECT count(*)::int AS rows
        FROM omni_schema_version
        WHERE version = 118
      `;
      expect(ledger).toEqual({ rows: 0 });
    } finally {
      await admin`
        INSERT INTO omni_schema_version (version, name, checksum, applied_at)
        VALUES (
          ${recorded.version}, ${recorded.name}, ${recorded.checksum},
          ${recorded.applied_at}
        )
      `;
      vi.resetModules();
    }
  });

  test("refuses to run a migration file that no longer has its manifest sha256", async () => {
    const step = getSchemaMigrationSteps()
      .filter((candidate) => candidate.kind === "sql")
      .at(-1);
    if (step?.kind !== "sql") {
      throw new Error("schema-migrations.json names no SQL file.");
    }
    const versions = step.migrations.map((migration) => migration.version);
    const original = fs.readFileSync(
      path.join(process.cwd(), "supabase", "migrations", step.file),
      "utf8",
    );
    const changed = original.replace(
      /COMMIT;\s*$/,
      "CREATE TABLE public.changed_migration_probe (id integer);\nCOMMIT;\n",
    );
    expect(changed).not.toBe(original);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniagent-changed-migration-"));
    fs.mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(root, "supabase", "migrations", step.file), changed);
    const recorded = await admin`
      SELECT version, name, checksum, applied_at
      FROM omni_schema_version
      WHERE version = ANY(${versions}::int[])
    `;
    expect(recorded).toHaveLength(versions.length);
    await admin`DELETE FROM omni_schema_version WHERE version = ANY(${versions}::int[])`;
    vi.resetModules();
    try {
      const client = await import("@/lib/db/client");
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      try {
        await expect(client.ensureDatabaseSchema()).rejects.toThrow(
          `Database migration${versions.length > 1 ? "s" : ""} ${step.migrations
            .map((migration) => `${migration.version} (${migration.name})`)
            .join(", ")} failed: ${step.file} has sha256 ${sqlMigrationFileDigest(
            changed,
            step.migrations.map((migration) => migration.checksum),
          )}, but schema-migrations.json expects ${step.sha256}. A migration file must not change once a database may have run it; make the change in a new migration.`,
        );
      } finally {
        cwd.mockRestore();
        await client.closeDatabaseClient();
      }
      const [state] = await admin`
        SELECT
          to_regclass('public.changed_migration_probe')::text AS probe,
          (
            SELECT count(*)::int FROM omni_schema_version
            WHERE version = ANY(${versions}::int[])
          ) AS rows
      `;
      expect(state).toEqual({ probe: null, rows: 0 });
    } finally {
      await admin`DROP TABLE IF EXISTS public.changed_migration_probe`;
      await admin`DELETE FROM omni_schema_version WHERE version = ANY(${versions}::int[])`;
      for (const row of recorded) {
        await admin`
          INSERT INTO omni_schema_version (version, name, checksum, applied_at)
          VALUES (${row.version}, ${row.name}, ${row.checksum}, ${row.applied_at})
        `;
      }
      fs.rmSync(root, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  test("atomically persists immutable generic effect intents and events", async () => {
    const tenantId = "effect_intent_tenant";
    const actorId = "effect_intent_actor";
    const claimToken = "effect-intent-integration-claim";
    const approvalFingerprint = "integration-http-post-contract";
    const toolInput = {
      url: "https://example.com/integration-effect",
      method: "POST",
    };
    const inputSha256 = toolInputSha256(toolInput);
    const approvalBindingSha256 = approvalMaterialBindingSha256({
      targetSha256: "6".repeat(64),
      inputSha256,
    });
    const base = createToolExecutionRecord({
      tenantId,
      actorId,
      toolId: "http.request",
      toolName: "HTTP request",
      riskLevel: 2,
      status: "executing",
      dryRun: false,
      approvalRequired: true,
      approvalDecision: "approved",
      approvedBy: "integration-admin",
      approvedAt: new Date().toISOString(),
      input: toolInput,
      output: undefined,
    });
    const claimed = {
      ...base,
      output: {
        ...sealToolExecutionInput(
          toolInput,
          base,
          approvalFingerprint,
          { approvalMaterialBindingSha256: approvalBindingSha256 },
        ),
        __executionClaim: {
          token: claimToken,
          claimedAt: new Date().toISOString(),
        },
      },
    };
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "effect-intent-integration-request",
      causationId: claimed.id,
      purpose: "tool.effect.execute",
    });
    const intent = buildEffectIntentV2({
      effectMode: "live",
      reversible: false,
      executionKind: "direct",
      executionId: claimed.id,
      tenantId,
      actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      workflowRunId: null,
      planId: null,
      planSha256: null,
      planNodeId: null,
      toolId: claimed.toolId,
      toolContractSha256: canonicalJsonSha256({ approvalFingerprint }),
      approvalState: "approved",
      approvalBindingSha256,
      inputSha256,
      idempotencyKeySha256: "7".repeat(64),
      targetType: "http_endpoint",
      targetId: "http_target:integration-effect",
      expectedTargetStateSha256: "8".repeat(64),
    });

    await runWithDatabaseTenantScope(tenantId, () => saveToolExecution(claimed));
    const persisted = await runWithDatabaseTenantScope(tenantId, () =>
      persistClaimedToolEffectIntentV2({
        recordId: claimed.id,
        tenantId,
        claimToken,
        intent,
        executionScope: scope,
      })
    );
    expect(getToolExecutionEffectIntentV2(persisted!)).toEqual(intent);
    await expect(runWithDatabaseTenantScope(tenantId, () =>
      saveToolExecution({ ...persisted!, output: { ok: false } })
    )).rejects.toThrow(/effect (?:intent|evidence)/i);

    const receipt = finalizeEffectIntentV2(intent, {
      providerAcknowledgement: "provider_response",
      providerAcknowledgementId: "provider:integration-effect",
      providerAcknowledgementSha256: "9".repeat(64),
      verificationMethod: "read_after_write",
      verificationState: "unverifiable",
      verificationReasonCode: "read_unavailable",
      observedTargetStateSha256: null,
    });
    const completed = await runWithDatabaseTenantScope(tenantId, () =>
      completeClaimedToolExecution({
        ...persisted!,
        status: "executed",
        output: { ok: true },
        effectReceipt: receipt,
        completedAt: new Date().toISOString(),
      }, claimToken, { executionScope: scope })
    );
    expect(getToolExecutionEffectIntentV2(completed!)).toEqual(intent);
    expect(publicToolExecution(completed!).output).toEqual({ ok: true });
    const reread = await runWithDatabaseTenantScope(tenantId, () =>
      getToolExecution(claimed.id, { tenantId })
    );
    expect(getToolExecutionEffectIntentV2(reread!)).toEqual(intent);

    const [eventCount] = await admin`
      SELECT COUNT(*)::int AS count
      FROM omni_events
      WHERE id = ${`tool.effect_intent:${intent.effectIntentId}`}
        AND tenant_id = ${tenantId}
    `;
    expect(eventCount.count).toBe(1);
  });

  test("returns newly inserted and replayed bulk memories", async () => {
    const tenantId = "bulk_memory_tenant";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: null,
      executingPrincipalType: "system",
      executingPrincipalId: "database-integration-test",
      correlationId: "bulk-memory-integration",
      purpose: "memory.persistence.integration",
    });
    const input = [
      {
        id: "bulk-memory-one",
        tenantId,
        title: "First bulk memory",
        content: "First integration memory.",
        executionScope,
      },
      {
        id: "bulk-memory-two",
        tenantId,
        title: "Second bulk memory",
        content: "Second integration memory.",
        executionScope,
      },
    ];
    const first = await runWithDatabaseTenantScope(
      tenantId,
      () => saveMemories(input),
    );
    const replayed = await runWithDatabaseTenantScope(
      tenantId,
      () =>
        saveMemories(
          input.map((memory) => ({
            ...memory,
            title: "A replay must not overwrite",
          })),
        ),
    );

    expect(first.map((memory) => memory.id)).toEqual([
      "bulk-memory-one",
      "bulk-memory-two",
    ]);
    expect(replayed).toEqual(first);
  });

  test("persists a knowledge chunk batch as a native JSON array", async () => {
    const tenantId = "knowledge_chunk_batch_tenant";
    const created = await runWithDatabaseTenantScope(tenantId, () =>
      createKnowledgeDocument({
        idempotencyKey: "native-jsonb-chunk-batch",
        tenantId,
        title: "Native JSONB chunk batch",
        content: "A connected-source document must persist atomically.",
        source: "integration.connected-source",
        sourceType: "api",
        chunks: [
          {
            index: 0,
            content: "A connected-source document must persist atomically.",
          },
        ],
      }),
    );

    const chunks = await admin`
      SELECT id, tenant_id, document_id, chunk_index, content
      FROM omni_knowledge_chunks
      WHERE tenant_id = ${tenantId}
        AND document_id = ${created.document.id}
      ORDER BY chunk_index
    `;
    expect(chunks).toEqual([
      expect.objectContaining({
        tenant_id: tenantId,
        document_id: created.document.id,
        chunk_index: 0,
        content: "A connected-source document must persist atomically.",
      }),
    ]);
  });

  test("stores structured parameters as native JSONB", async () => {
    const tenantId = "native_jsonb_tenant";
    const workflow = await runWithDatabaseTenantScope(
      tenantId,
      () =>
        createWorkflowRun({
          tenantId,
          goal: "Verify native JSONB workflow persistence.",
          mode: "research",
          requireApproval: true,
          maxAttempts: 1,
          metadata: { source: "integration", nativeJsonb: true },
        }),
    );
    const job = await runWithDatabaseTenantScope(
      tenantId,
      () =>
        enqueueOperationJob({
          tenantId,
          type: "workflow.tick",
          dedupeKey: "native-jsonb-regression",
          payload: {
            workflowRunId: workflow.run.id,
            reason: "native_jsonb_regression",
          },
        }),
    );

    const [runRow] = await admin`
      SELECT jsonb_typeof(input) AS input_type, input
      FROM omni_workflow_runs
      WHERE id = ${workflow.run.id}
    `;
    const stepRows = await admin`
      SELECT jsonb_typeof(input) AS input_type
      FROM omni_workflow_steps
      WHERE workflow_run_id = ${workflow.run.id}
    `;
    const eventRows = await admin`
      SELECT jsonb_typeof(payload) AS payload_type
      FROM omni_workflow_events
      WHERE workflow_run_id = ${workflow.run.id}
    `;
    const [jobRow] = await admin`
      SELECT jsonb_typeof(payload) AS payload_type, payload
      FROM omni_operation_jobs
      WHERE id = ${job.id}
    `;

    expect(runRow).toMatchObject({
      input_type: "object",
      input: {
        metadata: { source: "integration", nativeJsonb: true },
      },
    });
    expect(stepRows.length).toBeGreaterThan(0);
    expect(stepRows.every((row) => row.input_type === "object")).toBe(true);
    expect(eventRows.length).toBeGreaterThan(0);
    expect(eventRows.every((row) => row.payload_type === "object")).toBe(true);
    expect(jobRow).toEqual({
      payload_type: "object",
      payload: {
        workflowRunId: workflow.run.id,
        reason: "native_jsonb_regression",
      },
    });
  });

  test("reconciles legacy scalar operation-job payloads", async () => {
    await admin`
      INSERT INTO omni_operation_jobs (
        id, tenant_id, type, status, payload, attempt, max_attempts,
        run_at, locked_at, lease_owner, lease_expires_at
      )
      VALUES
        (
          'legacy-scalar-complete', 'legacy_job_tenant', 'workflow.tick',
          'running', '"legacy"'::jsonb, 1, 1, NOW(), NOW(),
          'legacy-complete-owner', NOW() + INTERVAL '5 minutes'
        ),
        (
          'legacy-scalar-fail', 'legacy_job_tenant', 'workflow.tick',
          'running', '42'::jsonb, 1, 1, NOW(), NOW(),
          'legacy-fail-owner', NOW() + INTERVAL '5 minutes'
        )
    `;

    const completed = await completeOperationJob(
      "legacy-scalar-complete",
      "legacy-complete-owner",
      "legacy_job_tenant",
    );
    const failed = await failOperationJob(
      "legacy-scalar-fail",
      "Legacy payload cannot execute.",
      "legacy-fail-owner",
      "legacy_job_tenant",
    );

    expect(completed).toMatchObject({
      status: "completed",
      payload: {},
    });
    expect(failed).toMatchObject({
      status: "failed",
      payload: {},
      lastError: "Legacy payload cannot execute.",
    });
  });

  test("rebuilds a tenant graph without requesting a second pool connection", async () => {
    await admin`
      INSERT INTO omni_memories (
        id, tenant_id, type, title, content, scope, source
      )
      VALUES (
        'graph-deadlock-memory',
        'graph_deadlock_tenant',
        'fact',
        'Postgres graph source',
        'A source record used to prove the max-one connection rebuild completes.',
        'tenant',
        'integration'
      )
    `;
    await admin`
      INSERT INTO omni_retrieval_traces (
        id, tenant_id, query, profile, results
      )
      VALUES (
        'graph-deadlock-trace',
        'graph_deadlock_tenant',
        'How does graph rebuilding work?',
        '{"mode":"balanced"}'::jsonb,
        '[]'::jsonb
      )
    `;

    const rebuilt = await withTimeout(
      rebuildMemoryGraph({
        tenantId: "graph_deadlock_tenant",
        source: "integration.max-one-pool",
      }),
      5_000,
    );
    const [build] = await admin`
      SELECT status, tenant_id
      FROM omni_memory_graph_builds
      WHERE id = ${rebuilt.build.id}
    `;

    expect(build).toEqual({
      status: "completed",
      tenant_id: "graph_deadlock_tenant",
    });
  });

  test("enables and forces RLS on every tenant policy table", async () => {
    const rows = await admin`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relname = ANY(${tenantPolicyTables as readonly string[]})
    `;

    expect(rows).toHaveLength(tenantPolicyTables.length);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  test("converges repaired tables on exact tenant and actor RLS", async () => {
    const policies = await admin`
      SELECT
        relation.relname AS table_name,
        policy.polname AS policy_name,
        policy.polpermissive AS permissive,
        policy.polcmd::TEXT AS command,
        policy.polroles = ARRAY[0::OID] AS public_role,
        pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
        pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      WHERE relation.relnamespace = 'public'::regnamespace
        AND relation.relname = ANY(${actorRlsRepairTables as readonly string[]})
      ORDER BY relation.relname, policy.polname
    `;

    expect(policies).toHaveLength(actorRlsRepairTables.length * 2);
    for (const tableName of actorRlsRepairTables) {
      const tablePolicies = policies.filter(
        (policy) => policy.table_name === tableName,
      );
      expect(tablePolicies).toHaveLength(2);
      expect(tablePolicies).toEqual(expect.arrayContaining([
        {
          table_name: tableName,
          policy_name: `${tableName}_actor`,
          permissive: false,
          command: "*",
          public_role: true,
          using_expression:
            "(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))",
          check_expression:
            "(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))",
        },
        {
          table_name: tableName,
          policy_name: "omni_tenant_isolation",
          permissive: true,
          command: "*",
          public_role: true,
          using_expression: "omni_tenant_visible(tenant_id)",
          check_expression: "omni_tenant_visible(tenant_id)",
        },
      ]));
    }
  });

  test("keeps a tenant-wide policy from widening any actor policy", async () => {
    // Permissive policies combine with OR, so a tenant-wide permissive policy
    // beside a permissive actor policy would admit every actor in the tenant.
    const tables = await admin`
      SELECT table_name,
        bool_or(NOT permissive AND actor_scoped) AS actor_restricted,
        bool_or(permissive AND NOT actor_scoped) AS other_permissive
      FROM (
        SELECT relation.relname AS table_name,
          policy.polpermissive AS permissive,
          strpos(
            concat_ws(
              ' ',
              pg_get_expr(policy.polqual, policy.polrelid),
              pg_get_expr(policy.polwithcheck, policy.polrelid)
            ),
            'actor_scope'
          ) > 0 AS actor_scoped
        FROM pg_policy policy
        JOIN pg_class relation ON relation.oid = policy.polrelid
        WHERE relation.relnamespace = 'public'::regnamespace
      ) policies
      GROUP BY table_name
      HAVING bool_or(actor_scoped)
      ORDER BY table_name
    `;

    expect(tables.length).toBeGreaterThan(100);
    expect(
      tables
        .filter((table) => table.other_permissive && !table.actor_restricted)
        .map((table) => table.table_name),
    ).toEqual([]);
  });

  test("keeps the execution-principal registry empty, narrowly granted, and actor-governed", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_execution_principals) AS rows,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid = 'omni_tenant_execution_principals'::regclass) AS policies,
        NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'omni_tenant_execution_principals'::regclass
            AND conname = 'omni_execution_principal_activation_hold_check'
        ) AS activation_hold_removed
    `;
    const policies = await admin`
      SELECT
        policy.polname AS policy_name,
        policy.polpermissive AS permissive,
        policy.polcmd::text AS command,
        policy.polroles = ARRAY[0::oid] AS public_role,
        pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
        pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
      FROM pg_policy policy
      WHERE policy.polrelid = 'omni_tenant_execution_principals'::regclass
      ORDER BY policy.polname
    `;
    const triggers = await admin`
      SELECT trigger.tgname AS trigger_name,
        procedure.proname AS function_name
      FROM pg_trigger trigger
      JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
      WHERE trigger.tgrelid = 'omni_tenant_execution_principals'::regclass
        AND NOT trigger.tgisinternal
        AND trigger.tgenabled = 'O'
      ORDER BY trigger.tgname
    `;
    expect(surface).toEqual({
      rows: 0,
      policies: 4,
      activation_hold_removed: true,
    });
    expect(await tableGrants(admin, ["omni_tenant_execution_principals"])).toEqual([
      "omni_tenant_execution_principals: omni_backup SELECT",
      "omni_tenant_execution_principals: omni_maintenance INSERT, SELECT",
      "omni_tenant_execution_principals: omni_runtime INSERT, SELECT",
    ]);
    const actorExpression =
      "(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, controller_actor_id))";
    expect(policies).toEqual([
      {
        policy_name: "omni_execution_principal_actor_insert",
        permissive: false,
        command: "a",
        public_role: true,
        using_expression: null,
        check_expression: actorExpression,
      },
      {
        policy_name: "omni_execution_principal_actor_select",
        permissive: false,
        command: "r",
        public_role: true,
        using_expression: actorExpression,
        check_expression: null,
      },
      {
        policy_name: "omni_execution_principal_actor_update",
        permissive: false,
        command: "w",
        public_role: true,
        using_expression: actorExpression,
        check_expression: actorExpression,
      },
      {
        policy_name: "omni_tenant_isolation",
        permissive: true,
        command: "*",
        public_role: true,
        using_expression: "omni_tenant_visible(tenant_id)",
        check_expression: "omni_tenant_visible(tenant_id)",
      },
    ]);
    expect(triggers).toEqual([
      {
        trigger_name: "omni_execution_principal_no_truncate",
        function_name: "omni_protect_execution_principal",
      },
      {
        trigger_name: "omni_execution_principal_policy_activation",
        function_name: "omni_validate_agent_principal_activation_v1",
      },
      {
        trigger_name: "omni_execution_principal_protect",
        function_name: "omni_protect_execution_principal",
      },
      {
        trigger_name: "omni_execution_principal_validate_insert",
        function_name: "omni_validate_execution_principal_insert",
      },
    ]);

    const userId = "00000000-0000-4000-8000-000000000021";
    const actorId = `actor:${userId}`;
    await expect(
      admin.begin(async (transaction) => {
        await transaction`
          INSERT INTO omni_auth_tenants (id, name, slug)
          VALUES (
            'execution-principal-lifecycle',
            'Execution principal lifecycle',
            'execution-principal-lifecycle'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_users (id, email, password_hash)
          VALUES (
            ${userId}, 'execution-principal-lifecycle@example.test',
            'test-only'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
          VALUES (
            'execution-principal-lifecycle-membership',
            'execution-principal-lifecycle', ${userId}, 'admin'
          )
        `;
        await transaction`
          INSERT INTO omni_tenant_execution_principals (
            tenant_id, principal_kind, principal_id, principal_generation,
            controller_actor_id, system_principal_class, state,
            lifecycle_revision, created_by_actor_id, activated_by_actor_id,
            activated_at
          ) VALUES (
            'execution-principal-lifecycle', 'system',
            'service:integration-direct-active', 1, ${actorId}, 'worker',
            'active', 1, ${actorId}, ${actorId}, statement_timestamp()
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const authorizedUserId = "00000000-0000-4000-8000-000000000026";
    const authorizedActorId = `actor:${authorizedUserId}`;
    let activatedPrincipal:
      | { state: string; lifecycle_revision: string; activated_by_actor_id: string }
      | undefined;
    const rollbackActivatedPrincipal = new Error(
      "Rollback activated execution principal integration fixture",
    );
    await admin
      .begin(async (transaction) => {
        await transaction`
          INSERT INTO omni_auth_tenants (id, name, slug)
          VALUES (
            'execution-principal-authorized',
            'Execution principal authorized',
            'execution-principal-authorized'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_users (id, email, password_hash)
          VALUES (
            ${authorizedUserId}, 'execution-principal-authorized@example.test',
            'test-only'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
          VALUES (
            'execution-principal-authorized-membership',
            'execution-principal-authorized', ${authorizedUserId}, 'admin'
          )
        `;
        await transaction`
          INSERT INTO omni_tenant_execution_principals (
            tenant_id, principal_kind, principal_id, principal_generation,
            controller_actor_id, system_principal_class, state,
            lifecycle_revision, created_by_actor_id
          ) VALUES (
            'execution-principal-authorized', 'system',
            'service:integration-authorized', 1, ${authorizedActorId}, 'worker',
            'held', 0, ${authorizedActorId}
          )
        `;
        [activatedPrincipal] = await transaction`
          UPDATE omni_tenant_execution_principals
          SET state = 'active', lifecycle_revision = 1,
              activated_by_actor_id = ${authorizedActorId}
          WHERE tenant_id = 'execution-principal-authorized'
            AND principal_id = 'service:integration-authorized'
            AND principal_generation = 1
          RETURNING state, lifecycle_revision, activated_by_actor_id
        `;
        throw rollbackActivatedPrincipal;
      })
      .catch((error) => {
        if (error !== rollbackActivatedPrincipal) throw error;
      });
    expect(activatedPrincipal).toEqual({
      state: "active",
      lifecycle_revision: "1",
      activated_by_actor_id: authorizedActorId,
    });
  });

  test("keeps workspace membership explicit, empty, read-only to the app, and lifecycle-governed", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_workspaces) AS workspaces,
        (SELECT count(*)::int FROM omni_tenant_workspace_memberships)
          AS memberships,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid IN (
           'omni_tenant_workspaces'::regclass,
           'omni_tenant_workspace_memberships'::regclass
         )) AS policies,
        NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE (conrelid, conname) IN (
            (
              'omni_tenant_workspaces'::regclass,
              'omni_workspace_activation_hold_check'
            ),
            (
              'omni_tenant_workspace_memberships'::regclass,
              'omni_workspace_membership_activation_hold_check'
            )
          )
        ) AS activation_holds_removed
    `;
    const triggers = await admin`
      SELECT relation.relname AS table_name, trigger.tgname AS trigger_name,
        procedure.proname AS function_name
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
      WHERE trigger.tgrelid IN (
        'omni_tenant_workspaces'::regclass,
        'omni_tenant_workspace_memberships'::regclass
      )
        AND trigger.tgname IN (
          'omni_workspace_protect',
          'omni_workspace_no_truncate',
          'omni_workspace_membership_protect',
          'omni_workspace_membership_no_truncate'
        )
        AND NOT trigger.tgisinternal
        AND trigger.tgenabled = 'O'
      ORDER BY relation.relname, trigger.tgname
    `;
    const rowContracts = await admin`
      SELECT relation.relname AS table_name,
        constraint_record.conname AS constraint_name
      FROM pg_constraint constraint_record
      JOIN pg_class relation ON relation.oid = constraint_record.conrelid
      WHERE (constraint_record.conrelid, constraint_record.conname) IN (
        (
          'omni_tenant_workspaces'::regclass,
          'omni_workspace_authority_row_check'
        ),
        (
          'omni_tenant_workspace_memberships'::regclass,
          'omni_workspace_membership_row_check'
        )
      )
        AND constraint_record.contype = 'c'
        AND constraint_record.convalidated
      ORDER BY relation.relname, constraint_record.conname
    `;

    expect(surface).toEqual({
      workspaces: 0,
      memberships: 0,
      policies: 4,
      activation_holds_removed: true,
    });
    expect(
      await tableGrants(admin, [
        "omni_tenant_workspaces",
        "omni_tenant_workspace_memberships",
      ]),
    ).toEqual([
      "omni_tenant_workspace_memberships: omni_backup SELECT",
      "omni_tenant_workspace_memberships: omni_maintenance SELECT",
      "omni_tenant_workspace_memberships: omni_runtime SELECT",
      "omni_tenant_workspaces: omni_backup SELECT",
      "omni_tenant_workspaces: omni_maintenance SELECT",
      "omni_tenant_workspaces: omni_runtime SELECT",
    ]);
    expect(triggers).toEqual([
      {
        table_name: "omni_tenant_workspace_memberships",
        trigger_name: "omni_workspace_membership_no_truncate",
        function_name: "omni_protect_workspace_authority_v1",
      },
      {
        table_name: "omni_tenant_workspace_memberships",
        trigger_name: "omni_workspace_membership_protect",
        function_name: "omni_protect_workspace_authority_v1",
      },
      {
        table_name: "omni_tenant_workspaces",
        trigger_name: "omni_workspace_no_truncate",
        function_name: "omni_protect_workspace_authority_v1",
      },
      {
        table_name: "omni_tenant_workspaces",
        trigger_name: "omni_workspace_protect",
        function_name: "omni_protect_workspace_authority_v1",
      },
    ]);
    expect(rowContracts).toEqual([
      {
        table_name: "omni_tenant_workspace_memberships",
        constraint_name: "omni_workspace_membership_row_check",
      },
      {
        table_name: "omni_tenant_workspaces",
        constraint_name: "omni_workspace_authority_row_check",
      },
    ]);

    const authorizedUserId = "00000000-0000-4000-8000-000000000022";
    const authorizedActorId = `actor:${authorizedUserId}`;
    let authorizedWorkspace:
      | { workspace_id: string; state: string; lifecycle_revision: string }
      | undefined;
    let authorizedWorkspaceMembership:
      | { subject_key: string; state: string; lifecycle_revision: string }
      | undefined;
    const rollbackAuthorizedWorkspace = new Error(
      "Rollback authorized workspace integration fixture",
    );
    await admin
      .begin(async (transaction) => {
        await transaction`
          INSERT INTO omni_auth_tenants (id, name, slug)
          VALUES (
            'workspace-lifecycle-authorized', 'Workspace lifecycle authorized',
            'workspace-lifecycle-authorized'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_users (id, email, password_hash)
          VALUES (
            ${authorizedUserId}, 'workspace-lifecycle-authorized@example.test',
            'test-only'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
          VALUES (
            'workspace-lifecycle-authorized-membership',
            'workspace-lifecycle-authorized', ${authorizedUserId}, 'admin'
          )
        `;
        [authorizedWorkspace] = await transaction`
          INSERT INTO omni_tenant_workspaces (
            tenant_id, workspace_id, display_name, owner_actor_id, state,
            lifecycle_revision, created_by_actor_id, activated_by_actor_id,
            created_at, activated_at, updated_at
          ) VALUES (
            'workspace-lifecycle-authorized', 'workspace:integration-authorized',
            'Authorized integration workspace', ${authorizedActorId}, 'active',
            1, ${authorizedActorId}, ${authorizedActorId},
            statement_timestamp(), statement_timestamp(), statement_timestamp()
          )
          RETURNING workspace_id, state, lifecycle_revision
        `;
        [authorizedWorkspaceMembership] = await transaction`
          INSERT INTO omni_tenant_workspace_memberships (
            tenant_id, workspace_id, subject_kind, subject_key,
            subject_actor_id, membership_generation, access_level, state,
            lifecycle_revision, created_by_actor_id, activated_by_actor_id,
            created_at, activated_at, updated_at
          ) VALUES (
            'workspace-lifecycle-authorized', 'workspace:integration-authorized',
            'user', ${authorizedActorId}, ${authorizedActorId}, 1, 'manager',
            'active', 1, ${authorizedActorId}, ${authorizedActorId},
            statement_timestamp(), statement_timestamp(), statement_timestamp()
          )
          RETURNING subject_key, state, lifecycle_revision
        `;
        throw rollbackAuthorizedWorkspace;
      })
      .catch((error) => {
        if (error !== rollbackAuthorizedWorkspace) throw error;
      });
    expect(authorizedWorkspace).toEqual({
      workspace_id: "workspace:integration-authorized",
      state: "active",
      lifecycle_revision: "1",
    });
    expect(authorizedWorkspaceMembership).toEqual({
      subject_key: authorizedActorId,
      state: "active",
      lifecycle_revision: "1",
    });

    const unauthorizedUserId = "00000000-0000-4000-8000-000000000023";
    const unauthorizedActorId = `actor:${unauthorizedUserId}`;
    await expect(
      admin.begin(async (transaction) => {
        await transaction`
          INSERT INTO omni_auth_tenants (id, name, slug)
          VALUES (
            'workspace-lifecycle-unauthorized',
            'Workspace lifecycle unauthorized',
            'workspace-lifecycle-unauthorized'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_users (id, email, password_hash)
          VALUES (
            ${unauthorizedUserId},
            'workspace-lifecycle-unauthorized@example.test', 'test-only'
          )
        `;
        await transaction`
          INSERT INTO omni_tenant_workspaces (
            tenant_id, workspace_id, display_name, owner_actor_id, state,
            lifecycle_revision, created_by_actor_id, activated_by_actor_id,
            created_at, activated_at, updated_at
          ) VALUES (
            'workspace-lifecycle-unauthorized',
            'workspace:integration-unauthorized',
            'Unauthorized integration workspace', ${unauthorizedActorId},
            'active', 1, ${unauthorizedActorId}, ${unauthorizedActorId},
            statement_timestamp(), statement_timestamp(), statement_timestamp()
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    const workspaceOwnerUserId = "00000000-0000-4000-8000-000000000027";
    const workspaceOwnerActorId = `actor:${workspaceOwnerUserId}`;
    const unauthorizedCreatorUserId =
      "00000000-0000-4000-8000-000000000028";
    const unauthorizedCreatorActorId = `actor:${unauthorizedCreatorUserId}`;
    await expect(
      admin.begin(async (transaction) => {
        await transaction`
          INSERT INTO omni_auth_tenants (id, name, slug)
          VALUES (
            'workspace-membership-unauthorized',
            'Workspace membership unauthorized',
            'workspace-membership-unauthorized'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_users (id, email, password_hash)
          VALUES
            (
              ${workspaceOwnerUserId}, 'workspace-membership-owner@example.test',
              'test-only'
            ),
            (
              ${unauthorizedCreatorUserId},
              'workspace-membership-unauthorized@example.test', 'test-only'
            )
        `;
        await transaction`
          INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
          VALUES (
            'workspace-membership-owner-membership',
            'workspace-membership-unauthorized', ${workspaceOwnerUserId}, 'admin'
          )
        `;
        await transaction`
          INSERT INTO omni_tenant_workspaces (
            tenant_id, workspace_id, display_name, owner_actor_id, state,
            lifecycle_revision, created_by_actor_id, activated_by_actor_id,
            created_at, activated_at, updated_at
          ) VALUES (
            'workspace-membership-unauthorized',
            'workspace:membership-unauthorized',
            'Workspace membership authorization fixture',
            ${workspaceOwnerActorId}, 'active', 1, ${workspaceOwnerActorId},
            ${workspaceOwnerActorId}, statement_timestamp(),
            statement_timestamp(), statement_timestamp()
          )
        `;
        await transaction`
          INSERT INTO omni_tenant_workspace_memberships (
            tenant_id, workspace_id, subject_kind, subject_key,
            subject_actor_id, membership_generation, access_level, state,
            lifecycle_revision, created_by_actor_id, activated_by_actor_id,
            created_at, activated_at, updated_at
          ) VALUES (
            'workspace-membership-unauthorized',
            'workspace:membership-unauthorized', 'user',
            ${workspaceOwnerActorId}, ${workspaceOwnerActorId}, 1, 'reader',
            'active', 1, ${unauthorizedCreatorActorId},
            ${unauthorizedCreatorActorId}, statement_timestamp(),
            statement_timestamp(), statement_timestamp()
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("keeps context and capability grants explicit, bounded, and lifecycle-governed", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_memory_access_grants) AS rows,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid = 'omni_tenant_memory_access_grants'::regclass)
          AS policies,
        NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'omni_tenant_memory_access_grants'::regclass
            AND conname = 'omni_memory_access_grant_activation_hold_check'
        ) AS activation_hold_removed,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'omni_tenant_memory_access_grants'::regclass
            AND conname = 'omni_memory_access_grant_binding_check'
            AND convalidated
            AND pg_get_expr(conbin, conrelid) LIKE
              '%omni_memory_access_grant_binding_is_valid%'
        ) AS binding_validated
    `;
    const triggers = await admin`
      SELECT trigger.tgname AS trigger_name,
        procedure.proname AS function_name
      FROM pg_trigger trigger
      JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
      WHERE trigger.tgrelid = 'omni_tenant_memory_access_grants'::regclass
        AND NOT trigger.tgisinternal
        AND trigger.tgenabled = 'O'
      ORDER BY trigger.tgname
    `;
    const policies = await admin`
      SELECT
        policy.polname AS policy_name,
        policy.polpermissive AS permissive,
        policy.polcmd::text AS command,
        policy.polroles = ARRAY[0::oid] AS public_role,
        pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
        pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
      FROM pg_policy policy
      WHERE policy.polrelid = 'omni_tenant_memory_access_grants'::regclass
      ORDER BY policy.polname
    `;

    expect(surface).toEqual({
      rows: 0,
      policies: 2,
      activation_hold_removed: true,
      binding_validated: true,
    });
    expect(await tableGrants(admin, ["omni_tenant_memory_access_grants"])).toEqual([
      "omni_tenant_memory_access_grants: omni_backup SELECT",
      "omni_tenant_memory_access_grants: omni_maintenance INSERT, SELECT",
      "omni_tenant_memory_access_grants: omni_runtime INSERT, SELECT",
    ]);
    expect(triggers).toEqual([
      {
        trigger_name: "omni_memory_access_grant_lifecycle_protect",
        function_name: "omni_protect_memory_access_grant_lifecycle_v1",
      },
      {
        trigger_name: "omni_memory_access_grant_no_truncate",
        function_name: "omni_reject_memory_access_grant_mutation",
      },
      {
        trigger_name: "omni_memory_access_grant_validate_insert",
        function_name: "omni_validate_memory_access_grant_insert",
      },
    ]);
    const actorExpression =
      "(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))";
    expect(policies).toEqual([
      {
        policy_name: "omni_memory_access_grant_actor",
        permissive: false,
        command: "*",
        public_role: true,
        using_expression: actorExpression,
        check_expression: actorExpression,
      },
      {
        policy_name: "omni_tenant_isolation",
        permissive: true,
        command: "*",
        public_role: true,
        using_expression: "omni_tenant_visible(tenant_id)",
        check_expression: "omni_tenant_visible(tenant_id)",
      },
    ]);

    const authorizedUserId = "00000000-0000-4000-8000-000000000024";
    const authorizedActorId = `actor:${authorizedUserId}`;
    let activatedGrant:
      | { state: string; lifecycle_revision: string; activated_by_actor_id: string }
      | undefined;
    const rollbackActivatedGrant = new Error(
      "Rollback activated memory grant integration fixture",
    );
    await admin
      .begin(async (transaction) => {
        await transaction`
          INSERT INTO omni_auth_tenants (id, name, slug)
          VALUES (
            'memory-grant-lifecycle-authorized',
            'Memory grant lifecycle authorized',
            'memory-grant-lifecycle-authorized'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_users (id, email, password_hash)
          VALUES (
            ${authorizedUserId}, 'memory-grant-lifecycle-authorized@example.test',
            'test-only'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
          VALUES (
            'memory-grant-lifecycle-authorized-membership',
            'memory-grant-lifecycle-authorized', ${authorizedUserId}, 'admin'
          )
        `;
        await transaction`
          INSERT INTO omni_tenant_memory_access_grants (
            tenant_id, grant_kind, grant_id, grant_generation,
            grantee_kind, grantee_key, grantee_actor_id, purpose_id,
            target_visibility, owner_actor_id, resource_ids, max_items,
            max_bytes, not_before, expires_at, state, lifecycle_revision,
            created_by_actor_id
          ) VALUES (
            'memory-grant-lifecycle-authorized', 'context',
            'context:integration-authorized', 1, 'user', ${authorizedActorId},
            ${authorizedActorId}, 'memory.retrieve.v1', 'user_private',
            ${authorizedActorId}, ARRAY['memory:integration-authorized'],
            10, 4096, statement_timestamp(),
            statement_timestamp() + INTERVAL '1 hour', 'held', 0,
            ${authorizedActorId}
          )
        `;
        [activatedGrant] = await transaction`
          UPDATE omni_tenant_memory_access_grants
          SET state = 'active', lifecycle_revision = 1,
              activated_by_actor_id = ${authorizedActorId}
          WHERE tenant_id = 'memory-grant-lifecycle-authorized'
            AND grant_kind = 'context'
            AND grant_id = 'context:integration-authorized'
            AND grant_generation = 1
          RETURNING state, lifecycle_revision, activated_by_actor_id
        `;
        throw rollbackActivatedGrant;
      })
      .catch((error) => {
        if (error !== rollbackActivatedGrant) throw error;
      });
    expect(activatedGrant).toEqual({
      state: "active",
      lifecycle_revision: "1",
      activated_by_actor_id: authorizedActorId,
    });

    const rejectedUserId = "00000000-0000-4000-8000-000000000025";
    const rejectedActorId = `actor:${rejectedUserId}`;
    await expect(
      admin.begin(async (transaction) => {
        await transaction`
          INSERT INTO omni_auth_tenants (id, name, slug)
          VALUES (
            'memory-grant-lifecycle-rejected',
            'Memory grant lifecycle rejected',
            'memory-grant-lifecycle-rejected'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_users (id, email, password_hash)
          VALUES (
            ${rejectedUserId}, 'memory-grant-lifecycle-rejected@example.test',
            'test-only'
          )
        `;
        await transaction`
          INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
          VALUES (
            'memory-grant-lifecycle-rejected-membership',
            'memory-grant-lifecycle-rejected', ${rejectedUserId}, 'admin'
          )
        `;
        await transaction`
          INSERT INTO omni_tenant_memory_access_grants (
            tenant_id, grant_kind, grant_id, grant_generation,
            grantee_kind, grantee_key, grantee_actor_id, purpose_id,
            target_visibility, owner_actor_id, resource_ids, max_items,
            max_bytes, not_before, expires_at, state, lifecycle_revision,
            created_by_actor_id, activated_by_actor_id, activated_at
          ) VALUES (
            'memory-grant-lifecycle-rejected', 'context',
            'context:integration-direct-active', 1, 'user', ${rejectedActorId},
            ${rejectedActorId}, 'memory.retrieve.v1', 'user_private',
            ${rejectedActorId}, ARRAY['memory:integration-direct-active'],
            10, 4096, statement_timestamp(),
            statement_timestamp() + INTERVAL '1 hour', 'active', 1,
            ${rejectedActorId}, ${rejectedActorId}, statement_timestamp()
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("keeps operation policies empty, owner-written, and unable to waive gates", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_memory_operation_policies)
          AS rows,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid = 'omni_tenant_memory_operation_policies'::regclass)
          AS policies,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'omni_tenant_memory_operation_policies'::regclass
            AND conname = 'omni_memory_operation_policy_activation_hold_check'
            AND convalidated
            AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
        ) AS activation_held,
        omni_memory_operation_policy_row_is_valid(
          1::smallint, 'tenant:one'::text, 'memory-policy:unsafe'::text,
          1::bigint, 'memory.forget.v1'::text, 'forget'::text, 'low'::text,
          ARRAY['user'], ARRAY['user_private'], ARRAY['public'],
          FALSE, FALSE, FALSE, FALSE,
          'held'::text, 0::bigint,
          'actor:00000000-0000-4000-8000-000000000001'::text,
          NULL::text, NULL::text,
          statement_timestamp(), NULL::timestamptz, NULL::timestamptz,
          statement_timestamp()
        ) AS unsafe_policy_accepted
    `;

    expect(surface).toEqual({
      rows: 0,
      policies: 2,
      activation_held: true,
      unsafe_policy_accepted: false,
    });
    expect(await tableGrants(admin, ["omni_tenant_memory_operation_policies"])).toEqual([
      "omni_tenant_memory_operation_policies: omni_backup SELECT",
    ]);
  });

  test("re-verifies the exact dormant informed-notice authority boundary", async () => {
    const [surface] = await admin`
      SELECT
        EXISTS (
          SELECT 1
          FROM omni_schema_version
          WHERE version = 65
            AND name =
              'memory_informed_notice_authority_boundary_verification'
            AND checksum =
              '6dacefc682e876fe123701a039428a11ba160a225025da0a86ef27045bcad476'
        ) AS verifier_recorded,
        (SELECT count(*)::int
         FROM omni_memory_informed_notice_contracts) AS notice_contracts,
        (SELECT count(*)::int
         FROM omni_tenant_actor_memory_notice_receipts) AS notice_receipts,
        (SELECT count(*)::int
         FROM omni_tenant_actor_memory_purpose_consents) AS purpose_consents
    `;

    expect(surface).toEqual({
      verifier_recorded: true,
      notice_contracts: 0,
      notice_receipts: 0,
      purpose_consents: 0,
    });
    expect(
      await tableGrants(admin, [
        "omni_memory_informed_notice_contracts",
        "omni_tenant_actor_memory_notice_receipts",
        "omni_tenant_actor_memory_purpose_consents",
      ]),
    ).toEqual([
      "omni_memory_informed_notice_contracts: omni_backup SELECT",
      "omni_tenant_actor_memory_notice_receipts: omni_backup SELECT",
      "omni_tenant_actor_memory_purpose_consents: omni_backup SELECT",
    ]);
  });

  test("keeps informed-notice governance and anchor-review evidence held", async () => {
    const [surface] = await admin`
      SELECT
        EXISTS (
          SELECT 1 FROM omni_schema_version
          WHERE version = 66
            AND name = 'memory_informed_notice_governance_evidence_shadow'
            AND checksum =
              '8e845ac8182b025d6dea8014ec3877c141e55ad2dc551054b1a885e4bb680f6e'
        ) AS migration_recorded,
        EXISTS (
          SELECT 1 FROM omni_schema_version
          WHERE version = 67
            AND name =
              'memory_informed_notice_anchor_review_evidence_shadow'
            AND checksum =
              '6659ee684d50ec67c535c5d3f597347ab31143bd9d9ca9dc4748883b66935956'
        ) AS anchor_migration_recorded,
        (SELECT count(*)::int
         FROM omni_memory_informed_notice_approval_batches) AS batches,
        (SELECT count(*)::int
         FROM omni_memory_informed_notice_approval_contracts) AS contracts,
        (SELECT count(*)::int
         FROM omni_memory_informed_notice_review_attestations) AS attestations,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid IN (
           'omni_memory_informed_notice_approval_batches'::regclass,
           'omni_memory_informed_notice_approval_contracts'::regclass,
           'omni_memory_informed_notice_review_attestations'::regclass
         )) AS policies,
        (
          SELECT count(*) = 3 FROM pg_constraint
          WHERE conname IN (
            'omni_notice_approval_batches_persistence_hold_check',
            'omni_notice_approval_contracts_persistence_hold_check',
            'omni_notice_review_attestations_persistence_hold_check'
          ) AND convalidated
            AND pg_get_expr(conbin, conrelid) = 'false'
        ) AS persistence_held,
        (
          SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name =
              'omni_memory_informed_notice_approval_batches'
            AND column_name IN (
              'independence_review_id',
              'independence_reviewed_by_actor_id',
              'independence_reviewed_at',
              'human_independence_reviewed'
            )
        ) AS anchor_columns,
        omni_notice_approval_contract_row_is_valid(
          1::smallint, 'notice-batch:valid'::text, repeat('a', 64)::text,
          0::smallint, 1::smallint, 'memory.retrieval.v1'::text,
          'notice-contract:valid'::text, 1::smallint, 'en-US'::text,
          'Exact notice'::text, repeat('b', 64)::text
        ) AS standing_notice_valid,
        omni_notice_approval_contract_row_is_valid(
          1::smallint, 'notice-batch:unsafe'::text, repeat('a', 64)::text,
          0::smallint, 1::smallint, 'memory.forget.v1'::text,
          'notice-contract:unsafe'::text, 1::smallint, 'en-US'::text,
          'Exact notice'::text, repeat('b', 64)::text
        ) AS data_right_notice_accepted
    `;

    expect(
      await tableGrants(admin, [
        "omni_memory_informed_notice_approval_batches",
        "omni_memory_informed_notice_approval_contracts",
        "omni_memory_informed_notice_review_attestations",
      ]),
    ).toEqual([
      "omni_memory_informed_notice_approval_batches: omni_backup SELECT",
      "omni_memory_informed_notice_approval_contracts: omni_backup SELECT",
      "omni_memory_informed_notice_review_attestations: omni_backup SELECT",
    ]);
    expect(surface).toEqual({
      migration_recorded: true,
      anchor_migration_recorded: true,
      batches: 0,
      contracts: 0,
      attestations: 0,
      policies: 3,
      persistence_held: true,
      anchor_columns: 4,
      standing_notice_valid: true,
      data_right_notice_accepted: false,
    });
  });

  test("keeps one-time memory data-right requests empty, owner-written, and inactive", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_memory_data_right_requests)
          AS rows,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid = 'omni_tenant_memory_data_right_requests'::regclass)
          AS policies,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'omni_tenant_memory_data_right_requests'::regclass
            AND conname = 'omni_memory_data_right_request_activation_hold_check'
            AND convalidated
        ) AS activation_held,
        omni_memory_data_right_request_row_is_valid(
          1::smallint, 'tenant:one'::text,
          'memory-data-right-request:valid'::text, 1::bigint,
          'memory.forget.v1'::text,
          'actor:00000000-0000-4000-8000-000000000001'::text,
          'user'::text,
          'actor:00000000-0000-4000-8000-000000000001'::text,
          'reviewed_deletion_preview'::text, repeat('a', 64)::text,
          ARRAY['memory:one']::text[],
          statement_timestamp()::timestamptz,
          (statement_timestamp() + INTERVAL '1 hour')::timestamptz,
          'held'::text, 0::bigint,
          'actor:00000000-0000-4000-8000-000000000001'::text,
          NULL::text, NULL::text, NULL::text,
          statement_timestamp()::timestamptz,
          NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
          statement_timestamp()::timestamptz
        ) AS valid_held_request,
        omni_memory_data_right_request_row_is_valid(
          1::smallint, 'tenant:one'::text,
          'memory-data-right-request:unsafe'::text, 1::bigint,
          'memory.forget.v1'::text,
          'actor:00000000-0000-4000-8000-000000000001'::text,
          'user'::text,
          'actor:00000000-0000-4000-8000-000000000001'::text,
          'explicit_export_request'::text, repeat('a', 64)::text,
          ARRAY['memory:one']::text[],
          statement_timestamp()::timestamptz,
          (statement_timestamp() + INTERVAL '1 hour')::timestamptz,
          'held'::text, 0::bigint,
          'actor:00000000-0000-4000-8000-000000000001'::text,
          NULL::text, NULL::text, NULL::text,
          statement_timestamp()::timestamptz,
          NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
          statement_timestamp()::timestamptz
        ) AS mismatched_confirmation_accepted
    `;

    expect(surface).toEqual({
      rows: 0,
      policies: 2,
      activation_held: true,
      valid_held_request: true,
      mismatched_confirmation_accepted: false,
    });
    expect(await tableGrants(admin, ["omni_tenant_memory_data_right_requests"])).toEqual([
      "omni_tenant_memory_data_right_requests: omni_backup SELECT",
    ]);
    await expect(admin`
      INSERT INTO omni_tenant_memory_data_right_requests (
        tenant_id, request_id, request_generation, purpose_id,
        subject_actor_id, executing_principal_type, executing_principal_id,
        confirmation_kind, request_binding_sha256, resource_ids,
        not_before, expires_at, state, lifecycle_revision,
        created_by_actor_id, activated_by_actor_id, activated_at
      ) VALUES (
        'tenant:forbidden', 'memory-data-right-request:forbidden', 1,
        'memory.forget.v1',
        'actor:00000000-0000-4000-8000-000000000001', 'user',
        'actor:00000000-0000-4000-8000-000000000001',
        'reviewed_deletion_preview', ${"a".repeat(64)},
        ARRAY['memory:forbidden'], statement_timestamp(),
        statement_timestamp() + INTERVAL '1 hour', 'active', 1,
        'actor:00000000-0000-4000-8000-000000000001',
        'actor:00000000-0000-4000-8000-000000000001',
        statement_timestamp()
      )
    `).rejects.toMatchObject({ code: "23514" });
  });

  test("records a held memory data-right request and its event atomically", async () => {
    const tenantId = "tenant_data_right_writer";
    const userId = "00000000-0000-4000-8000-000000000064";
    const actorId = `actor:${userId}`;
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES (${tenantId}, 'Data-right writer', 'data-right-writer')
    `;
    await admin`
      INSERT INTO omni_auth_users (id, email, password_hash)
      VALUES (${userId}, 'data-right-writer@example.test', 'test-only')
    `;
    await admin`
      INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
      VALUES ('membership:data-right-writer', ${tenantId}, ${userId}, 'admin')
    `;
    const now = Date.now();
    const createdAt = new Date(now - 120_000).toISOString();
    const notBefore = new Date(now).toISOString();
    const expiresAt = new Date(now + 3_600_000).toISOString();
    const requestBindingSha256 = "6".repeat(64);
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "correlation:data-right-writer-integration",
      purpose: "memory.export.v1",
    });

    const result = await runWithDatabaseSystemScope(
      "integration held data-right request",
      () => getSql().transaction((sql: MemoryDataRightRequestWriterSql) =>
        recordHeldMemoryDataRightRequestV1(
          {
            executionScope,
            governanceDecisionId: "governance:data-right-writer-integration",
            request: {
              schemaVersion: 1,
              tenantId,
              requestId: "memory-data-right-request:integration",
              requestGeneration: 1,
              purposeId: "memory.export.v1",
              subjectActorId: actorId,
              executingPrincipalType: "user",
              executingPrincipalId: actorId,
              confirmationKind: "explicit_export_request",
              requestBindingSha256,
              resourceIds: ["memory:integration"],
              notBefore,
              expiresAt,
              state: "held",
              lifecycleRevision: 0,
              createdByActorId: actorId,
              activatedByActorId: null,
              consumedByActorId: null,
              revokedByActorId: null,
              createdAt,
              activatedAt: null,
              consumedAt: null,
              revokedAt: null,
              updatedAt: createdAt,
            },
          },
          sql,
        )
      ),
    ) as RecordHeldMemoryDataRightRequestResultV1;

    expect(result).toMatchObject({
      request: {
        tenantId,
        purposeId: "memory.export.v1",
        state: "held",
      },
      authorityGranted: false,
      runtimeAccepted: false,
    });
    const [stored] = await admin`
      SELECT state, lifecycle_revision
      FROM omni_tenant_memory_data_right_requests
      WHERE tenant_id = ${tenantId}
        AND request_id = 'memory-data-right-request:integration'
    `;
    const [event] = await admin`
      SELECT type, payload
      FROM omni_events
      WHERE id = ${result.event.id}
    `;
    expect(stored).toEqual({ state: "held", lifecycle_revision: "0" });
    expect(event).toMatchObject({
      type: "memory.data_right_request.held",
      payload: {
        tenantId,
        resourceCount: 1,
        state: "held",
      },
    });
    expect(event.payload).not.toHaveProperty("resourceIds");
  });

  test("enforces shared limits atomically across concurrent requests", async () => {
    const key = `integration:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        checkSharedRateLimit({ key, limit: 5, windowMs: 60_000 }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(7);
    expect(
      results.filter((result) => !result.allowed).every((result) => result.retryAfterSeconds > 0),
    ).toBe(true);
  });

  test("prunes expired terminal payloads without deleting active work", async () => {
    await admin`
      INSERT INTO omni_agent_runs (
        id, tenant_id, owner_actor_id, mode, status, prompt, messages,
        started_at, completed_at
      )
      VALUES
        (
          'expired-run', 'tenant_a', 'retention_actor', 'orchestrate', 'completed', 'sensitive',
          '[]'::jsonb, NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        ),
        (
          'active-run', 'tenant_a', 'retention_actor', 'orchestrate', 'waiting_approval', 'keep',
          '[]'::jsonb, NOW() - INTERVAL '4000 days', NULL
        ),
        (
          'expired-waiting-run', 'tenant_a', 'retention_actor', 'orchestrate',
          'waiting_approval', 'redact',
          '[]'::jsonb, NOW() - INTERVAL '4000 days', NULL
        )
    `;
    await admin`
      UPDATE omni_agent_runs
      SET continuation = '{"pendingToolCall":{"executionId":"expired-approval"}}'::jsonb
      WHERE id = 'expired-waiting-run'
    `;
    await admin`
      INSERT INTO omni_tool_executions (
        id, tool_id, tool_name, risk_level, status, tenant_id, actor_id,
        input, created_at, completed_at
      )
      VALUES
        (
          'expired-tool', 'tool', 'Tool', 1, 'executed', 'tenant_a', 'retention_actor',
          '{"secret":"value"}'::jsonb, NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        ),
        (
          'expired-approval', 'tool', 'Tool', 2, 'approval_required', 'tenant_a',
          'retention_actor',
          '{"secret":"pending"}'::jsonb, NOW() - INTERVAL '4000 days', NULL
        )
    `;
    await admin`
      UPDATE omni_tool_executions
      SET output = '{"preview":"sensitive pre-approval output"}'::jsonb,
          reason = 'Waiting for operator approval.'
      WHERE id = 'expired-approval'
    `;
    await admin`
      INSERT INTO omni_access_requests (
        id, tenant_id, name, email, company, role, use_case, timeline,
        status, created_at, updated_at
      )
      VALUES
        (
          'expired-access-pending', 'tenant_a', 'Pending Person', 'pending@example.test',
          'Example', 'engineering', 'Sensitive use case', 'now',
          'pending_review', NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        ),
        (
          'expired-access-reviewed', 'tenant_a', 'Reviewed Person', 'reviewed@example.test',
          'Example', 'product', 'Reviewed use case', 'quarter',
          'approved', NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        )
    `;
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES ('tenant_retention', 'Retention tenant', 'retention-tenant')
    `;
    await admin`
      INSERT INTO omni_auth_users (id, email, password_hash)
      VALUES (
        '00000000-0000-4000-8000-000000000001',
        'retention@example.test',
        'test-password-hash'
      )
    `;
    await admin`
      INSERT INTO omni_auth_sessions (
        id, tenant_id, user_id, token_hash, expires_at
      )
      VALUES
        (
          'expired-auth-session', 'tenant_retention',
          '00000000-0000-4000-8000-000000000001',
          'expired-auth-token', NOW() - INTERVAL '1 day'
        ),
        (
          'active-auth-session', 'tenant_retention',
          '00000000-0000-4000-8000-000000000001',
          'active-auth-token', NOW() + INTERVAL '1 day'
        )
    `;
    await admin`
      INSERT INTO omni_memories (
        id, tenant_id, type, title, content, tags, scope, source, importance,
        created_at, updated_at
      )
      VALUES
        (
          'expired-episode-memory', 'tenant_a', 'episode', 'Episode', 'Sensitive episode',
          '{}'::text[], 'workspace', 'agent', 0.5,
          NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        ),
        (
          'expired-consolidated-memory', 'tenant_a', 'fact', 'Fact', 'Sensitive fact',
          '{}'::text[], 'workspace', 'consolidator', 0.5,
          NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        ),
        (
          'retained-curated-memory', 'tenant_a', 'fact', 'Curated', 'Retain this',
          '{}'::text[], 'workspace', 'operator', 0.5,
          NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        )
    `;
    await admin`
      INSERT INTO omni_memory_graph_nodes (
        id, tenant_id, kind, label, slug, memory_ids
      )
      VALUES
        (
          'expired-memory-node', 'tenant_a', 'fact', 'Expired memory node',
          'tenant-a-expired-memory-node', ARRAY['expired-consolidated-memory']::text[]
        ),
        (
          'retained-memory-node', 'tenant_a', 'fact', 'Retained memory node',
          'tenant-a-retained-memory-node', '{}'::text[]
        )
    `;
    await admin`
      INSERT INTO omni_memory_graph_edges (
        id, tenant_id, source_node_id, target_node_id, relation, memory_ids
      )
      VALUES (
        'expired-memory-edge', 'tenant_a', 'expired-memory-node', 'retained-memory-node',
        'related_to', ARRAY['expired-consolidated-memory']::text[]
      )
    `;
    await admin`
      INSERT INTO omni_retrieval_traces (id, tenant_id, query, created_at)
      VALUES (
        'expired-retrieval-trace', 'tenant_a', 'Sensitive historical query',
        NOW() - INTERVAL '4000 days'
      )
    `;
    await admin`
      INSERT INTO omni_workflow_runs (
        id, tenant_id, workflow_type, status, goal, created_at, updated_at, completed_at
      )
      VALUES
        (
          'expired-workflow', 'tenant_a', 'research', 'completed', 'Expired workflow',
          NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days',
          NOW() - INTERVAL '4000 days'
        ),
        (
          'active-workflow', 'tenant_a', 'research', 'running', 'Active workflow',
          NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days', NULL
        )
    `;
    await admin`
      INSERT INTO omni_workflow_plans (
        id, tenant_id, workflow_run_id, goal, status, planner, created_at, updated_at
      )
      VALUES
        (
          'expired-plan', 'tenant_a', 'expired-workflow', 'Expired plan',
          'completed', 'integration', NOW() - INTERVAL '4000 days',
          NOW() - INTERVAL '4000 days'
        ),
        (
          'active-plan', 'tenant_a', 'active-workflow', 'Active plan',
          'running', 'integration', NOW() - INTERVAL '4000 days',
          NOW() - INTERVAL '4000 days'
        )
    `;
    await admin`
      INSERT INTO omni_workflow_triggers (
        id, tenant_id, name, source, status, goal_template, created_at, updated_at
      )
      VALUES (
        'retention-trigger', 'tenant_a', 'Retention trigger', 'webhook', 'active',
        'Run retention test', NOW() - INTERVAL '4000 days', NOW()
      )
    `;
    await admin`
      INSERT INTO omni_workflow_trigger_events (
        id, tenant_id, trigger_id, status, source, received_at
      )
      VALUES
        (
          'expired-trigger-event', 'tenant_a', 'retention-trigger', 'rejected',
          'webhook', NOW() - INTERVAL '4000 days'
        ),
        (
          'recent-trigger-event', 'tenant_a', 'retention-trigger', 'accepted',
          'webhook', NOW()
        )
    `;
    await admin`
      INSERT INTO omni_operation_jobs (
        id, tenant_id, type, status, completed_at, created_at, updated_at
      )
      VALUES
        (
          'expired-operation-job', 'tenant_a', 'workflow.tick', 'completed',
          NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days',
          NOW() - INTERVAL '4000 days'
        ),
        (
          'active-operation-job', 'tenant_a', 'workflow.tick', 'queued',
          NULL, NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        )
    `;

    await expect(admin`
      UPDATE omni_tool_executions
      SET input = '{"tampered":true}'::jsonb
      WHERE id = 'expired-tool'
    `).rejects.toThrow("Governed tool execution identity is immutable");

    const result = await sweepExpiredSensitiveData({
      tenantId: "tenant_a",
      allTenants: true,
    });
    const remainingRuns = await admin`
      SELECT id, status, prompt
      FROM omni_agent_runs
      WHERE id IN ('expired-run', 'active-run', 'expired-waiting-run')
      ORDER BY id
    `;
    const [expiredApproval] = await admin`
      SELECT status, input, output, reason, approval_reason
      FROM omni_tool_executions
      WHERE id = 'expired-approval'
    `;
    const remainingAccessRequests = await admin`
      SELECT id, status, name, email
      FROM omni_access_requests
      WHERE id IN ('expired-access-pending', 'expired-access-reviewed')
      ORDER BY id
    `;
    const remainingAuthSessions = await admin`
      SELECT id
      FROM omni_auth_sessions
      WHERE id IN ('expired-auth-session', 'active-auth-session')
      ORDER BY id
    `;
    const remainingMemories = await admin`
      SELECT id, title, content, source, claim_status
      FROM omni_memories
      WHERE id IN (
        'expired-episode-memory',
        'expired-consolidated-memory',
        'retained-curated-memory'
      )
      ORDER BY id
    `;
    const remainingGraphNodes = await admin`
      SELECT id
      FROM omni_memory_graph_nodes
      WHERE id IN ('expired-memory-node', 'retained-memory-node')
      ORDER BY id
    `;
    const [rebuiltGraph] = await admin`
      SELECT COUNT(*)::int AS count
      FROM omni_memory_graph_nodes
      WHERE tenant_id = 'tenant_a'
        AND memory_ids @> ARRAY['retained-curated-memory']::text[]
    `;
    const pendingGraphRebuilds = await admin`
      SELECT tenant_id
      FROM omni_memory_graph_rebuild_queue
      WHERE tenant_id = 'tenant_a'
    `;
    const remainingTraces = await admin`
      SELECT id
      FROM omni_retrieval_traces
      WHERE id = 'expired-retrieval-trace'
    `;
    const remainingWorkflows = await admin`
      SELECT id
      FROM omni_workflow_runs
      WHERE id IN ('expired-workflow', 'active-workflow')
      ORDER BY id
    `;
    const remainingWorkflowPlans = await admin`
      SELECT id
      FROM omni_workflow_plans
      WHERE id IN ('expired-plan', 'active-plan')
      ORDER BY id
    `;
    const remainingTriggerEvents = await admin`
      SELECT id
      FROM omni_workflow_trigger_events
      WHERE id IN ('expired-trigger-event', 'recent-trigger-event')
      ORDER BY id
    `;
    const remainingOperationJobs = await admin`
      SELECT id
      FROM omni_operation_jobs
      WHERE id IN ('expired-operation-job', 'active-operation-job')
      ORDER BY id
    `;

    expect(result.deleted.expiredApprovalRuns).toBe(1);
    expect(result.deleted.expiredToolApprovals).toBe(1);
    expect(result.deleted.expiredAccessRequests).toBe(1);
    expect(result.deleted.accessRequests).toBe(1);
    expect(result.deleted.authSessions).toBe(1);
    expect(result.deleted.memoryGraphEdges).toBe(1);
    // Retention invalidates only rows derived from expired inputs. The durable
    // rebuild replaces the remaining tenant graph after this count is taken.
    expect(result.deleted.memoryGraphNodes).toBe(1);
    expect(result.deleted.memories).toBe(2);
    expect(result.deleted.retrievalTraces).toBe(1);
    expect(result.deleted.workflowPlans).toBe(1);
    expect(result.deleted.workflows).toBe(1);
    expect(result.deleted.triggerEvents).toBe(1);
    expect(result.deleted.operationJobs).toBe(1);
    expect(result.deleted.runs).toBeGreaterThanOrEqual(1);
    expect(result.deleted.toolExecutions).toBeGreaterThanOrEqual(1);
    expect(remainingRuns).toEqual([
      { id: "active-run", status: "waiting_approval", prompt: "keep" },
      { id: "expired-waiting-run", status: "failed", prompt: "[expired approval]" },
    ]);
    expect(expiredApproval).toMatchObject({
      status: "rejected",
      input: { redacted: "expired approval" },
      output: null,
      reason: "Approval expired before an operator decision.",
      approval_reason: "Expired by retention policy.",
    });
    expect(remainingAccessRequests).toEqual([
      {
        id: "expired-access-pending",
        status: "declined",
        name: "[expired]",
        email: "expired+expired-access-pending@invalid",
      },
    ]);
    expect(remainingAuthSessions).toEqual([{ id: "active-auth-session" }]);
    expect(remainingMemories).toEqual([
      {
        id: "expired-consolidated-memory",
        title: "[retired]",
        content: "",
        source: "[retired]",
        claim_status: "superseded",
      },
      {
        id: "expired-episode-memory",
        title: "[retired]",
        content: "",
        source: "[retired]",
        claim_status: "superseded",
      },
      {
        id: "retained-curated-memory",
        title: "Curated",
        content: "Retain this",
        source: "operator",
        claim_status: "active",
      },
    ]);
    expect(remainingGraphNodes).toEqual([{ id: "retained-memory-node" }]);
    expect(rebuiltGraph.count).toBe(0);
    expect(pendingGraphRebuilds).toEqual([{ tenant_id: "tenant_a" }]);
    expect(remainingTraces).toEqual([]);
    expect(remainingWorkflows).toEqual([{ id: "active-workflow" }]);
    expect(remainingWorkflowPlans).toEqual([{ id: "active-plan" }]);
    expect(remainingTriggerEvents).toEqual([{ id: "recent-trigger-event" }]);
    expect(remainingOperationJobs).toEqual([{ id: "active-operation-job" }]);
  });

  test("bounds retention mutations and reports follow-up work", async () => {
    const previousBatchSize = process.env.OMNIAGENT_RETENTION_BATCH_SIZE;
    process.env.OMNIAGENT_RETENTION_BATCH_SIZE = "100";
    try {
      await admin`
        INSERT INTO omni_observability_events (
          id, level, category, action, correlation_id, tenant_id, message,
          created_at
        )
        SELECT
          'bounded-retention-' || item,
          'info',
          'integration',
          'retention.batch',
          'bounded-correlation-' || item,
          'tenant_bounded_retention',
          'expired integration event',
          NOW() - INTERVAL '4000 days'
        FROM generate_series(1, 105) item
      `;

      const first = await sweepExpiredSensitiveData({
        tenantId: "tenant_bounded_retention",
      });
      expect(first).toMatchObject({
        batchLimit: 100,
        moreAvailable: true,
        deleted: { observabilityEvents: 100 },
      });

      const second = await sweepExpiredSensitiveData({
        tenantId: "tenant_bounded_retention",
      });
      expect(second).toMatchObject({
        batchLimit: 100,
        moreAvailable: false,
        deleted: { observabilityEvents: 5 },
      });
    } finally {
      if (previousBatchSize === undefined) {
        delete process.env.OMNIAGENT_RETENTION_BATCH_SIZE;
      } else {
        process.env.OMNIAGENT_RETENTION_BATCH_SIZE = previousBatchSize;
      }
    }
  });

  test("restricts a non-privileged role to the active tenant", async () => {
    await admin.unsafe(`CREATE ROLE ${rlsRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${rlsRole}`);
    await admin.unsafe(`GRANT SELECT, INSERT ON omni_memories TO ${rlsRole}`);
    await admin.unsafe(`GRANT SELECT, INSERT ON omni_auth_memberships, omni_auth_sessions TO ${rlsRole}`);
    await admin.unsafe(
      `GRANT SELECT, INSERT, UPDATE ON omni_tenant_execution_principals TO ${rlsRole}`,
    );
    await admin`
      INSERT INTO omni_memories (id, tenant_id, type, title, content, scope, source)
      VALUES
        ('integration-tenant-a', 'tenant_a', 'fact', 'Tenant A', 'visible', 'tenant', 'integration'),
        ('integration-tenant-b', 'tenant_b', 'fact', 'Tenant B', 'hidden', 'tenant', 'integration')
    `;
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES
        ('tenant_a', 'Tenant A', 'integration-tenant-a'),
        ('tenant_b', 'Tenant B', 'integration-tenant-b')
      ON CONFLICT (id) DO NOTHING
    `;
    await admin`
      INSERT INTO omni_auth_users (id, email, password_hash)
      VALUES
        (
          '00000000-0000-4000-8000-000000000010',
          'integration-a@example.test',
          'test-only'
        ),
        (
          '00000000-0000-4000-8000-000000000011',
          'integration-b@example.test',
          'test-only'
        ),
        (
          '00000000-0000-4000-8000-000000000012',
          'integration-a-other-actor@example.test',
          'test-only'
        )
    `;
    await admin`
      INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
      VALUES
        (
          'integration-membership-a', 'tenant_a',
          '00000000-0000-4000-8000-000000000010', 'admin'
        ),
        (
          'integration-membership-b', 'tenant_b',
          '00000000-0000-4000-8000-000000000011', 'admin'
        ),
        (
          'integration-membership-a-other-actor', 'tenant_a',
          '00000000-0000-4000-8000-000000000012', 'member'
        )
    `;
    await admin`
      INSERT INTO omni_tenant_execution_principals (
        tenant_id, principal_kind, principal_id, principal_generation,
        controller_actor_id, system_principal_class, state,
        lifecycle_revision, created_by_actor_id
      ) VALUES
        (
          'tenant_a', 'system', 'service:integration-actor-a', 1,
          'actor:00000000-0000-4000-8000-000000000010', 'worker',
          'held', 0, 'actor:00000000-0000-4000-8000-000000000010'
        ),
        (
          'tenant_a', 'system', 'service:integration-actor-a-other', 1,
          'actor:00000000-0000-4000-8000-000000000012', 'worker',
          'held', 0, 'actor:00000000-0000-4000-8000-000000000012'
        ),
        (
          'tenant_b', 'system', 'service:integration-actor-b', 1,
          'actor:00000000-0000-4000-8000-000000000011', 'worker',
          'held', 0, 'actor:00000000-0000-4000-8000-000000000011'
        )
    `;
    await admin`
      INSERT INTO omni_auth_sessions (
        id, tenant_id, user_id, token_hash, expires_at
      )
      VALUES
        (
          'integration-session-a', 'tenant_a',
          '00000000-0000-4000-8000-000000000010',
          'integration-token-a', NOW() + INTERVAL '1 day'
        ),
        (
          'integration-session-b', 'tenant_b',
          '00000000-0000-4000-8000-000000000011',
          'integration-token-b', NOW() + INTERVAL '1 day'
        )
    `;

    const visible = await admin.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${rlsRole}`);
      await transaction`SELECT set_config('omni.tenant_id', 'tenant_a', true)`;
      return transaction`
        SELECT id, tenant_id
        FROM omni_memories
        WHERE id IN ('integration-tenant-a', 'integration-tenant-b')
        ORDER BY id
      `;
    });

    expect(visible).toEqual([
      { id: "integration-tenant-a", tenant_id: "tenant_a" },
    ]);

    const visibleIdentityRows = await admin.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${rlsRole}`);
      await transaction`SELECT set_config('omni.tenant_id', 'tenant_a', true)`;
      const memberships = await transaction`
        SELECT id, tenant_id
        FROM omni_auth_memberships
        ORDER BY id
      `;
      const sessions = await transaction`
        SELECT id, tenant_id
        FROM omni_auth_sessions
        ORDER BY id
      `;
      return { memberships, sessions };
    });
    expect(visibleIdentityRows).toEqual({
      memberships: [
        { id: "integration-membership-a", tenant_id: "tenant_a" },
        {
          id: "integration-membership-a-other-actor",
          tenant_id: "tenant_a",
        },
      ],
      sessions: [
        { id: "integration-session-a", tenant_id: "tenant_a" },
      ],
    });

    const actorScope = JSON.stringify({
      version: 1,
      tenantId: "tenant_a",
      actorIds: ["actor:00000000-0000-4000-8000-000000000010"],
    });
    const visiblePrincipals = await admin.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${rlsRole}`);
      await transaction`SELECT set_config('omni.tenant_id', 'tenant_a', true)`;
      await transaction`SELECT set_config('omni.actor_scope_v1', ${actorScope}, true)`;
      return transaction`
        SELECT principal_id, controller_actor_id
        FROM omni_tenant_execution_principals
        WHERE principal_id IN (
          'service:integration-actor-a',
          'service:integration-actor-a-other',
          'service:integration-actor-b'
        )
        ORDER BY principal_id
      `;
    });
    expect(visiblePrincipals).toEqual([
      {
        principal_id: "service:integration-actor-a",
        controller_actor_id: "actor:00000000-0000-4000-8000-000000000010",
      },
    ]);

    await expect(
      admin.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${rlsRole}`);
        await transaction`SELECT set_config('omni.tenant_id', 'tenant_a', true)`;
        await transaction`SELECT set_config('omni.actor_scope_v1', ${actorScope}, true)`;
        await transaction`
          INSERT INTO omni_tenant_execution_principals (
            tenant_id, principal_kind, principal_id, principal_generation,
            controller_actor_id, system_principal_class, state,
            lifecycle_revision, created_by_actor_id
          ) VALUES (
            'tenant_a', 'system', 'service:integration-cross-actor', 1,
            'actor:00000000-0000-4000-8000-000000000012', 'worker',
            'held', 0, 'actor:00000000-0000-4000-8000-000000000012'
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    const attemptedBypass = await admin.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${rlsRole}`);
      await transaction`SELECT set_config('omni.tenant_id', '', true)`;
      await transaction`SELECT set_config('omni.system_scope', 'true', true)`;
      await transaction`SELECT set_config('omni.system_reason', 'untrusted attempt', true)`;
      return transaction`
        SELECT id
        FROM omni_memories
        WHERE id IN ('integration-tenant-a', 'integration-tenant-b')
      `;
    });
    expect(attemptedBypass).toEqual([]);

    await expect(
      admin.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${rlsRole}`);
        await transaction`SELECT set_config('omni.tenant_id', 'tenant_a', true)`;
        await transaction`
          INSERT INTO omni_memories (id, tenant_id, type, title, content, scope, source)
          VALUES ('integration-cross-tenant', 'tenant_b', 'fact', 'Blocked', 'blocked', 'tenant', 'integration')
        `;
      }),
    ).rejects.toThrow();
  });

  test("routes system scope through a dedicated maintenance role", async () => {
    await admin.unsafe(`
      CREATE ROLE ${runtimeRole}
      LOGIN PASSWORD 'integration-only'
      NOSUPERUSER NOBYPASSRLS
    `);
    await admin.unsafe(`
      CREATE ROLE ${maintenanceRole}
      LOGIN PASSWORD 'integration-only'
      NOSUPERUSER BYPASSRLS
    `);
    for (const role of [runtimeRole, maintenanceRole]) {
      await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await admin.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      );
      await admin.unsafe(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      );
    }

    const runtimeUrl = databaseUrlForRole(databaseUrl!, runtimeRole);
    const maintenanceUrl = databaseUrlForRole(
      databaseUrl!,
      maintenanceRole,
    );
    vi.stubEnv("DATABASE_URL", runtimeUrl);
    vi.stubEnv("OMNIAGENT_MAINTENANCE_DATABASE_URL", maintenanceUrl);
    vi.stubEnv("NODE_ENV", "test");
    vi.resetModules();
    try {
      const client = await import("@/lib/db/client");
      const safety = await withTimeout(
        client.getMaintenanceDatabaseRoleSafety(),
        5_000,
      );
      expect(safety).toMatchObject({
        configured: true,
        safe: true,
        sameDatabase: true,
        role: {
          name: maintenanceRole,
          superuser: false,
          bypassRls: true,
          ownsSchema: false,
        },
      });

      const tenantRows = await client.runWithDatabaseTenantScope(
        "tenant_a",
        () =>
          client.getSql()`
            SELECT id
            FROM omni_memories
            WHERE id IN ('integration-tenant-a', 'integration-tenant-b')
            ORDER BY id
          `,
      );
      expect(tenantRows).toEqual([{ id: "integration-tenant-a" }]);

      const allRows = await client.runWithDatabaseSystemScope(
        "integration all-tenant maintenance",
        () =>
          client.getSql()`
            SELECT id
            FROM omni_memories
            WHERE id IN ('integration-tenant-a', 'integration-tenant-b')
            ORDER BY id
          `,
      );
      expect(allRows).toEqual([
        { id: "integration-tenant-a" },
        { id: "integration-tenant-b" },
      ]);
      // Functions and triggers that check for system scope accept the
      // maintenance role as well as the schema owner.
      const [maintenanceScope] = await client.runWithDatabaseSystemScope(
        "integration system-scope check",
        () => client.getSql()`SELECT omni_system_scope_enabled() AS enabled`,
      );
      expect(maintenanceScope).toEqual({ enabled: true });

      const spoofedRows = await client.runWithDatabaseTenantScope(
        "tenant_a",
        () =>
          client.getSql().transaction(
            async (sql: ReturnType<typeof client.getSql>) => {
              await sql`SELECT set_config('omni.tenant_id', '', true)`;
              await sql`SELECT set_config('omni.system_scope', 'true', true)`;
              await sql`SELECT set_config('omni.system_reason', 'spoofed', true)`;
              return sql`
                SELECT id
                FROM omni_memories
                WHERE id IN ('integration-tenant-a', 'integration-tenant-b')
              `;
            },
          ),
      );
      expect(spoofedRows).toEqual([]);
      const spoofedScope = await client.runWithDatabaseTenantScope(
        "tenant_a",
        () =>
          client.getSql().transaction(
            async (sql: ReturnType<typeof client.getSql>) => {
              await sql`SELECT set_config('omni.system_scope', 'true', true)`;
              await sql`SELECT set_config('omni.system_reason', 'spoofed', true)`;
              return sql`SELECT omni_system_scope_enabled() AS enabled`;
            },
          ),
      );
      expect(spoofedScope).toEqual([{ enabled: false }]);
      await client.closeDatabaseClient();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  test("keeps each procedure alias on one active workspace template", async () => {
    const tenantId = "tenant_template_aliases";
    const userId = "00000000-0000-4000-8000-000000000071";
    const actorId = `actor:${userId}`;
    const workspaceId = "workspace:template-aliases";
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES (${tenantId}, 'Template aliases', 'template-aliases')
    `;
    await admin`
      INSERT INTO omni_auth_users (id, email, password_hash)
      VALUES (${userId}, 'template-aliases@example.test', 'test-only')
    `;
    await admin`
      INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
      VALUES ('membership:template-aliases', ${tenantId}, ${userId}, 'admin')
    `;
    await admin`
      INSERT INTO omni_tenant_workspaces (
        tenant_id, workspace_id, display_name, owner_actor_id, state,
        lifecycle_revision, created_by_actor_id, activated_by_actor_id,
        created_at, activated_at, updated_at
      ) VALUES (
        ${tenantId}, ${workspaceId}, 'Template aliases', ${actorId}, 'active',
        1, ${actorId}, ${actorId},
        statement_timestamp(), statement_timestamp(), statement_timestamp()
      )
    `;
    await admin`
      INSERT INTO omni_tenant_workspace_memberships (
        tenant_id, workspace_id, subject_kind, subject_key,
        subject_actor_id, membership_generation, access_level, state,
        lifecycle_revision, created_by_actor_id, activated_by_actor_id,
        created_at, activated_at, updated_at
      ) VALUES (
        ${tenantId}, ${workspaceId}, 'user', ${actorId}, ${actorId}, 1,
        'manager', 'active', 1, ${actorId}, ${actorId},
        statement_timestamp(), statement_timestamp(), statement_timestamp()
      )
    `;

    // Two pooled connections let concurrent publishes contend for the
    // workspace alias lock instead of queueing for a single connection.
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2");
    vi.resetModules();
    const client = await import("@/lib/db/client");
    const { publishWorkspaceTemplate } = await import(
      "@/lib/workspace-templates/store"
    );
    try {
      const publish = (
        idempotencyKey: string,
        name: string,
        aliases: string[] | null,
        templateId?: string,
      ) => client.runWithDatabaseActorScope(tenantId, [actorId], () =>
        publishWorkspaceTemplate({
          authority: {
            tenantId,
            workspaceId,
            canonicalActorId: actorId,
            idempotencyKey,
            executionScope: createExecutionScope({
              tenantId,
              initiatingActorId: actorId,
              executingPrincipalType: "user",
              executingPrincipalId: actorId,
              workspaceId,
              correlationId: `correlation:${idempotencyKey}`,
              purpose: "workspace.template.publish",
            }),
          },
          definition: {
            ...(templateId ? { templateId } : {}),
            name,
            description: "",
            project: {
              title: name,
              objective: "Verify the release.",
              status: "draft",
              tasks: [],
            },
            playbook: aliases && {
              aliases,
              mode: "orchestrate",
              toolBindings: [{ toolId: "app.projects.list", input: { limit: 5 } }],
              acceptanceCriteria: ["Focused checks pass."],
            },
          },
        }));

      await publish("template-aliases:notes", "Notes", null);
      const release = await publish(
        "template-aliases:release:v1",
        "Release",
        ["Run release", "Ship it"],
      );
      const revised = await publish(
        "template-aliases:release:v2",
        "Release",
        ["Run release"],
        release.templateId,
      );
      const hotfix = await publish(
        "template-aliases:hotfix",
        "Hotfix",
        ["Ship  it!"],
      );
      await expect(publish(
        "template-aliases:rollback",
        "Rollback",
        ["Rollback", "RUN release"],
      )).rejects.toMatchObject({
        code: "workspace_template_conflict",
        message: expect.stringContaining('procedure alias "run release"'),
      });
      const race = await Promise.allSettled([
        publish("template-aliases:race:a", "Race A", ["Race"]),
        publish("template-aliases:race:b", "Race B", ["race!"]),
      ]);
      const [persisted] = await admin`
        SELECT count(*)::int AS versions,
          count(DISTINCT template_id)::int AS templates,
          count(*) FILTER (WHERE name = 'Rollback')::int AS rollbacks
        FROM omni_workspace_template_versions
        WHERE tenant_id = ${tenantId}
      `;

      expect(revised).toMatchObject({
        templateId: release.templateId,
        version: 2,
      });
      expect(hotfix.playbook?.aliases).toEqual(["ship it"]);
      expect(race.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(race.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "workspace_template_conflict" },
      });
      expect(persisted).toEqual({ versions: 5, templates: 4, rollbacks: 0 });
    } finally {
      await client.closeDatabaseClient();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  test.skipIf(databaseTlsDisabled)(
    "forgets a shared agent copy and everything derived from it across visibilities",
    async () => {
      const tenantId = "tenant_forget_lineage";
      const userId = "00000000-0000-4000-8000-000000000081";
      const actorId = `actor:${userId}`;
      await admin`
        INSERT INTO omni_auth_tenants (id, name, slug)
        VALUES (${tenantId}, 'Forget lineage', 'forget-lineage')
      `;
      await admin`
        INSERT INTO omni_auth_users (id, email, password_hash)
        VALUES (${userId}, 'forget-lineage@example.test', 'test-only')
      `;
      await admin`
        INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
        VALUES ('membership:forget-lineage', ${tenantId}, ${userId}, 'admin')
      `;
      await admin.unsafe(`
        CREATE ROLE ${lineageRuntimeRole}
        LOGIN PASSWORD 'integration-only'
        NOSUPERUSER NOBYPASSRLS
      `);
      await admin.unsafe(`
        CREATE ROLE ${lineageMaintenanceRole}
        LOGIN PASSWORD 'integration-only'
        NOSUPERUSER BYPASSRLS
      `);
      for (const role of [lineageRuntimeRole, lineageMaintenanceRole]) {
        await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
        await admin.unsafe(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
        );
        await admin.unsafe(
          `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
        );
        // Migrations grant the production serving roles their functions,
        // including the lineage closure, because those roles exist before the
        // schema. These roles are created after it.
        await admin.unsafe(
          `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`,
        );
      }

      vi.stubEnv("DATABASE_URL", databaseUrlForRole(databaseUrl!, lineageRuntimeRole));
      vi.stubEnv(
        "OMNIAGENT_MAINTENANCE_DATABASE_URL",
        databaseUrlForRole(databaseUrl!, lineageMaintenanceRole),
      );
      vi.stubEnv("NODE_ENV", "production");
      vi.resetModules();
      const client = await import("@/lib/db/client");
      try {
        const store = await import("@/lib/memory/store");
        const { processPendingMemoryDeletionScrubs } = await import(
          "@/lib/memory/deletion-scrub"
        );
        const binding = await import("@/lib/memory/access-binding");
        const { databaseMemoryAccessScopeFromExecutionScope } = await import(
          "@/lib/db/memory-access-scope"
        );
        const asActor = <T,>(operation: () => Promise<T>) =>
          client.runWithDatabaseActorScope(tenantId, [actorId], operation);
        const userScope = createExecutionScope({
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          correlationId: "correlation:forget-lineage",
          purpose: "memory.forget",
        });
        const agentScope = createExecutionScope({
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "agent",
          executingPrincipalId: "agent-alpha",
          correlationId: "correlation:forget-lineage:agent",
          purpose: "memory.share",
        });
        const userForgetScope = databaseMemoryAccessScopeFromExecutionScope(
          userScope,
          {
            purposeId: binding.MEMORY_PURPOSE_IDS.forget,
            auditPurpose: "integration forget",
          },
        );
        const memoryRow = async (id: string) => {
          const [row] = await admin`
            SELECT claim_status, title, content, evidence_refs
            FROM omni_memories
            WHERE tenant_id = ${tenantId} AND id = ${id}
          `;
          return row;
        };
        const shell = {
          claim_status: "forgotten",
          title: "[forgotten]",
          content: "",
          evidence_refs: [],
        };

        // An agent shares its private memory, which copies it to the target
        // agent. Only the target agent's scope can read the copy.
        await asActor(() => store.saveMemories([{
          id: "lineage-source",
          tenantId,
          type: "episode",
          tier: "episodic",
          title: "Agent source",
          content: "agent-alpha private content",
          scope: "user",
          source: "effect-receipt",
          claimStatus: "active",
          assertedBy: "system",
          accessBinding: binding.buildAgentPrivateMemoryAccessBindingV1({
            tenantId,
            ownerActorId: actorId,
            ownerAgentId: "agent-alpha",
            originPurpose: "memory.verified_effect",
          }),
          databaseAccessScope: databaseMemoryAccessScopeFromExecutionScope(
            agentScope,
            {
              purposeId: binding.MEMORY_PURPOSE_IDS.formation,
              auditPurpose: "integration share",
            },
          ),
          executionScope: agentScope,
        }]));
        const shared = await asActor(() => store.shareAgentPrivateMemory({
          tenantId,
          sourceMemoryId: "lineage-source",
          targetAgentId: "agent-beta",
          idempotencyKey: "forget-lineage:share",
          sharedAt: new Date().toISOString(),
          executionScope: agentScope,
        }));
        const copyId = shared.memory.id;
        await admin`
          INSERT INTO omni_memories (id, tenant_id, type, title, content, scope, source)
          VALUES (
            'lineage-keep', ${tenantId}, 'fact', 'Kept', 'unrelated content',
            'workspace', 'manual'
          )
        `;
        // Literal JSON: a string bound to a jsonb parameter is encoded again.
        await admin.unsafe(`
          INSERT INTO omni_retrieval_traces (id, tenant_id, query, results)
          VALUES (
            'lineage-trace', '${tenantId}', 'copy query',
            '[{"kind":"memory","id":"${copyId}"}]'::jsonb
          )
        `);
        // A trace recorded before memory_ids was materialized cites the copy
        // only in its results.
        await admin.begin(async (transaction) => {
          await transaction`SET LOCAL session_replication_role = replica`;
          await transaction.unsafe(`
            INSERT INTO omni_retrieval_traces (id, tenant_id, query, results, memory_ids)
            VALUES (
              'lineage-trace-historical', '${tenantId}', 'historical query',
              '[{"kind":"memory","id":"${copyId}"}]'::jsonb, '{}'::text[]
            )
          `);
        });
        await admin`
          INSERT INTO omni_memory_graph_nodes (id, tenant_id, kind, label, slug, memory_ids)
          VALUES
            ('lineage-node-copy', ${tenantId}, 'fact', 'Copy', 'lineage-node-copy',
              ARRAY[${copyId}]::text[]),
            ('lineage-node-keep', ${tenantId}, 'fact', 'Kept', 'lineage-node-keep',
              ARRAY['lineage-keep']::text[])
        `;
        await admin`
          INSERT INTO omni_memory_graph_nodes (id, tenant_id, kind, label, slug, trace_ids)
          VALUES (
            'lineage-node-trace', ${tenantId}, 'fact', 'Trace', 'lineage-node-trace',
            ARRAY['lineage-trace']::text[]
          )
        `;
        await admin`
          INSERT INTO omni_memory_graph_edges (
            id, tenant_id, source_node_id, target_node_id, relation
          ) VALUES (
            'lineage-edge', ${tenantId}, 'lineage-node-copy', 'lineage-node-keep',
            'related_to'
          )
        `;

        // Agents cannot forget; the owner forgets under a validated scope.
        await expect(asActor(() => store.forgetMemoryWithReceipt("lineage-source", {
          tenantId,
          executionScope: agentScope,
          accessScope: databaseMemoryAccessScopeFromExecutionScope(agentScope, {
            purposeId: binding.MEMORY_PURPOSE_IDS.forget,
            auditPurpose: "integration forget",
          }),
        }))).resolves.toBeNull();
        const preview = await asActor(() => store.previewMemoryDeletion("lineage-source", {
          tenantId,
          accessScope: userForgetScope,
        }));
        expect(preview).toMatchObject({
          state: "ready",
          descendantMemories: [{ id: copyId }],
          impact: {
            descendantMemoryCount: 1,
            retrievalTraceCount: 2,
            graphNodeCount: 2,
            graphEdgeCount: 1,
          },
        });
        const forgotten = await asActor(() => store.forgetMemoryWithReceipt("lineage-source", {
          tenantId,
          executionScope: userScope,
          accessScope: userForgetScope,
          expectedDescendantManifestSha256: preview?.expectedReceiptManifestSha256,
        }));
        expect(forgotten).toMatchObject({
          deletionDisposition: "committed",
          receipt: { memoryId: "lineage-source", descendantMemoryIds: [copyId] },
        });
        const [receipt] = await admin`
          SELECT descendant_memory_ids, retrieval_trace_ids, graph_node_ids, graph_edge_ids
          FROM omni_memory_deletion_receipts
          WHERE tenant_id = ${tenantId} AND memory_id = 'lineage-source'
        `;
        expect(receipt).toEqual({
          descendant_memory_ids: [copyId],
          retrieval_trace_ids: ["lineage-trace", "lineage-trace-historical"],
          graph_node_ids: ["lineage-node-copy", "lineage-node-trace"],
          graph_edge_ids: ["lineage-edge"],
        });
        expect(await memoryRow("lineage-source")).toEqual(shell);
        expect(await memoryRow(copyId)).toEqual(shell);
        expect(await memoryRow("lineage-keep")).toMatchObject({
          claim_status: "active",
          content: "unrelated content",
        });
        expect(await admin`
          SELECT grant_id FROM omni_agent_memory_grants WHERE tenant_id = ${tenantId}
        `).toEqual([]);
        expect(await admin`
          SELECT id FROM omni_retrieval_traces WHERE tenant_id = ${tenantId}
        `).toEqual([]);
        expect(await admin`
          SELECT id FROM omni_memory_graph_nodes WHERE tenant_id = ${tenantId}
        `).toEqual([{ id: "lineage-node-keep" }]);
        expect(await admin`
          SELECT id FROM omni_memory_graph_edges WHERE tenant_id = ${tenantId}
        `).toEqual([]);

        // A legacy read cannot see a private memory that cites a legacy root,
        // yet forgetting the root still lists and scrubs it.
        const userBinding = binding.buildUserPrivateMemoryAccessBindingV1({
          tenantId,
          ownerActorId: actorId,
          originPurpose: "app.memory.write",
        });
        await admin`
          INSERT INTO omni_memories (id, tenant_id, type, title, content, scope, source)
          VALUES (
            'lineage-legacy-root', ${tenantId}, 'fact', 'Legacy root',
            'legacy root content', 'workspace', 'legacy'
          )
        `;
        await admin`
          INSERT INTO omni_memories (
            id, tenant_id, type, title, content, scope, source, evidence_refs,
            access_contract_version, access_state, owner_actor_id, owner_agent_id,
            workspace_id, project_id, mission_id, visibility, sensitivity,
            origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at
          ) VALUES (
            'lineage-private-copy', ${tenantId}, 'fact', 'Private copy',
            'private copy of the legacy root', 'user', 'manual',
            ARRAY['memory:lineage-legacy-root'],
            1, 'scope_bound', ${actorId}, NULL, NULL, NULL, NULL, 'user_private',
            ${userBinding.sensitivity}, ${userBinding.originPurpose},
            ${[...userBinding.allowedPurposeIds]}, ${userBinding.accessScopeSha256},
            ${userBinding.accessBoundAt}
          )
        `;
        const legacyPreview = await asActor(() =>
          store.previewMemoryDeletion("lineage-legacy-root", { tenantId }));
        expect(legacyPreview?.descendantMemories).toEqual([{
          id: "lineage-private-copy",
          title: "[restricted descendant]",
          type: "knowledge",
        }]);
        const legacyForgotten = await asActor(() =>
          store.forgetMemoryWithReceipt("lineage-legacy-root", {
            tenantId,
            executionScope: userScope,
          }));
        expect(legacyForgotten?.receipt?.descendantMemoryIds).toEqual([
          "lineage-private-copy",
        ]);
        expect(await memoryRow("lineage-private-copy")).toEqual(shell);

        // A receipt written before forget scrubbed its descendants leaves them
        // to the worker, which stamps each shell with the receipt's exact time.
        await admin`
          INSERT INTO omni_memories (id, tenant_id, type, title, content, scope, source)
          VALUES (
            'lineage-legacy-forgotten', ${tenantId}, 'fact', 'Legacy forgotten',
            'legacy forgotten content', 'workspace', 'legacy'
          )
        `;
        await admin`
          INSERT INTO omni_memories (
            id, tenant_id, type, title, content, scope, source, evidence_refs
          ) VALUES (
            'lineage-legacy-copy', ${tenantId}, 'fact', 'Legacy copy',
            'legacy copy content', 'workspace', 'legacy',
            ARRAY['memory:lineage-legacy-forgotten']
          )
        `;
        await admin.begin(async (transaction) => {
          await transaction`SET LOCAL session_replication_role = replica`;
          // The time is made in SQL with microseconds, which a bound timestamp
          // would lose and some clocks, PGlite's among them, never produce.
          await transaction`
            UPDATE omni_memories
            SET title = '[forgotten]', content = '', tags = '{}'::text[],
              source = '[forgotten]', embedding = NULL, evidence_refs = '{}'::text[],
              supersedes_id = NULL, contradiction_of_id = NULL,
              claim_status = 'forgotten',
              forgotten_at = date_trunc('second', NOW()) - INTERVAL '2 days'
                + INTERVAL '123456 microseconds',
              updated_at = NOW() - INTERVAL '2 days'
            WHERE tenant_id = ${tenantId} AND id = 'lineage-legacy-forgotten'
          `;
          await transaction`
            INSERT INTO omni_memory_deletion_receipts (
              id, schema_version, contract_kind, tenant_id, memory_id,
              attribution_kind, delete_reason,
              descendant_memory_ids, retrieval_trace_ids, graph_node_ids,
              graph_edge_ids, descendant_memory_count, retrieval_trace_count,
              graph_node_count, graph_edge_count, forgotten_at, created_at
            )
            SELECT
              'legacy:' || md5(${tenantId} || ':lineage-legacy-forgotten'), 1,
              'memory_deletion', ${tenantId}, 'lineage-legacy-forgotten',
              'legacy_unattributed', 'legacy_unattributed',
              ARRAY['lineage-legacy-copy']::text[], '{}'::text[], '{}'::text[],
              '{}'::text[], 1, 0, 0, 0,
              memory.forgotten_at, memory.forgotten_at
            FROM omni_memories memory
            WHERE memory.tenant_id = ${tenantId}
              AND memory.id = 'lineage-legacy-forgotten'
          `;
        });
        const [legacyReceipt] = await admin`
          SELECT id
          FROM omni_memory_deletion_receipts
          WHERE tenant_id = ${tenantId} AND memory_id = 'lineage-legacy-forgotten'
        `;
        const scrubbed = await processPendingMemoryDeletionScrubs();
        expect(scrubbed.completedReceiptIds).toContain(legacyReceipt.id);
        expect(await memoryRow("lineage-legacy-copy")).toEqual(shell);
        expect(await admin`
          SELECT memory.forgotten_at = receipt.forgotten_at AS exact
          FROM omni_memories memory
          JOIN omni_memory_deletion_receipts receipt
            ON receipt.tenant_id = memory.tenant_id
          WHERE memory.tenant_id = ${tenantId}
            AND memory.id = 'lineage-legacy-copy'
            AND receipt.id = ${legacyReceipt.id}
        `).toEqual([{ exact: true }]);
        const repeated = await processPendingMemoryDeletionScrubs();
        expect(repeated.completedReceiptIds).not.toContain(legacyReceipt.id);
      } finally {
        await client.closeDatabaseClient();
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    },
  );

  test("fences tool effects to active agent runs and withdraws a canceled run's approvals", async () => {
    const tenantId = "run_fence_tenant";
    const otherTenantId = "run_fence_other_tenant";
    const actorId = "run_fence_actor";
    const withdrawnReason =
      "Withdrawn: the agent run was canceled before this action was approved.";
    const inTenant = <T,>(operation: () => Promise<T>, tenant = tenantId) =>
      runWithDatabaseTenantScope(tenant, operation);
    const startRun = (id: string, tenant = tenantId) =>
      inTenant(() => createAgentRun({
        id,
        tenantId: tenant,
        actorId,
        mode: "orchestrate",
        prompt: "Fence integration",
        messages: [{ role: "user", content: "Fence integration" }],
      }), tenant);
    // A direct status write stands in for a cancel or finish recorded elsewhere.
    const writeRunStatus = (id: string, status: string) => admin`
      UPDATE omni_agent_runs SET status = ${status}
      WHERE tenant_id = ${tenantId} AND id = ${id}
    `;
    const toolInput = { url: "https://example.com/run-fence", method: "POST" };
    const pendingRecord = (id: string, runId?: string) => {
      const base = {
        ...createToolExecutionRecord({
          tenantId,
          actorId,
          toolId: "http.request",
          toolName: "HTTP request",
          riskLevel: 2,
          status: "approval_required",
          dryRun: false,
          approvalRequired: true,
          input: toolInput,
        }),
        id,
      };
      return {
        ...base,
        output: sealToolExecutionInput(
          toolInput,
          base,
          "run-fence-contract",
          runId ? { agentRunId: runId } : {},
        ),
      };
    };
    const claimRecord = (id: string) => ({
      ...createToolExecutionRecord({
        tenantId,
        actorId,
        toolId: "http.request",
        toolName: "HTTP request",
        riskLevel: 2,
        status: "executing",
        dryRun: false,
        approvalRequired: false,
        input: toolInput,
        output: {
          __executionClaim: {
            token: `${id}-token`,
            claimedAt: new Date().toISOString(),
          },
        },
      }),
      id,
    });
    const approve = (id: string) => inTenant(() => approveAndClaimToolExecution({
      id,
      tenantId,
      approvedBy: actorId,
      approvedRole: "admin",
      claimToken: `${id}-approval-token`,
      mutation: {
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          correlationId: `correlation:${id}-approval`,
          purpose: "tool.approval.decide",
        }),
        idempotencyKey: `${id}-approval`,
      },
    }));
    const withdrawnEvents = (ids: string[]) => admin`
      SELECT stream_id
      FROM omni_events
      WHERE tenant_id = ${tenantId}
        AND stream_id = ANY(${ids.map((id) => `tool_execution:${id}`)})
        AND type = 'tool.execution.upserted'
        AND payload->>'operation' = 'withdrawn'
      ORDER BY stream_id
    `;

    // The claiming transaction refuses a finished, canceled, deleted, or
    // foreign run before it writes anything.
    await startRun("run-fence-db-active");
    for (const status of ["completed", "failed", "canceled"]) {
      await startRun(`run-fence-db-${status}`);
      await writeRunStatus(`run-fence-db-${status}`, status);
    }
    await startRun("run-fence-db-foreign", otherTenantId);
    for (const [runId, runStatus] of [
      ["run-fence-db-completed", "completed"],
      ["run-fence-db-failed", "failed"],
      ["run-fence-db-canceled", "canceled"],
      ["run-fence-db-deleted", "missing"],
      ["run-fence-db-foreign", "missing"],
    ] as const) {
      await expect(inTenant(() => saveToolExecution(
        pendingRecord(`fence-save-${runId}`, runId),
        { activeAgentRun: { runId } },
      ))).rejects.toMatchObject({ code: "agent_run_not_active", runId, runStatus });
      await expect(inTenant(() => claimIdempotentToolExecution(
        claimRecord(`fence-claim-${runId}`),
        { idempotencyKey: `${runId}:call-1`, activeAgentRun: { runId } },
      ))).rejects.toMatchObject({ code: "agent_run_not_active", runId, runStatus });
    }
    expect(await admin`
      SELECT id FROM omni_tool_executions WHERE tenant_id = ${tenantId}
    `).toEqual([]);
    await expect(inTenant(() => saveToolExecution(
      pendingRecord("fence-save-active", "run-fence-db-active"),
      { activeAgentRun: { runId: "run-fence-db-active" } },
    ))).resolves.toMatchObject({ status: "approval_required" });
    await expect(inTenant(() => claimIdempotentToolExecution(
      claimRecord("fence-claim-active"),
      {
        idempotencyKey: "run-fence-db-active:call-1",
        activeAgentRun: { runId: "run-fence-db-active" },
      },
    ))).resolves.toMatchObject({ outcome: "claimed" });

    // Canceling withdraws the run's bound and legacy pending approvals, keeps
    // their stored input, and leaves every other record alone.
    await startRun("run-fence-db-cancel");
    await startRun("run-fence-db-sibling");
    const bound = await inTenant(() => saveToolExecution(
      pendingRecord("withdraw-db-bound", "run-fence-db-cancel"),
    ));
    const legacy = await inTenant(() => saveToolExecution(
      pendingRecord("withdraw-db-legacy"),
    ));
    const claimed = await inTenant(() => saveToolExecution(
      pendingRecord("withdraw-db-claimed", "run-fence-db-cancel"),
    ));
    await expect(approve(claimed.id)).resolves.toMatchObject({ outcome: "claimed" });
    const sibling = await inTenant(() => saveToolExecution(
      pendingRecord("withdraw-db-sibling", "run-fence-db-sibling"),
    ));
    const unbound = await inTenant(() => saveToolExecution(
      pendingRecord("withdraw-db-unbound"),
    ));
    const foreign = await inTenant(() => saveToolExecution({
      ...pendingRecord("withdraw-db-foreign", "run-fence-db-cancel"),
      tenantId: otherTenantId,
    }), otherTenantId);
    await admin`
      UPDATE omni_agent_runs
      SET status = 'waiting_approval',
        continuation = jsonb_build_object(
          'pendingToolCall',
          jsonb_build_object('executionId', ${legacy.id}::text)
        )
      WHERE tenant_id = ${tenantId} AND id = 'run-fence-db-cancel'
    `;
    const withdrawnIds = [bound.id, legacy.id].sort();
    const storedInputs = () => admin`
      SELECT id, input
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId} AND id = ANY(${withdrawnIds})
      ORDER BY id
    `;
    const inputsBefore = await storedInputs();

    await expect(inTenant(() => cancelAgentRun(
      "run-fence-db-cancel",
      "Stop this run.",
      { tenantId },
    ))).resolves.toBe(true);

    expect(await admin`
      SELECT id, status, approval_decision, approval_reason, reason, output,
        completed_at IS NOT NULL AS completed
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId} AND id = ANY(${withdrawnIds})
      ORDER BY id
    `).toEqual(withdrawnIds.map((id) => ({
      id,
      status: "rejected",
      approval_decision: "rejected",
      approval_reason: withdrawnReason,
      reason: withdrawnReason,
      output: null,
      completed: true,
    })));
    expect(await storedInputs()).toEqual(inputsBefore);
    expect(await withdrawnEvents(withdrawnIds)).toEqual(
      withdrawnIds.map((id) => ({ stream_id: `tool_execution:${id}` })),
    );
    expect(await admin`
      SELECT id, status
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId}
        AND id = ANY(${[claimed.id, sibling.id, unbound.id]})
      ORDER BY id
    `).toEqual([
      { id: claimed.id, status: "executing" },
      { id: sibling.id, status: "approval_required" },
      { id: unbound.id, status: "approval_required" },
    ]);
    expect(await admin`
      SELECT status
      FROM omni_tool_executions
      WHERE tenant_id = ${otherTenantId} AND id = ${foreign.id}
    `).toEqual([{ status: "approval_required" }]);
    await expect(approve(bound.id)).resolves.toMatchObject({ outcome: "conflict" });

    // A cancel that lands while the run's approved action executes leaves
    // that action's claim alone.
    await startRun("run-fence-db-cancel-resuming");
    await admin`
      UPDATE omni_agent_runs
      SET status = 'resuming',
        continuation = jsonb_build_object(
          'pendingToolCall',
          jsonb_build_object('executionId', ${claimed.id}::text)
        )
      WHERE tenant_id = ${tenantId} AND id = 'run-fence-db-cancel-resuming'
    `;
    await expect(inTenant(() => cancelAgentRun(
      "run-fence-db-cancel-resuming",
      "Stop this run.",
      { tenantId },
    ))).resolves.toBe(true);
    expect(await admin`
      SELECT status, output->'__executionClaim'->>'token' AS claim_token
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId} AND id = ${claimed.id}
    `).toEqual([
      { status: "executing", claim_token: `${claimed.id}-approval-token` },
    ]);

    // Approving an action of a run that was canceled without withdrawing it
    // withdraws the action instead, while a finished run's approval still
    // claims, as a council delegate's does after its parent completes.
    await startRun("run-fence-db-approve-canceled");
    await startRun("run-fence-db-approve-completed");
    const orphaned = await inTenant(() => saveToolExecution(
      pendingRecord("approve-db-canceled", "run-fence-db-approve-canceled"),
    ));
    const delegated = await inTenant(() => saveToolExecution(
      pendingRecord("approve-db-completed", "run-fence-db-approve-completed"),
    ));
    await writeRunStatus("run-fence-db-approve-canceled", "canceled");
    await writeRunStatus("run-fence-db-approve-completed", "completed");

    const refused = await approve(orphaned.id);

    expect(refused).toMatchObject({
      outcome: "conflict",
      record: {
        id: orphaned.id,
        status: "rejected",
        approvalDecision: "rejected",
        reason: withdrawnReason,
      },
    });
    expect(refused.record?.output).toBeUndefined();
    expect(await admin`
      SELECT status, output
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId} AND id = ${orphaned.id}
    `).toEqual([{ status: "rejected", output: null }]);
    expect(await withdrawnEvents([orphaned.id])).toEqual([
      { stream_id: `tool_execution:${orphaned.id}` },
    ]);
    await expect(approve(delegated.id)).resolves.toMatchObject({
      outcome: "claimed",
      record: { status: "executing" },
    });
  });

  test("leases a job by dedupe key only while no live lease holds it", async () => {
    const tenantId = "dedupe_lease_tenant";
    const otherTenantId = "dedupe_lease_other";
    const inTenant = <T,>(operation: () => Promise<T>, tenant = tenantId) =>
      runWithDatabaseTenantScope(tenant, operation);
    const leaseByKey = (
      dedupeKey: string,
      options: {
        tenant?: string;
        type?: "agent.resume" | "workflow.tick";
        owner?: string;
      } = {},
    ) => {
      const tenant = options.tenant ?? tenantId;
      return inTenant(() => leaseOperationJobByDedupeKey(dedupeKey, {
        tenantId: tenant,
        type: options.type ?? "agent.resume",
        owner: options.owner,
        leaseSeconds: 60,
      }), tenant);
    };
    const enqueue = (
      dedupeKey: string,
      options: { tenant?: string; runAt?: string; maxAttempts?: number } = {},
    ) => {
      const tenant = options.tenant ?? tenantId;
      return inTenant(() => enqueueOperationJob({
        tenantId: tenant,
        type: "agent.resume",
        dedupeKey,
        payload: {},
        runAt: options.runAt,
        maxAttempts: options.maxAttempts,
      }), tenant);
    };
    const jobRow = async (id: string) => {
      const [row] = await admin`
        SELECT status, attempt, lease_owner, last_error, completed_at
        FROM omni_operation_jobs
        WHERE id = ${id}
      `;
      return row;
    };

    // A job deferred into the future is claimed at once, and the same key in
    // another tenant is a different job.
    const pendingKey = getAgentResumeJobDedupeKey("dedupe-lease-db");
    const future = new Date(Date.now() + 600_000).toISOString();
    const pending = await enqueue(pendingKey, { runAt: future });
    const foreign = await enqueue(pendingKey, {
      tenant: otherTenantId,
      runAt: future,
    });
    expect(await inTenant(() => leaseOperationJobs({
      tenantId,
      type: "agent.resume",
    }))).toEqual([]);

    await expect(leaseByKey(pendingKey, { owner: "request:approval" }))
      .resolves.toMatchObject({
        outcome: "leased",
        job: {
          id: pending.id,
          tenantId,
          status: "running",
          attempt: 1,
          leaseOwner: "request:approval",
        },
      });
    expect(await admin`
      SELECT lease_expires_at > NOW() + INTERVAL '50 seconds' AS long_enough,
        lease_expires_at <= NOW() + INTERVAL '60 seconds' AS bounded
      FROM omni_operation_jobs
      WHERE id = ${pending.id}
    `).toEqual([{ long_enough: true, bounded: true }]);
    expect(await jobRow(foreign.id)).toMatchObject({
      status: "queued",
      attempt: 0,
      lease_owner: null,
    });
    await expect(leaseByKey(pendingKey, { owner: "request:second" }))
      .resolves.toEqual({ outcome: "busy" });
    await expect(leaseByKey(pendingKey, { type: "workflow.tick" }))
      .resolves.toEqual({ outcome: "absent" });
    await expect(leaseByKey(pendingKey, {
      tenant: otherTenantId,
      owner: "request:foreign",
    })).resolves.toMatchObject({
      outcome: "leased",
      job: { id: foreign.id, tenantId: otherTenantId },
    });
    expect(await jobRow(pending.id)).toMatchObject({
      status: "running",
      attempt: 1,
      lease_owner: "request:approval",
    });

    // A legacy row that stored its key without a tenant prefix is still
    // another tenant's job.
    await admin`
      INSERT INTO omni_operation_jobs (
        id, tenant_id, type, status, payload, dedupe_key, attempt, max_attempts
      )
      VALUES (
        'dedupe-lease-legacy', ${otherTenantId}, 'agent.resume', 'queued',
        '{}'::jsonb, 'dedupe-lease-legacy-key', 0, 3
      )
    `;
    await expect(leaseByKey("dedupe-lease-legacy-key", { tenant: "default" }))
      .resolves.toEqual({ outcome: "absent" });
    expect(await jobRow("dedupe-lease-legacy")).toMatchObject({
      status: "queued",
      attempt: 0,
    });

    // A failed job is leased again with its error cleared.
    const failedKey = "dedupe-lease-failed";
    const failed = await enqueue(failedKey, { maxAttempts: 1 });
    const [failedLease] = await inTenant(() => leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      dedupeKey: failedKey,
    }));
    await inTenant(() => failOperationJob(
      failed.id,
      "boom",
      failedLease.leaseOwner,
      tenantId,
    ));
    expect(await jobRow(failed.id)).toMatchObject({
      status: "failed",
      last_error: "boom",
    });
    await expect(leaseByKey(failedKey, { owner: "request:failed" }))
      .resolves.toMatchObject({
        outcome: "leased",
        job: { id: failed.id, status: "running", attempt: 2 },
      });
    expect(await jobRow(failed.id)).toMatchObject({
      status: "running",
      attempt: 2,
      lease_owner: "request:failed",
      last_error: null,
      completed_at: null,
    });

    // A running job is taken over only once its lease has lapsed.
    const expiredKey = "dedupe-lease-expired";
    const expired = await enqueue(expiredKey);
    await inTenant(() => leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      dedupeKey: expiredKey,
      owner: "worker:dead",
      leaseSeconds: 10,
    }));
    await expect(leaseByKey(expiredKey)).resolves.toEqual({ outcome: "busy" });
    await admin`
      UPDATE omni_operation_jobs
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE id = ${expired.id}
    `;
    await expect(leaseByKey(expiredKey, { owner: "request:expired" }))
      .resolves.toMatchObject({
        outcome: "leased",
        job: { id: expired.id, attempt: 2, leaseOwner: "request:expired" },
      });
    await admin`
      UPDATE omni_operation_jobs
      SET lease_expires_at = NULL
      WHERE id = ${expired.id}
    `;
    await expect(leaseByKey(expiredKey, { owner: "request:unleased" }))
      .resolves.toMatchObject({
        outcome: "leased",
        job: { id: expired.id, attempt: 3, leaseOwner: "request:unleased" },
      });

    // Finished, canceled, and unknown jobs are absent, and so is a waiting
    // job of another type.
    await inTenant(() => completeOperationJob(
      pending.id,
      "request:approval",
      tenantId,
    ));
    await expect(leaseByKey(pendingKey)).resolves.toEqual({ outcome: "absent" });
    const canceledKey = "dedupe-lease-canceled";
    const canceled = await enqueue(canceledKey);
    await expect(leaseByKey(canceledKey, { type: "workflow.tick" }))
      .resolves.toEqual({ outcome: "absent" });
    expect(await jobRow(canceled.id)).toMatchObject({
      status: "queued",
      attempt: 0,
      lease_owner: null,
    });
    await inTenant(() => cancelOperationJobByDedupeKey(
      canceledKey,
      "gone",
      { tenantId },
    ));
    await expect(leaseByKey(canceledKey)).resolves.toEqual({ outcome: "absent" });
    expect(await jobRow(canceled.id)).toMatchObject({ status: "canceled" });
    await expect(leaseByKey("dedupe-lease-never-enqueued"))
      .resolves.toEqual({ outcome: "absent" });
  });

  test("keeps request-derived run, thread, and turn identities single-use", async () => {
    const tenantId = "request_identity_tenant";
    const otherTenantId = "request_identity_other";
    const inTenant = <T,>(operation: () => Promise<T>, tenant = tenantId) =>
      runWithDatabaseTenantScope(tenant, operation);
    const threadId = "6d2f9a41-7c3b-8e15-a9d4-2b8c6e0f1a73";
    const turnId = "8a1c5e27-4f90-8b36-9c7e-5d3a1f2b6c84";
    const runId = "2e7b4c19-9a35-8d62-b1f8-4c6a2e9d7b05";
    const newThread = (overrides: { tenantId?: string; actorId?: string } = {}) =>
      createThread({
        id: threadId,
        tenantId: overrides.tenantId ?? tenantId,
        actorId: overrides.actorId ?? "request-identity-owner",
        title: "Plan my week",
        mode: "orchestrate",
      });

    const thread = await inTenant(() => newThread());
    expect(thread.id).toBe(threadId);
    await expect(inTenant(() => newThread())).resolves.toMatchObject({
      id: threadId,
      actorId: "request-identity-owner",
      createdAt: thread.createdAt,
    });
    await expect(inTenant(() => newThread({ actorId: "request-identity-other" })))
      .rejects.toThrow("Thread identity is already bound to a different conversation.");
    // The id is global, so another tenant can neither reuse nor see it.
    await expect(inTenant(
      () => newThread({ tenantId: otherTenantId }),
      otherTenantId,
    )).rejects.toThrow("Thread identity is already bound to a different conversation.");
    await expect(inTenant(() => getThread(threadId, { tenantId })))
      .resolves.toMatchObject({ actorId: "request-identity-owner" });
    const [threadCount] = await admin`
      SELECT count(*)::int AS count FROM omni_threads WHERE id = ${threadId}
    `;
    expect(threadCount.count).toBe(1);

    const appendTurn = (
      content: string,
      options: { tenant?: string; threadId?: string } = {},
    ) => inTenant(() => appendThreadTurn({
      id: turnId,
      tenantId: options.tenant ?? tenantId,
      threadId: options.threadId ?? threadId,
      role: "user",
      content,
    }), options.tenant ?? tenantId);
    const turn = await appendTurn("Plan my week");
    expect(turn.id).toBe(turnId);
    await expect(appendTurn("Plan my week")).resolves.toMatchObject({
      id: turnId,
      content: "Plan my week",
      createdAt: turn.createdAt,
    });
    await expect(appendTurn("Plan my month"))
      .rejects.toThrow("Thread turn identity is already bound to a different message.");
    const foreignThread = await inTenant(() => createThread({
      tenantId: otherTenantId,
      actorId: "request-identity-owner",
      title: "Other tenant",
      mode: "orchestrate",
    }), otherTenantId);
    await expect(appendTurn("Plan my week", {
      tenant: otherTenantId,
      threadId: foreignThread.id,
    })).rejects.toThrow("Thread turn identity is already bound to a different message.");
    await expect(inTenant(() => listThreadTurns(threadId, { tenantId })))
      .resolves.toMatchObject([{ id: turnId, content: "Plan my week" }]);
    await expect(inTenant(
      () => listThreadTurns(foreignThread.id, { tenantId: otherTenantId }),
      otherTenantId,
    )).resolves.toEqual([]);

    const newRun = () => inTenant(() => createAgentRun({
      id: runId,
      tenantId,
      actorId: "request-identity-owner",
      threadId,
      mode: "orchestrate",
      prompt: "Plan my week",
      messages: [{ role: "user", content: "Plan my week" }],
      agentId: "atlas",
    }));
    await newRun();
    await inTenant(() => cancelAgentRun(runId, undefined, { tenantId }));
    await expect(newRun()).rejects.toBeInstanceOf(AgentRunAlreadyExistsError);
    await expect(inTenant(() => getAgentRun(runId, { tenantId })))
      .resolves.toMatchObject({ id: runId, status: "canceled" });
    const [runCount] = await admin`
      SELECT count(*)::int AS count FROM omni_agent_runs WHERE id = ${runId}
    `;
    expect(runCount.count).toBe(1);
  });

  test("positions each run event on its stream and lists a run's events after one", async () => {
    const tenantId = "run_event_tail_tenant";
    const otherTenantId = "run_event_tail_other";
    const inTenant = <T,>(operation: () => Promise<T>, tenant = tenantId) =>
      runWithDatabaseTenantScope(tenant, operation);
    const newRun = () => inTenant(() => createAgentRun({
      tenantId,
      actorId: "run-event-tail-owner",
      mode: "orchestrate",
      prompt: "Summarize my week",
      messages: [{ role: "user", content: "Summarize my week" }],
      agentId: "atlas",
    }));
    const run = await newRun();
    const sibling = await newRun();
    const append = (runId: string, label: string) =>
      inTenant(() => appendRunEvent(runId, { type: "status", label }, { tenantId }));

    const planning = { type: "status" as const, label: "Planning" };
    const first = await inTenant(() => appendRunEvent(run.id, planning, { tenantId }));
    await append(sibling.id, "Sibling step");
    const second = await append(run.id, "Checking sources");
    const delta = await inTenant(() =>
      appendRunEvent(run.id, { type: "delta", text: "Partial" }, { tenantId }));
    const third = await append(run.id, "Drafting");

    expect(first.seq).toEqual(expect.any(Number));
    expect(second.seq).toBeGreaterThan(first.seq!);
    expect(third.seq).toBeGreaterThan(second.seq!);
    expect(runEventCursor(planning)).toBe(first.seq);
    expect(delta.seq).toBeUndefined();
    // Each record shares its domain event's id, which carries its position.
    const positions = await admin`
      SELECT event.id, event.seq
      FROM omni_events event
      JOIN omni_agent_events record ON record.id = event.id
      WHERE event.stream_id = ${`run:${run.id}`}
      ORDER BY event.seq ASC
    `;
    expect(positions.map((row) => [row.id, Number(row.seq)])).toEqual(
      [first, second, third].map((record) => [record.id, record.seq]),
    );

    const list = (
      options: { afterSeq?: number; limit?: number } = {},
      tenant = tenantId,
    ) => inTenant(
      () => listAgentRunEventsAfter(run.id, { tenantId: tenant, ...options }),
      tenant,
    );
    const listed = await list();
    expect(listed).toEqual([first, second, third]);
    expect(listed[1]).toMatchObject({
      tenantId,
      runId: run.id,
      type: "status",
      payload: { type: "status", label: "Checking sources" },
    });
    await expect(list({ afterSeq: first.seq })).resolves.toEqual([second, third]);
    await expect(list({ afterSeq: first.seq, limit: 1 })).resolves.toEqual([second]);
    await expect(list({ afterSeq: third.seq })).resolves.toEqual([]);
    // The tenant predicate holds even where row security is not in force.
    await expect(list({}, otherTenantId)).resolves.toEqual([]);

    // A step recorded inside a run transition is positioned the same way.
    await admin`
      UPDATE omni_agent_runs
      SET status = 'waiting_approval', continuation = '{}'::jsonb
      WHERE tenant_id = ${tenantId} AND id = ${run.id}
    `;
    await expect(inTenant(() => markAgentRunResuming(run.id, { tenantId })))
      .resolves.toBe(true);
    const resumed = await list({ afterSeq: third.seq });
    expect(resumed).toEqual([{
      id: expect.any(String),
      tenantId,
      runId: run.id,
      type: "status",
      payload: expect.objectContaining({
        type: "status",
        label: "resuming after approval",
      }),
      createdAt: expect.any(String),
      seq: expect.any(Number),
    }]);
    expect(resumed[0].seq).toBeGreaterThan(third.seq!);
  });

  test("lists the owners with due schedules across tenants in database time", async () => {
    const tenantA = "schedule_due_a";
    const tenantB = "schedule_due_b";
    const userId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const actorFor = (n: number) => `actor:${userId(n)}`;
    for (let n = 93; n <= 101; n += 1) {
      await admin`
        INSERT INTO omni_auth_users (id, email, password_hash)
        VALUES (${userId(n)}, ${`schedule-due-${n}@example.test`}, 'test-only')
      `;
    }
    const create = (tenantId: string, n: number, key: string) =>
      runWithDatabaseTenantScope(tenantId, () => createWorkflowTrigger(
        scheduleTriggerInput({ tenantId, actorId: actorFor(n), key }),
      ));
    const [{ base }] = await admin`
      SELECT date_trunc('second', clock_timestamp()) AS base
    `;
    // Cursors are offsets from one database instant. A cursor left alone stays
    // at the schedule's first run, years ahead.
    const due = (triggerId: string, next: string, shadow = "1 day") => admin`
      UPDATE omni_workflow_triggers
      SET next_due_at = ${base}::timestamptz + ${next}::interval,
          shadow_next_due_at = ${base}::timestamptz + ${shadow}::interval
      WHERE id = ${triggerId}
    `;
    const occurrence = (
      triggerId: string,
      occurrenceId: string,
      occurrenceStatus: "claimed" | "enqueued",
      offset: string,
    ) => admin`
      INSERT INTO omni_workflow_schedule_occurrences (
        id, tenant_id, owner_actor_id, trigger_id, occurrence_kind, status,
        scheduled_for, evaluated_through, outcome, occurrences_consumed,
        occurrence_count, configuration_sha256, agent_identity_pin_sha256,
        policy_pin_sha256, procedure_snapshot_sha256, reviewed_snapshot_sha256,
        occurrence_budget_sha256, authority_sha256, workflow_run_id, queue_job_id
      )
      SELECT
        ${occurrenceId}::text, tenant_id, owner_actor_id, id, 'scheduled',
        ${occurrenceStatus}::text,
        ${base}::timestamptz + ${offset}::interval,
        ${base}::timestamptz + ${offset}::interval,
        'due', 1, 1, schedule_config_sha256, agent_identity_pin_sha256,
        policy_pin_sha256, procedure_snapshot_sha256, reviewed_snapshot_sha256,
        occurrence_budget_sha256, repeat('a', 64),
        ${occurrenceStatus === "enqueued" ? `workflow-run:${occurrenceId}` : null}::text,
        ${occurrenceStatus === "enqueued" ? `job:${occurrenceId}` : null}::text
      FROM omni_workflow_triggers
      WHERE id = ${triggerId}
    `;

    const earliest = await create(tenantA, 93, "schedule-due-earliest");
    const later = await create(tenantA, 93, "schedule-due-later");
    const shadowDue = await create(tenantB, 94, "schedule-due-shadow");
    const waiting = await create(tenantA, 95, "schedule-due-waiting");
    const hourLate = await create(tenantA, 96, "schedule-due-hour");
    const paused = await create(tenantA, 97, "schedule-due-paused");
    const circuitOpen = await create(tenantA, 98, "schedule-due-open");
    const early = await create(tenantA, 99, "schedule-due-early");
    const enqueued = await create(tenantA, 100, "schedule-due-enqueued");
    const shadowEarly = await create(tenantA, 101, "schedule-due-shadow-early");
    await due(earliest.id, "-2 hours");
    await due(later.id, "-10 minutes");
    await due(shadowDue.id, "1 day", "-2 hours");
    await occurrence(waiting.id, "schedule-due-waiting-run", "claimed", "-1 hour");
    await due(hourLate.id, "-1 hour");
    // Each of these would be listed but for the one condition it breaks.
    await due(paused.id, "-3 hours");
    await admin`UPDATE omni_workflow_triggers SET status = 'paused' WHERE id = ${paused.id}`;
    await due(circuitOpen.id, "-3 hours");
    await admin`
      UPDATE omni_workflow_triggers
      SET circuit_state = 'open', circuit_opened_at = ${base}::timestamptz
      WHERE id = ${circuitOpen.id}
    `;
    await due(early.id, "10 minutes");
    await occurrence(enqueued.id, "schedule-due-enqueued-run", "enqueued", "-3 hours");
    await due(shadowEarly.id, "1 day", "10 minutes");

    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      // An application clock an hour ahead would find the early schedules due.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      const listed = await listDueWorkflowScheduleOwners();
      // Oldest due work first; equal due times fall back to tenant, then owner.
      expect(listed.owners).toEqual([
        { tenantId: tenantA, actorId: actorFor(93) },
        { tenantId: tenantB, actorId: actorFor(94) },
        { tenantId: tenantA, actorId: actorFor(95) },
        { tenantId: tenantA, actorId: actorFor(96) },
      ]);
      expect(Date.parse(listed.now)).toBeGreaterThanOrEqual(base.getTime());
      expect(Date.parse(listed.now)).toBeLessThan(Date.now() - 30 * 60_000);
      await expect(listDueWorkflowScheduleOwners({ limit: 2 })).resolves
        .toMatchObject({ owners: listed.owners.slice(0, 2) });
    } finally {
      vi.useRealTimers();
      // Later passes list every tenant's due work, so leave none behind.
      await admin`
        UPDATE omni_workflow_triggers
        SET status = 'paused'
        WHERE tenant_id IN (${tenantA}, ${tenantB}) AND trigger_kind = 'schedule'
      `;
      await admin`
        UPDATE omni_workflow_schedule_occurrences
        SET status = 'skipped'
        WHERE tenant_id = ${tenantA} AND status = 'claimed'
      `;
    }
  });

  test("runs due schedules for every tenant in database time and isolates a failing owner", async () => {
    const tenantA = "schedule_run_a";
    const tenantB = "schedule_run_b";
    const actorA = "actor:00000000-0000-4000-8000-000000000102";
    const actorB = "actor:00000000-0000-4000-8000-000000000103";
    const actorA2 = "actor:00000000-0000-4000-8000-000000000104";
    for (const [tenantId, slug] of [[tenantA, "schedule-run-a"], [tenantB, "schedule-run-b"]]) {
      await admin`
        INSERT INTO omni_auth_tenants (id, name, slug)
        VALUES (${tenantId}, 'Scheduled runs', ${slug})
      `;
    }
    for (const [tenantId, actorId, slug] of [
      [tenantA, actorA, "schedule-run-a"],
      [tenantA, actorA2, "schedule-run-a2"],
      [tenantB, actorB, "schedule-run-b"],
    ]) {
      const userId = actorId.slice("actor:".length);
      await admin`
        INSERT INTO omni_auth_users (id, email, password_hash)
        VALUES (${userId}, ${`${slug}@example.test`}, 'test-only')
      `;
      await admin`
        INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
        VALUES (${`membership:${slug}`}, ${tenantId}, ${userId}, 'admin')
      `;
    }
    const create = (
      tenantId: string,
      actorId: string,
      key: string,
      missedPolicy?: "skip" | "run_once",
    ) => runWithDatabaseTenantScope(tenantId, () => createWorkflowTrigger(
      scheduleTriggerInput({ tenantId, actorId, key, missedPolicy }),
    ));
    const late = await create(tenantA, actorA, "schedule-run-late");
    const skipped = await create(tenantA, actorA2, "schedule-run-skipped");
    const once = await create(tenantA, actorA, "schedule-run-once", "run_once");
    const early = await create(tenantA, actorA, "schedule-run-early");
    const valid = await create(tenantB, actorB, "schedule-run-valid");
    const brokenId = "schedule-run-broken";
    const [{ base }] = await admin`
      SELECT date_trunc('second', clock_timestamp()) AS base
    `;
    const at = (offsetMs: number) => new Date(base.getTime() + offsetMs).toISOString();
    const day = 24 * 60 * 60_000;
    const due = (triggerId: string, next: string, shadow = "1 day") => admin`
      UPDATE omni_workflow_triggers
      SET next_due_at = ${base}::timestamptz + ${next}::interval,
          shadow_next_due_at = ${base}::timestamptz + ${shadow}::interval
      WHERE id = ${triggerId}
    `;
    // Five minutes late is inside the grace; two days late is missed.
    await due(late.id, "-5 minutes", "-5 minutes");
    await due(skipped.id, "-2 days");
    await due(once.id, "-2 days");
    await due(early.id, "10 minutes");
    // A copy of the other tenant's schedule whose configuration no longer
    // matches its digest cannot load, and it is the oldest due work.
    await admin`
      INSERT INTO omni_workflow_triggers
      SELECT (jsonb_populate_record(original, jsonb_build_object(
        'id', ${brokenId}::text,
        'schedule_config', jsonb_set(original.schedule_config, '{maxOccurrences}', '41'),
        'next_due_at', ${base}::timestamptz - interval '3 days',
        'shadow_next_due_at', NULL
      ))).*
      FROM omni_workflow_triggers original
      WHERE original.id = ${valid.id}
    `;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logged = (spy: typeof warn, event: string) => spy.mock.calls.flatMap(([line]) => {
      try {
        const entry = JSON.parse(String(line));
        return entry.event === event ? [entry] : [];
      } catch {
        return [];
      }
    });
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      // An application clock an hour ahead would find the late run missed and
      // the early one due.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      const pass = (deadlineAt?: number) => processDueWorkflowSchedules({
        systemActorId: "integration-worker",
        correlationId: "correlation:schedule-run",
        deadlineAt,
      });
      const totals = await pass();
      expect(totals).toEqual({
        ownerActors: 3,
        ownerFailures: 1,
        shadowEvaluated: 1,
        occurrencesClaimed: 2,
        occurrencesEnqueued: 0,
        occurrencesSkipped: 1,
        occurrencesMissed: 2,
        occurrencesFailed: 2,
        occurrencesReconciled: 0,
      });

      const occurrences = await admin`
        SELECT trigger_id, status, outcome, failure_code, scheduled_for, evaluated_through
        FROM omni_workflow_schedule_occurrences
        WHERE tenant_id IN (${tenantA}, ${tenantB})
      `;
      expect(occurrences).toHaveLength(3);
      // Neither procedure exists, so each claimed run fails its review.
      expect(Object.fromEntries(occurrences.map((row) => [row.trigger_id, {
        status: row.status,
        outcome: row.outcome,
        failureCode: row.failure_code,
        scheduledFor: new Date(row.scheduled_for).toISOString(),
      }]))).toEqual({
        [late.id]: {
          status: "failed",
          outcome: "due",
          failureCode: "procedure_changed",
          scheduledFor: at(-5 * 60_000),
        },
        [skipped.id]: {
          status: "skipped",
          outcome: "missed_skipped",
          failureCode: null,
          scheduledFor: at(-2 * day),
        },
        [once.id]: {
          status: "failed",
          outcome: "missed_run_once",
          failureCode: "procedure_changed",
          scheduledFor: at(-2 * day),
        },
      });
      for (const row of occurrences) {
        const evaluatedThrough = new Date(row.evaluated_through).getTime();
        expect(evaluatedThrough).toBeGreaterThanOrEqual(base.getTime());
        expect(evaluatedThrough).toBeLessThan(Date.now() - 30 * 60_000);
      }
      const cursors = await admin`
        SELECT id, next_due_at
        FROM omni_workflow_triggers
        WHERE tenant_id IN (${tenantA}, ${tenantB})
      `;
      // The failing owner's claim rolled back, so its cursor did not move.
      expect(Object.fromEntries(cursors.map((row) => [
        row.id,
        new Date(row.next_due_at).toISOString(),
      ]))).toEqual({
        [late.id]: scheduleStartsAt,
        [skipped.id]: scheduleStartsAt,
        [once.id]: scheduleStartsAt,
        [early.id]: at(10 * 60_000),
        [valid.id]: scheduleStartsAt,
        [brokenId]: at(-3 * day),
      });

      const missed = logged(warn, "workflow_schedule.occurrence_missed");
      expect(missed).toHaveLength(2);
      expect(missed).toEqual(expect.arrayContaining([
        {
          level: "warn",
          event: "workflow_schedule.occurrence_missed",
          tenantId: tenantA,
          triggerId: skipped.id,
          scheduledFor: at(-2 * day),
          evaluatedThrough: expect.any(String),
          outcome: "missed_skipped",
          occurrencesConsumed: 1,
        },
        {
          level: "warn",
          event: "workflow_schedule.occurrence_missed",
          tenantId: tenantA,
          triggerId: once.id,
          scheduledFor: at(-2 * day),
          evaluatedThrough: expect.any(String),
          outcome: "missed_run_once",
          occurrencesConsumed: 1,
        },
      ]));
      expect(JSON.stringify(missed)).not.toContain("actor:");
      expect(logged(error, "workflow_schedule.owner_failed")).toEqual([{
        level: "error",
        event: "workflow_schedule.owner_failed",
        tenantId: tenantB,
        error: "Scheduled workflow configuration digest is invalid.",
      }]);

      // Tenant maintenance and a single owner's pass read the same database
      // clock, so neither finds the early run due. A pass that has reached its
      // deadline starts no owner, even with the broken schedule still due.
      const zeros = Object.fromEntries(Object.keys(totals).map((key) => [key, 0]));
      const tenantPass = (tenantId: string, deadlineAt?: number) =>
        processDueWorkflowSchedulesForTenant({
          tenantId,
          systemActorId: "integration-worker",
          correlationId: "correlation:schedule-run",
          deadlineAt,
        });
      await expect(tenantPass(tenantA)).resolves.toEqual(zeros);
      await expect(runWithDatabaseTenantScope(tenantA, () => processActorWorkflowSchedules({
        tenantId: tenantA,
        actorId: actorA,
        systemActorId: "integration-worker",
        correlationId: "correlation:schedule-run",
      }))).resolves.toEqual({
        shadowEvaluated: 0,
        occurrencesClaimed: 0,
        occurrencesSkipped: 0,
        occurrencesMissed: 0,
        occurrencesEnqueued: 0,
        occurrencesFailed: 0,
        occurrencesReconciled: 0,
      });
      await expect(tenantPass(tenantB, Date.now())).resolves.toEqual(zeros);
      await expect(pass(Date.now())).resolves.toEqual(zeros);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      error.mockRestore();
      await admin`
        UPDATE omni_workflow_triggers
        SET status = 'paused'
        WHERE tenant_id IN (${tenantA}, ${tenantB}) AND trigger_kind = 'schedule'
      `;
    }
  });

  test("claims a failed tool execution again only when its failure changed nothing", async () => {
    const tenantId = "retry_failed_tenant";
    const actorId = "retry_failed_actor";
    const createdAt = "2026-09-01T00:00:00.000Z";
    const inTenant = <T,>(operation: () => Promise<T>) =>
      runWithDatabaseTenantScope(tenantId, operation);
    const failedRead = (id: string) => ({
      ...createToolExecutionRecord({
        tenantId,
        actorId,
        toolId: "memory.search",
        toolName: "Search memory",
        riskLevel: 0,
        status: "failed",
        dryRun: false,
        approvalRequired: false,
        input: { query: "standup", limit: 5 },
        output: { error: "Search index unavailable." },
        reason: "Search index unavailable.",
        completedAt: createdAt,
      }),
      id,
      createdAt,
    });
    const failedWrite = (id: string, output: Record<string, unknown>) => ({
      ...createToolExecutionRecord({
        tenantId,
        actorId,
        toolId: "memory.write",
        toolName: "Write memory",
        riskLevel: 1,
        status: "failed",
        dryRun: false,
        approvalRequired: false,
        input: { title: "Standup", content: "Standup moved to 10am." },
        output,
        reason: "The tool call failed.",
        completedAt: createdAt,
      }),
      id,
      createdAt,
    });
    const claimOf = (record: ReturnType<typeof failedRead>) => ({
      ...record,
      status: "executing" as const,
      output: {
        __executionClaim: {
          token: `${record.id}-retry`,
          claimedAt: new Date().toISOString(),
        },
      },
      reason: "Claimed for a retry.",
      createdAt: new Date().toISOString(),
      completedAt: undefined,
    });
    const asRead = { retryFailed: { operationClass: "read_only" as const } };
    const asWrite = { retryFailed: { operationClass: "mutation" as const } };
    const read = failedRead("retry-db-read");
    const write = failedWrite("retry-db-write", {
      error: "This operation was aborted",
      interrupted: "before_start",
    });
    const unrequested = failedRead("retry-db-unrequested");
    const writeError = failedWrite("retry-db-write-error", {
      error: "Memory quota exceeded.",
    });
    const leased = failedRead("retry-db-leased");
    for (const record of [read, write, unrequested, writeError, leased]) {
      await inTenant(() => saveToolExecution(record));
    }
    const row = (id: string) => admin`
      SELECT
        status,
        completed_at IS NULL AS open,
        output #>> '{__executionClaim,token}' AS token,
        created_at = ${createdAt}::timestamptz AS created_at_kept
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId} AND id = ${id}
    `;
    const operations = async (id: string) => (await admin`
      SELECT payload->>'operation' AS operation
      FROM omni_events
      WHERE tenant_id = ${tenantId}
        AND stream_id = ${`tool_execution:${id}`}
        AND type = 'tool.execution.upserted'
      ORDER BY payload->>'operation'
    `).map((event) => event.operation);

    // A read, and a write interrupted before its tool started, are claimed
    // again at the same row under the lock.
    for (const [record, options] of [[read, asRead], [write, asWrite]] as const) {
      await expect(inTenant(() => claimIdempotentToolExecution(
        claimOf(record),
        { ...options, idempotencyKey: `${record.id}:retry` },
      ))).resolves.toMatchObject({
        outcome: "claimed",
        record: { id: record.id, status: "executing", createdAt },
      });
      expect(await row(record.id)).toEqual([{
        status: "executing",
        open: true,
        token: `${record.id}-retry`,
        created_at_kept: true,
      }]);
      expect(await operations(record.id)).toEqual(["reclaimed", "saved"]);
    }

    // No retry was asked for, a write failed on its own error, or a policy
    // lease rides the claim: the failure stands.
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: "correlation:retry-db-leased",
      purpose: "tool.execution.claim",
    });
    for (const [record, options] of [
      [unrequested, {}],
      [writeError, asWrite],
      // The claim refuses before it would read the lease.
      [leased, { ...asRead, executionScope: scope, policyLeaseClaim: {} as never }],
    ] as const) {
      await expect(inTenant(() => claimIdempotentToolExecution(
        claimOf(record),
        options,
      ))).resolves.toMatchObject({
        outcome: "existing",
        record: { id: record.id, status: "failed" },
      });
      expect(await row(record.id)).toEqual([{
        status: "failed",
        open: false,
        token: null,
        created_at_kept: true,
      }]);
      expect(await operations(record.id)).toEqual(["saved"]);
    }
  });

  test("ranks each tenant for dispatch by its next job and counts only queued runs without a tick", async () => {
    const inTenant = <T,>(operation: () => Promise<T>, tenant: string) =>
      runWithDatabaseTenantScope(tenant, operation);
    // Ten days back, ahead of the other tests' work.
    const [{ base }] = await admin`SELECT NOW() - INTERVAL '10 days' AS base`;
    const ago = (seconds: number) =>
      new Date(new Date(base).getTime() - seconds * 1_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const job = (
      tenant: string,
      dedupeKey: string,
      options: {
        type?: "workflow.tick" | "agent.resume";
        priority?: number;
        runAt?: string;
        workflowRunId?: string;
      } = {},
    ) => inTenant(() => enqueueOperationJob({
      tenantId: tenant,
      type: options.type ?? "workflow.tick",
      dedupeKey,
      payload: { workflowRunId: options.workflowRunId ?? dedupeKey },
      priority: options.priority ?? 10,
      runAt: options.runAt,
    }), tenant);
    const queuedRun = async (tenant: string, updatedSecondsAgo: number) => {
      const { run } = await inTenant(() => createWorkflowRun({
        tenantId: tenant,
        goal: "Sort this week's receipts.",
      }), tenant);
      await admin`
        UPDATE omni_workflow_runs
        SET updated_at = ${ago(updatedSecondsAgo)}::timestamptz
        WHERE id = ${run.id}
      `;
      return run;
    };
    const tickFor = (tenant: string, runId: string, runAt?: string) =>
      job(tenant, `workflow:${runId}`, { workflowRunId: runId, runAt });

    const aged = "dispatch_db_aged";
    const urgent = "dispatch_db_urgent";
    const steady = "dispatch_db_steady";
    const waiting = "dispatch_db_waiting";
    // Fifteen minutes of waiting lift this job above a newer, more urgent one.
    const agedOld = await job(aged, "dispatch-db-aged-old", { runAt: ago(900) });
    await admin`
      UPDATE omni_operation_jobs
      SET created_at = NOW() - INTERVAL '15 minutes'
      WHERE id = ${agedOld.id}
    `;
    await job(aged, "dispatch-db-aged-urgent", { priority: 20, runAt: ago(5) });
    // A newer, more urgent job leases before this tenant's older one.
    await job(urgent, "dispatch-db-urgent-old", { runAt: ago(300) });
    await job(urgent, "dispatch-db-urgent-new", { priority: 20, runAt: ago(1) });
    await job(steady, "dispatch-db-steady", { runAt: ago(120) });
    // At equal priority the earlier run_at leases first, even over an
    // earlier-created job.
    await job(waiting, "dispatch-db-waiting-new", { runAt: ago(30) });
    await job(waiting, "dispatch-db-waiting-old", { runAt: ago(180) });

    const live = "dispatch_db_live";
    const backoff = "dispatch_db_backoff";
    const done = "dispatch_db_done";
    const none = "dispatch_db_none";
    const decoy = "dispatch_db_decoy";
    // A run whose tick runs under a live lease, or waits out a backoff,
    // already has its delivery, however long it has been queued.
    const liveRun = await queuedRun(live, 400);
    await tickFor(live, liveRun.id);
    expect(await inTenant(() => leaseOperationJobs({
      tenantId: live,
      type: "workflow.tick",
    }), live)).toHaveLength(1);
    const backoffRun = await queuedRun(backoff, 400);
    await tickFor(backoff, backoffRun.id, future);
    // A run whose tick finished, or that never had one, waits for the
    // bootstrap from its oldest update.
    const doneRun = await queuedRun(done, 100);
    await tickFor(done, doneRun.id);
    const [doneLease] = await inTenant(() => leaseOperationJobs({
      tenantId: done,
      type: "workflow.tick",
    }), done);
    await inTenant(
      () => completeOperationJob(doneLease.id, doneLease.leaseOwner, done),
      done,
    );
    const noneRun = await queuedRun(none, 150);
    const laterNoneRun = await queuedRun(none, 50);
    // Jobs that name the run without being a tick of it in its tenant.
    await tickFor(decoy, noneRun.id, future);
    await job(none, "dispatch-db-none-resume", {
      type: "agent.resume",
      workflowRunId: noneRun.id,
      runAt: future,
    });
    await job(none, "dispatch-db-none-other-run", { runAt: future });

    const mine = new Set([aged, urgent, steady, waiting, live, backoff, done, none, decoy]);
    const snapshot = await listRunnableOperationDispatchTenants({ workflowLimit: 25 });

    expect(snapshot.workflowTenantIds.filter((id) => mine.has(id))).toEqual([
      aged,
      waiting,
      none,
      steady,
      done,
      urgent,
    ]);
    const activeTicks = (tenant: string) =>
      inTenant(() => listActiveWorkflowTickRunIds({ tenantId: tenant }), tenant);
    expect(await activeTicks(live)).toEqual(new Set([liveRun.id]));
    expect(await activeTicks(backoff)).toEqual(new Set([backoffRun.id]));
    expect(await activeTicks(done)).toEqual(new Set());
    expect(await activeTicks(none)).toEqual(new Set(["dispatch-db-none-other-run"]));
    // The bootstrap's exclusion applies before its limit.
    const runnable = (limit: number, excludeIds?: ReadonlySet<string>) =>
      inTenant(() => listRunnableWorkflowRuns(limit, { tenantId: none, excludeIds }), none);
    expect((await runnable(50)).map((run) => run.id)).toEqual([noneRun.id, laterNoneRun.id]);
    expect((await runnable(1, new Set([noneRun.id]))).map((run) => run.id))
      .toEqual([laterNoneRun.id]);

    // A tick deferred at the deadline keeps its run_at only when asked.
    const deferTenant = "dispatch_db_defer";
    const deferRunAt = ago(60);
    await job(deferTenant, "dispatch-db-defer-kept", { runAt: deferRunAt });
    await job(deferTenant, "dispatch-db-defer-moved", { runAt: deferRunAt });
    const leased = new Map((await inTenant(() => leaseOperationJobs({
      tenantId: deferTenant,
      type: "workflow.tick",
      limit: 2,
    }), deferTenant)).map((leasedJob) => [
      String(leasedJob.payload.workflowRunId),
      leasedJob,
    ]));
    const kept = leased.get("dispatch-db-defer-kept")!;
    const moved = leased.get("dispatch-db-defer-moved")!;
    await inTenant(() => deferOperationJob(kept.id, kept.leaseOwner!, {
      tenantId: deferTenant,
      keepRunAt: true,
      reason: "The deadline passed before the tick started.",
    }), deferTenant);
    await inTenant(() => deferOperationJob(moved.id, moved.leaseOwner!, {
      tenantId: deferTenant,
      delaySeconds: 1,
      reason: "The deadline cut the tick short.",
    }), deferTenant);
    expect(await admin`
      SELECT
        payload->>'workflowRunId' AS key,
        status,
        attempt,
        run_at = ${deferRunAt}::timestamptz AS run_at_kept,
        run_at > NOW() AS run_at_later
      FROM omni_operation_jobs
      WHERE tenant_id = ${deferTenant}
      ORDER BY key
    `).toEqual([
      {
        key: "dispatch-db-defer-kept",
        status: "queued",
        attempt: 0,
        run_at_kept: true,
        run_at_later: false,
      },
      {
        key: "dispatch-db-defer-moved",
        status: "queued",
        attempt: 0,
        run_at_kept: false,
        run_at_later: true,
      },
    ]);
  });

  test("backs a waiting tick off with fresh attempts, wakes it, and records pending specialists only on change", async () => {
    const tenant = "tenant-db-specialist-wait";
    const otherTenant = "tenant-db-specialist-wait-other";
    const inTenant = <T,>(operation: () => Promise<T>, scope = tenant) =>
      runWithDatabaseTenantScope(scope, operation);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const dedupeKey = "workflow:db-specialist-wait";
    await inTenant(() => enqueueOperationJob({
      tenantId: tenant,
      type: "workflow.tick",
      dedupeKey,
      payload: { workflowRunId: "db-specialist-wait", reason: "queue_bootstrap" },
    }));
    const lease = () => inTenant(() => leaseOperationJobs({
      tenantId: tenant,
      type: "workflow.tick",
      dedupeKey,
    }));
    const [first] = await lease();
    // Its lease runs out, and the tick is delivered again.
    await admin`
      UPDATE omni_operation_jobs
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE id = ${first.id}
    `;
    await inTenant(() => repairExpiredOperationJobs({ tenantId: tenant }));
    const [second] = await lease();
    expect(second).toMatchObject({ id: first.id, attempt: 2 });

    const reason = "Waiting for durable specialist tasks to finish.";
    const deferred = await inTenant(() => deferOperationJob(
      second.id,
      second.leaseOwner || "",
      {
        tenantId: tenant,
        delaySeconds: 15,
        resetAttempts: true,
        payload: { specialistWaits: 1 },
        reason,
      },
    ));

    expect(deferred).toMatchObject({
      status: "queued",
      attempt: 0,
      lastError: reason,
      payload: {
        workflowRunId: "db-specialist-wait",
        reason: "queue_bootstrap",
        specialistWaits: 1,
      },
    });
    const [waiting] = await admin`
      SELECT run_at > NOW() + INTERVAL '14 seconds' AS later
      FROM omni_operation_jobs
      WHERE id = ${first.id}
    `;
    expect(waiting.later).toBe(true);

    await inTenant(() => wakeOperationJobByDedupeKey(dedupeKey, { tenantId: tenant }));
    const [woken] = await admin`
      SELECT status, attempt, run_at <= NOW() AS due, payload->>'specialistWaits' AS waits
      FROM omni_operation_jobs
      WHERE id = ${first.id}
    `;
    expect(woken).toEqual({ status: "queued", attempt: 0, due: true, waits: "1" });

    // A plain defer still gives back only the attempt it took.
    await lease();
    await admin`
      UPDATE omni_operation_jobs
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE id = ${first.id}
    `;
    await inTenant(() => repairExpiredOperationJobs({ tenantId: tenant }));
    const [again] = await lease();
    expect(again).toMatchObject({ id: first.id, attempt: 2 });
    await expect(inTenant(() => deferOperationJob(again.id, again.leaseOwner || "", {
      tenantId: tenant,
      delaySeconds: 1,
    }))).resolves.toMatchObject({
      status: "queued",
      attempt: 1,
      payload: { workflowRunId: "db-specialist-wait", specialistWaits: 1 },
    });

    const { run } = await inTenant(() => createWorkflowRun({
      tenantId: tenant,
      goal: "Compare the flight options.",
    }));
    const { run: sibling } = await inTenant(() => createWorkflowRun({
      tenantId: tenant,
      goal: "Compare the hotel options.",
    }));
    const { run: foreign } = await inTenant(() => createWorkflowRun({
      tenantId: otherTenant,
      goal: "Renew the passport.",
    }), otherTenant);
    await expect(
      inTenant(() => getWorkflowRun(foreign.id, { tenantId: tenant })),
    ).resolves.toBeNull();
    await expect(
      inTenant(() => getWorkflowRun(run.id, { tenantId: tenant })),
    ).resolves.toMatchObject({ id: run.id, tenantId: tenant, status: "queued" });

    const record = async (runId: string, taskIds: string[]) => {
      const recorded = await inTenant(() => recordWorkflowSpecialistsPending(
        runId,
        taskIds,
        { tenantId: tenant },
      ));
      // Distinct creation times, so the latest record is the last one written.
      await pause();
      return recorded;
    };
    expect(await record(run.id, ["task-a", "task-b"])).toBeDefined();
    await inTenant(() => appendWorkflowEvent(run.id, "workflow.queue.enqueued", {
      reason: "workflow_queued",
    }));
    await pause();
    expect(await record(run.id, ["task-b", "task-a"])).toBeUndefined();
    expect(await record(run.id, ["task-b"])).toBeDefined();
    expect(await record(run.id, ["task-a"])).toBeDefined();
    expect(await record(run.id, ["task-a"])).toBeUndefined();
    expect(await record(sibling.id, ["task-a"])).toBeDefined();
    expect(await record(foreign.id, ["task-c"])).toBeUndefined();

    expect(await admin`
      SELECT workflow_run_id AS run_id, payload->'taskIds' AS task_ids
      FROM omni_workflow_events
      WHERE type = 'workflow.specialists.pending'
        AND workflow_run_id IN (${run.id}, ${sibling.id}, ${foreign.id})
      ORDER BY created_at, id
    `).toEqual([
      { run_id: run.id, task_ids: ["task-a", "task-b"] },
      { run_id: run.id, task_ids: ["task-b"] },
      { run_id: run.id, task_ids: ["task-a"] },
      { run_id: sibling.id, task_ids: ["task-a"] },
    ]);
  });

  test("runs a migration again from the version check when a statement cannot get its lock", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
    ) as unknown[];
    const version = databaseSchemaMigrations.at(-1)!.version + 1;
    const name = "migration_lock_probe_v1";
    const file = "20990101000000_migration_lock_probe.sql";
    const placeholder = "0".repeat(64);
    const template = [
      "BEGIN;",
      "",
      "SELECT pg_advisory_xact_lock(271828182);",
      "",
      "CREATE TABLE migration_lock_probe_target (id INTEGER PRIMARY KEY);",
      "",
      "CREATE VIEW migration_lock_probe_view AS",
      "  SELECT id FROM migration_lock_probe_target;",
      "",
      "INSERT INTO omni_schema_version (version, name, checksum, applied_at)",
      `VALUES (${version}, '${name}', '${placeholder}', clock_timestamp());`,
      "",
      "COMMIT;",
      "",
    ].join("\n");
    const checksum = sqlMigrationFileDigest(template, []);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniagent-migration-lock-"));
    fs.mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "supabase", "migrations", file),
      template.replace(placeholder, checksum),
    );
    vi.stubEnv("OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS", "7000");
    vi.stubEnv("OMNIAGENT_MIGRATION_STATEMENT_TIMEOUT_MS", "45000");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    vi.doMock("../../schema-migrations.json", () => ({
      default: [...manifest, { version, name, checksum, file, sha256: checksum }],
    }));
    try {
      await admin`CREATE SEQUENCE migration_lock_probe_view_seq`;
      await admin`CREATE SEQUENCE migration_lock_probe_extension_seq`;
      await admin`
        CREATE TABLE migration_lock_probe_ddl (
          seq BIGSERIAL PRIMARY KEY,
          tag TEXT NOT NULL,
          probe BOOLEAN NOT NULL,
          lock_timeout TEXT NOT NULL,
          statement_timeout TEXT NOT NULL,
          reason TEXT
        )
      `;
      // The first CREATE VIEW and the first CREATE EXTENSION fail as if
      // another session held a lock they needed. Every DDL command that runs
      // is recorded with the settings it ran under; the IFs are nested so
      // each sequence counts only its own command.
      await admin.unsafe(`
        CREATE FUNCTION migration_lock_probe_ddl_start() RETURNS event_trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF tg_tag = 'CREATE VIEW' THEN
            IF nextval('migration_lock_probe_view_seq') = 1 THEN
              RAISE EXCEPTION 'simulated lock wait on %', tg_tag
                USING ERRCODE = 'lock_not_available';
            END IF;
          ELSIF tg_tag = 'CREATE EXTENSION' THEN
            IF nextval('migration_lock_probe_extension_seq') = 1 THEN
              RAISE EXCEPTION 'simulated lock wait on %', tg_tag
                USING ERRCODE = 'lock_not_available';
            END IF;
          END IF;
          INSERT INTO migration_lock_probe_ddl (
            tag, probe, lock_timeout, statement_timeout, reason
          )
          VALUES (
            tg_tag,
            strpos(current_query(), 'migration_lock_probe_') > 0,
            current_setting('lock_timeout'),
            current_setting('statement_timeout'),
            current_setting('omni.system_reason', true)
          );
        END
        $$
      `);
      await admin`
        CREATE EVENT TRIGGER migration_lock_probe
        ON ddl_command_start
        EXECUTE FUNCTION migration_lock_probe_ddl_start()
      `;

      const client = await import("@/lib/db/client");
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
      try {
        await client.ensureDatabaseSchema();
      } finally {
        cwd.mockRestore();
        await client.closeDatabaseClient();
      }

      expect(await admin`
        SELECT version, name, checksum
        FROM omni_schema_version
        WHERE version IS NOT NULL
        ORDER BY version ASC
      `).toEqual([...databaseSchemaMigrations, { version, name, checksum }]);
      const [probe] = await admin`
        SELECT to_regclass('migration_lock_probe_view')::text AS view
      `;
      expect(probe).toEqual({ view: "migration_lock_probe_view" });
      const ddl = (await admin`
        SELECT tag, probe, lock_timeout, statement_timeout, reason
        FROM migration_lock_probe_ddl
        ORDER BY seq
      `).map((row) => ({
        tag: String(row.tag),
        probe: Boolean(row.probe),
        settings: `${row.lock_timeout} ${row.statement_timeout} ${row.reason}`,
      }));
      const schemaDdl = ddl.filter((row) => row.tag !== "CREATE EXTENSION");
      // The attempt that lost the lock race rolled back, so the file's
      // commands appear once, from the attempt that committed.
      expect(schemaDdl.filter((row) => row.probe).map((row) => row.tag)).toEqual([
        "CREATE TABLE",
        "CREATE VIEW",
      ]);
      // The lock timeout is in place from the first command on.
      expect(ddl[0]).toEqual({
        tag: "CREATE TABLE",
        probe: false,
        settings: "7s 45s ordered schema migration",
      });
      expect([...new Set(schemaDdl.map((row) => row.settings))]).toEqual([
        "7s 45s ordered schema migration",
      ]);
      expect(ddl.filter((row) => row.tag === "CREATE EXTENSION")).toEqual(
        requirePgvector
          ? [
              {
                tag: "CREATE EXTENSION",
                probe: false,
                settings: "7s 45s optional vector schema maintenance",
              },
            ]
          : [],
      );
      expect(migrationLockLogLines(warn.mock.calls)).toEqual([
        {
          level: "warn",
          event: "database_migration_lock_retry",
          step: "Schema migration",
          attempt: 1,
          attempts: 5,
          retryInMs: 1_000,
          sqlstate: "55P03",
          error: `Database migration ${version} (${name}) failed: ${file} statement 4 (CREATE VIEW migration_lock_probe_view AS) failed: simulated lock wait on CREATE VIEW`,
        },
        {
          level: "warn",
          event: "database_migration_lock_retry",
          step: "Vector schema maintenance",
          attempt: 1,
          attempts: 5,
          retryInMs: 1_000,
          sqlstate: "55P03",
          error: "simulated lock wait on CREATE EXTENSION",
        },
      ]);
    } finally {
      warn.mockRestore();
      vi.doUnmock("../../schema-migrations.json");
      vi.resetModules();
      vi.unstubAllEnvs();
      await admin`DROP EVENT TRIGGER IF EXISTS migration_lock_probe`;
      await admin`DROP FUNCTION IF EXISTS migration_lock_probe_ddl_start()`;
      await admin`DROP VIEW IF EXISTS migration_lock_probe_view`;
      await admin`DROP TABLE IF EXISTS migration_lock_probe_target`;
      await admin`DROP TABLE IF EXISTS migration_lock_probe_ddl`;
      await admin`DROP SEQUENCE IF EXISTS migration_lock_probe_view_seq`;
      await admin`DROP SEQUENCE IF EXISTS migration_lock_probe_extension_seq`;
      await admin`DELETE FROM omni_schema_version WHERE version = ${version}`;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!requirePgvector)(
    "fills vector columns a keyset batch per transaction and runs a batch again after a lock timeout",
    async () => {
      const tenant = "tenant-vector-backfill";
      const documentId = "vector-backfill-document";
      const memoryId = "vector-backfill-memory";
      const [pending] = await admin`
        SELECT count(*)::int AS rows
        FROM omni_knowledge_chunks
        WHERE embedding_vector IS NULL
          AND embedding IS NOT NULL
      `;
      // No other chunk waits for a vector, so every batch below is this test's.
      expect(pending).toEqual({ rows: 0 });
      vi.stubEnv("OMNIAGENT_MIGRATION_LOCK_TIMEOUT_MS", "7000");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.resetModules();
      try {
        await admin`
          INSERT INTO omni_knowledge_documents (id, tenant_id, title, source, content_hash)
          VALUES (
            ${documentId}, ${tenant}, 'Vector backfill', 'integration-test', 'vector-backfill'
          )
        `;
        // 501 chunks with whole embeddings, stored last id first so that only
        // the backfill's id order puts the first 500 ids in the first batch,
        // then one with an element that is not a number and one that is too
        // short, neither of which can become a vector.
        await admin`
          INSERT INTO omni_knowledge_chunks (
            id, tenant_id, document_id, chunk_index, title, content, source, embedding
          )
          SELECT
            'vector-backfill-chunk-' || lpad(g::text, 4, '0'),
            ${tenant}::text,
            ${documentId}::text,
            g,
            'Chunk',
            'Chunk ' || g,
            'integration-test',
            (
              SELECT jsonb_agg(((g * 7 + d) % 97) / 97.0 ORDER BY d)
              FROM generate_series(1, ${VECTOR_INDEX_DIMENSIONS}::int) d
            )
          FROM generate_series(500, 0, -1) g
        `;
        await admin`
          INSERT INTO omni_knowledge_chunks (
            id, tenant_id, document_id, chunk_index, title, content, source, embedding
          )
          VALUES
            (
              'vector-backfill-chunk-malformed', ${tenant}, ${documentId}, 501,
              'Chunk', 'Malformed', 'integration-test',
              (
                SELECT jsonb_agg(
                  CASE WHEN d = 2 THEN to_jsonb('x'::text) ELSE to_jsonb(d / 97.0) END
                  ORDER BY d
                )
                FROM generate_series(1, ${VECTOR_INDEX_DIMENSIONS}::int) d
              )
            ),
            (
              'vector-backfill-chunk-short', ${tenant}, ${documentId}, 502,
              'Chunk', 'Short', 'integration-test', '[0.25, 0.5, 0.75]'::jsonb
            )
        `;
        await admin`
          INSERT INTO omni_memories (id, tenant_id, type, title, content, scope, source, embedding)
          SELECT
            ${memoryId}::text, ${tenant}::text, 'fact', 'Vector backfill',
            'A memory waiting for its vector.',
            'tenant', 'integration-test',
            (
              SELECT jsonb_agg(d / 97.0 ORDER BY d)
              FROM generate_series(1, ${VECTOR_INDEX_DIMENSIONS}::int) d
            )
        `;
        await admin`
          CREATE TABLE vector_backfill_visits (
            seq BIGSERIAL PRIMARY KEY,
            id TEXT NOT NULL,
            txid TEXT NOT NULL,
            lock_timeout TEXT NOT NULL,
            reason TEXT
          )
        `;
        await admin`CREATE SEQUENCE vector_backfill_visit_seq`;
        // The 250th chunk the backfill updates fails as if another session
        // held its lock. Chunk 0137 never keeps its vector, so a backfill that
        // chose chunks by the missing vector alone, or went on from the first
        // id of a batch, would update it again.
        await admin.unsafe(`
          CREATE FUNCTION vector_backfill_visit() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF nextval('vector_backfill_visit_seq') = 250 THEN
              RAISE EXCEPTION 'simulated lock wait in the vector backfill'
                USING ERRCODE = 'lock_not_available';
            END IF;
            INSERT INTO vector_backfill_visits (id, txid, lock_timeout, reason)
            VALUES (
              NEW.id,
              txid_current()::text,
              current_setting('lock_timeout'),
              current_setting('omni.system_reason', true)
            );
            IF NEW.id = 'vector-backfill-chunk-0137' THEN
              NEW.embedding_vector := NULL;
            END IF;
            RETURN NEW;
          END
          $$
        `);
        await admin`
          CREATE TRIGGER vector_backfill_visit
          BEFORE UPDATE ON omni_knowledge_chunks
          FOR EACH ROW
          WHEN (NEW.id LIKE 'vector-backfill-chunk-%')
          EXECUTE FUNCTION vector_backfill_visit()
        `;

        const client = await import("@/lib/db/client");
        try {
          await client.ensureDatabaseSchema();
        } finally {
          await client.closeDatabaseClient();
        }

        expect(await admin`
          SELECT id
          FROM omni_knowledge_chunks
          WHERE document_id = ${documentId}
            AND embedding_vector IS NULL
          ORDER BY id
        `).toEqual([
          { id: "vector-backfill-chunk-0137" },
          { id: "vector-backfill-chunk-malformed" },
          { id: "vector-backfill-chunk-short" },
        ]);
        const [memory] = await admin`
          SELECT embedding_vector::real[] = ARRAY(
            SELECT item.value::real
            FROM jsonb_array_elements_text(embedding) WITH ORDINALITY AS item(value, ordinality)
            ORDER BY item.ordinality
          ) AS filled
          FROM omni_memories
          WHERE id = ${memoryId}
        `;
        expect(memory).toEqual({ filled: true });
        const [filled] = await admin`
          SELECT count(*)::int AS rows
          FROM omni_knowledge_chunks chunk
          WHERE chunk.document_id = ${documentId}
            AND CASE
              WHEN chunk.embedding_vector IS NULL THEN false
              ELSE chunk.embedding_vector::real[] = ARRAY(
                SELECT item.value::real
                FROM jsonb_array_elements_text(chunk.embedding)
                  WITH ORDINALITY AS item(value, ordinality)
                ORDER BY item.ordinality
              )
            END
        `;
        expect(filled).toEqual({ rows: 500 });
        const visits = await admin`
          SELECT id, txid, lock_timeout, reason
          FROM vector_backfill_visits
          ORDER BY seq
        `;
        // Each chunk was updated once, by the attempt that committed; the
        // attempt that lost the lock race rolled back its 249 updates.
        expect(visits.map((visit) => String(visit.id)).sort()).toEqual(
          Array.from(
            { length: 501 },
            (_, index) => `vector-backfill-chunk-${String(index).padStart(4, "0")}`,
          ),
        );
        // A batch of 500 chunks, then one of the chunk after them, each in a
        // transaction of its own.
        const batches = new Map<string, string[]>();
        for (const visit of visits) {
          batches.set(String(visit.txid), [
            ...(batches.get(String(visit.txid)) ?? []),
            String(visit.id),
          ]);
        }
        expect(
          [...batches.values()].map((ids) => {
            const sorted = [...ids].sort();
            return [ids.length, sorted[0], sorted.at(-1)];
          }),
        ).toEqual([
          [500, "vector-backfill-chunk-0000", "vector-backfill-chunk-0499"],
          [1, "vector-backfill-chunk-0500", "vector-backfill-chunk-0500"],
        ]);
        expect([
          ...new Set(visits.map((visit) => `${visit.lock_timeout} ${visit.reason}`)),
        ]).toEqual(["7s optional vector schema maintenance"]);
        expect(migrationLockLogLines(warn.mock.calls)).toEqual([
          {
            level: "warn",
            event: "database_migration_lock_retry",
            step: "Vector backfill of omni_knowledge_chunks",
            attempt: 1,
            attempts: 5,
            retryInMs: 1_000,
            sqlstate: "55P03",
            error: "simulated lock wait in the vector backfill",
          },
        ]);
      } finally {
        warn.mockRestore();
        vi.resetModules();
        vi.unstubAllEnvs();
        await admin`DROP TRIGGER IF EXISTS vector_backfill_visit ON omni_knowledge_chunks`;
        await admin`DROP FUNCTION IF EXISTS vector_backfill_visit()`;
        await admin`DROP TABLE IF EXISTS vector_backfill_visits`;
        await admin`DROP SEQUENCE IF EXISTS vector_backfill_visit_seq`;
        // Memory rows are never deleted, so the memory stays.
        await admin`DELETE FROM omni_knowledge_documents WHERE id = ${documentId}`;
      }
    },
  );
  test("changes nothing on a database the migration files built", async () => {
    const fileCatalog = await schemaCatalogSnapshot(admin);

    const ddl = await withSchemaConvergencePending(admin, () =>
      convergenceDdlDuring(admin, migrateWithFreshClient),
    );

    expect(await schemaCatalogSnapshot(admin)).toEqual(fileCatalog);
    // Replacing the system scope function locks no table.
    expect(ddl).toEqual([
      { statement: "function", tag: "CREATE FUNCTION", commands: 1 },
    ]);
    expect(await admin`
      SELECT version, name, checksum
      FROM omni_schema_version
      WHERE version IS NOT NULL
      ORDER BY version ASC
    `).toEqual(databaseSchemaMigrations);
  });

  test("refuses to converge a table that matches neither the old runner's catalog nor the files'", async () => {
    const table = "public.omni_ap2_payment_receipts";
    const policy = "omni_ap2_payment_receipts_actor";
    const expression =
      "omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)";
    const recreatePolicy = (definition: string) => [
      `DROP POLICY ${policy} ON ${table}`,
      `CREATE POLICY ${policy} ON ${table} ${definition}`,
    ];
    const actorPolicy = recreatePolicy(
      `FOR ALL USING (${expression}) WITH CHECK (${expression})`,
    );
    const policyError =
      "The policies of omni_ap2_payment_receipts are not its actor policy alone";
    const revisions = "public.omni_salesforce_record_revisions";
    const swapRevisionChecks = [
      `ALTER TABLE ${revisions} RENAME CONSTRAINT omni_salesforce_record_revisions_check2 TO omni_salesforce_record_revisions_swap`,
      `ALTER TABLE ${revisions} RENAME CONSTRAINT omni_salesforce_record_revisions_check3 TO omni_salesforce_record_revisions_check2`,
      `ALTER TABLE ${revisions} RENAME CONSTRAINT omni_salesforce_record_revisions_swap TO omni_salesforce_record_revisions_check3`,
    ];
    const variants = [
      {
        change: [`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`],
        restore: [`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`],
        error: policyError,
      },
      {
        change: [`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`],
        restore: [`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`],
        error: policyError,
      },
      {
        change: [
          `ALTER POLICY ${policy} ON ${table} RENAME TO omni_ap2_payment_receipts_owner`,
        ],
        restore: [
          `ALTER POLICY omni_ap2_payment_receipts_owner ON ${table} RENAME TO ${policy}`,
        ],
        error: policyError,
      },
      {
        change: recreatePolicy(
          `AS RESTRICTIVE FOR ALL USING (${expression}) WITH CHECK (${expression})`,
        ),
        restore: actorPolicy,
        error: policyError,
      },
      {
        change: recreatePolicy(
          `FOR UPDATE USING (${expression}) WITH CHECK (${expression})`,
        ),
        restore: actorPolicy,
        error: policyError,
      },
      {
        change: recreatePolicy(
          `FOR ALL TO omni_runtime USING (${expression}) WITH CHECK (${expression})`,
        ),
        restore: actorPolicy,
        error: policyError,
      },
      {
        change: [
          `ALTER POLICY ${policy} ON ${table} USING (omni_system_scope_enabled())`,
        ],
        restore: [`ALTER POLICY ${policy} ON ${table} USING (${expression})`],
        error: policyError,
      },
      {
        change: [
          `ALTER POLICY ${policy} ON ${table} WITH CHECK (omni_system_scope_enabled())`,
        ],
        restore: [`ALTER POLICY ${policy} ON ${table} WITH CHECK (${expression})`],
        error: policyError,
      },
      // A second permissive policy would admit rows the actor policy refuses.
      {
        change: [
          `CREATE POLICY omni_ap2_payment_receipts_reader ON ${table} FOR SELECT USING (true)`,
        ],
        restore: [`DROP POLICY omni_ap2_payment_receipts_reader ON ${table}`],
        error: policyError,
      },
      {
        change: [
          "ALTER TABLE public.omni_model_assignments DROP CONSTRAINT omni_model_assignments_revision_check",
          "ALTER TABLE public.omni_model_assignments ADD CONSTRAINT omni_model_assignments_revision_check CHECK (assignment_revision >= 0)",
        ],
        restore: [
          "ALTER TABLE public.omni_model_assignments DROP CONSTRAINT omni_model_assignments_revision_check",
          "ALTER TABLE public.omni_model_assignments ADD CONSTRAINT omni_model_assignments_revision_check CHECK (assignment_revision > 0)",
        ],
        error:
          "Constraint omni_model_assignments_revision_check of omni_model_assignments is not the expected one",
      },
      // Two CHECKs under each other's names.
      {
        change: swapRevisionChecks,
        restore: swapRevisionChecks,
        error:
          "Constraint omni_salesforce_record_revisions_check2 of omni_salesforce_record_revisions is not the expected one",
      },
      // With both names present, the old one is not renamed.
      {
        change: [
          "ALTER TABLE public.omni_mobile_push_registrations ADD CONSTRAINT omni_mobile_push_registrations_check1 CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))",
        ],
        restore: [
          "ALTER TABLE public.omni_mobile_push_registrations DROP CONSTRAINT omni_mobile_push_registrations_check1",
        ],
        error:
          "omni_mobile_push_registrations still has a constraint the files do not create",
      },
    ];
    const fileCatalog = await schemaCatalogSnapshot(admin);

    await withSchemaConvergencePending(admin, async () => {
      for (const variant of variants) {
        for (const statement of variant.change) {
          await admin.unsafe(statement);
        }
        const changed = await schemaCatalogSnapshot(admin);
        // The runner wraps the file runner's error, which wraps the database's.
        await expect(migrateWithFreshClient()).rejects.toMatchObject({
          message: expect.stringContaining(variant.error),
          cause: { cause: { code: "55000" } },
        });
        expect(await schemaCatalogSnapshot(admin)).toEqual(changed);
        for (const statement of variant.restore) {
          await admin.unsafe(statement);
        }
      }
      const [ledger] = await admin`
        SELECT count(*)::int AS rows
        FROM omni_schema_version
        WHERE version >= ${schemaConvergenceVersion}
      `;
      expect(ledger).toEqual({ rows: 0 });
    });
    expect(await schemaCatalogSnapshot(admin)).toEqual(fileCatalog);
  });

  test("adds a CHECK the database lacks under both its old runner name and its file name", async () => {
    const tableName = "omni_salesforce_record_heads";
    const missingChecks = [
      { tableName, constraintName: "omni_salesforce_record_heads_check1" },
      { tableName, constraintName: "omni_salesforce_record_heads_check2" },
    ];
    const fileCatalog = await schemaCatalogSnapshot(admin);

    await withSchemaConvergencePending(admin, async () => {
      for (const { constraintName } of missingChecks) {
        await admin.unsafe(
          `ALTER TABLE public.${tableName} DROP CONSTRAINT ${constraintName}`,
        );
      }

      const ddl = await convergenceDdlDuring(admin, migrateWithFreshClient);

      expect(ddl).toEqual([
        { statement: "constraints", tag: "ALTER TABLE", commands: 2 },
        { statement: "function", tag: "CREATE FUNCTION", commands: 1 },
      ]);
      expect(await schemaCatalogSnapshot(admin)).toEqual(
        withUnvalidatedChecks(fileCatalog, missingChecks),
      );
      for (const { constraintName } of missingChecks) {
        await admin.unsafe(
          `ALTER TABLE public.${tableName} VALIDATE CONSTRAINT ${constraintName}`,
        );
      }
    });
    expect(await schemaCatalogSnapshot(admin)).toEqual(fileCatalog);
  });

  test("brings a database the old runner built to the catalog the migration files build", async () => {
    const tenantId = "tenant_schema_convergence";
    const isolationReport = () =>
      runWithDatabaseTenantScope(tenantId, () => getTenantIsolationReport(tenantId));
    const missingChecks = Object.entries(oldRunnerMissingChecks).flatMap(
      ([tableName, constraintNames]) =>
        constraintNames.map((constraintName) => ({ tableName, constraintName })),
    );
    const fileCatalog = await schemaCatalogSnapshot(admin);
    await admin.unsafe(
      `CREATE ROLE ${scopeProbeRole} NOLOGIN NOSUPERUSER BYPASSRLS`,
    );
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${scopeProbeRole}`);
    expect(await systemScopeEnabledFor(admin, scopeProbeRole)).toBe(true);
    expect((await isolationReport()).summary).toMatchObject({
      failingTables: 0,
      missingPolicies: [],
    });

    await withSchemaConvergencePending(admin, async () => {
      for (const tableName of oldRunnerTenantWidePolicyTables) {
        await admin.unsafe(`
          CREATE POLICY omni_tenant_isolation ON public.${tableName} FOR ALL
          USING (omni_tenant_visible(tenant_id))
          WITH CHECK (omni_tenant_visible(tenant_id))
        `);
      }
      for (const { tableName, constraintName } of missingChecks) {
        await admin.unsafe(
          `ALTER TABLE public.${tableName} DROP CONSTRAINT ${constraintName}`,
        );
      }
      for (const [tableName, oldName, fileName] of [...oldRunnerCheckNames].reverse()) {
        await admin.unsafe(
          `ALTER TABLE public.${tableName} RENAME CONSTRAINT ${fileName} TO ${oldName}`,
        );
      }
      await admin.unsafe(oldRunnerSystemScopeFunction);
      const oldCatalog = await schemaCatalogSnapshot(admin);

      expect(await systemScopeEnabledFor(admin, scopeProbeRole)).toBe(false);
      const oldReport = await isolationReport();
      expect(oldReport.status).toBe("degraded");
      expect([...oldReport.summary.missingPolicies].sort()).toEqual(
        oldRunnerTenantWidePolicyTables,
      );

      // A CHECK that matches neither catalog stops the migration, and what it
      // had changed by then rolls back.
      await admin.unsafe(`
        ALTER TABLE public.omni_model_assignments
        ADD CONSTRAINT omni_model_assignments_revision_check
        CHECK (assignment_revision >= 0)
      `);
      await expect(migrateWithFreshClient()).rejects.toThrow(
        "Constraint omni_model_assignments_revision_check of omni_model_assignments is not the expected one",
      );
      await admin.unsafe(`
        ALTER TABLE public.omni_model_assignments
        DROP CONSTRAINT omni_model_assignments_revision_check
      `);
      expect(await schemaCatalogSnapshot(admin)).toEqual(oldCatalog);

      const ddl = await convergenceDdlDuring(admin, migrateWithFreshClient);

      expect(await schemaCatalogSnapshot(admin)).toEqual(
        withUnvalidatedChecks(fileCatalog, missingChecks),
      );
      expect(ddl).toEqual([
        { statement: "constraints", tag: "ALTER TABLE", commands: 51 },
        { statement: "function", tag: "CREATE FUNCTION", commands: 1 },
        { statement: "policies", tag: "DROP POLICY", commands: 38 },
      ]);
      expect(await admin`
        SELECT version, name, checksum
        FROM omni_schema_version
        WHERE version IS NOT NULL
        ORDER BY version ASC
      `).toEqual(databaseSchemaMigrations);
      expect(await systemScopeEnabledFor(admin, scopeProbeRole)).toBe(true);
      const report = await isolationReport();
      expect(report.status).toBe("passing");
      expect(report.summary.missingPolicies).toEqual([]);

      // A later release validates the CHECKs this one adds.
      for (const { tableName, constraintName } of missingChecks) {
        await admin.unsafe(
          `ALTER TABLE public.${tableName} VALIDATE CONSTRAINT ${constraintName}`,
        );
      }
      expect(await schemaCatalogSnapshot(admin)).toEqual(fileCatalog);
    });
  });

  test("reports each table whose tenant policy has lost the restrictive actor policy that narrows it", async () => {
    const tenantId = "tenant_restrictive_actor_policies";
    const restrictivePolicies = await admin`
      SELECT relation.relname AS table_name,
        policy.polname AS policy_name,
        policy.polcmd::text AS command,
        policy.polroles::text AS roles,
        pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
        pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      WHERE relation.relnamespace = 'public'::regnamespace
        AND relation.relname = ANY(${tenantPolicyTables as readonly string[]})
        AND NOT policy.polpermissive
        AND policy.polname ~ '_actor$'
      ORDER BY relation.relname
    `;
    // Each one covers every command and role, as its restore below does.
    expect(restrictivePolicies.map(({ command, roles }) => ({ command, roles })))
      .toEqual(Array(40).fill({ command: "*", roles: "{0}" }));
    const catalog = await schemaCatalogSnapshot(admin);
    const dropped: typeof restrictivePolicies[number][] = [];

    try {
      for (const policy of restrictivePolicies) {
        await admin.unsafe(
          `DROP POLICY ${policy.policy_name} ON public.${policy.table_name}`,
        );
        dropped.push(policy);
      }
      const report = await runWithDatabaseTenantScope(tenantId, () =>
        getTenantIsolationReport(tenantId),
      );
      expect([...report.summary.missingPolicies].sort()).toEqual(
        restrictivePolicies.map((policy) => policy.table_name),
      );
    } finally {
      for (const policy of dropped) {
        await admin.unsafe(`
          CREATE POLICY ${policy.policy_name} ON public.${policy.table_name}
          AS RESTRICTIVE FOR ALL TO PUBLIC
          USING (${policy.using_expression})
          ${policy.check_expression === null ? "" : `WITH CHECK (${policy.check_expression})`}
        `);
      }
    }
    expect(await schemaCatalogSnapshot(admin)).toEqual(catalog);
  });
});

async function dropDatabaseRole(
  client: ReturnType<typeof postgres>,
  roleName: string,
) {
  const [role] = await client`
    SELECT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = ${roleName}
    ) AS exists
  `;
  if (role.exists) {
    await client.unsafe(`DROP OWNED BY ${roleName}`);
    await client.unsafe(`DROP ROLE ${roleName}`);
  }
}

// Table privileges held by roles other than the one that ran the migrations,
// as "table: grantee privileges" lines. The migrations grant to the deployment
// roles by name, and the runner creates any that are missing, so every
// database carries these grants.
async function tableGrants(
  client: ReturnType<typeof postgres>,
  tables: readonly string[],
) {
  const rows = await client`
    SELECT table_name, grantee,
      string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = ANY(${[...tables]}::text[])
      AND grantee <> current_user
    GROUP BY table_name, grantee
  `;
  return rows
    .map((row) => `${row.table_name}: ${row.grantee} ${row.privileges}`)
    .sort();
}

// The migration lock retry lines a console.warn spy received, parsed.
function migrationLockLogLines(calls: readonly unknown[][]) {
  return calls.flatMap(([line]) => {
    try {
      const parsed = JSON.parse(String(line)) as { event?: unknown };
      return typeof parsed.event === "string" &&
        parsed.event.startsWith("database_migration_lock")
        ? [parsed]
        : [];
    } catch {
      return [];
    }
  });
}

const schemaConvergenceVersion = 208;

// A database the old runner migrated, before every version ran from its SQL
// file, gave these tables a permissive tenant-wide policy beside their actor
// policy.
const oldRunnerTenantWidePolicyTables = [
  "omni_ap2_credential_claims",
  "omni_ap2_credential_grants",
  "omni_ap2_mandate_authorizations",
  "omni_ap2_mandate_reviews",
  "omni_ap2_payment_receipts",
  "omni_ap2_payment_transactions",
  "omni_ap2_reconciliation_jobs",
  "omni_ap2_reconciliation_observations",
  "omni_ap2_signing_credentials",
  "omni_app_builder_checkpoints",
  "omni_app_builder_deliveries",
  "omni_app_builder_deployments",
  "omni_app_builder_events",
  "omni_app_builder_releases",
  "omni_app_builder_repository_bindings",
  "omni_app_builder_sessions",
  "omni_app_builder_verifications",
  "omni_communication_intents",
  "omni_conversation_links",
  "omni_delivery_receipts",
  "omni_inbound_communications",
  "omni_market_backtest_events",
  "omni_market_backtests",
  "omni_market_event_replay_events",
  "omni_market_event_replays",
  "omni_market_macro_event_events",
  "omni_market_macro_event_schedule_events",
  "omni_market_macro_event_schedules",
  "omni_market_macro_events",
  "omni_market_macro_observation_events",
  "omni_market_macro_observations",
  "omni_market_price_snapshot_events",
  "omni_market_price_snapshots",
  "omni_message_drafts",
  "omni_mobile_push_deliveries",
  "omni_mobile_push_registrations",
  "omni_person_contact_policies",
  "omni_personal_context_consents",
];

// The CHECK constraints the files create that the old runner left out.
const oldRunnerMissingChecks: Record<string, string[]> = {
  omni_mobile_push_deliveries: [
    "omni_mobile_push_deliveries_attempt_check",
    "omni_mobile_push_deliveries_cause_id_check",
    "omni_mobile_push_deliveries_check",
    "omni_mobile_push_deliveries_deep_link_check",
    "omni_mobile_push_deliveries_id_check",
    "omni_mobile_push_deliveries_max_attempts_check",
    "omni_mobile_push_deliveries_notification_id_check",
    "omni_mobile_push_deliveries_owner_actor_id_check",
    "omni_mobile_push_deliveries_parent_id_check",
    "omni_mobile_push_deliveries_provider_message_id_sha256_check",
  ],
  omni_mobile_push_registrations: [
    "omni_mobile_push_registrations_credential_version_check",
    "omni_mobile_push_registrations_device_id_check",
    "omni_mobile_push_registrations_id_check",
    "omni_mobile_push_registrations_lifecycle_revision_check",
    "omni_mobile_push_registrations_owner_actor_id_check",
  ],
  omni_model_assignments: ["omni_model_assignments_revision_check"],
  omni_salesforce_connections: [
    "omni_salesforce_connections_check2",
    "omni_salesforce_connections_check3",
    "omni_salesforce_connections_instance_origin_check",
    "omni_salesforce_connections_object_scope_check",
    "omni_salesforce_connections_object_scope_check1",
    "omni_salesforce_connections_sync_cursor_check1",
    "omni_salesforce_connections_sync_error_check",
    "omni_salesforce_connections_sync_lease_owner_id_check",
  ],
  omni_salesforce_reconciliation_findings: [
    "omni_salesforce_reconciliation_finding_remote_revision_id_check",
    "omni_salesforce_reconciliation_findings_local_revision_id_check",
    "omni_salesforce_reconciliation_findings_object_type_check",
  ],
  omni_salesforce_record_heads: [
    "omni_salesforce_record_heads_account_external_id_check",
    "omni_salesforce_record_heads_check1",
    "omni_salesforce_record_heads_check3",
    "omni_salesforce_record_heads_organization_id_sha256_check",
    "omni_salesforce_record_heads_projection_error_code_check",
  ],
  omni_salesforce_record_revisions: [
    "omni_salesforce_record_revisions_account_external_id_check",
    "omni_salesforce_record_revisions_check1",
    "omni_salesforce_record_revisions_check2",
    "omni_salesforce_record_revisions_check3",
    "omni_salesforce_record_revisions_check4",
    "omni_salesforce_record_revisions_fields_sha256_check",
    "omni_salesforce_record_revisions_organization_id_sha256_check",
    "omni_salesforce_record_revisions_replay_id_sha256_check",
  ],
  omni_salesforce_webhook_events: [
    "omni_salesforce_webhook_events_external_id_check",
    "omni_salesforce_webhook_events_object_type_check",
    "omni_salesforce_webhook_events_organization_id_sha256_check",
  ],
};

// The CHECK constraints the old runner named differently, as [table, the old
// runner's name, the files' name], in the order the migration renames them.
const oldRunnerCheckNames = [
  [
    "omni_mobile_push_deliveries",
    "omni_mobile_push_deliveries_check4",
    "omni_mobile_push_deliveries_check5",
  ],
  [
    "omni_mobile_push_deliveries",
    "omni_mobile_push_deliveries_check3",
    "omni_mobile_push_deliveries_check4",
  ],
  [
    "omni_mobile_push_deliveries",
    "omni_mobile_push_deliveries_check2",
    "omni_mobile_push_deliveries_check3",
  ],
  [
    "omni_mobile_push_deliveries",
    "omni_mobile_push_deliveries_check1",
    "omni_mobile_push_deliveries_check2",
  ],
  [
    "omni_mobile_push_deliveries",
    "omni_mobile_push_deliveries_check",
    "omni_mobile_push_deliveries_check1",
  ],
  [
    "omni_mobile_push_registrations",
    "omni_mobile_push_registrations_check1",
    "omni_mobile_push_registrations_check",
  ],
  [
    "omni_salesforce_connections",
    "omni_salesforce_connections_object_scope_check",
    "omni_salesforce_connections_object_scope_check2",
  ],
  [
    "omni_salesforce_record_heads",
    "omni_salesforce_record_heads_check1",
    "omni_salesforce_record_heads_check2",
  ],
] as const;

// The old runner's system scope function, which admits the schema owner
// alone.
const oldRunnerSystemScopeFunction = `
  CREATE OR REPLACE FUNCTION public.omni_system_scope_enabled()
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

// Row security, policies and constraints of every table in the public schema,
// and the system scope function, as the catalogs describe them.
async function schemaCatalogSnapshot(client: ReturnType<typeof postgres>) {
  const tables = await client`
    SELECT relname AS table_name,
      relrowsecurity AS row_security,
      relforcerowsecurity AS forced_row_security
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relkind IN ('r', 'p')
    ORDER BY relname
  `;
  const policies = await client`
    SELECT relation.relname AS table_name,
      policy.polname AS policy_name,
      policy.polpermissive AS permissive,
      policy.polcmd::text AS command,
      policy.polroles::text AS roles,
      pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
      pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE relation.relnamespace = 'public'::regnamespace
    ORDER BY relation.relname, policy.polname
  `;
  const constraints = await client`
    SELECT relation.relname AS table_name,
      table_constraint.conname AS constraint_name,
      table_constraint.contype::text AS type,
      pg_get_constraintdef(table_constraint.oid) AS definition,
      table_constraint.convalidated AS validated
    FROM pg_constraint table_constraint
    JOIN pg_class relation ON relation.oid = table_constraint.conrelid
    WHERE relation.relnamespace = 'public'::regnamespace
    ORDER BY relation.relname, table_constraint.conname
  `;
  const [systemScope] = await client`
    SELECT pg_get_functiondef(oid) AS definition,
      pg_get_userbyid(proowner) AS owner,
      proacl::text AS acl
    FROM pg_proc
    WHERE oid = 'public.omni_system_scope_enabled()'::regprocedure
  `;
  return {
    tables: [...tables],
    policies: [...policies],
    constraints: [...constraints],
    systemScope: { ...systemScope },
  };
}

// The catalog with the given CHECK constraints added NOT VALID.
function withUnvalidatedChecks(
  catalog: Awaited<ReturnType<typeof schemaCatalogSnapshot>>,
  checks: { tableName: string; constraintName: string }[],
) {
  const unvalidated = new Set(
    checks.map(({ tableName, constraintName }) => `${tableName}.${constraintName}`),
  );
  return {
    ...catalog,
    constraints: catalog.constraints.map((constraint) =>
      unvalidated.has(`${constraint.table_name}.${constraint.constraint_name}`)
        ? {
            ...constraint,
            definition: `${constraint.definition} NOT VALID`,
            validated: false,
          }
        : constraint,
    ),
  };
}

// Runs the operation with the schema catalog convergence migration and every
// later one pending, then puts back any ledger row the operation did not
// record again.
async function withSchemaConvergencePending<T>(
  client: ReturnType<typeof postgres>,
  operation: () => Promise<T>,
) {
  const recorded = await client`
    SELECT version, name, checksum, applied_at
    FROM omni_schema_version
    WHERE version >= ${schemaConvergenceVersion}
  `;
  expect(recorded.map((row) => row.version)).toContain(schemaConvergenceVersion);
  await client`
    DELETE FROM omni_schema_version
    WHERE version >= ${schemaConvergenceVersion}
  `;
  try {
    return await operation();
  } finally {
    for (const row of recorded) {
      await client`
        INSERT INTO omni_schema_version (version, name, checksum, applied_at)
        SELECT ${row.version}::int, ${row.name}::text, ${row.checksum}::text,
          ${row.applied_at}::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM omni_schema_version WHERE version = ${row.version}::int
        )
      `;
    }
  }
}

// Runs the pending migrations the way a new server process does.
async function migrateWithFreshClient() {
  vi.resetModules();
  const client = await import("@/lib/db/client");
  try {
    await client.ensureDatabaseSchema();
  } finally {
    await client.closeDatabaseClient();
    vi.resetModules();
  }
}

// Runs the operation while an event trigger records each DDL command, and
// counts the commands each statement of the schema catalog convergence
// migration ran. A command a DO block runs reports the whole block as its
// query.
async function convergenceDdlDuring(
  client: ReturnType<typeof postgres>,
  operation: () => Promise<void>,
) {
  await client`
    CREATE TABLE schema_convergence_ddl (
      tag TEXT NOT NULL,
      statement TEXT NOT NULL
    )
  `;
  await client.unsafe(`
    CREATE FUNCTION schema_convergence_ddl_start() RETURNS event_trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO schema_convergence_ddl (tag, statement)
      VALUES (
        tg_tag,
        CASE
          WHEN strpos(current_query(), '$policies$') > 0 THEN 'policies'
          WHEN strpos(current_query(), '$constraints$') > 0 THEN 'constraints'
          WHEN strpos(
            current_query(),
            'FUNCTION public.omni_system_scope_enabled()'
          ) > 0 THEN 'function'
          ELSE 'other'
        END
      );
    END
    $$
  `);
  await client`
    CREATE EVENT TRIGGER schema_convergence_ddl
    ON ddl_command_start
    EXECUTE FUNCTION schema_convergence_ddl_start()
  `;
  try {
    await operation();
    const rows = await client`
      SELECT statement, tag, count(*)::int AS commands
      FROM schema_convergence_ddl
      WHERE statement <> 'other'
      GROUP BY statement, tag
      ORDER BY statement, tag
    `;
    return rows.map((row) => ({
      statement: String(row.statement),
      tag: String(row.tag),
      commands: Number(row.commands),
    }));
  } finally {
    await client`DROP EVENT TRIGGER IF EXISTS schema_convergence_ddl`;
    await client`DROP FUNCTION IF EXISTS schema_convergence_ddl_start()`;
    await client`DROP TABLE IF EXISTS schema_convergence_ddl`;
  }
}

// Whether omni_system_scope_enabled() lets the role raise system scope.
async function systemScopeEnabledFor(
  client: ReturnType<typeof postgres>,
  roleName: string,
) {
  const [scope] = await client.begin(async (transaction) => {
    await transaction`SELECT set_config('omni.system_scope', 'true', true)`;
    await transaction`
      SELECT set_config('omni.system_reason', 'integration scope check', true)
    `;
    await transaction.unsafe(`SET LOCAL ROLE ${roleName}`);
    return transaction`SELECT omni_system_scope_enabled() AS enabled`;
  });
  return Boolean(scope.enabled);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Operation exceeded ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function databaseUrlForRole(databaseUrl: string, roleName: string) {
  const url = new URL(databaseUrl);
  url.username = roleName;
  url.password = "integration-only";
  return url.toString();
}

// Far enough ahead that no test run reaches a schedule's first occurrence.
const scheduleStartsAt = `${new Date().getUTCFullYear() + 2}-01-01T00:00:00.000Z`;

function scheduleTriggerInput(input: {
  tenantId: string;
  actorId: string;
  key: string;
  missedPolicy?: "skip" | "run_once";
}) {
  return {
    tenantId: input.tenantId,
    triggerKind: "schedule" as const,
    name: `Schedule ${input.key}`,
    source: "saved-procedure",
    workflowMode: "orchestrate" as const,
    executionScope: createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: input.actorId,
      correlationId: `correlation:${input.key}`,
      purpose: "workflow.schedule.create",
    }),
    idempotencyKey: input.key,
    schedule: {
      timezone: "UTC",
      rrule: "FREQ=DAILY;INTERVAL=1;BYHOUR=0;BYMINUTE=0",
      startsAt: scheduleStartsAt,
      maxOccurrences: 40,
      missedPolicy: input.missedPolicy || "skip",
      procedurePin: {
        schemaVersion: 1 as const,
        procedureId: "procedure:integration-review",
        snapshotSha256: "1".repeat(64),
        reviewedSnapshotSha256: "2".repeat(64),
        reviewedAt: "2026-09-01T00:00:00.000Z",
      },
      agentIdentityPin: buildAgentRunIdentityPinV1({
        runId: `schedule-review-${input.key}`,
        identity: buildBuiltInAgentIdentityV1({
          agentId: "atlas",
          tenantId: input.tenantId,
          controllerActorId: input.actorId,
        }),
      }),
      occurrenceBudget: {
        modelTurns: 4,
        tokens: 24_000,
        costMicrousd: 600_000,
        wallTimeMs: 180_000,
        toolCalls: 20,
        browserActions: 0,
        agents: 0,
        fanOut: 0,
        retries: 1,
        replans: 1,
      },
      failureLimit: 3,
    },
  };
}
