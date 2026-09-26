import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  databaseSchemaMigrations,
  ensureDatabaseSchema,
  getSql,
  getVectorStoreStatus,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
  tenantPolicyTables,
} from "@/lib/db/client";
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
  enqueueOperationJob,
  failOperationJob,
  getAgentResumeJobDedupeKey,
  leaseOperationJobByDedupeKey,
  leaseOperationJobs,
} from "@/lib/operations/job-queue";
import { cancelAgentRun, createAgentRun } from "@/lib/runs/store";
import { sweepExpiredSensitiveData } from "@/lib/security/retention";
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
import { createWorkflowRun } from "@/lib/workflows/store";

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

databaseDescribe("Postgres schema integration", () => {
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(databaseUrl!, {
      ssl:
        new URL(databaseUrl!).searchParams.get("sslmode") === "disable"
          ? false
          : "require",
      max: 1,
      prepare: false,
    });

    await dropDatabaseRole(admin, rlsRole);
    await dropDatabaseRole(admin, runtimeRole);
    await dropDatabaseRole(admin, maintenanceRole);
    await dropDatabaseRole(admin, lineageRuntimeRole);
    await dropDatabaseRole(admin, lineageMaintenanceRole);
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

    expect(markers).toEqual(databaseSchemaMigrations);
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

  test("keeps the execution-principal registry empty, owner-only, and actor-governed", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_execution_principals) AS rows,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid = 'omni_tenant_execution_principals'::regclass) AS policies,
        NOT EXISTS (
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'public'
            AND table_name = 'omni_tenant_execution_principals'
            AND grantee <> current_user
        ) AS owner_only,
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
      owner_only: true,
      activation_hold_removed: true,
    });
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

  test("keeps workspace membership explicit, empty, owner-only, and lifecycle-governed", async () => {
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
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'public'
            AND table_name IN (
              'omni_tenant_workspaces',
              'omni_tenant_workspace_memberships'
            )
            AND grantee <> current_user
        ) AS owner_only,
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
      owner_only: true,
      activation_holds_removed: true,
    });
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
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'public'
            AND table_name = 'omni_tenant_memory_access_grants'
            AND grantee <> current_user
        ) AS owner_only,
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
      owner_only: true,
      activation_hold_removed: true,
      binding_validated: true,
    });
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

  test("keeps operation policies empty, owner-only, and unable to waive gates", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_memory_operation_policies)
          AS rows,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid = 'omni_tenant_memory_operation_policies'::regclass)
          AS policies,
        NOT EXISTS (
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'public'
            AND table_name = 'omni_tenant_memory_operation_policies'
            AND grantee <> current_user
        ) AS owner_only,
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
      owner_only: true,
      activation_held: true,
      unsafe_policy_accepted: false,
    });
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
         FROM omni_tenant_actor_memory_purpose_consents) AS purpose_consents,
        NOT EXISTS (
          SELECT 1
          FROM information_schema.table_privileges
          WHERE table_schema = 'public'
            AND table_name IN (
              'omni_memory_informed_notice_contracts',
              'omni_tenant_actor_memory_notice_receipts',
              'omni_tenant_actor_memory_purpose_consents'
            )
            AND grantee <> current_user
        ) AS owner_only
    `;

    expect(surface).toEqual({
      verifier_recorded: true,
      notice_contracts: 0,
      notice_receipts: 0,
      purpose_consents: 0,
      owner_only: true,
    });
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
        NOT EXISTS (
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'public'
            AND table_name IN (
              'omni_memory_informed_notice_approval_batches',
              'omni_memory_informed_notice_approval_contracts',
              'omni_memory_informed_notice_review_attestations'
            )
            AND grantee <> current_user
        ) AS owner_only,
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

    expect(surface).toEqual({
      migration_recorded: true,
      anchor_migration_recorded: true,
      batches: 0,
      contracts: 0,
      attestations: 0,
      policies: 3,
      owner_only: true,
      persistence_held: true,
      anchor_columns: 4,
      standing_notice_valid: true,
      data_right_notice_accepted: false,
    });
  });

  test("keeps one-time memory data-right requests empty, owner-only, and inactive", async () => {
    const [surface] = await admin`
      SELECT
        (SELECT count(*)::int FROM omni_tenant_memory_data_right_requests)
          AS rows,
        (SELECT count(*)::int FROM pg_policy
         WHERE polrelid = 'omni_tenant_memory_data_right_requests'::regclass)
          AS policies,
        NOT EXISTS (
          SELECT 1 FROM information_schema.table_privileges
          WHERE table_schema = 'public'
            AND table_name = 'omni_tenant_memory_data_right_requests'
            AND grantee <> current_user
        ) AS owner_only,
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
      owner_only: true,
      activation_held: true,
      valid_held_request: true,
      mismatched_confirmation_accepted: false,
    });
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
