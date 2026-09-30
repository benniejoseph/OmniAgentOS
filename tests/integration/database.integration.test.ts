import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import {
  WORKFLOW_APPROVAL_RISK_LEVEL,
  approvalPriorityMs,
} from "@/lib/approvals/order";
import type { MobileIdentity } from "@/lib/auth/mobile-types";
import { VECTOR_INDEX_DIMENSIONS } from "@/lib/config";
import {
  databaseSchemaMigrations,
  ensureDatabaseSchema,
  getSchemaMigrationSteps,
  getSql,
  getVectorStoreStatus,
  migrationScopedTenantTables,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
  tenantIsolationExemptTables,
  tenantPolicyTables,
} from "@/lib/db/client";
import { sqlMigrationFileDigest } from "@/lib/db/sql-migration-files";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import { memoryContentDigest } from "@/lib/memory/content-digest";
import { rebuildMemoryGraph } from "@/lib/memory/graph";
import {
  recordHeldMemoryDataRightRequestV1,
  type MemoryDataRightRequestWriterSql,
  type RecordHeldMemoryDataRightRequestResultV1,
} from "@/lib/memory/data-right-request-writer";
import { saveMemories } from "@/lib/memory/store";
import { reconcileMissionProjections } from "@/lib/missions/reconcile";
import { attachMissionExecutor } from "@/lib/missions/runtime";
import {
  createMission,
  ensureMissionTask,
  listEndedMissionsToReconcile,
  listMissionAttemptsToReconcile,
  transitionMissionAttempt,
  transitionMissionTask,
} from "@/lib/missions/store";
import {
  listPendingSloPolicyChangePage,
  requestObservabilitySloPolicyChange,
} from "@/lib/observability/slo-policy-store";
import {
  createProject,
  getProject,
  updateProjectExecution,
} from "@/lib/projects/store";
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
import { getApprovalQueue, getApprovalQueueItem } from "@/lib/operations/queue";
import {
  getWorkerReleaseActivation,
  listWorkerReleaseActivations,
  recordWorkerHeartbeat,
} from "@/lib/operations/worker-heartbeat";
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
import { loadTenantAiUsageSince } from "@/lib/usage/allowance";
import { tenantHasAtMostOneActiveMember } from "@/lib/auth/tenant-membership";
import { approvalMaterialBindingSha256 } from "@/lib/tools/approval-binding";
import {
  approveAndClaimToolExecution,
  claimIdempotentToolExecution,
  completeClaimedToolExecution,
  createToolExecutionRecord,
  getToolExecution,
  getToolExecutionEffectIntentV2,
  listPendingToolApprovalPage,
  persistClaimedToolEffectIntentV2,
  publicToolExecution,
  savePendingToolApproval,
  saveToolExecution,
  sealToolExecutionInput,
  withdrawPendingToolApproval,
} from "@/lib/tools/audit-store";
import { AgentRunNotActiveError } from "@/lib/runs/active-run-fence";
import {
  buildEffectIntentV2,
  finalizeEffectIntentV2,
} from "@/lib/tools/effect-intent-v2";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  getToolExecutionScopeBinding,
  ToolExecutionScopeBindingError,
  toolInputSha256,
} from "@/lib/tools/execution-scope";
import {
  appendWorkflowEvent,
  bindWorkflowRunExecutionAuthority,
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunExecutionAuthority,
  listRunnableWorkflowRuns,
  listWorkflowApprovalPage,
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
    // The fixture is no app table, and the catalog checks below read them all.
    await admin`DROP TABLE omni_jsonb_migration_fixture`;
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

  test("enables and forces RLS on every tenant table", async () => {
    const tenantTables = [...tenantPolicyTables, ...migrationScopedTenantTables];
    const rows = await admin`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relname = ANY(${tenantTables as readonly string[]})
    `;

    expect(rows).toHaveLength(tenantTables.length);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  test("classifies every table as a tenant table or as exempt", async () => {
    const rows = await admin`
      SELECT relation.relname AS table_name,
        EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attname = 'tenant_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) AS tenant_column
      FROM pg_class relation
      WHERE relation.relnamespace = 'public'::regnamespace
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname
    `;
    const tenantTables = new Set<string>([
      ...tenantPolicyTables,
      ...migrationScopedTenantTables,
    ]);
    const exemptTables = new Set(Object.keys(tenantIsolationExemptTables));
    const catalogTables = new Set(rows.map((row) => String(row.table_name)));

    // A new table fails here until it is classified.
    expect([...catalogTables].filter((tableName) =>
      !tenantTables.has(tableName) && !exemptTables.has(tableName)
    )).toEqual([]);
    expect([...tenantTables, ...exemptTables].filter((tableName) =>
      !catalogTables.has(tableName)
    )).toEqual([]);
    // An exempt table holds no tenant's rows, so it has no tenant column.
    expect(rows
      .filter((row) => row.tenant_column && exemptTables.has(String(row.table_name)))
      .map((row) => row.table_name)).toEqual([]);
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
      vi.stubEnv(
        "OMNIAGENT_INTERNAL_AUTH_SECRET",
        "integration-only-internal-secret-0123456789",
      );
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
        // Events keep digests of a memory's text: keyed ones now, plain ones
        // from before. Forget deletes those of each memory it forgets, only.
        const digestPayload = async (eventId: string) => {
          const [row] = await admin`
            SELECT payload FROM omni_events WHERE id = ${eventId}
          `;
          return row?.payload as Record<string, unknown> | undefined;
        };
        const sourceCreatedEventId = "memory_mutation_created_lineage-source";
        expect(await digestPayload(sourceCreatedEventId)).toMatchObject({
          schemaVersion: 2,
          memoryId: "lineage-source",
          titleHmac: memoryContentDigest(tenantId, "Agent source"),
          contentHmac: memoryContentDigest(tenantId, "agent-alpha private content"),
          sourceHmac: memoryContentDigest(tenantId, "effect-receipt"),
        });
        expect(memoryContentDigest(tenantId, "Agent source")).not.toBe(
          createHash("sha256").update("Agent source").digest("hex"),
        );
        await admin.unsafe(`
          INSERT INTO omni_events (id, stream_id, type, tenant_id, actor_id, payload)
          VALUES
            ('lineage-digest-copy', 'memory:${copyId}',
              'memory.reconciliation.detected', '${tenantId}', '${actorId}',
              '{"candidateMemoryId":"${copyId}","candidateContentSha256":"${"a".repeat(64)}","kind":"confirmation"}'::jsonb),
            ('lineage-digest-keep', 'memory:lineage-keep', 'memory.created',
              '${tenantId}', '${actorId}',
              '{"memoryId":"lineage-keep","contentSha256":"${"b".repeat(64)}"}'::jsonb),
            ('lineage-digest-other-type', 'memory:lineage-source',
              'memory.feedback_applied', '${tenantId}', '${actorId}',
              '{"memoryId":"lineage-source","contentSha256":"${"c".repeat(64)}"}'::jsonb),
            ('lineage-digest-other-tenant', 'memory:lineage-source',
              'memory.created', 'lineage-other-tenant', '${actorId}',
              '{"memoryId":"lineage-source","contentSha256":"${"d".repeat(64)}"}'::jsonb),
            ('lineage-digest-none', 'memory:lineage-source', 'memory.created',
              '${tenantId}', '${actorId}', '{"memoryId":"lineage-source"}'::jsonb)
        `);
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
        const forgottenSource = await digestPayload(sourceCreatedEventId);
        expect(forgottenSource).toMatchObject({
          schemaVersion: 2,
          memoryId: "lineage-source",
          digestsForgottenAt: forgotten?.receipt?.forgottenAt,
        });
        for (const field of ["titleHmac", "contentHmac", "sourceHmac"]) {
          expect(forgottenSource).not.toHaveProperty(field);
        }
        expect(await digestPayload("lineage-digest-copy")).toEqual({
          candidateMemoryId: copyId,
          kind: "confirmation",
          digestsForgottenAt: forgotten?.receipt?.forgottenAt,
        });
        for (const [eventId, digest] of [
          ["lineage-digest-keep", "b"],
          ["lineage-digest-other-type", "c"],
          ["lineage-digest-other-tenant", "d"],
        ]) {
          const payload = await digestPayload(eventId);
          expect(payload).toMatchObject({ contentSha256: digest.repeat(64) });
          expect(payload).not.toHaveProperty("digestsForgottenAt");
        }
        expect(await digestPayload("lineage-digest-none")).toEqual({
          memoryId: "lineage-source",
        });
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
      outcome: "withdrawn",
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

    // An approval past its window is withdrawn by its claim with its input
    // kept, and a pending approval is withdrawn once with the reason given.
    const expiredReason =
      "Withdrawn: the approval expired before a decision was made.";
    const lapsedReason =
      "Withdrawn: the member who requested this action no longer belongs to this workspace.";
    const expired = await inTenant(() => saveToolExecution({
      ...pendingRecord("approve-db-expired"),
      createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    }));
    const lapsed = await inTenant(() => saveToolExecution(
      pendingRecord("approve-db-lapsed"),
    ));
    const withdraw = (id: string) => inTenant(() => withdrawPendingToolApproval({
      id,
      tenantId,
      reason: lapsedReason,
    }));

    await expect(approve(expired.id)).resolves.toMatchObject({
      outcome: "withdrawn",
      record: { status: "rejected", reason: expiredReason, input: toolInput },
    });
    await expect(withdraw(lapsed.id)).resolves.toMatchObject({
      status: "rejected",
      approvalDecision: "rejected",
      reason: lapsedReason,
    });
    await expect(withdraw(lapsed.id)).resolves.toBeUndefined();
    await expect(withdraw(delegated.id)).resolves.toBeUndefined();
    expect(await admin`
      SELECT id, status, approval_decision, reason, input
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId}
        AND id = ANY(${[expired.id, lapsed.id, delegated.id]})
      ORDER BY id
    `).toEqual([
      {
        id: delegated.id,
        status: "executing",
        approval_decision: "approved",
        reason: null,
        input: toolInput,
      },
      {
        id: expired.id,
        status: "rejected",
        approval_decision: "rejected",
        reason: expiredReason,
        input: toolInput,
      },
      {
        id: lapsed.id,
        status: "rejected",
        approval_decision: "rejected",
        reason: lapsedReason,
        input: toolInput,
      },
    ]);
    expect(await withdrawnEvents([expired.id, lapsed.id])).toEqual([
      { stream_id: `tool_execution:${expired.id}` },
      { stream_id: `tool_execution:${lapsed.id}` },
    ]);
  });

  test("reads the role an approval's requester holds now", async () => {
    const tenantId = "current_role_tenant";
    const email = "current-role-tenant@example.com";
    await withPrivateMobileAccount(tenantId, async () => {
      const auth = await import("@/lib/auth/store");
      const safety = await import("@/lib/a2a/safety-store");
      const role = (actorId: string, tenant = tenantId) =>
        auth.currentAccountRoleInTenant({ tenantId: tenant, actorId });

      await expect(role(email.toUpperCase())).resolves.toBe("operator");
      await expect(role("internal-service")).resolves.toBeUndefined();
      await expect(role(email, "current_role_elsewhere")).resolves.toBeNull();
      await admin`
        UPDATE omni_auth_memberships
        SET status = 'disabled'
        WHERE tenant_id = ${tenantId}
      `;
      await expect(role(email)).resolves.toBeNull();
      await expect(runWithDatabaseTenantScope(tenantId, () =>
        safety.findExternalA2ASafetyForDelegation({
          tenantId,
          ownerActorId: email,
          delegationId: "delegation-without-reservation",
        }))).resolves.toBeUndefined();
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

  test("runs a tenant's schedule owners by their oldest work, not their names", async () => {
    await ensureDatabaseSchema();
    const tenantId = "schedule_owner_order";
    const otherTenantId = "schedule_owner_order_other";
    const userId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const actorFor = (n: number) => `actor:${userId(n)}`;
    for (const [id, slug] of [
      [tenantId, "schedule-owner-order"],
      [otherTenantId, "schedule-owner-other"],
    ]) {
      await admin`
        INSERT INTO omni_auth_tenants (id, name, slug)
        VALUES (${id}, 'Schedule owners', ${slug})
      `;
    }
    for (let n = 105; n <= 109; n += 1) {
      await admin`
        INSERT INTO omni_auth_users (id, email, password_hash)
        VALUES (${userId(n)}, ${`schedule-owner-${n}@example.test`}, 'test-only')
      `;
      await admin`
        INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
        VALUES (
          ${`membership:schedule-owner-${n}`},
          ${n === 109 ? otherTenantId : tenantId},
          ${userId(n)},
          'admin'
        )
      `;
    }
    const create = (tenant: string, n: number, key: string) =>
      runWithDatabaseTenantScope(tenant, () => createWorkflowTrigger(
        scheduleTriggerInput({ tenantId: tenant, actorId: actorFor(n), key }),
      ));
    const [{ base }] = await admin`
      SELECT date_trunc('second', clock_timestamp()) AS base
    `;
    const due = (triggerId: string, next: string) => admin`
      UPDATE omni_workflow_triggers
      SET next_due_at = ${base}::timestamptz + ${next}::interval,
          shadow_next_due_at = ${base}::timestamptz + interval '1 day'
      WHERE id = ${triggerId}
    `;
    const workflowRun = async (tenant: string, status: string, endedAt: string | null) => {
      const { run } = await runWithDatabaseTenantScope(tenant, () => createWorkflowRun({
        tenantId: tenant,
        goal: "Send the weekly digest.",
      }));
      await admin`
        UPDATE omni_workflow_runs
        SET status = ${status},
            completed_at = ${base}::timestamptz + ${endedAt}::interval
        WHERE id = ${run.id}
      `;
      return run.id;
    };
    const occurrence = (
      triggerId: string,
      occurrenceId: string,
      offset: string,
      workflowRunId?: string,
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
        ${workflowRunId ? "enqueued" : "claimed"}::text,
        ${base}::timestamptz + ${offset}::interval,
        ${base}::timestamptz + ${offset}::interval,
        'due', 1, 1, schedule_config_sha256, agent_identity_pin_sha256,
        policy_pin_sha256, procedure_snapshot_sha256, reviewed_snapshot_sha256,
        occurrence_budget_sha256, repeat('a', 64),
        ${workflowRunId || null}::text,
        ${workflowRunId ? `job:${occurrenceId}` : null}::text
      FROM omni_workflow_triggers
      WHERE id = ${triggerId}
    `;

    const going = await create(tenantId, 105, "schedule-owner-going");
    const dueCursor = await create(tenantId, 106, "schedule-owner-due");
    const claimed = await create(tenantId, 107, "schedule-owner-claimed");
    const ended = await create(tenantId, 108, "schedule-owner-ended");
    const other = await create(otherTenantId, 109, "schedule-owner-other");
    // The first owner by name has only a queued run that is still going.
    await occurrence(
      going.id,
      "schedule-owner-going-run",
      "-3 hours",
      await workflowRun(tenantId, "running", null),
    );
    await due(dueCursor.id, "-1 hour");
    await occurrence(claimed.id, "schedule-owner-claimed-run", "-30 minutes");
    // The last owner by name has the oldest work: a queued run that ended.
    await occurrence(
      ended.id,
      "schedule-owner-ended-run",
      "-3 hours",
      await workflowRun(tenantId, "completed", "-2 hours"),
    );
    // The other tenant's owner has older work of every kind.
    await due(other.id, "-4 hours");
    await occurrence(other.id, "schedule-owner-other-claimed", "-5 hours");
    await occurrence(
      other.id,
      "schedule-owner-other-ended",
      "-7 hours",
      await workflowRun(otherTenantId, "failed", "-6 hours"),
    );

    const owners = (limit?: number) => listDueWorkflowScheduleOwners({ tenantId, limit })
      .then((listed) => listed.owners.map((owner) => owner.actorId));
    try {
      await expect(owners()).resolves.toEqual([actorFor(108), actorFor(106), actorFor(107)]);
      // A pass of one owner reaches the oldest work and records the ended run.
      await expect(processDueWorkflowSchedulesForTenant({
        tenantId,
        systemActorId: "integration-worker",
        correlationId: "correlation:schedule-owner-order",
        limit: 1,
      })).resolves.toEqual({
        ownerActors: 1,
        ownerFailures: 0,
        shadowEvaluated: 0,
        occurrencesClaimed: 0,
        occurrencesEnqueued: 0,
        occurrencesSkipped: 0,
        occurrencesMissed: 0,
        occurrencesFailed: 0,
        occurrencesReconciled: 1,
      });
      const [recorded] = await admin`
        SELECT status FROM omni_workflow_schedule_occurrences
        WHERE id = 'schedule-owner-ended-run'
      `;
      expect(recorded.status).toBe("completed");
      await expect(owners()).resolves.toEqual([actorFor(106), actorFor(107)]);
      await expect(owners(1)).resolves.toEqual([actorFor(106)]);
    } finally {
      // Later passes list every tenant's due work, so leave none behind.
      await admin`
        UPDATE omni_workflow_triggers
        SET status = 'paused'
        WHERE tenant_id IN (${tenantId}, ${otherTenantId}) AND trigger_kind = 'schedule'
      `;
      await admin`
        UPDATE omni_workflow_schedule_occurrences
        SET status = 'skipped'
        WHERE tenant_id IN (${tenantId}, ${otherTenantId})
          AND status IN ('claimed', 'enqueued')
      `;
    }
  });

  test("writes a project's execution status only while it keeps the status expected", async () => {
    await ensureDatabaseSchema();
    const tenantId = "project_status_check";
    const userId = "00000000-0000-4000-8000-000000000110";
    const actorId = `actor:${userId}`;
    const owner = { tenantId, actorId };
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES (${tenantId}, 'Project status', 'project-status-check')
    `;
    await admin`
      INSERT INTO omni_auth_users (id, email, password_hash)
      VALUES (${userId}, 'project-status@example.test', 'test-only')
    `;
    await admin`
      INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
      VALUES ('membership:project-status', ${tenantId}, ${userId}, 'admin')
    `;
    const mutation = (key: string) => ({
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "user",
        executingPrincipalId: actorId,
        correlationId: `project-status:${key}`,
        purpose: `project.test.${key}`,
      }),
      idempotencyKey: `project-status:${key}`,
    });
    const asOwner = <T,>(operation: () => Promise<T>) =>
      runWithDatabaseActorScope(tenantId, [actorId], operation);
    const project = await asOwner(() => createProject({
      ...owner,
      title: "Status check",
      objective: "A pause stands.",
      mutation: mutation("create"),
    }));
    await asOwner(() => updateProjectExecution(project.id, { executionStatus: "paused" }, {
      ...owner,
      mutation: mutation("pause"),
    }));

    // A sync that read the project running does not write over its pause.
    await expect(asOwner(() => updateProjectExecution(project.id, {
      executionStatus: "running",
      lastSyncedAt: new Date().toISOString(),
    }, {
      ...owner,
      expectedExecutionStatus: "running",
      mutation: mutation("sync"),
    }))).resolves.toBeUndefined();
    await expect(asOwner(() => getProject(project.id, owner))).resolves.toMatchObject({
      executionStatus: "paused",
    });
    await expect(asOwner(() => updateProjectExecution(project.id, { executionStatus: "running" }, {
      ...owner,
      expectedExecutionStatus: "paused",
      mutation: mutation("resume"),
    }))).resolves.toMatchObject({ executionStatus: "running" });
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

  test("binds a new scoped tool execution in the transaction that creates it", async () => {
    const tenantId = "scope_bind_tenant";
    const actorId = "scope_bind_actor";
    const inTenant = <T,>(operation: () => Promise<T>) =>
      runWithDatabaseTenantScope(tenantId, operation);
    const toolInput = { query: "standup", limit: 5 };
    const scopeFor = (initiatingActorId: string) => createExecutionScope({
      tenantId,
      initiatingActorId,
      executingPrincipalType: "user",
      executingPrincipalId: initiatingActorId,
      correlationId: "correlation:scope-bind-db",
      purpose: "tool.execution.claim",
    });
    const scope = scopeFor(actorId);
    const scoped = {
      executionScope: scope,
      scopeBinding: { toolInput, requesterRole: "operator" as const },
    };
    const executing = (id: string) => ({
      ...createToolExecutionRecord({
        tenantId,
        actorId,
        toolId: "memory.search",
        toolName: "Search memory",
        riskLevel: 0,
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
        reason: "Claimed.",
      }),
      id,
    });
    const bindingEvents = (ids: string[]) => admin`
      SELECT stream_id, actor_id, correlation_id
      FROM omni_events
      WHERE tenant_id = ${tenantId}
        AND stream_id = ANY(${ids.map((id) => `tool_execution:${id}`)})
        AND type = 'tool.scope_bound'
      ORDER BY stream_id
    `;
    const storedIds = (ids: string[]) => admin`
      SELECT id FROM omni_tool_executions
      WHERE tenant_id = ${tenantId} AND id = ANY(${ids})
      ORDER BY id
    `;
    const expectBound = async (id: string) => {
      const binding = await inTenant(() =>
        getToolExecutionScopeBinding(id, { tenantId })
      );
      expect(binding).toMatchObject({
        requesterRole: "operator",
        toolId: "memory.search",
        inputSha256: toolInputSha256(toolInput),
      });
      expect(binding?.executionScope).toEqual(scope);
    };

    // The claim alone leaves the record bound; nothing has to run after it.
    await expect(inTenant(() => claimIdempotentToolExecution(
      executing("scope-bind-claim"),
      { ...scoped, idempotencyKey: "scope-bind-claim:call-1" },
    ))).resolves.toMatchObject({ outcome: "claimed" });
    await expectBound("scope-bind-claim");

    // The same key again finds that record and binds nothing more.
    await expect(inTenant(() => claimIdempotentToolExecution(
      executing("scope-bind-claim"),
      { ...scoped, idempotencyKey: "scope-bind-claim:call-1" },
    ))).resolves.toMatchObject({ outcome: "existing" });
    expect(await bindingEvents(["scope-bind-claim"])).toEqual([{
      stream_id: "tool_execution:scope-bind-claim",
      actor_id: actorId,
      correlation_id: "correlation:scope-bind-db",
    }]);

    // A new scoped record saved without a key is bound the same way.
    await inTenant(() => saveToolExecution(
      executing("scope-bind-save"),
      { ...scoped, idempotencyKey: "scope-bind-save" },
    ));
    await expectBound("scope-bind-save");

    // A binding that cannot be written takes its record with it.
    const refused = ["scope-bind-refused-claim", "scope-bind-refused-save"];
    await admin.unsafe(`
      CREATE FUNCTION scope_bind_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'simulated binding write failure';
      END
      $$
    `);
    await admin.unsafe(`
      CREATE TRIGGER scope_bind_refuse
      BEFORE INSERT ON omni_events
      FOR EACH ROW
      WHEN (NEW.type = 'tool.scope_bound' AND NEW.tenant_id = '${tenantId}')
      EXECUTE FUNCTION scope_bind_refuse()
    `);
    try {
      await expect(inTenant(() => claimIdempotentToolExecution(
        executing(refused[0]),
        { ...scoped, idempotencyKey: `${refused[0]}:call-1` },
      ))).rejects.toThrow("simulated binding write failure");
      await expect(inTenant(() => saveToolExecution(
        executing(refused[1]),
        { ...scoped, idempotencyKey: refused[1] },
      ))).rejects.toThrow("simulated binding write failure");
    } finally {
      await admin`DROP TRIGGER IF EXISTS scope_bind_refuse ON omni_events`;
      await admin`DROP FUNCTION IF EXISTS scope_bind_refuse()`;
    }
    expect(await storedIds(refused)).toEqual([]);
    expect(await admin`
      SELECT id FROM omni_events
      WHERE tenant_id = ${tenantId}
        AND stream_id = ANY(${refused.map((id) => `tool_execution:${id}`)})
    `).toEqual([]);

    // A scope that cannot bind the record is refused before any write.
    const foreign = {
      executionScope: scopeFor("scope_bind_other_actor"),
      scopeBinding: scoped.scopeBinding,
    };
    await expect(inTenant(() => claimIdempotentToolExecution(
      executing("scope-bind-foreign"),
      { ...foreign, idempotencyKey: "scope-bind-foreign:call-1" },
    ))).rejects.toBeInstanceOf(ToolExecutionScopeBindingError);
    expect(await storedIds(["scope-bind-foreign"])).toEqual([]);
    expect(await bindingEvents(["scope-bind-foreign"])).toEqual([]);
  });

  test("queues one approval per tool execution id and replaces only a failure that changed nothing", async () => {
    const tenantId = "pending_approval_tenant";
    const actorId = "pending_approval_actor";
    const createdAt = "2026-09-01T00:00:00.000Z";
    const inTenant = <T,>(operation: () => Promise<T>, tenant = tenantId) =>
      runWithDatabaseTenantScope(tenant, operation);
    const request = {
      tenantId,
      actorId,
      toolId: "memory.write",
      toolName: "Write memory",
      riskLevel: 2,
      dryRun: false,
      approvalRequired: true,
      input: { title: "Standup", content: "Standup moved to 10am." },
    } as const;
    const approval = (id: string) => ({
      ...createToolExecutionRecord({
        ...request,
        status: "approval_required",
        reason: "Waiting for approval.",
      }),
      id,
    });
    const failed = (id: string, output: Record<string, unknown>) => ({
      ...createToolExecutionRecord({
        ...request,
        status: "failed",
        output,
        reason: "The first attempt failed.",
        completedAt: createdAt,
      }),
      id,
      createdAt,
    });
    const asWrite = { retryFailed: { operationClass: "mutation" as const } };
    const statuses = async (id: string) => (await admin`
      SELECT status FROM omni_tool_executions
      WHERE tenant_id = ${tenantId} AND id = ${id}
    `).map((row) => row.status);
    const operations = async (id: string) => (await admin`
      SELECT payload->>'operation' AS operation
      FROM omni_events
      WHERE tenant_id = ${tenantId}
        AND stream_id = ${`tool_execution:${id}`}
        AND type = 'tool.execution.upserted'
    `).map((event) => event.operation);

    // A retry, or a concurrent duplicate, gets the queued approval back.
    const queued = approval("pending-db-once");
    await expect(inTenant(() => savePendingToolApproval(queued))).resolves
      .toMatchObject({ outcome: "saved", record: { id: queued.id } });
    const duplicates = await Promise.all([1, 2, 3].map(() =>
      inTenant(() => savePendingToolApproval(approval(queued.id), asWrite))
    ));
    for (const duplicate of duplicates) {
      expect(duplicate).toMatchObject({
        outcome: "existing",
        record: { id: queued.id, status: "approval_required", createdAt: queued.createdAt },
      });
    }
    expect(await operations(queued.id)).toEqual(["saved"]);

    // A write interrupted before its tool started gives way under the lock;
    // a write that failed on its own error, or with no retry asked for, stands.
    const interrupted = failed("pending-db-interrupted", {
      error: "This operation was aborted",
      interrupted: "before_start",
    });
    const writeError = failed("pending-db-write-error", {
      error: "Memory quota exceeded.",
    });
    const unrequested = failed("pending-db-unrequested", {
      error: "This operation was aborted",
      interrupted: "before_start",
    });
    for (const record of [interrupted, writeError, unrequested]) {
      await inTenant(() => saveToolExecution(record));
    }
    const retry = approval(interrupted.id);
    await expect(inTenant(() => savePendingToolApproval(retry, asWrite))).resolves
      .toMatchObject({
        outcome: "saved",
        record: { id: interrupted.id, status: "approval_required", createdAt: retry.createdAt },
      });
    expect(await statuses(interrupted.id)).toEqual(["approval_required"]);
    expect(await operations(interrupted.id)).toEqual(["saved", "saved"]);
    for (const [record, options] of [[writeError, asWrite], [unrequested, {}]] as const) {
      await expect(inTenant(() => savePendingToolApproval(approval(record.id), options)))
        .resolves.toMatchObject({
          outcome: "existing",
          record: { id: record.id, status: "failed" },
        });
      expect(await statuses(record.id)).toEqual(["failed"]);
      expect(await operations(record.id)).toEqual(["saved"]);
    }

    // Another tenant's id, or a run that is not active, queues nothing.
    const otherTenant = "pending_approval_other";
    await expect(inTenant(
      () => savePendingToolApproval({ ...approval(queued.id), tenantId: otherTenant }),
      otherTenant,
    )).rejects.toThrow("collided with another tenant");
    await expect(inTenant(() => savePendingToolApproval(
      approval("pending-db-missing-run"),
      { activeAgentRun: { runId: "pending-db-missing-run" } },
    ))).rejects.toBeInstanceOf(AgentRunNotActiveError);
    expect(await statuses("pending-db-missing-run")).toEqual([]);
    expect(await operations("pending-db-missing-run")).toEqual([]);
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
        AND relation.relname = ANY(${[
          ...tenantPolicyTables,
          ...migrationScopedTenantTables,
        ] as readonly string[]})
        AND NOT policy.polpermissive
        AND policy.polname ~ '_actor$'
      ORDER BY relation.relname
    `;
    // Each one covers every command and role, as its restore below does.
    expect(restrictivePolicies.map(({ command, roles }) => ({ command, roles })))
      .toEqual(Array(49).fill({ command: "*", roles: "{0}" }));
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

  test("reports an app table that no isolation class covers", async () => {
    const tenantId = "tenant_unclassified_table";
    const isolationReport = () =>
      runWithDatabaseTenantScope(tenantId, () => getTenantIsolationReport(tenantId));
    expect((await isolationReport()).status).toBe("passing");

    await admin`CREATE TABLE public.omni_unclassified_notes (id TEXT PRIMARY KEY)`;
    await admin`CREATE TABLE public.unrelated_notes (id TEXT PRIMARY KEY)`;
    try {
      const report = await isolationReport();
      expect(report.status).toBe("degraded");
      expect(report.summary).toMatchObject({
        failingTables: 0,
        unclassifiedTables: ["omni_unclassified_notes"],
      });
      expect(report.recommendations[0]).toMatch(/^Classify each new table/);
    } finally {
      await admin`DROP TABLE public.omni_unclassified_notes`;
      await admin`DROP TABLE public.unrelated_notes`;
    }
    expect((await isolationReport()).summary.unclassifiedTables).toEqual([]);
  });

  test("gives a mobile refresh token replaced in the last 60 seconds the pair that replaced it, and revokes on any other replaced token", async () => {
    await withPrivateMobileAccount("tenant_refresh_retry", async ({ signIn }) => {
      const mobile = await import("@/lib/auth/mobile");
      const sessionRow = async (sessionId: string) => {
        const [row] = await admin`
          SELECT * FROM omni_mobile_sessions WHERE id = ${sessionId}
        `;
        return row;
      };
      const reissued = async (
        refreshToken: string,
        deviceId: string,
        client?: typeof androidClient,
      ) => (await mobile.rotateMobileRefreshToken(refreshToken, deviceId, client)).tokens;
      const refused = (refreshToken: string, deviceId: string) =>
        mobile.rotateMobileRefreshToken(refreshToken, deviceId, androidClient).then(
          () => "rotated",
          (error: { code?: string }) => error.code,
        );

      const first = await signIn("android-refresh-retry-1");
      const firstId = first.identity.session.id;
      expect(await sessionRow(firstId)).toMatchObject({
        refresh_rotated_at: null,
        refresh_rotation_key: null,
      });
      const rotated = await mobile.rotateMobileRefreshToken(
        first.tokens.refreshToken,
        "android-refresh-retry-1",
      );
      const afterRotation = await sessionRow(firstId);
      expect(afterRotation.refresh_rotated_at).not.toBeNull();
      expect(afterRotation.refresh_rotation_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Without and with the attestation, and neither writes to the session.
      await expect(reissued(first.tokens.refreshToken, "android-refresh-retry-1"))
        .resolves.toEqual(rotated.tokens);
      await expect(
        reissued(first.tokens.refreshToken, "android-refresh-retry-1", androidClient),
      ).resolves.toEqual(rotated.tokens);
      expect(await sessionRow(firstId)).toEqual(afterRotation);
      await expect(
        mobile.getMobileIdentityFromRequest(bearerRequest(rotated.tokens.accessToken)),
      ).resolves.toMatchObject({ session: { id: firstId } });

      const next = await mobile.rotateMobileRefreshToken(
        rotated.tokens.refreshToken,
        "android-refresh-retry-1",
        androidClient,
      );
      expect((await sessionRow(firstId)).refresh_rotation_key)
        .not.toBe(afterRotation.refresh_rotation_key);
      await expect(
        reissued(rotated.tokens.refreshToken, "android-refresh-retry-1", androidClient),
      ).resolves.toEqual(next.tokens);
      // The 60 seconds are measured on the database clock, either side of the
      // rotation, so a retry that started before the rotation committed gets
      // the pair too.
      await admin`
        UPDATE omni_mobile_sessions
        SET refresh_rotated_at = NOW() + INTERVAL '59 seconds'
        WHERE id = ${firstId}
      `;
      await expect(
        reissued(rotated.tokens.refreshToken, "android-refresh-retry-1", androidClient),
      ).resolves.toEqual(next.tokens);
      await admin`
        UPDATE omni_mobile_sessions
        SET refresh_rotated_at = NOW() - INTERVAL '59 seconds'
        WHERE id = ${firstId}
      `;
      await expect(
        reissued(rotated.tokens.refreshToken, "android-refresh-retry-1", androidClient),
      ).resolves.toEqual(next.tokens);
      await admin`
        UPDATE omni_mobile_sessions
        SET refresh_rotated_at = NOW() + INTERVAL '61 seconds'
        WHERE id = ${firstId}
      `;
      await expect(refused(rotated.tokens.refreshToken, "android-refresh-retry-1"))
        .resolves.toBe("refresh_token_reuse");
      await expect(refused(next.tokens.refreshToken, "android-refresh-retry-1"))
        .resolves.toBe("invalid_refresh_token");
      expect(await sessionRow(firstId)).toMatchObject({ revocation_reason: "refresh_reuse" });

      const second = await signIn("android-refresh-retry-2");
      const secondRotated = await mobile.rotateMobileRefreshToken(
        second.tokens.refreshToken,
        "android-refresh-retry-2",
        androidClient,
      );
      await admin`
        UPDATE omni_mobile_sessions
        SET refresh_rotated_at = NOW() - INTERVAL '61 seconds'
        WHERE id = ${second.identity.session.id}
      `;
      await expect(refused(second.tokens.refreshToken, "android-refresh-retry-2"))
        .resolves.toBe("refresh_token_reuse");
      await expect(refused(secondRotated.tokens.refreshToken, "android-refresh-retry-2"))
        .resolves.toBe("invalid_refresh_token");

      // A signed-out session stays signed out, and keeps its reason.
      const third = await signIn("android-refresh-retry-3");
      await mobile.rotateMobileRefreshToken(
        third.tokens.refreshToken,
        "android-refresh-retry-3",
        androidClient,
      );
      await mobile.revokeMobileSession(third.identity);
      await expect(refused(third.tokens.refreshToken, "android-refresh-retry-3"))
        .resolves.toBe("invalid_refresh_token");
      expect(await sessionRow(third.identity.session.id))
        .toMatchObject({ revocation_reason: "logout" });

      const fourth = await signIn("android-refresh-retry-4");
      await mobile.rotateMobileRefreshToken(
        fourth.tokens.refreshToken,
        "android-refresh-retry-4",
        androidClient,
      );
      await admin`
        UPDATE omni_auth_memberships
        SET status = 'suspended'
        WHERE user_id = ${fourth.identity.user.id}
      `;
      await expect(refused(fourth.tokens.refreshToken, "android-refresh-retry-4"))
        .resolves.toBe("invalid_refresh_token");
      expect(await sessionRow(fourth.identity.session.id))
        .toMatchObject({ revocation_reason: "membership_changed" });
    });
  });

  test("keeps a refresh rotation key only beside its rotation time, as a 43-character base64url key", async () => {
    const [constraint] = await admin`
      SELECT convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'public.omni_mobile_sessions'::regclass
        AND conname = 'omni_mobile_sessions_refresh_rotation_check'
    `;
    // Added without scanning the table, whose rows all lacked a key then.
    expect(constraint).toEqual({ validated: false });
    const [session] = await admin`
      SELECT id FROM omni_mobile_sessions
      WHERE refresh_rotation_key IS NOT NULL
      ORDER BY created_at
      LIMIT 1
    `;
    expect(session).toBeDefined();
    const setRotation = (rotatedAt: string, key: string) =>
      admin.unsafe(`
        UPDATE public.omni_mobile_sessions
        SET refresh_rotated_at = ${rotatedAt}, refresh_rotation_key = ${key}
        WHERE id = '${String(session.id)}'
      `);

    for (const [rotatedAt, key] of [
      ["NOW()", "NULL"],
      ["NULL", "repeat('a', 43)"],
      ["NOW()", "repeat('a', 42)"],
      ["NOW()", "repeat('a', 44)"],
      ["NOW()", "repeat('a', 42) || '='"],
      ["NOW()", "repeat('a', 42) || '+'"],
    ]) {
      await expect(setRotation(rotatedAt, key)).rejects.toMatchObject({ code: "23514" });
    }
    await setRotation("NOW()", "repeat('-_', 21) || 'Z'");
    await setRotation("NULL", "NULL");
  });

  test("refuses to migrate over a refresh rotation column that exists with another type, default or nullability", async () => {
    const alter = "ALTER TABLE public.omni_mobile_sessions ALTER COLUMN";
    const variants = [
      {
        change: [`${alter} refresh_rotated_at TYPE TIMESTAMP`],
        restore: [`${alter} refresh_rotated_at TYPE TIMESTAMPTZ`],
      },
      {
        change: [`${alter} refresh_rotation_key TYPE VARCHAR(43)`],
        restore: [`${alter} refresh_rotation_key TYPE TEXT`],
      },
      {
        change: [`${alter} refresh_rotated_at SET DEFAULT NOW()`],
        restore: [`${alter} refresh_rotated_at DROP DEFAULT`],
      },
      {
        change: [
          `UPDATE public.omni_mobile_sessions
           SET refresh_rotated_at = COALESCE(refresh_rotated_at, NOW()),
             refresh_rotation_key = COALESCE(refresh_rotation_key, repeat('a', 43))`,
          `${alter} refresh_rotation_key SET NOT NULL`,
        ],
        restore: [`${alter} refresh_rotation_key DROP NOT NULL`],
      },
    ];
    const rotations = () => admin`
      SELECT id, refresh_rotated_at, refresh_rotation_key
      FROM omni_mobile_sessions
      ORDER BY id
    `;
    const fileCatalog = await schemaCatalogSnapshot(admin);
    const recorded = await rotations();
    expect(recorded.some((row) => row.refresh_rotation_key !== null)).toBe(true);
    // Each variant puts the values back from this copy, to the microsecond.
    await admin`
      CREATE TEMPORARY TABLE mobile_refresh_rotation_backup AS
      SELECT id, refresh_rotated_at, refresh_rotation_key
      FROM omni_mobile_sessions
    `;

    try {
      await withMigrationsPendingFrom(admin, refreshRotationRetryVersion, async () => {
        // The file adds the CHECK again once the columns are the ones it adds.
        await admin`
          ALTER TABLE public.omni_mobile_sessions
          DROP CONSTRAINT omni_mobile_sessions_refresh_rotation_check
        `;
        for (const variant of variants) {
          for (const statement of variant.change) {
            await admin.unsafe(statement);
          }
          await expect(migrateWithFreshClient()).rejects.toMatchObject({
            message: expect.stringContaining(
              "omni_mobile_sessions has a refresh rotation column this migration does not add",
            ),
            cause: { cause: { code: "55000" } },
          });
          for (const statement of variant.restore) {
            await admin.unsafe(statement);
          }
          await admin`
            UPDATE omni_mobile_sessions session
            SET refresh_rotated_at = backup.refresh_rotated_at,
              refresh_rotation_key = backup.refresh_rotation_key
            FROM mobile_refresh_rotation_backup backup
            WHERE backup.id = session.id
          `;
        }
        await migrateWithFreshClient();
      });
    } finally {
      await admin`DROP TABLE IF EXISTS mobile_refresh_rotation_backup`;
    }
    expect(await admin`
      SELECT version, name, checksum
      FROM omni_schema_version
      WHERE version IS NOT NULL
      ORDER BY version ASC
    `).toEqual(databaseSchemaMigrations);
    expect(await rotations()).toEqual(recorded);
    expect(await schemaCatalogSnapshot(admin)).toEqual(fileCatalog);
  });

  test("holds an OAuth connection back after syncs that reach no source, doubling the wait up to six hours", async () => {
    const tenantId = "oauth_backoff_tenant";
    const actorId = "oauth-backoff-owner";
    const owner = { tenantId, actorId, provider: "google" as const };
    const store = await import("@/lib/connectors/oauth-store");
    const asOwner = <T,>(operation: () => Promise<T>) =>
      runWithDatabaseActorScope(tenantId, [actorId], operation);
    const save = (
      refresh?: { connectionId: string; expectedAuthorizationGeneration: number },
    ) => {
      const grant = {
        ...owner,
        accountEmail: "oauth-backoff@example.com",
        tokens: {
          access_token: "backoff-access-token",
          refresh_token: "backoff-refresh-token",
          scope: "https://www.googleapis.com/auth/drive",
          expires_in: 3_600,
        },
      };
      return asOwner(() => store.saveOAuthGrant(
        refresh ? { ...grant, authorizationMode: "refresh", ...refresh } : grant,
      ));
    };
    const backoff = async () => {
      const [row] = await admin`
        SELECT sync_failure_count AS failures,
          extract(epoch FROM sync_retry_at)::float8 * 1000 AS "retryAtMs"
        FROM omni_oauth_grants
        WHERE tenant_id = ${tenantId}
      `;
      return row as { failures: number; retryAtMs: number | null };
    };
    // Finishes one sync, and checks the wait it set from the moment it did.
    const finish = async (
      attempt: "failed" | "succeeded" | undefined,
      expected: { failures: number; waitMs?: number },
    ) => {
      const claim = await asOwner(() => store.claimOAuthSyncLease(owner));
      if (claim.status !== "claimed") throw new Error("Expected a lease.");
      const before = Date.now();
      const grant = await asOwner(() => store.updateOAuthSyncState({
        ...owner,
        status: attempt === "succeeded" ? "healthy" : "error",
        lease: claim.lease,
        releaseLease: true,
        ...(attempt ? { attempt } : {}),
      }));
      const after = Date.now();
      expect(grant).toBeDefined();
      const row = await backoff();
      expect(row.failures).toBe(expected.failures);
      if (expected.waitMs === undefined) {
        expect(row.retryAtMs).toBeNull();
      } else {
        expect(row.retryAtMs! - expected.waitMs).toBeGreaterThanOrEqual(before);
        expect(row.retryAtMs! - expected.waitMs).toBeLessThanOrEqual(after);
      }
      return row;
    };
    const setFailures = (failures: number) => admin`
      UPDATE omni_oauth_grants
      SET sync_failure_count = ${failures}, sync_retry_at = NOW()
      WHERE tenant_id = ${tenantId}
    `;
    const minute = 60_000;
    const previousKeyring = process.env.OMNIAGENT_CREDENTIAL_KEYRING;
    process.env.OMNIAGENT_CREDENTIAL_KEYRING = JSON.stringify({
      activeKeyId: "oauth-backoff-v1",
      keys: { "oauth-backoff-v1": Buffer.alloc(32, 7).toString("base64url") },
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const connected = await save();
      await finish("failed", { failures: 1, waitMs: 5 * minute });
      // Connections that failed together do not retry together.
      random.mockReturnValue(0.5);
      await finish("failed", { failures: 2, waitMs: 10 * minute * 0.875 });
      random.mockReturnValue(0);
      const held = await finish("failed", { failures: 3, waitMs: 20 * minute });
      // A sync that ends without an outcome, like an interrupted one, keeps
      // the wait, and the scheduler reads it from the connection list.
      const claim = await asOwner(() => store.claimOAuthSyncLease(owner));
      if (claim.status !== "claimed") throw new Error("Expected a lease.");
      await asOwner(() => store.updateOAuthSyncState({
        ...owner,
        status: "syncing",
        lease: claim.lease,
        releaseLease: true,
      }));
      expect(await backoff()).toEqual(held);
      const [listed] = await asOwner(() => store.listOAuthGrantsForTenant(tenantId));
      expect(listed.syncFailureCount).toBe(3);
      expect(Math.abs(Date.parse(listed.syncRetryAt!) - held.retryAtMs!))
        .toBeLessThan(1_000);

      // A token refresh keeps the wait; reconnecting the account clears it.
      await expect(save({
        connectionId: connected.id,
        expectedAuthorizationGeneration: connected.authorizationGeneration,
      })).resolves.toMatchObject({ syncFailureCount: 3 });
      expect(await backoff()).toEqual(held);
      const reconnected = await save();
      expect(reconnected).not.toHaveProperty("syncFailureCount");
      expect(reconnected).not.toHaveProperty("syncRetryAt");
      expect(await backoff()).toEqual({ failures: 0, retryAtMs: null });

      await setFailures(6);
      await finish("failed", { failures: 7, waitMs: 320 * minute });
      // Five minutes doubled seven times would pass six hours.
      await finish("failed", { failures: 8, waitMs: 360 * minute });
      // A connection left failing for a year does not overflow the wait.
      await setFailures(5_000);
      await finish("failed", { failures: 5_001, waitMs: 360 * minute });
      await finish("succeeded", { failures: 0 });
    } finally {
      random.mockRestore();
      if (previousKeyring === undefined) {
        delete process.env.OMNIAGENT_CREDENTIAL_KEYRING;
      } else {
        process.env.OMNIAGENT_CREDENTIAL_KEYRING = previousKeyring;
      }
    }
  });

  test("refuses to write a token refresh over a disconnected or reconnected OAuth connection", async () => {
    const tenantId = "oauth_refresh_tenant";
    const actorId = "oauth-refresh-owner";
    const owner = { tenantId, actorId, provider: "google" as const };
    const accountEmail = "oauth-refresh@example.com";
    const store = await import("@/lib/connectors/oauth-store");
    const asOwner = <T,>(operation: () => Promise<T>) =>
      runWithDatabaseActorScope(tenantId, [actorId], operation);
    const connect = (accessToken: string) => asOwner(() =>
      store.saveOAuthGrant({
        ...owner,
        accountEmail,
        tokens: {
          access_token: accessToken,
          refresh_token: "oauth-refresh-token",
          scope: "https://www.googleapis.com/auth/drive",
          expires_in: 3_600,
        },
      }));
    // A refresh names the grant and authorization its refresh token came from.
    const refresh = (
      read: { id: string; authorizationGeneration: number },
      accessToken: string,
    ) => asOwner(() =>
      store.saveOAuthGrant({
        ...owner,
        accountEmail,
        tokens: { access_token: accessToken, expires_in: 3_600 },
        authorizationMode: "refresh",
        connectionId: read.id,
        expectedAuthorizationGeneration: read.authorizationGeneration,
      }));
    const stored = async () => {
      const [row] = await admin`
        SELECT status, authorization_generation::int AS generation
        FROM omni_oauth_grants
        WHERE tenant_id = ${tenantId}
      `;
      return row;
    };
    const accessToken = async () =>
      (await asOwner(() => store.getOAuthGrantSecrets(tenantId, actorId, "google")))
        ?.tokens.access_token;
    const previousKeyring = process.env.OMNIAGENT_CREDENTIAL_KEYRING;
    process.env.OMNIAGENT_CREDENTIAL_KEYRING = JSON.stringify({
      activeKeyId: "oauth-refresh-v1",
      keys: { "oauth-refresh-v1": Buffer.alloc(32, 9).toString("base64url") },
    });

    try {
      const connected = await connect("first-access-token");
      const generation = connected.authorizationGeneration;
      for (const mismatch of [
        { ...connected, id: "another-connection" },
        { ...connected, authorizationGeneration: generation + 1 },
      ]) {
        await expect(refresh(mismatch, "mismatched-access-token"))
          .rejects.toMatchObject({ code: "grant_not_found" });
      }
      expect(await accessToken()).toBe("first-access-token");
      await expect(refresh(connected, "refreshed-access-token")).resolves.toMatchObject({
        id: connected.id,
        status: "active",
        authorizationGeneration: generation,
      });
      expect(await accessToken()).toBe("refreshed-access-token");

      await asOwner(() => store.revokeOAuthGrant(tenantId, actorId, "google"));
      expect(await stored()).toEqual({ status: "revoked", generation: generation + 1 });
      await expect(refresh(connected, "late-access-token"))
        .rejects.toMatchObject({ code: "grant_not_found" });
      expect(await stored()).toEqual({ status: "revoked", generation: generation + 1 });

      const reconnected = await connect("reconnected-access-token");
      expect(reconnected).toMatchObject({
        id: connected.id,
        status: "active",
        authorizationGeneration: generation + 1,
      });
      await expect(refresh(connected, "stale-access-token"))
        .rejects.toMatchObject({ code: "grant_not_found" });
      expect(await accessToken()).toBe("reconnected-access-token");
      await expect(refresh(reconnected, "current-access-token")).resolves.toMatchObject({
        authorizationGeneration: generation + 1,
      });
      expect(await accessToken()).toBe("current-access-token");

      // Earlier releases disconnected without moving the authorization on.
      await admin`
        UPDATE omni_oauth_grants SET status = 'revoked' WHERE tenant_id = ${tenantId}
      `;
      await expect(refresh(reconnected, "resurrecting-access-token"))
        .rejects.toMatchObject({ code: "grant_not_found" });
      expect(await stored()).toEqual({ status: "revoked", generation: generation + 1 });
    } finally {
      if (previousKeyring === undefined) {
        delete process.env.OMNIAGENT_CREDENTIAL_KEYRING;
      } else {
        process.env.OMNIAGENT_CREDENTIAL_KEYRING = previousKeyring;
      }
    }
  });

  test("keeps an OAuth retry time only beside a failure count above zero", async () => {
    const [constraint] = await admin`
      SELECT convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'public.omni_oauth_grants'::regclass
        AND conname = 'omni_oauth_grants_sync_backoff_check'
    `;
    // Added without scanning the table, whose rows had no failures then.
    expect(constraint).toEqual({ validated: false });
    const [grant] = await admin`
      SELECT id FROM omni_oauth_grants ORDER BY created_at LIMIT 1
    `;
    expect(grant).toBeDefined();
    const setBackoff = (failures: string, retryAt: string) =>
      admin.unsafe(`
        UPDATE public.omni_oauth_grants
        SET sync_failure_count = ${failures}, sync_retry_at = ${retryAt}
        WHERE id = '${String(grant.id)}'
      `);

    for (const [failures, retryAt] of [
      ["1", "NULL"],
      ["0", "NOW()"],
      ["-1", "NOW()"],
      ["-1", "NULL"],
    ]) {
      await expect(setBackoff(failures, retryAt)).rejects.toMatchObject({ code: "23514" });
    }
    await setBackoff("1", "NOW()");
    await setBackoff("0", "NULL");
  });

  test("refuses to migrate over a sync backoff column that exists with another type, default or nullability", async () => {
    const alter = "ALTER TABLE public.omni_oauth_grants ALTER COLUMN";
    const variants = [
      {
        change: [`${alter} sync_failure_count TYPE BIGINT`],
        restore: [`${alter} sync_failure_count TYPE INTEGER`],
      },
      {
        change: [`${alter} sync_failure_count SET DEFAULT 1`],
        restore: [`${alter} sync_failure_count SET DEFAULT 0`],
      },
      {
        change: [`${alter} sync_failure_count DROP NOT NULL`],
        restore: [`${alter} sync_failure_count SET NOT NULL`],
      },
      {
        change: [`${alter} sync_retry_at TYPE TIMESTAMP`],
        restore: [`${alter} sync_retry_at TYPE TIMESTAMPTZ`],
      },
      {
        change: [`${alter} sync_retry_at SET DEFAULT NOW()`],
        restore: [`${alter} sync_retry_at DROP DEFAULT`],
      },
      {
        change: [
          "UPDATE public.omni_oauth_grants SET sync_retry_at = COALESCE(sync_retry_at, NOW())",
          `${alter} sync_retry_at SET NOT NULL`,
        ],
        restore: [`${alter} sync_retry_at DROP NOT NULL`],
      },
    ];
    const backoffs = () => admin`
      SELECT id, sync_failure_count, sync_retry_at
      FROM omni_oauth_grants
      ORDER BY id
    `;
    const fileCatalog = await schemaCatalogSnapshot(admin);
    const recorded = await backoffs();
    expect(recorded.length).toBeGreaterThan(0);
    // Each variant puts the values back from this copy, to the microsecond.
    await admin`
      CREATE TEMPORARY TABLE oauth_sync_backoff_backup AS
      SELECT id, sync_failure_count, sync_retry_at
      FROM omni_oauth_grants
    `;

    try {
      await withMigrationsPendingFrom(admin, oauthSyncBackoffVersion, async () => {
        // The file adds the CHECK again once the columns are the ones it adds.
        await admin`
          ALTER TABLE public.omni_oauth_grants
          DROP CONSTRAINT omni_oauth_grants_sync_backoff_check
        `;
        for (const variant of variants) {
          for (const statement of variant.change) {
            await admin.unsafe(statement);
          }
          await expect(migrateWithFreshClient()).rejects.toMatchObject({
            message: expect.stringContaining(
              "omni_oauth_grants has a sync backoff column this migration does not add",
            ),
            cause: { cause: { code: "55000" } },
          });
          for (const statement of variant.restore) {
            await admin.unsafe(statement);
          }
          await admin`
            UPDATE omni_oauth_grants grant_row
            SET sync_failure_count = backup.sync_failure_count,
              sync_retry_at = backup.sync_retry_at
            FROM oauth_sync_backoff_backup backup
            WHERE backup.id = grant_row.id
          `;
        }
        await migrateWithFreshClient();
      });
    } finally {
      await admin`DROP TABLE IF EXISTS oauth_sync_backoff_backup`;
    }
    expect(await admin`
      SELECT version, name, checksum
      FROM omni_schema_version
      WHERE version IS NOT NULL
      ORDER BY version ASC
    `).toEqual(databaseSchemaMigrations);
    expect(await backoffs()).toEqual(recorded);
    expect(await schemaCatalogSnapshot(admin)).toEqual(fileCatalog);
  });

  test("orders pending approvals by risk and age across every source and pages them without a gap", async () => {
    const tenantId = "approval_order_tenant";
    const otherTenantId = "approval_order_other";
    const inTenant = <T,>(operation: () => Promise<T>, tenant = tenantId) =>
      runWithDatabaseTenantScope(tenant, operation);
    const day = 24 * 60 * 60 * 1000;
    const base = Date.parse("2026-09-01T12:00:00.000Z");
    const at = (days: number) => new Date(base + days * day).toISOString();
    const staleClaimAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Priority is the time an item started waiting less a day per risk
    // level, so several rows below share one. One row from each source has
    // milliseconds and microseconds, which the database must cut to the
    // millisecond the way a JS Date does, and the tied ids differ only in
    // case, which COLLATE "C" orders upper first.
    await admin`
      INSERT INTO omni_tool_executions (
        id, tool_id, tool_name, risk_level, status, dry_run, approval_required,
        tenant_id, actor_id, input, created_at
      )
      VALUES
        (
          'approval-order-tool-old', 'http.request', 'HTTP Request', 0,
          'approval_required', FALSE, TRUE, ${tenantId}, 'queue-owner',
          '{}'::jsonb, '2026-09-01T12:00:00.250999Z'::timestamptz
        ),
        (
          'approval-order-tie-B', 'http.request', 'HTTP Request', 1,
          'approval_required', FALSE, TRUE, ${tenantId}, 'queue-owner',
          '{}'::jsonb, ${at(2)}::timestamptz
        ),
        (
          'approval-order-tie-a', 'http.request', 'HTTP Request', 0,
          'approval_required', FALSE, TRUE, ${tenantId}, 'queue-owner',
          '{}'::jsonb, ${at(1)}::timestamptz
        ),
        (
          'approval-order-tool-late', 'http.request', 'HTTP Request', 3,
          'approval_required', FALSE, TRUE, ${tenantId}, 'queue-owner',
          '{}'::jsonb, ${at(5)}::timestamptz
        ),
        (
          'approval-order-tool-done', 'http.request', 'HTTP Request', 3,
          'executed', FALSE, TRUE, ${tenantId}, 'queue-owner',
          '{}'::jsonb, ${at(0)}::timestamptz
        ),
        (
          'approval-order-tool-other', 'http.request', 'HTTP Request', 3,
          'approval_required', FALSE, TRUE, ${otherTenantId}, 'queue-owner',
          '{}'::jsonb, ${at(0)}::timestamptz
        )
    `;
    // An approved deletion whose claim went stale waits for reconciliation,
    // ahead of everything else however recent it is.
    await admin`
      INSERT INTO omni_tool_executions (
        id, tool_id, tool_name, risk_level, status, dry_run, approval_required,
        tenant_id, actor_id, input, output, approval_decision, approved_by,
        approved_at, created_at
      )
      VALUES (
        'approval-order-reconcile', 'memory.forget', 'Forget memory', 2,
        'executing', FALSE, TRUE, ${tenantId}, 'queue-owner', '{}'::jsonb,
        jsonb_build_object(
          '__executionClaim',
          jsonb_build_object('token', 'claim-token', 'claimedAt', ${staleClaimAt}::text)
        ),
        'approved', 'queue-reviewer', ${at(10)}::timestamptz, ${at(10)}::timestamptz
      )
    `;
    // A workflow run waits from its last update, at risk level two.
    await admin`
      INSERT INTO omni_workflow_runs (
        id, tenant_id, workflow_type, status, goal, approval_required,
        created_at, updated_at
      )
      VALUES
        (
          'approval-order-workflow-tie', ${tenantId}, 'agent.orchestrate',
          'waiting_approval', 'Publish the weekly summary', TRUE,
          ${at(0)}::timestamptz, ${at(3)}::timestamptz
        ),
        (
          'approval-order-workflow-late', ${tenantId}, 'agent.orchestrate',
          'waiting_approval', 'Archive the quarter', TRUE,
          ${at(0)}::timestamptz, '2026-09-06T12:00:00.100999Z'::timestamptz
        ),
        (
          'approval-order-workflow-running', ${tenantId}, 'agent.orchestrate',
          'running', 'Still running', TRUE,
          ${at(0)}::timestamptz, ${at(0)}::timestamptz
        ),
        (
          'approval-order-workflow-other', ${otherTenantId}, 'agent.orchestrate',
          'waiting_approval', 'Another tenant', TRUE,
          ${at(0)}::timestamptz, ${at(0)}::timestamptz
        )
    `;
    const requestChange = (tenant = tenantId) => inTenant(
      () => requestObservabilitySloPolicyChange({
        policyId: "latency-p95",
        action: "delete_policy",
        tenantId: tenant,
        requestedBy: "queue-owner",
        reason: "Retire the latency objective.",
      }),
      tenant,
    );
    const sloRiskThree = await requestChange();
    const sloRiskZero = await requestChange();
    const sloRiskNine = await requestChange();
    const sloRejected = await requestChange();
    const sloOther = await requestChange(otherTenantId);
    // A stored risk level of zero reads as two and one above three as three.
    for (const [change, riskLevel, createdAt, changeStatus] of [
      [sloRiskThree, 3, at(4), "pending"],
      [sloRiskZero, 0, at(4), "pending"],
      [sloRiskNine, 9, "2026-09-07T12:00:00.250999Z", "pending"],
      [sloRejected, 3, at(0), "rejected"],
      [sloOther, 3, at(0), "pending"],
    ] as const) {
      await admin`
        UPDATE omni_observability_slo_policy_changes
        SET risk_level = ${riskLevel}, created_at = ${createdAt}::timestamptz,
          status = ${changeStatus}
        WHERE id = ${change.id}
      `;
    }

    const order = [
      "tool:approval-order-reconcile",
      "tool:approval-order-tool-old",
      "tool:approval-order-tie-B",
      "tool:approval-order-tie-a",
      "workflow:approval-order-workflow-tie",
      `slo_policy:${sloRiskThree.id}`,
      "tool:approval-order-tool-late",
      `slo_policy:${sloRiskZero.id}`,
      "workflow:approval-order-workflow-late",
      `slo_policy:${sloRiskNine.id}`,
    ];
    const stats = {
      total: 10,
      tools: 5,
      reconciliations: 1,
      workflows: 2,
      sloPolicies: 3,
    };
    const itemKey = (item: { kind: string; id: string }) => `${item.kind}:${item.id}`;

    const whole = await inTenant(() => getApprovalQueue(100, { tenantId }));
    expect(whole.items.map(itemKey)).toEqual(order);
    expect(whole.stats).toEqual(stats);
    expect(whole.nextCursor).toBeNull();
    expect(whole.items[0]).toMatchObject({ status: "reconciliation_required" });

    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof getApprovalQueue>> = await inTenant(
          () => getApprovalQueue(limit, { tenantId, cursor }),
        );
        expect(page.items.length).toBeLessThanOrEqual(limit);
        if (page.nextCursor) expect(page.items).toHaveLength(limit);
        expect(page.stats).toEqual(stats);
        seen.push(...page.items.map(itemKey));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(order.length + 1);
      } while (cursor);
      expect(seen).toEqual(order);
    }

    // Each source computes the priority in SQL exactly as the order module
    // does from the record it returns.
    const toolPage = await inTenant(() =>
      listPendingToolApprovalPage({ tenantId, limit: 50 })
    );
    expect(toolPage).toMatchObject({
      exhausted: true,
      total: 5,
      reconciliations: 1,
    });
    expect(toolPage.entries.map(({ record, key }) => [record.id, key.classRank, key.priorityMs]))
      .toEqual([
        ["approval-order-reconcile", 0, base + 8 * day],
        ["approval-order-tool-old", 1, base + 250],
        ["approval-order-tie-B", 1, base + day],
        ["approval-order-tie-a", 1, base + day],
        ["approval-order-tool-late", 1, base + 2 * day],
      ]);
    for (const { record, key } of toolPage.entries) {
      expect(key.priorityMs).toBe(
        approvalPriorityMs(Date.parse(record.createdAt), record.riskLevel),
      );
    }
    const workflowPage = await inTenant(() =>
      listWorkflowApprovalPage({ tenantId, limit: 50 })
    );
    expect(workflowPage).toMatchObject({ exhausted: true, total: 2 });
    expect(workflowPage.entries.map(({ run, key }) => [run.id, key.priorityMs])).toEqual([
      ["approval-order-workflow-tie", base + day],
      ["approval-order-workflow-late", base + 3 * day + 100],
    ]);
    for (const { run, key } of workflowPage.entries) {
      expect(key.priorityMs).toBe(
        approvalPriorityMs(Date.parse(run.updatedAt), WORKFLOW_APPROVAL_RISK_LEVEL),
      );
    }
    const sloPage = await inTenant(() =>
      listPendingSloPolicyChangePage({ tenantId, limit: 50 })
    );
    expect(sloPage).toMatchObject({ exhausted: true, total: 3 });
    expect(sloPage.entries.map(({ change, key }) => [change.id, change.riskLevel, key.priorityMs]))
      .toEqual([
        [sloRiskThree.id, 3, base + day],
        [sloRiskZero.id, 2, base + 2 * day],
        [sloRiskNine.id, 3, base + 3 * day + 250],
      ]);
    for (const { change, key } of sloPage.entries) {
      expect(key.priorityMs).toBe(
        approvalPriorityMs(Date.parse(change.createdAt), change.riskLevel),
      );
    }

    // A page its rows fill exactly is a source's last; one row short of the
    // total reads one row ahead and ends on it.
    const sourcePages: Array<[
      (limit: number) => Promise<{
        entries: ReadonlyArray<{ key: unknown }>;
        last?: unknown;
        exhausted: boolean;
      }>,
      number,
    ]> = [
      [(limit) => listPendingToolApprovalPage({ tenantId, limit }), 5],
      [(limit) => listWorkflowApprovalPage({ tenantId, limit }), 2],
      [(limit) => listPendingSloPolicyChangePage({ tenantId, limit }), 3],
    ];
    for (const [readPage, total] of sourcePages) {
      const filled = await inTenant(() => readPage(total));
      expect(filled.exhausted).toBe(true);
      expect(filled.entries).toHaveLength(total);
      const short = await inTenant(() => readPage(total - 1));
      expect(short.exhausted).toBe(false);
      expect(short.entries).toHaveLength(total);
      expect(short.last).toEqual(short.entries.at(-1)?.key);
    }

    // One item by id, while it still waits and only in its own tenant.
    const item = (id: string, kind?: "tool" | "workflow" | "slo_policy", tenant = tenantId) =>
      inTenant(() => getApprovalQueueItem(id, { tenantId: tenant, kind }), tenant);
    await expect(item("approval-order-tie-a", "tool")).resolves.toMatchObject({
      kind: "tool",
      id: "approval-order-tie-a",
      status: "approval_required",
    });
    await expect(item("approval-order-reconcile")).resolves.toMatchObject({
      kind: "tool",
      status: "reconciliation_required",
    });
    await expect(item("approval-order-workflow-tie")).resolves.toMatchObject({
      kind: "workflow",
      id: "approval-order-workflow-tie",
    });
    await expect(item(sloRiskNine.id, "slo_policy")).resolves.toMatchObject({
      kind: "slo_policy",
      id: sloRiskNine.id,
      riskLevel: 3,
    });
    for (const [id, kind] of [
      ["approval-order-tie-a", "workflow"],
      ["approval-order-workflow-tie", "tool"],
      [sloRiskThree.id, "workflow"],
      ["approval-order-tool-done", undefined],
      ["approval-order-workflow-running", undefined],
      [sloRejected.id, undefined],
      ["approval-order-missing", undefined],
    ] as const) {
      await expect(item(id, kind)).resolves.toBeNull();
    }
    await expect(item("approval-order-tool-other", "tool")).resolves.toBeNull();
    await expect(item("approval-order-workflow-other", "workflow")).resolves.toBeNull();
    await expect(item(sloOther.id, "slo_policy")).resolves.toBeNull();
    await expect(item("approval-order-tool-other", "tool", otherTenantId))
      .resolves.toMatchObject({ id: "approval-order-tool-other" });

    // A tool item names the run paused on it, and that run's conversation,
    // only to the run's owner; the newest run wins when two name one item.
    const thread = await inTenant(() => createThread({
      tenantId,
      actorId: "queue-owner",
      title: "Check the status page",
      mode: "orchestrate",
    }));
    for (const run of [
      {
        id: "approval-order-run-late",
        tenant: tenantId,
        owner: "queue-owner",
        runStatus: "waiting_approval",
        executionId: "approval-order-tool-late",
        startedAt: at(5),
        threadId: thread.id,
      },
      {
        id: "approval-order-run-tie-older",
        tenant: tenantId,
        owner: "queue-owner",
        runStatus: "waiting_approval",
        executionId: "approval-order-tie-B",
        startedAt: at(1),
        threadId: null,
      },
      {
        id: "approval-order-run-tie-newer",
        tenant: tenantId,
        owner: "queue-owner",
        runStatus: "resuming",
        executionId: "approval-order-tie-B",
        startedAt: at(2),
        threadId: null,
      },
      {
        id: "approval-order-run-completed",
        tenant: tenantId,
        owner: "queue-owner",
        runStatus: "completed",
        executionId: "approval-order-tool-old",
        startedAt: at(0),
        threadId: null,
      },
      {
        id: "approval-order-run-other-tenant",
        tenant: otherTenantId,
        owner: "queue-owner",
        runStatus: "waiting_approval",
        executionId: "approval-order-tie-a",
        startedAt: at(1),
        threadId: null,
      },
      {
        id: "approval-order-run-someone-else",
        tenant: tenantId,
        owner: "someone-else",
        runStatus: "waiting_approval",
        executionId: "approval-order-reconcile",
        startedAt: at(10),
        threadId: null,
      },
    ]) {
      await admin`
        INSERT INTO omni_agent_runs (
          id, tenant_id, owner_actor_id, mode, status, prompt, messages,
          continuation, started_at, thread_id
        )
        VALUES (
          ${run.id}, ${run.tenant}, ${run.owner}, 'orchestrate', ${run.runStatus},
          'Check the status page.', '[]'::jsonb,
          jsonb_build_object(
            'pendingToolCall',
            jsonb_build_object('executionId', ${run.executionId}::text)
          ),
          ${run.startedAt}::timestamptz, ${run.threadId}
        )
      `;
    }
    const origins = async (actorId?: string) => {
      const queue = await inTenant(() => getApprovalQueue(100, { tenantId, actorId }));
      expect(queue.items.map(itemKey)).toEqual(order);
      return Object.fromEntries(queue.items.flatMap((queued) =>
        queued.kind === "tool" && queued.origin ? [[queued.id, queued.origin]] : []
      ));
    };
    await expect(origins("queue-owner")).resolves.toEqual({
      "approval-order-tool-late": { runId: "approval-order-run-late", threadId: thread.id },
      "approval-order-tie-B": { runId: "approval-order-run-tie-newer" },
    });
    await expect(origins("someone-else")).resolves.toEqual({
      "approval-order-reconcile": { runId: "approval-order-run-someone-else" },
    });
    await expect(origins()).resolves.toEqual({});
    await expect(inTenant(() => getApprovalQueueItem("approval-order-tool-late", {
      tenantId,
      kind: "tool",
      actorId: "queue-owner",
    }))).resolves.toMatchObject({
      origin: { runId: "approval-order-run-late", threadId: thread.id },
    });
    await expect(inTenant(() => getApprovalQueueItem("approval-order-tool-late", {
      tenantId,
      kind: "tool",
      actorId: "someone-else",
    }))).resolves.not.toHaveProperty("origin");

    // A stored risk level below zero reads as zero, in the page's SQL too.
    await admin`
      UPDATE omni_observability_slo_policy_changes
      SET risk_level = -1
      WHERE id = ${sloRiskZero.id}
    `;
    const belowZero = await inTenant(() =>
      listPendingSloPolicyChangePage({ tenantId, limit: 50 })
    );
    expect(belowZero.entries.map(({ change, key }) => [change.id, change.riskLevel, key.priorityMs]))
      .toEqual([
        [sloRiskThree.id, 3, base + day],
        [sloRiskNine.id, 3, base + 3 * day + 250],
        [sloRiskZero.id, 0, base + 4 * day],
      ]);
  });

  test("sums a tenant's recorded AI usage from a window's start", async () => {
    const tenantId = "ai_usage_window_tenant";
    const since = new Date("2026-09-28T12:00:00.000Z");
    const at = (offsetMs: number) => new Date(since.getTime() + offsetMs).toISOString();
    const hour = 60 * 60 * 1000;
    const rows: Array<{
      id: string;
      tenant: string;
      usage: Record<string, unknown>;
      cost: number | null;
      recordedAt: string;
      stream?: string;
    }> = [
      { id: "at-start", tenant: tenantId, usage: { totalTokens: 100 }, cost: 2_000, recordedAt: at(0) },
      {
        id: "peer-stream",
        tenant: tenantId,
        usage: { totalTokens: 40 },
        cost: 4,
        recordedAt: at(hour),
        stream: "a2a-peer:ai-usage-window",
      },
      {
        id: "parts-exceed-total",
        tenant: tenantId,
        usage: { inputTokens: 300, outputTokens: 50, totalTokens: 200 },
        cost: 1_500,
        recordedAt: at(hour),
      },
      {
        id: "unpriced-text-counts",
        tenant: tenantId,
        usage: { totalTokens: "999", inputTokens: "5" },
        cost: null,
        recordedAt: at(2 * hour),
      },
      { id: "before-start", tenant: tenantId, usage: { totalTokens: 10_000 }, cost: 99, recordedAt: at(-1) },
      {
        id: "other-tenant",
        tenant: "ai_usage_window_other",
        usage: { totalTokens: 7_777 },
        cost: 7_777,
        recordedAt: at(hour),
        stream: "a2a-peer:ai-usage-window",
      },
    ];
    for (const row of rows) {
      await admin`
        INSERT INTO omni_ai_usage (
          id, tenant_id, actor_id, source_stream_id, operation, purpose,
          status, provider, model, usage, estimated_cost_microusd, recorded_at
        ) VALUES (
          ${`ai-usage-window-${row.id}`}, ${row.tenant}, 'ai-usage-window-owner',
          ${row.stream ?? "run:ai-usage-window"}, 'tool_turn', 'agent', 'completed', 'openai',
          'gpt-5.2', ${JSON.stringify(row.usage)}::text::jsonb, ${row.cost},
          ${row.recordedAt}::timestamptz
        )
      `;
    }

    await expect(runWithDatabaseTenantScope(
      tenantId,
      () => loadTenantAiUsageSince({ tenantId, since }),
    )).resolves.toEqual({ tokens: 490, costMicrousd: 3_504 });
    await expect(runWithDatabaseTenantScope(
      tenantId,
      () => loadTenantAiUsageSince({
        tenantId,
        since,
        sourceStreamId: "a2a-peer:ai-usage-window",
      }),
    )).resolves.toEqual({ tokens: 40, costMicrousd: 4 });
    await expect(runWithDatabaseTenantScope(
      tenantId,
      () => loadTenantAiUsageSince({
        tenantId,
        since,
        sourceStreamId: "run:ai-usage-window",
      }),
    )).resolves.toEqual({ tokens: 450, costMicrousd: 3_500 });
    await expect(runWithDatabaseTenantScope(
      tenantId,
      () => loadTenantAiUsageSince({ tenantId, since: new Date(since.getTime() + 3 * hour) }),
    )).resolves.toEqual({ tokens: 0, costMicrousd: 0 });
  });

  test("counts only a tenant's active members for its default context lane", async () => {
    const tenantId = "membership_count_tenant";
    const otherTenantId = "membership_count_other";
    const userIds = [
      "00000000-0000-4000-8000-000000000901",
      "00000000-0000-4000-8000-000000000902",
      "00000000-0000-4000-8000-000000000903",
    ];
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES
        (${tenantId}, 'Membership count', ${tenantId}),
        (${otherTenantId}, 'Membership count other', ${otherTenantId})
    `;
    for (const [index, userId] of userIds.entries()) {
      await admin`
        INSERT INTO omni_auth_users (id, email, password_hash)
        VALUES (${userId}, ${`membership-count-${index}@example.test`}, 'test-only')
      `;
    }
    await admin`
      INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role, status)
      VALUES
        ('membership-count-owner', ${tenantId}, ${userIds[0]}, 'admin', 'active'),
        ('membership-count-second', ${tenantId}, ${userIds[1]}, 'operator', 'disabled'),
        ('membership-count-other', ${otherTenantId}, ${userIds[2]}, 'admin', 'active')
    `;

    await expect(tenantHasAtMostOneActiveMember(tenantId)).resolves.toBe(true);
    await expect(runWithDatabaseTenantScope(
      tenantId,
      () => tenantHasAtMostOneActiveMember(tenantId),
    )).resolves.toBe(true);

    await admin`
      UPDATE omni_auth_memberships
      SET status = 'active'
      WHERE id = 'membership-count-second'
    `;
    await expect(tenantHasAtMostOneActiveMember(tenantId)).resolves.toBe(false);
    await expect(runWithDatabaseTenantScope(
      tenantId,
      () => tenantHasAtMostOneActiveMember(tenantId),
    )).resolves.toBe(false);
    await expect(tenantHasAtMostOneActiveMember(otherTenantId)).resolves.toBe(true);
  });

  test("keeps a worker's release activation across its startup registrations", async () => {
    const worker = {
      instanceId: "activation-machine",
      protocol: "1",
      revision: "activation-release",
      target: "https://asael.test",
    };
    const at = (time: string) => vi.setSystemTime(new Date(`2026-09-30T${time}Z`));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      at("10:00:00.000");
      await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "startup" });
      await expect(getWorkerReleaseActivation(worker)).resolves.toBeUndefined();

      at("10:05:00.000");
      await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "active" });
      at("10:20:00.000");
      await recordWorkerHeartbeat({ ...worker, lane: "maintenance", phase: "active" });
      at("10:25:00.000");
      await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "active" });
      // A restart registers again; that leaves the activation as it was.
      at("10:30:00.000");
      await recordWorkerHeartbeat({ ...worker, lane: "fast", phase: "startup" });
    } finally {
      vi.useRealTimers();
    }

    await expect(getWorkerReleaseActivation(worker)).resolves.toEqual({
      instanceId: "activation-machine",
      revision: "activation-release",
      activatedAt: "2026-09-30T10:05:00.000Z",
      lanes: {
        fast: "2026-09-30T10:25:00.000Z",
        maintenance: "2026-09-30T10:20:00.000Z",
      },
    });
    await expect(getWorkerReleaseActivation({
      instanceId: "activation-machine",
      revision: "another-release",
    })).resolves.toBeUndefined();
    await expect(listWorkerReleaseActivations({
      revision: "activation-release",
    })).resolves.toHaveLength(1);
    const rows = await admin<{
      tenant_id: string;
      status: string;
      created_at: Date | string;
    }[]>`
      SELECT tenant_id, status, created_at
      FROM omni_system_health_checks
      WHERE scope = 'worker_release_activation'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: "system", status: "healthy" });
    // Retention ages the row from its last work, not from its activation.
    expect(new Date(rows[0]!.created_at).toISOString()).toBe(
      "2026-09-30T10:25:00.000Z",
    );
  });

  test("finds a workflow run's authority however many events come before its binding", async () => {
    const tenantId = "workflow_authority_tenant";
    const { run } = await runWithDatabaseTenantScope(tenantId, () => createWorkflowRun({
      tenantId,
      goal: "Summarize the quarter.",
    }));
    // More events than one stream read returns, all before the binding.
    await admin`
      INSERT INTO omni_events (id, stream_id, type, tenant_id)
      SELECT 'workflow-authority-filler-' || n, ${`workflow:${run.id}`},
        'workflow.queue.enqueued', ${tenantId}
      FROM generate_series(1, 2001) AS n
    `;
    const authority = {
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: "workflow-authority-owner",
        executingPrincipalType: "user",
        executingPrincipalId: "workflow-authority-owner",
        correlationId: "workflow-authority-request",
        purpose: "workflow.run",
      }),
      requesterRole: "admin" as const,
    };
    const bound = {
      requesterRole: "admin",
      executionScope: { correlationId: "workflow-authority-request" },
    };

    await expect(runWithDatabaseTenantScope(tenantId, () =>
      bindWorkflowRunExecutionAuthority(run.id, authority, { tenantId })
    )).resolves.toMatchObject(bound);
    await expect(runWithDatabaseTenantScope(tenantId, () =>
      getWorkflowRunExecutionAuthority(run.id, { tenantId })
    )).resolves.toMatchObject(bound);
  });

  test("replays the mission updates a run's end never delivered, for every owner in a tenant", async () => {
    await ensureDatabaseSchema();
    const tenant = "mission_repair_tenant";
    const otherTenant = "mission_repair_other";
    const userIds = [
      "00000000-0000-4000-8000-000000000911",
      "00000000-0000-4000-8000-000000000912",
    ];
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES
        (${tenant}, 'Mission repair', ${tenant}),
        (${otherTenant}, 'Mission repair other', ${otherTenant})
    `;
    for (const [index, userId] of userIds.entries()) {
      await admin`
        INSERT INTO omni_auth_users (id, email, password_hash)
        VALUES (${userId}, ${`mission-repair-${index}@example.test`}, 'test-only')
      `;
    }
    await admin`
      INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role, status)
      VALUES
        ('mission-repair-a', ${tenant}, ${userIds[0]}, 'admin', 'active'),
        ('mission-repair-b', ${tenant}, ${userIds[1]}, 'operator', 'active'),
        ('mission-repair-other-a', ${otherTenant}, ${userIds[0]}, 'admin', 'active')
    `;
    const [ownerA, ownerB] = userIds.map((userId) => `actor:${userId}`);
    type Owner = { tenantId: string; actorId: string };
    const asOwner = <T,>(owner: Owner, operation: () => Promise<T>) =>
      runWithDatabaseActorScope(owner.tenantId, [owner.actorId], operation);
    const startTask = (
      key: string,
      actorId: string,
      options: { tenantId?: string; workflow?: boolean } = {},
    ) => {
      const owner = { tenantId: options.tenantId || tenant, actorId };
      return asOwner(owner, async () => {
        let executorId = `db-mission-repair-${key}`;
        if (options.workflow) {
          executorId = (await createWorkflowRun({
            tenantId: owner.tenantId,
            goal: `Run ${key}`,
          })).run.id;
        } else {
          await createAgentRun({
            id: executorId,
            ...owner,
            mode: "orchestrate",
            prompt: `Run ${key}`,
            messages: [{ role: "user", content: `Run ${key}` }],
          });
        }
        const mission = await createMission({
          ...owner,
          title: `Mission ${key}`,
          objective: "Finish one task.",
          sourceKey: `mission:${key}`,
        });
        const task = await ensureMissionTask(mission.id, {
          sourceKey: `task:${key}`,
          title: `Task ${key}`,
        }, owner);
        const attempt = await attachMissionExecutor({
          taskId: task.id,
          executorType: options.workflow ? "workflow_run" : "agent_run",
          executorId,
          status: "running",
        }, owner);
        return { owner, mission, task, attempt, executorId };
      });
    };
    const agentDone = await startTask("agent-done", ownerA);
    const workflowFailed = await startTask("workflow-failed", ownerB, {
      workflow: true,
    });
    const agentRecent = await startTask("agent-recent", ownerA);
    const agentRunning = await startTask("agent-running", ownerB);
    const foreign = await startTask("foreign", ownerA, {
      tenantId: otherTenant,
    });
    const endAttempt = async (key: string, actorId: string) => {
      const started = await startTask(key, actorId);
      await asOwner(started.owner, () => transitionMissionAttempt(
        started.attempt.id,
        "failed",
        {
          fenceToken: started.attempt.fenceToken,
          error: "The run stopped.",
          agentRunId: started.attempt.agentRunId,
        },
        started.owner,
      ));
      return started;
    };
    const attemptEnded = await endAttempt("attempt-ended", ownerB);
    const attemptRecent = await endAttempt("attempt-recent", ownerA);
    const attemptSeen = await endAttempt("attempt-seen", ownerB);
    const taskCanceled = await startTask("task-canceled", ownerA);
    await asOwner(taskCanceled.owner, () => transitionMissionTask(
      taskCanceled.task.id,
      "canceled",
      taskCanceled.owner,
    ));
    const endMission = (key: string, actorId: string, options = { withTask: true }) => {
      const owner = { tenantId: tenant, actorId };
      return asOwner(owner, async () => {
        const mission = await createMission({
          ...owner,
          title: `Mission ${key}`,
          objective: "Finish one task.",
          sourceKey: `mission:${key}`,
        });
        if (!options.withTask) return { mission, task: undefined };
        const task = await ensureMissionTask(mission.id, {
          sourceKey: `task:${key}`,
          title: `Task ${key}`,
        }, owner);
        await transitionMissionTask(task.id, "canceled", owner);
        return { mission, task };
      });
    };
    const missionEnded = await endMission("mission-ended", ownerA);
    const missionRecent = await endMission("mission-recent", ownerB);
    await endMission("mission-empty", ownerA, { withTask: false });
    // The runs end, but their own mission updates never land.
    await admin`
      UPDATE omni_agent_runs
      SET status = 'completed', response = 'Brief ready.',
        completed_at = NOW() - INTERVAL '3 minutes'
      WHERE id IN (${agentDone.executorId}, ${foreign.executorId})
    `;
    await admin`
      UPDATE omni_agent_runs
      SET status = 'completed', response = 'Brief ready.',
        completed_at = NOW() - INTERVAL '1 minute'
      WHERE id = ${agentRecent.executorId}
    `;
    // A run that started long ago and is still going has not ended.
    await admin`
      UPDATE omni_agent_runs
      SET started_at = NOW() - INTERVAL '5 minutes'
      WHERE id = ${agentRunning.executorId}
    `;
    await admin`
      UPDATE omni_workflow_runs
      SET status = 'failed', error = 'The source stopped answering.',
        updated_at = NOW() - INTERVAL '3 minutes'
      WHERE id = ${workflowFailed.executorId}
    `;
    // One attempt ended after its task last changed, one ended under two
    // minutes ago, and one ended before its task last changed.
    await admin`
      UPDATE omni_mission_attempts
      SET terminal_at = NOW() - CASE id
        WHEN ${attemptRecent.attempt.id} THEN INTERVAL '1 minute'
        ELSE INTERVAL '3 minutes'
      END
      WHERE id IN (
        ${attemptEnded.attempt.id},
        ${attemptRecent.attempt.id},
        ${attemptSeen.attempt.id}
      )
    `;
    await admin`
      UPDATE omni_mission_tasks
      SET updated_at = NOW() - CASE id
        WHEN ${attemptSeen.task.id} THEN INTERVAL '150 seconds'
        WHEN ${missionEnded.task!.id} THEN INTERVAL '3 minutes'
        WHEN ${missionRecent.task!.id} THEN INTERVAL '1 minute'
        ELSE INTERVAL '4 minutes'
      END
      WHERE id IN (
        ${attemptEnded.task.id},
        ${attemptRecent.task.id},
        ${attemptSeen.task.id},
        ${missionEnded.task!.id},
        ${missionRecent.task!.id}
      )
    `;
    await admin`
      UPDATE omni_agent_runs
      SET status = 'completed', completed_at = NOW() - INTERVAL '3 minutes'
      WHERE id = ${taskCanceled.executorId}
    `;
    await admin`
      UPDATE omni_mission_attempts
      SET updated_at = NOW() - CASE id
        WHEN ${attemptEnded.attempt.id} THEN INTERVAL '3 minutes'
        WHEN ${agentDone.attempt.id} THEN INTERVAL '5 minutes'
        ELSE INTERVAL '6 minutes'
      END
      WHERE id IN (
        ${attemptEnded.attempt.id},
        ${agentDone.attempt.id},
        ${workflowFailed.attempt.id}
      )
    `;

    const settledBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    await expect(runWithDatabaseTenantScope(tenant, async () => ({
      attempts: (await listMissionAttemptsToReconcile({
        tenantId: tenant,
        settledBefore,
      })).map((attempt) => attempt.id),
      missions: (await listEndedMissionsToReconcile({
        tenantId: tenant,
        settledBefore,
      })).map((mission) => mission.id),
    }))).resolves.toEqual({
      attempts: [
        attemptEnded.attempt.id,
        agentDone.attempt.id,
        workflowFailed.attempt.id,
      ],
      missions: [missionEnded.mission.id],
    });
    const reconcile = () => runWithDatabaseTenantScope(
      tenant,
      () => reconcileMissionProjections({ tenantId: tenant }),
    );
    await expect(reconcile()).resolves.toEqual({ repaired: 4, failed: 0 });
    await expect(reconcile()).resolves.toEqual({ repaired: 0, failed: 0 });

    expect(await admin`
      SELECT
        mission.source_key AS key,
        mission.status AS mission,
        task.status AS task,
        attempt.status AS attempt
      FROM omni_missions mission
      JOIN omni_mission_tasks task ON task.mission_id = mission.id
      LEFT JOIN omni_mission_attempts attempt ON attempt.task_id = task.id
      WHERE mission.tenant_id IN (${tenant}, ${otherTenant})
      ORDER BY mission.source_key COLLATE "C"
    `).toEqual([
      { key: "mission:agent-done", mission: "succeeded", task: "succeeded", attempt: "succeeded" },
      { key: "mission:agent-recent", mission: "running", task: "running", attempt: "running" },
      { key: "mission:agent-running", mission: "running", task: "running", attempt: "running" },
      { key: "mission:attempt-ended", mission: "failed", task: "failed", attempt: "failed" },
      { key: "mission:attempt-recent", mission: "running", task: "running", attempt: "failed" },
      { key: "mission:attempt-seen", mission: "running", task: "running", attempt: "failed" },
      { key: "mission:foreign", mission: "running", task: "running", attempt: "running" },
      { key: "mission:mission-ended", mission: "canceled", task: "canceled", attempt: null },
      { key: "mission:mission-recent", mission: "draft", task: "canceled", attempt: null },
      { key: "mission:task-canceled", mission: "running", task: "canceled", attempt: "running" },
      { key: "mission:workflow-failed", mission: "failed", task: "failed", attempt: "failed" },
    ]);
    expect(await admin`
      SELECT output, error
      FROM omni_mission_attempts
      WHERE id IN (${agentDone.attempt.id}, ${workflowFailed.attempt.id})
      ORDER BY id = ${agentDone.attempt.id} DESC
    `).toEqual([
      {
        output: {
          responseLength: 12,
          responseSha256: createHash("sha256").update("Brief ready.").digest("hex"),
        },
        error: null,
      },
      { output: null, error: "The source stopped answering." },
    ]);
  });
  test("sweeps each retention table outside the memory graph transaction", async () => {
    const tenantId = "tenant_short_retention";
    // The memory statement trigger locks only tenants that have memories, so
    // only the sweep itself locks a tenant whose expired rows are all traces.
    const traceTenantId = "tenant_short_retention_traces";
    const userId = "7c1e2a90-4b5d-4f3e-8a61-2d9b0c4e5f71";
    // A single-user server, such as the one the local harness embeds, reports
    // no backend pid for its locks.
    const graphLockHeld = (key: string) => `EXISTS (
      SELECT 1
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted
        AND COALESCE(pid, pg_backend_pid()) = pg_backend_pid()
        AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended('${key}', 0)
    )`;
    const addExpiredWork = async (suffix: string) => {
      await admin`
        INSERT INTO omni_auth_sessions (
          id, tenant_id, user_id, token_hash, expires_at
        )
        VALUES (
          ${`expired-session-${suffix}`}, ${tenantId}, ${userId},
          ${`expired-token-${suffix}`}, NOW() - INTERVAL '1 day'
        )
      `;
      await admin`
        INSERT INTO omni_memories (
          id, tenant_id, type, title, content, tags, scope, source, importance,
          created_at, updated_at
        )
        VALUES (
          ${`expired-episode-${suffix}`}, ${tenantId}, 'episode', 'Episode',
          'Sensitive episode', '{}'::text[], 'workspace', 'agent', 0.5,
          NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        )
      `;
    };
    await admin`
      INSERT INTO omni_auth_tenants (id, name, slug)
      VALUES (${tenantId}, 'Short retention tenant', 'short-retention-tenant')
    `;
    await admin`
      INSERT INTO omni_auth_users (id, email, password_hash)
      VALUES (${userId}, 'short-retention@example.test', 'test-password-hash')
    `;
    try {
      await admin.unsafe(`
        CREATE TABLE retention_transaction_probe (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          label TEXT NOT NULL,
          transaction_id BIGINT NOT NULL,
          tenant_graph_lock BOOLEAN NOT NULL,
          global_graph_lock BOOLEAN NOT NULL
        )
      `);
      // Named to fire before the graph lock trigger, so each probe sees the
      // locks held before its statement starts.
      await admin.unsafe(`
        CREATE FUNCTION record_retention_transaction_probe()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
        BEGIN
          INSERT INTO retention_transaction_probe (
            label, transaction_id, tenant_graph_lock, global_graph_lock
          )
          VALUES (
            TG_ARGV[0],
            txid_current(),
            ${graphLockHeld(`memory-graph:${traceTenantId}`)},
            ${graphLockHeld("memory-graph-lock-order:global")}
          );
          RETURN NULL;
        END
        $$
      `);
      for (const [table, action, label] of [
        ["omni_local_computer_commands", "UPDATE", "commands"],
        ["omni_memories", "UPDATE", "memories"],
        ["omni_auth_sessions", "DELETE", "sessions"],
        ["omni_security_audits", "DELETE", "audits"],
      ]) {
        await admin.unsafe(`
          CREATE TRIGGER a_retention_transaction_probe
          BEFORE ${action} ON ${table}
          FOR EACH STATEMENT
          EXECUTE FUNCTION record_retention_transaction_probe('${label}')
        `);
      }
      await addExpiredWork("probed");
      await admin`
        INSERT INTO omni_retrieval_traces (id, tenant_id, query, created_at)
        VALUES (
          'expired-short-retention-trace', ${traceTenantId},
          'Sensitive historical query', NOW() - INTERVAL '4000 days'
        )
      `;

      const result = await sweepExpiredSensitiveData({ tenantId, allTenants: true });

      expect(result.deleted.authSessions).toBeGreaterThanOrEqual(1);
      expect(result.deleted.memories).toBeGreaterThanOrEqual(1);
      expect(await admin`
        SELECT id FROM omni_retrieval_traces WHERE tenant_id = ${traceTenantId}
      `).toEqual([]);
      expect(await admin`
        SELECT label,
          COUNT(DISTINCT transaction_id)::int AS transactions,
          BOOL_OR(tenant_graph_lock) AS any_tenant_graph_lock,
          BOOL_AND(global_graph_lock) AS always_global_graph_lock,
          BOOL_OR(global_graph_lock) AS any_global_graph_lock
        FROM retention_transaction_probe
        GROUP BY label
        ORDER BY label
      `).toEqual([
        ["audits", false],
        ["commands", false],
        ["memories", true],
        ["sessions", false],
      ].map(([label, locked]) => ({
        label,
        transactions: 1,
        any_tenant_graph_lock: locked,
        always_global_graph_lock: locked,
        any_global_graph_lock: locked,
      })));
      const [{ transactions }] = await admin`
        SELECT COUNT(DISTINCT transaction_id)::int AS transactions
        FROM retention_transaction_probe
      `;
      expect(transactions).toBe(4);

      await admin.unsafe(`
        CREATE FUNCTION fail_retention_audit_store()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'The audit store is unavailable.';
        END
        $$
      `);
      await admin.unsafe(`
        CREATE TRIGGER a_retention_audit_store_failure
        BEFORE DELETE ON omni_security_audits
        FOR EACH STATEMENT
        EXECUTE FUNCTION fail_retention_audit_store()
      `);
      await addExpiredWork("before-failure");

      await expect(sweepExpiredSensitiveData({ tenantId })).rejects.toThrow(
        "The audit store is unavailable.",
      );

      expect(await admin`
        SELECT id
        FROM omni_auth_sessions
        WHERE tenant_id = ${tenantId}
      `).toEqual([]);
      expect(await admin`
        SELECT id, title, content
        FROM omni_memories
        WHERE tenant_id = ${tenantId}
        ORDER BY id
      `).toEqual([
        { id: "expired-episode-before-failure", title: "[retired]", content: "" },
        { id: "expired-episode-probed", title: "[retired]", content: "" },
      ]);
    } finally {
      await admin.unsafe("DROP FUNCTION IF EXISTS fail_retention_audit_store() CASCADE");
      await admin.unsafe(
        "DROP FUNCTION IF EXISTS record_retention_transaction_probe() CASCADE",
      );
      await admin.unsafe("DROP TABLE IF EXISTS retention_transaction_probe");
    }
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
const refreshRotationRetryVersion = 209;
const oauthSyncBackoffVersion = 210;

// A native client that attests an Android build.
const androidClient = {
  platform: "android",
  appVersion: "1.0.0",
  buildNumber: 1,
  clientContractVersion: 1,
} as const;

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
  return withMigrationsPendingFrom(client, schemaConvergenceVersion, operation);
}

// Runs the operation with the given migration and every later one pending,
// then puts back any ledger row the operation did not record again.
async function withMigrationsPendingFrom<T>(
  client: ReturnType<typeof postgres>,
  version: number,
  operation: () => Promise<T>,
) {
  const recorded = await client`
    SELECT version, name, checksum, applied_at
    FROM omni_schema_version
    WHERE version >= ${version}
  `;
  expect(recorded.map((row) => row.version)).toContain(version);
  await client`
    DELETE FROM omni_schema_version
    WHERE version >= ${version}
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

// Runs the operation with one private account admitted, whose devices sign
// in with a password.
async function withPrivateMobileAccount<T>(
  tenantId: string,
  operation: (account: {
    signIn: (deviceId: string) => Promise<{
      tokens: { accessToken: string; refreshToken: string };
      identity: MobileIdentity;
    }>;
  }) => Promise<T>,
) {
  const email = `${tenantId.replaceAll("_", "-")}@example.com`;
  const password = "an integration mobile password";
  const previous = {
    OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON:
      process.env.OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON,
    OMNIAGENT_DATA_DIR: process.env.OMNIAGENT_DATA_DIR,
  };
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-mobile-integration-"));
  process.env.OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON = JSON.stringify([
    {
      email,
      tenantId,
      tenantName: "Mobile Integration",
      tenantMode: "new",
      label: "Mobile integration",
      role: "operator",
    },
  ]);
  process.env.OMNIAGENT_DATA_DIR = dataDirectory;
  try {
    const auth = await import("@/lib/auth/store");
    const mobile = await import("@/lib/auth/mobile");
    await auth.createUserWithMembership({
      email,
      password,
      role: "operator",
      tenantId,
      tenantName: "Mobile Integration",
    });
    return await operation({
      signIn: async (deviceId) => {
        const signedIn = await mobile.authenticateMobilePassword({
          email,
          password,
          device: { id: deviceId, name: "Integration Android", platform: "android" },
        });
        expect(signedIn).not.toBeNull();
        return signedIn!;
      },
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

function bearerRequest(accessToken: string) {
  return new Request("https://example.test/api/projects", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
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
