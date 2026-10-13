import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createProject, createProjectTasks, updateProjectTask } from "@/lib/projects/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { getWorkflowRunDetail } from "@/lib/workflows/store";
import { createResponsibilityDraft, changeResponsibilityDraft, getResponsibilityDraft } from "@/lib/responsibilities/service";
import * as runtimeStore from "@/lib/responsibilities/lifecycle-store";
import { changeResponsibilityLifecycle } from "@/lib/responsibilities/lifecycle-state";
import { resolveResponsibilityPilot } from "@/lib/responsibilities/runtime-references";
import { prepareDueWake, enqueueResponsibilityWake, processDueResponsibilities } from "@/lib/responsibilities/scheduler";
import { tickResponsibilityWorkflow } from "@/lib/responsibilities/runtime";
import { RESPONSIBILITY_WORK_ITEM_PILOT } from "@/lib/responsibilities/runtime-contracts";
import { draftFixture } from "@/lib/responsibilities/test-fixtures";
import { responsibilityBaselineSchema } from "@/lib/responsibilities/observation-contracts";
import { recordResponsibilityObservationWithSql, readResponsibilityObservationHistory } from "@/lib/responsibilities/observation-store";
import { responsibilityObservationReader } from "@/lib/responsibilities/observation-references";
import { RESPONSIBILITY_WORK_ITEM_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import { enableResponsibilityNotifications, getResponsibilityNotifications } from "@/lib/responsibilities/notification-service";
import { admitObservedNotificationWithSql } from "@/lib/responsibilities/notification-store";
import { attemptResponsibilityNotification } from "@/lib/responsibilities/notification-delivery";
import { readOwnedWorkItemWithSql, WORK_ITEM_FOLLOWTHROUGH_PROCEDURE } from "@/lib/responsibilities/work-item-source";
import { showWorkItemService } from "@/lib/app-services/work-items";
import { lockResponsibilityWorkspace } from "@/lib/responsibilities/workspace-read-fence";
import { verifyResponsibilityWorkspaceFence } from "@/lib/db/responsibility-workspace-fence";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const userId = "77777777-7777-4777-8777-777777777777"; const actorId = `actor:${userId}`; const email = "responsibility-work@example.test";
databaseDescribe("Canonical work-item follow-through under serving-role isolation", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient(); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    admin = postgres(databaseUrl!, { max: 1, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    // Fixture-only provisioned legacy table grants; all production FORCE RLS,
    // immutable receipt guards and deferred reconciliation remain enabled.
    // Workspace authority retains the exact migration-only SELECT grants.
    await admin`GRANT SELECT,UPDATE ON omni_auth_users,omni_auth_memberships,omni_auth_tenants,
      omni_work_items,omni_meetings,omni_memories,omni_memory_lifecycle_states,omni_today_preferences TO omni_runtime`;
    await admin`GRANT INSERT ON omni_today_preferences TO omni_runtime`;
    await admin`GRANT SELECT ON omni_schema_version,omni_meeting_revisions,omni_work_projects,omni_work_project_memberships,omni_agent_runs,omni_mission_attempts TO omni_runtime`;
    await admin`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_workflow_runs,omni_workflow_steps,omni_workflow_events,omni_operation_jobs,omni_tool_executions,omni_personal_notifications TO omni_runtime`;
    await admin`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO omni_runtime`;
    await admin`INSERT INTO omni_auth_users (id,email,password_hash) VALUES (${userId},${email},'fixture-only')`;
  });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs(); });
  async function serving(enabled: boolean) { await getSql().query(enabled ? "SET ROLE omni_runtime" : "SET ROLE NONE"); }
  async function fixture(tag: string, input: { maximumChecks?: number; maximumNotifications?: number; preferences?: boolean } = {}) {
    await serving(false);
    const tenantId = `work-followthrough-${tag}`; const workspaceId = `workspace:work-followthrough-${tag}`; const owner = { tenantId, actorId };
    const context: SecurityContext = { tenantId, actorId: email, role: "operator", source: "session", auth: { userId, email, sessionId: `fixture-${tag}`, tenantName: tag } };
    await admin`INSERT INTO omni_auth_tenants (id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships (id,tenant_id,user_id,role) VALUES (${`membership:${tag}`},${tenantId},${userId},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces (tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},${tag},${actorId},'active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    await admin`INSERT INTO omni_tenant_workspace_memberships (tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'user',${actorId},${actorId},1,'manager','active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const scope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId, workspaceId, correlationId: tag, purpose: "responsibility.fixture" });
    const project = await runWithDatabaseActorScope(tenantId, [actorId], () => createProject({ tenantId, actorId, title: "Follow my proposal", objective: "Finite fixture", mutation: { executionScope: scope, idempotencyKey: `${tag}:project` } }));
    const [task] = await runWithDatabaseActorScope(tenantId, [actorId], () => createProjectTasks(project.id, [{ title: "Deliver the proposal" }], { tenantId, actorId, mutation: { executionScope: scope, idempotencyKey: `${tag}:task` } }));
    const now = new Date().toISOString(); const startsAt = new Date(Math.floor(Date.parse(now) / 60_000) * 60_000).toISOString();
    if (input.preferences !== false) await admin`INSERT INTO omni_today_preferences (tenant_id,actor_id,brief_enabled,brief_time,timezone,reminder_lead_minutes,notifications_enabled,quiet_hours_enabled,quiet_hours_start,quiet_hours_end,visible_sections,created_at,updated_at)
      VALUES (${tenantId},${email},false,'08:00','UTC',30,true,false,'00:00','23:59',${["focus"]},${now},${now})`;
    await serving(true);
    const draft = { ...draftFixture, sources: [{ kind: "work_item" as const, id: task.id, workspaceId, projectId: project.id }], procedureId: WORK_ITEM_FOLLOWTHROUGH_PROCEDURE, agentId: "atlas", work: { workspaceId, projectId: project.id, workItemId: task.id },
      cadence: { frequency: "daily" as const, interval: 1, timezone: "UTC", startsAt, expiresAt: new Date(Date.parse(startsAt) + 7 * 86_400_000).toISOString(), missedPolicy: "skip" as const },
      limits: { ...draftFixture.limits!, maxChecks: input.maximumChecks ?? 7, maxNotifications: input.maximumNotifications ?? 7 } };
    const created = await createResponsibilityDraft(context, { action: "create", expectedRevision: 0, draft }, `${tag}:create`);
    const preview = await getResponsibilityDraft(context, created.current.id, true);
    if (!("reviewSha256" in preview.readiness)) throw new Error(`Fixture review unavailable: ${JSON.stringify(preview.readiness)}`);
    const reviewed = await changeResponsibilityDraft(context, created.current.id, { action: "review", expectedRevision: 1, draftSha256: preview.readiness.draftSha256, reviewSha256: preview.readiness.reviewSha256 }, `${tag}:review`);
    const record = reviewed.current;
    await runtimeStore.withResponsibilityRuntimeTransaction(owner, async (sql) => {
      const at = await runtimeStore.runtimeDatabaseNow(sql); const resolved = await resolveResponsibilityPilot(sql, owner, record, at, true);
      const current = changeResponsibilityLifecycle({ owner, responsibilityId: record.id, current: null, configuration: resolved.configuration, now: at, nextDueAt: startsAt,
        request: { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: resolved.configuration.configurationSha256, acknowledgePilot: RESPONSIBILITY_WORK_ITEM_PILOT } });
      await runtimeStore.persistRuntimeTransition(sql, { previous: null, current, action: "activate", key: `${tag}:activate`, request: { fixture: "previously-active-due-slot" } });
    });
    return { owner, context, record, scope, task, project, workspaceId, tag };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function owned<T>(f: Fixture, work: () => Promise<T>) { return runWithDatabaseActorScope(f.owner.tenantId, [actorId, email], work); }
  async function enable(f: Fixture) {
    const preview = await getResponsibilityNotifications(f.context, f.record.id, true);
    if (!("preview" in preview) || preview.preview.state !== "ready") throw new Error(`Notification preview unavailable: ${JSON.stringify(preview)}`);
    return enableResponsibilityNotifications(f.context, f.record.id, { action: "enable", expectedRuntimeRevision: preview.preview.expectedRuntimeRevision,
      expectedRuntimeGeneration: preview.preview.expectedRuntimeGeneration, configurationSha256: preview.preview.configuration.configurationSha256, acknowledgeDestination: "owner_in_app" }, `${f.tag}:enable`);
  }
  async function observe(f: Fixture, key: string, admit = true) {
    return runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const rows = await sql`SELECT snapshot FROM omni_responsibility_baselines WHERE tenant_id = ${f.owner.tenantId} AND actor_id = ${actorId} AND responsibility_id = ${f.record.id} FOR UPDATE`;
      const baseline = rows[0] ? responsibilityBaselineSchema.parse(rows[0].snapshot) : null;
      const at = await runtimeStore.runtimeDatabaseNow(sql);
      const result = await recordResponsibilityObservationWithSql(sql, f.owner, { responsibilityId: f.record.id, expectedResponsibilityRevision: f.record.revision,
        expectedReviewSha256: f.record.review!.reviewSha256, expectedBaselineRevision: baseline?.revision ?? 0, policySha256: RESPONSIBILITY_WORK_ITEM_COMPARISON_POLICY.policySha256 }, key,
      responsibilityObservationReader(f.context, f.owner), at);
      if (admit && !result.replayed) await admitObservedNotificationWithSql(sql, f.owner, result.receipt, result.receipt.savedAt);
      return result;
    });
  }
  async function change(f: Fixture, key: string, input: Parameters<typeof updateProjectTask>[2]) {
    await serving(false);
    await owned(f, () => updateProjectTask(f.project.id, f.task.id, input, { ...f.owner,
      mutation: { executionScope: f.scope, idempotencyKey: `${f.tag}:${key}` } }));
    await serving(true);
  }
  async function runDue(f: Fixture) {
    const admitted = await prepareDueWake(f.owner, f.record.id);
    if (!admitted || admitted === "reconciled" || admitted === "blocked") throw new Error(`Due WorkItem admission failed: ${String(admitted)}`);
    await enqueueResponsibilityWake(f.owner, f.record.id, admitted);
    const runtime = await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false);
    const wake = runtime.wakes[0];
    const workflow = await owned(f, () => getWorkflowRunDetail(wake.workflowRunId!, { tenantId: f.owner.tenantId }));
    expect(workflow).toBeDefined();
    expect((await owned(f, () => tickResponsibilityWorkflow(workflow!))).run.status).toBe("completed");
    return { workflow: workflow!, wake };
  }

  test("reviews and reads with exact workspace grants while direct locks and mutations remain forbidden", async () => {
    const f = await fixture("serving-grants");
    await verifyResponsibilityWorkspaceFence((query, parameters) => admin.unsafe(query, (parameters ?? []) as never[]));
    expect(await admin`SELECT has_table_privilege('omni_runtime','omni_tenant_workspaces','UPDATE') AS workspace_update,
      has_any_column_privilege('omni_runtime','omni_tenant_workspace_memberships','UPDATE') AS membership_update`).toMatchObject([{ workspace_update: false, membership_update: false }]);
    await expect(owned(f, () => getSql()`SELECT workspace_id FROM omni_tenant_workspaces FOR SHARE`)).rejects.toMatchObject({ code: "42501" });
    await expect(owned(f, () => getSql()`UPDATE omni_tenant_workspace_memberships SET state = state WHERE tenant_id = ${f.owner.tenantId}`)).rejects.toMatchObject({ code: "42501" });
    expect((await getResponsibilityDraft(f.context, f.record.id, true)).readiness.state).toBe("ready");
    expect((await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, true)).preview?.state).toBe("ready");
    expect((await showWorkItemService({ context: f.context }, f.record.draft.work!)).data.workItem.workItemId).toBe(f.task.id);
  });

  test("fails closed outside exact actor scope, workspace membership, and valid source identity", async () => {
    const f = await fixture("read-fence-scope");
    for (const owner of [{ ...f.owner, tenantId: "foreign-tenant" }, { ...f.owner, actorId: "actor:88888888-8888-4888-8888-888888888888" },
      { ...f.owner, actorId: email }]) {
      await runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
        expect(await lockResponsibilityWorkspace(sql, owner, f.workspaceId)).toBe(false);
      });
    }
    await runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      expect(await lockResponsibilityWorkspace(sql, f.owner, "workspace:unknown")).toBe(false);
      await sql`SELECT set_config('omni.system_scope', 'true', true)`;
      expect(await lockResponsibilityWorkspace(sql, f.owner, f.workspaceId)).toBe(false);
    });
    await expect(runtimeStore.withResponsibilityRuntimeTransaction(f.owner, (sql) => readOwnedWorkItemWithSql(sql, f.owner,
      { ...f.record.draft.work!, workItemId: "" }, new Date().toISOString()))).rejects.toBeDefined();
    await admin`UPDATE omni_tenant_workspace_memberships SET state = 'revoked', lifecycle_revision = lifecycle_revision + 1,
      revoked_at = statement_timestamp(), revoked_by_actor_id = ${actorId}, updated_at = statement_timestamp()
      WHERE tenant_id = ${f.owner.tenantId} AND workspace_id = ${f.workspaceId}`;
    expect((await getResponsibilityDraft(f.context, f.record.id, true)).readiness).toMatchObject({ state: "blocked", issues: ["responsibility_source_unavailable"] });
    await expect(showWorkItemService({ context: f.context }, f.record.draft.work!)).rejects.toMatchObject({ code: "responsibility_source_unavailable" });
  });

  test("keeps membership revocation behind the authoritative read transaction and denies every later read", async () => {
    const f = await fixture("concurrent-revocation");
    const applicationName = "responsibility-workspace-revoker";
    const revoker = postgres(databaseUrl!, { max: 1, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require",
      connection: { application_name: applicationName }, onnotice: () => undefined });
    let releaseRead!: () => void; let lockAcquired!: () => void;
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const read = runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const value = await readOwnedWorkItemWithSql(sql, f.owner, f.record.draft.work!, await runtimeStore.runtimeDatabaseNow(sql));
      lockAcquired(); await release; return value;
    });
    let revocation: Promise<unknown> | undefined;
    try {
      await acquired;
      revocation = revoker`UPDATE omni_tenant_workspace_memberships SET state = 'revoked', lifecycle_revision = lifecycle_revision + 1,
        revoked_at = statement_timestamp(), revoked_by_actor_id = ${actorId}, updated_at = statement_timestamp()
        WHERE tenant_id = ${f.owner.tenantId} AND workspace_id = ${f.workspaceId}`.then((value) => value);
      let blocked = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await admin`SELECT wait_event_type FROM pg_stat_activity WHERE application_name = ${applicationName}`;
        if (state[0]?.wait_event_type === "Lock") { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      releaseRead();
      expect((await read).workItem.workItemId).toBe(f.task.id);
      await revocation;
      await expect(showWorkItemService({ context: f.context }, f.record.draft.work!)).rejects.toMatchObject({ code: "responsibility_source_unavailable" });
    } finally { releaseRead(); await read; await revocation; await revoker.end(); }
  });

  test("the promotion gate rejects public execution and an unsafe helper search path", async () => {
    for (const change of ["GRANT EXECUTE ON FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) TO PUBLIC",
      "ALTER FUNCTION public.omni_lock_responsibility_workspace_v1(TEXT,TEXT,TEXT) SET search_path = public, pg_catalog"]) {
      const rollback = new Error("rollback deliberate catalog drift");
      await expect(admin.begin(async (transaction) => {
        await transaction.unsafe(change);
        await expect(verifyResponsibilityWorkspaceFence((query, parameters) => transaction.unsafe(query, (parameters ?? []) as never[])))
          .rejects.toThrow("Responsibility workspace read fence does not match this release");
        throw rollback;
      })).rejects.toBe(rollback);
    }
    await verifyResponsibilityWorkspaceFence((query, parameters) => admin.unsafe(query, (parameters ?? []) as never[]));
  });

  test("runs the exact governed read, keeps completed work unverified, delivers once and survives restart/reopening", async () => {
    const f = await fixture("complete"); await enable(f);
    expect(await admin`SELECT id FROM omni_memories WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
    expect((await observe(f, "baseline")).receipt.plan.outcome).toBe("baseline_established");
    expect((await observe(f, "quiet")).receipt.plan.outcome).toBe("no_change");
    expect((await getResponsibilityNotifications(f.context, f.record.id)).candidates).toEqual([]);
    await change(f, "done", { status: "done" });
    const before = (await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current!;
    const execution = await runDue(f);
    const after = (await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current!;
    expect(after).toMatchObject({ state: "active", budget: { usedChecks: 1, reservedChecks: 0 } });
    expect(after.configuration).toEqual(before.configuration);
    const actual = await showWorkItemService({ context: f.context }, f.record.draft.work!);
    expect(actual.data.workItem).toMatchObject({ sourceStatus: "done/unknown", canonicalStatus: "unverified" });
    const state = await getResponsibilityNotifications(f.context, f.record.id);
    expect(state.candidates).toHaveLength(1);
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, state.candidates[0].id)).toBe("delivered");
    await closeDatabaseClient(); await ensureDatabaseSchema(); await serving(true);
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, state.candidates[0].id)).toBe("unchanged");
    expect((await owned(f, () => tickResponsibilityWorkflow(execution.workflow))).run.status).toBe("completed");
    expect(await admin`SELECT id FROM omni_tool_executions WHERE tenant_id = ${f.owner.tenantId} AND tool_id = 'app.work_items.show'`).toHaveLength(1);
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toHaveLength(1);
    await change(f, "reopen", { status: "open" });
    const reopened = await observe(f, "reopened");
    expect(reopened.receipt.plan).toMatchObject({ outcome: "material_change", reasons: ["work_status"] });
    const next = await getResponsibilityNotifications(f.context, f.record.id);
    const pending = next.candidates.find((candidate) => candidate.state === "pending")!;
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, pending.id)).toBe("delivered");
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toHaveLength(2);
    expect(await admin`SELECT id FROM omni_mobile_push_deliveries WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
  });

  test("detects a deadline crossing without a source edit and retains one change identity across replay", async () => {
    const f = await fixture("deadline"); await enable(f);
    await change(f, "deadline", { dueAt: new Date(Date.now() + 2_000).toISOString() });
    expect((await observe(f, "before-deadline")).receipt.plan.outcome).toBe("baseline_established");
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    const changed = await observe(f, "after-deadline");
    expect(changed.receipt.plan).toMatchObject({ outcome: "material_change", reasons: ["work_overdue"] });
    const replay = await runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => recordResponsibilityObservationWithSql(sql, f.owner, changed.receipt.request,
      "after-deadline", responsibilityObservationReader(f.context, f.owner), await runtimeStore.runtimeDatabaseNow(sql)));
    expect(replay.replayed).toBe(true);
    expect((await observe(f, "still-overdue")).receipt.plan.outcome).toBe("no_change");
    expect((await getResponsibilityNotifications(f.context, f.record.id)).candidates).toHaveLength(1);
  });

  test("blocks source access after owner membership revocation without creating tool or observation evidence", async () => {
    const f = await fixture("revoked");
    await admin`UPDATE omni_auth_memberships SET status = 'disabled' WHERE tenant_id = ${f.owner.tenantId}`;
    expect(await processDueResponsibilities({ context: f.context, limit: 1 })).toMatchObject({ blocked: 1, enqueued: 0, failed: 0 });
    expect((await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current).toMatchObject({ state: "blocked", reason: "authority_changed" });
    expect((await readResponsibilityObservationHistory(f.owner, f.record.id, 25)).baseline).toBeNull();
    expect(await admin`SELECT id FROM omni_tool_executions WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
  });

  test("rejects cross-project source reads and mixed runtime source/tool/stop lanes in PostgreSQL", async () => {
    const f = await fixture("scope");
    await expect(showWorkItemService({ context: f.context }, { ...f.record.draft.work!, projectId: "wrong-project" })).rejects.toBeDefined();
    const head = (await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current!;
    for (const patch of [{ pilot: "native_meeting_metadata_v1" }, { source: { ...head.configuration.source, kind: "meeting" } },
      { tool: { ...head.configuration.tool, id: "app.meetings.show" } }, { stops: ["expiry", "meeting_started", "meeting_canceled"] }]) {
      const invalid = { ...head, revision: head.revision + 1, configuration: { ...head.configuration, ...patch } };
      await expect(admin`UPDATE omni_responsibility_lifecycles SET revision = ${invalid.revision}, snapshot = ${admin.json(invalid)}
        WHERE tenant_id = ${f.owner.tenantId} AND actor_id = ${actorId} AND responsibility_id = ${f.record.id}`).rejects.toThrow("runtime head binding is invalid");
    }
    expect((await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current).toEqual(head);
  });
});
