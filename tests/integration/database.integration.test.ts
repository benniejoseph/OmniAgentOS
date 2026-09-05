import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  databaseSchemaMigrations,
  ensureDatabaseSchema,
  getVectorStoreStatus,
  runWithDatabaseTenantScope,
  tenantPolicyTables,
} from "@/lib/db/client";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import { rebuildMemoryGraph } from "@/lib/memory/graph";
import { saveMemories } from "@/lib/memory/store";
import { createKnowledgeDocument } from "@/lib/rag/store";
import {
  completeOperationJob,
  enqueueOperationJob,
  failOperationJob,
} from "@/lib/operations/job-queue";
import { sweepExpiredSensitiveData } from "@/lib/security/retention";
import { createWorkflowRun } from "@/lib/workflows/store";

const databaseUrl = process.env.DATABASE_URL;
const resetAllowed = process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true";
const requirePgvector =
  process.env.OMNIAGENT_INTEGRATION_REQUIRE_PGVECTOR !== "false";
const databaseDescribe = databaseUrl && resetAllowed ? describe : describe.skip;
const rlsRole = "omniagent_integration_rls";
const runtimeRole = "omniagent_integration_runtime";
const maintenanceRole = "omniagent_integration_maintenance";

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

  test("returns newly inserted and replayed bulk memories", async () => {
    const tenantId = "bulk_memory_tenant";
    const input = [
      {
        id: "bulk-memory-one",
        tenantId,
        title: "First bulk memory",
        content: "First integration memory.",
      },
      {
        id: "bulk-memory-two",
        tenantId,
        title: "Second bulk memory",
        content: "Second integration memory.",
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

  test("keeps the execution-principal registry empty, owner-only, and activation-held", async () => {
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
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'omni_tenant_execution_principals'::regclass
            AND conname = 'omni_execution_principal_activation_hold_check'
            AND convalidated
            AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
        ) AS activation_held
    `;

    expect(surface).toEqual({
      rows: 0,
      policies: 2,
      owner_only: true,
      activation_held: true,
    });
    await expect(admin`
      INSERT INTO omni_tenant_execution_principals (
        tenant_id, principal_kind, principal_id, principal_generation,
        controller_actor_id, agent_definition_id, system_principal_class,
        state, lifecycle_revision, created_by_actor_id,
        activated_by_actor_id, activated_at
      ) VALUES (
        'tenant:forbidden', 'system', 'service:forbidden', 1,
        'actor:00000000-0000-4000-8000-000000000001', NULL, 'worker',
        'active', 1, 'actor:00000000-0000-4000-8000-000000000001',
        'actor:00000000-0000-4000-8000-000000000001', statement_timestamp()
      )
    `).rejects.toMatchObject({ code: "23514" });
  });

  test("keeps workspace membership explicit, empty, owner-only, and activation-held", async () => {
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
        (
          SELECT count(*)::int FROM pg_constraint
          WHERE (conrelid, conname) IN (
            (
              'omni_tenant_workspaces'::regclass,
              'omni_workspace_activation_hold_check'
            ),
            (
              'omni_tenant_workspace_memberships'::regclass,
              'omni_workspace_membership_activation_hold_check'
            )
          ) AND convalidated
            AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
        ) AS activation_holds
    `;

    expect(surface).toEqual({
      workspaces: 0,
      memberships: 0,
      policies: 4,
      owner_only: true,
      activation_holds: 2,
    });
    await expect(admin`
      INSERT INTO omni_tenant_workspaces (
        tenant_id, workspace_id, state, lifecycle_revision,
        created_by_actor_id, activated_by_actor_id, activated_at
      ) VALUES (
        'tenant:forbidden', 'workspace:forbidden', 'active', 1,
        'actor:00000000-0000-4000-8000-000000000001',
        'actor:00000000-0000-4000-8000-000000000001',
        statement_timestamp()
      )
    `).rejects.toMatchObject({ code: "23514" });
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
        id, tenant_id, mode, status, prompt, messages, started_at, completed_at
      )
      VALUES
        (
          'expired-run', 'tenant_a', 'orchestrate', 'completed', 'sensitive',
          '[]'::jsonb, NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        ),
        (
          'active-run', 'tenant_a', 'orchestrate', 'waiting_approval', 'keep',
          '[]'::jsonb, NOW() - INTERVAL '4000 days', NULL
        ),
        (
          'expired-waiting-run', 'tenant_a', 'orchestrate', 'waiting_approval', 'redact',
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
        id, tool_id, tool_name, risk_level, status, tenant_id, input, created_at, completed_at
      )
      VALUES
        (
          'expired-tool', 'tool', 'Tool', 1, 'executed', 'tenant_a',
          '{"secret":"value"}'::jsonb, NOW() - INTERVAL '4000 days', NOW() - INTERVAL '4000 days'
        ),
        (
          'expired-approval', 'tool', 'Tool', 2, 'approval_required', 'tenant_a',
          '{"secret":"pending"}'::jsonb, NOW() - INTERVAL '4000 days', NULL
        )
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
      SELECT status, input, approval_reason
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
    expect(remainingGraphNodes).toEqual([]);
    expect(rebuiltGraph.count).toBeGreaterThan(0);
    expect(pendingGraphRebuilds).toEqual([]);
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
      ],
      sessions: [
        { id: "integration-session-a", tenant_id: "tenant_a" },
      ],
    });

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
