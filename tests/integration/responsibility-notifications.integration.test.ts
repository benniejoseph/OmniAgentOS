import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getDatabasePoolMax, getSql, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { saveMeeting } from "@/lib/meetings/store";
import type { MeetingDraftInput } from "@/lib/meetings/contracts";
import { createProject, createProjectTasks } from "@/lib/projects/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";
import { getWorkflowRunDetail } from "@/lib/workflows/store";
import { SAVED_PROCEDURE_V1_TAG } from "@/lib/workflows/saved-procedures";
import { createResponsibilityDraft, changeResponsibilityDraft, getResponsibilityDraft } from "@/lib/responsibilities/service";
import * as runtimeStore from "@/lib/responsibilities/lifecycle-store";
import { changeResponsibilityLifecycle } from "@/lib/responsibilities/lifecycle-state";
import { resolveResponsibilityPilot } from "@/lib/responsibilities/runtime-references";
import { processDueResponsibilities } from "@/lib/responsibilities/scheduler";
import { tickResponsibilityWorkflow } from "@/lib/responsibilities/runtime";
import { RESPONSIBILITY_PILOT } from "@/lib/responsibilities/runtime-contracts";
import { draftFixture } from "@/lib/responsibilities/test-fixtures";
import { responsibilityBaselineSchema } from "@/lib/responsibilities/observation-contracts";
import { recordResponsibilityObservationWithSql, readResponsibilityObservationHistory } from "@/lib/responsibilities/observation-store";
import { responsibilityObservationReader } from "@/lib/responsibilities/observation-references";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import { changeResponsibilityNotifications, enableResponsibilityNotifications, getResponsibilityNotifications } from "@/lib/responsibilities/notification-service";
import { admitObservedNotificationWithSql, syncNotificationLifecycleWithSql } from "@/lib/responsibilities/notification-store";
import { attemptResponsibilityNotification, processDueResponsibilityNotifications } from "@/lib/responsibilities/notification-delivery";
import { listNotifications, markAllNotificationsRead, updatePersonalNotification } from "@/lib/today/notifications";
import { notificationBulkMutationFromRequest, notificationMutationFromRequest } from "@/lib/today/notification-events";
import { applyNotificationDispositionDecision } from "@/lib/mobile/notification-disposition-store";
import { notificationDecisionExecutionScope } from "@/lib/mobile/notification-decision-events";
import { decideServerNotification, notificationDispositionCoordinates, responsibilityChangeNotificationCandidate } from "@/lib/mobile/notification-delivery-policy";
import { updateTodayPreferences } from "@/lib/today/briefs";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const userId = "44444444-4444-4444-8444-444444444444"; const actorId = `actor:${userId}`; const email = "responsibility-inbox@example.test";
databaseDescribe("Responsibility in-app delivery under serving-role isolation", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient(); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    admin = postgres(databaseUrl!, { max: 1, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    // Fixture-only provisioned legacy table grants; all production FORCE RLS,
    // immutable receipt guards and deferred reconciliation remain enabled.
    await admin`GRANT SELECT,UPDATE ON omni_auth_users,omni_auth_memberships,omni_auth_tenants,omni_tenant_workspaces,
      omni_tenant_workspace_memberships,omni_work_items,omni_meetings,omni_memories,omni_memory_lifecycle_states,omni_today_preferences TO omni_runtime`;
    await admin`GRANT INSERT ON omni_today_preferences TO omni_runtime`;
    await admin`GRANT SELECT ON omni_schema_version,omni_meeting_revisions,omni_work_projects,omni_work_project_memberships,omni_agent_runs,omni_mission_attempts TO omni_runtime`;
    await admin`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_workflow_runs,omni_workflow_steps,omni_workflow_events,omni_operation_jobs,omni_tool_executions,omni_personal_notifications TO omni_runtime`;
    await admin`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO omni_runtime`;
    await admin`INSERT INTO omni_auth_users (id,email,password_hash) VALUES (${userId},${email},'fixture-only')`;
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs(); });
  async function serving(enabled: boolean) { await getSql().query(enabled ? "SET ROLE omni_runtime" : "SET ROLE NONE"); }
  async function fixture(tag: string, input: { maximumChecks?: number; maximumNotifications?: number; preferences?: boolean } = {}) {
    await serving(false);
    const tenantId = `notification-${tag}`; const workspaceId = `workspace:notification-${tag}`; const owner = { tenantId, actorId };
    const context: SecurityContext = { tenantId, actorId: email, role: "operator", source: "session", auth: { userId, email, sessionId: `fixture-${tag}`, tenantName: tag } };
    await admin`INSERT INTO omni_auth_tenants (id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships (id,tenant_id,user_id,role) VALUES (${`membership:${tag}`},${tenantId},${userId},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces (tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},${tag},${actorId},'active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    await admin`INSERT INTO omni_tenant_workspace_memberships (tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'user',${actorId},${actorId},1,'manager','active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const scope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId, workspaceId, correlationId: tag, purpose: "responsibility.fixture" });
    const project = await runWithDatabaseActorScope(tenantId, [actorId], () => createProject({ tenantId, actorId, title: "Observe a meeting", objective: "Finite fixture", mutation: { executionScope: scope, idempotencyKey: `${tag}:project` } }));
    const [task] = await runWithDatabaseActorScope(tenantId, [actorId], () => createProjectTasks(project.id, [{ title: "Observe meeting" }], { tenantId, actorId, mutation: { executionScope: scope, idempotencyKey: `${tag}:task` } }));
    const now = new Date().toISOString(); const startsAt = new Date(Math.floor(Date.parse(now) / 60_000) * 60_000).toISOString();
    const meetingDraft: MeetingDraftInput = { title: "Private meeting", summary: "PRIVATE_SOURCE_PROSE", status: "scheduled", scheduledStartAt: new Date(Date.parse(now) + 7_200_000).toISOString(),
      scheduledEndAt: new Date(Date.parse(now) + 10_800_000).toISOString(), actualStartAt: null, actualEndAt: null, timezone: "UTC", location: "", projectId: null, declaredAccessClass: "owner_private",
      participants: [{ participantId: "owner", displayName: "Owner", email: null, entityId: null, role: "organizer", response: "accepted", attendeeConsent: "granted", recordingConsent: "not_required", consentCapturedAt: now, source: "manual" }],
      sourceLinks: [], entityLinks: [], decisions: [], commitments: [], followUps: [] };
    const meetingScope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId, workspaceId, correlationId: `${tag}:meeting`, purpose: "meeting.write" });
    const meetingAuthority = { tenantId, workspaceId, canonicalActorId: actorId, readableActorIds: [actorId], executionScope: meetingScope, idempotencyKey: `${tag}:meeting` };
    const meeting = await saveMeeting({ authority: meetingAuthority, draft: meetingDraft });
    const procedureId = `notify-${tag}`; const binding = buildUserPrivateMemoryAccessBindingV1({ tenantId, ownerActorId: actorId, originPurpose: "responsibility.fixture" });
    const content = JSON.stringify({ schemaVersion: 1, id: procedureId, aliases: [`Observe ${tag}`], toolBindings: [{ toolId: "app.meetings.show", input: { workspaceId, meetingId: meeting.meetingId } }] });
    await admin`INSERT INTO omni_memories (id,tenant_id,type,title,content,tags,scope,source,access_contract_version,access_state,owner_actor_id,visibility,sensitivity,origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
      VALUES (${`procedure:${tag}`},${tenantId},'procedure','Observe meeting',${content},${[SAVED_PROCEDURE_V1_TAG]},'workspace','manual',1,'scope_bound',${actorId},'user_private',
        ${binding.sensitivity},${binding.originPurpose},${[...binding.allowedPurposeIds]},${binding.accessScopeSha256},${binding.accessBoundAt})`;
    if (input.preferences !== false) await admin`INSERT INTO omni_today_preferences (tenant_id,actor_id,brief_enabled,brief_time,timezone,reminder_lead_minutes,notifications_enabled,quiet_hours_enabled,quiet_hours_start,quiet_hours_end,visible_sections,created_at,updated_at)
      VALUES (${tenantId},${email},false,'08:00','UTC',30,true,false,'00:00','23:59',${["focus"]},${now},${now})`;
    await serving(true);
    const draft = { ...draftFixture, sources: [{ kind: "meeting" as const, id: meeting.meetingId, workspaceId }], procedureId, agentId: "atlas", work: { workspaceId, projectId: project.id, workItemId: task.id },
      cadence: { frequency: "daily" as const, interval: 1, timezone: "UTC", startsAt, expiresAt: new Date(Date.parse(startsAt) + 7 * 86_400_000).toISOString(), missedPolicy: "skip" as const },
      limits: { ...draftFixture.limits!, maxChecks: input.maximumChecks ?? 2, maxNotifications: input.maximumNotifications ?? 2 } };
    const created = await createResponsibilityDraft(context, { action: "create", expectedRevision: 0, draft }, `${tag}:create`);
    const preview = await getResponsibilityDraft(context, created.current.id, true);
    if (!("reviewSha256" in preview.readiness)) throw new Error(`Fixture review unavailable: ${JSON.stringify(preview.readiness)}`);
    const reviewed = await changeResponsibilityDraft(context, created.current.id, { action: "review", expectedRevision: 1, draftSha256: preview.readiness.draftSha256, reviewSha256: preview.readiness.reviewSha256 }, `${tag}:review`);
    const record = reviewed.current;
    await runtimeStore.withResponsibilityRuntimeTransaction(owner, async (sql) => {
      const at = await runtimeStore.runtimeDatabaseNow(sql); const resolved = await resolveResponsibilityPilot(sql, owner, record, at, true);
      const current = changeResponsibilityLifecycle({ owner, responsibilityId: record.id, current: null, configuration: resolved.configuration, now: at, nextDueAt: startsAt,
        request: { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: resolved.configuration.configurationSha256, acknowledgePilot: RESPONSIBILITY_PILOT } });
      await runtimeStore.persistRuntimeTransition(sql, { previous: null, current, action: "activate", key: `${tag}:activate`, request: { fixture: "previously-active-due-slot" } });
    });
    return { owner, context, record, meeting, meetingDraft, meetingAuthority, tag };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function owned<T>(f: Fixture, work: () => Promise<T>) { return runWithDatabaseActorScope(f.owner.tenantId, [actorId, email], work); }
  async function enable(f: Fixture) {
    const preview = await getResponsibilityNotifications(f.context, f.record.id, true);
    if (!("preview" in preview) || preview.preview.state !== "ready") throw new Error(`Fixture notification preview unavailable: ${JSON.stringify(preview)}`);
    return enableResponsibilityNotifications(f.context, f.record.id, { action: "enable", expectedRuntimeRevision: preview.preview.expectedRuntimeRevision,
      expectedRuntimeGeneration: preview.preview.expectedRuntimeGeneration, configurationSha256: preview.preview.configuration.configurationSha256, acknowledgeDestination: "owner_in_app" }, `${f.tag}:enable`);
  }
  async function observe(f: Fixture, key: string, admit = false, fail = false) {
    return runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const rows = await sql`SELECT snapshot FROM omni_responsibility_baselines WHERE tenant_id = ${f.owner.tenantId} AND actor_id = ${actorId} AND responsibility_id = ${f.record.id} FOR UPDATE`;
      const baseline = rows[0] ? responsibilityBaselineSchema.parse(rows[0].snapshot) : null;
      const at = await runtimeStore.runtimeDatabaseNow(sql);
      const result = await recordResponsibilityObservationWithSql(sql, f.owner, { responsibilityId: f.record.id, expectedResponsibilityRevision: f.record.revision,
        expectedReviewSha256: f.record.review!.reviewSha256, expectedBaselineRevision: baseline?.revision ?? 0, policySha256: RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256 }, key,
      fail ? async () => { throw new Error("private transient read failure"); } : responsibilityObservationReader(f.context, f.owner), at);
      if (admit && !result.replayed) await admitObservedNotificationWithSql(sql, f.owner, result.receipt, result.receipt.savedAt);
      return result;
    });
  }
  async function changeMeeting(f: Fixture, key: string, consent = false) {
    await serving(false);
    const draft = { ...f.meetingDraft, scheduledStartAt: new Date(Date.parse(f.meetingDraft.scheduledStartAt!) + 60_000).toISOString(),
      ...(consent ? { participants: f.meetingDraft.participants.map((participant) => ({ ...participant, attendeeConsent: "declined" as const })) } : {}) };
    f.meeting = await saveMeeting({ authority: { ...f.meetingAuthority, idempotencyKey: key }, meetingId: f.meeting.meetingId, expectedRevision: f.meeting.revision, draft });
    f.meetingDraft = draft; await serving(true);
  }
  async function pending(f: Fixture, governed = false) {
    await enable(f); expect((await observe(f, `${f.tag}:baseline`)).receipt.plan.outcome).toBe("baseline_established");
    await changeMeeting(f, `${f.tag}:changed`);
    if (governed) {
      expect(await processDueResponsibilities({ context: f.context, limit: 1 })).toMatchObject({ enqueued: 1, failed: 0 });
      const runtime = await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false); const wake = runtime.wakes[0];
      const detail = await owned(f, () => getWorkflowRunDetail(wake.workflowRunId!, { tenantId: f.owner.tenantId }));
      expect((await owned(f, () => tickResponsibilityWorkflow(detail!))).run.status).toBe("completed");
    } else expect((await observe(f, `${f.tag}:material`, true)).receipt.plan.outcome).toBe("material_change");
    const state = await getResponsibilityNotifications(f.context, f.record.id); expect(state.candidates).toHaveLength(1); return state.candidates[0];
  }
  async function assertNoExternal(tenantId: string) {
    expect(await admin`SELECT id FROM omni_mobile_push_deliveries WHERE tenant_id = ${tenantId}`).toEqual([]);
    expect(await admin`SELECT id FROM omni_notification_digest_deliveries WHERE tenant_id = ${tenantId}`).toEqual([]);
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  const raceOperation = new AsyncLocalStorage<string>();
  type RaceTransaction = { operation: string; pid: number };
  async function withTwoServingConnections(work: (transactions: RaceTransaction[]) => Promise<void>,
    beforeCommit: (sql: SqlClient, operation: string, result: unknown) => Promise<void>) {
    // Only these race fixtures use two application connections. Each callback
    // still receives a real manager-minted transaction and production scope;
    // only its role and test deadlines are installed before the real work.
    await closeDatabaseClient(); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2");
    let restoreTransaction: (() => void) | undefined;
    try {
      expect(getDatabasePoolMax(), "Concurrency proof requires a local two-connection fixture pool").toBe(2);
      await ensureDatabaseSchema();
      const client = getSql(); const transaction = client.transaction.bind(client); const transactions: RaceTransaction[] = [];
      const wrapped = vi.spyOn(client, "transaction").mockImplementation((callback, options) => {
        if (typeof callback !== "function") throw new Error("Race fixture requires a real callback transaction");
        return transaction(async (sql: SqlClient) => {
          await sql`SET LOCAL ROLE omni_runtime`;
          const operation = raceOperation.getStore() ?? "read";
          await sql`SELECT set_config('application_name',${`responsibility-race:${operation}`},true),
            set_config('statement_timeout','15000',true),set_config('lock_timeout','10000',true),set_config('idle_in_transaction_session_timeout','15000',true)`;
          const [identity] = await sql`SELECT pg_backend_pid() AS pid,current_user AS role,rolsuper,rolbypassrls,
            current_setting('omni.system_scope',true) AS system_scope FROM pg_roles WHERE rolname = current_user`;
          expect(identity).toMatchObject({ role: "omni_runtime", rolsuper: false, rolbypassrls: false, system_scope: "false" });
          transactions.push({ operation, pid: Number(identity.pid) });
          const result = await callback(sql);
          await beforeCommit(sql, operation, result);
          return result;
        }, options);
      });
      restoreTransaction = () => wrapped.mockRestore();
      await work(transactions);
    }
    finally {
      restoreTransaction?.(); await closeDatabaseClient(); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1"); await ensureDatabaseSchema();
    }
  }
  function commitBarrier(operation: "stop" | "delivery" | "preferences") {
    const reached = deferred<number>(); const release = deferred<void>(); let held = false;
    return { reached, release, async beforeCommit(sql: SqlClient, actualOperation: string, result: unknown) {
      // Delivery first performs an identity-only transaction. Hold only its
      // actual inbox/receipt transaction, before the manager commits it.
      if (held || actualOperation !== operation || (operation === "delivery" && result !== "delivered")) return;
      held = true; const [row] = await sql`SELECT pg_backend_pid() AS pid`;
      reached.resolve(Number(row.pid)); await release.promise;
    } };
  }
  async function blockedBy(blocker: number, operation: string) {
    // Completion of a bounded catalog probe, not a sleep, establishes that
    // the second backend reached the actual conflicting database lock.
    const deadline = Date.now() + 8_000;
    for (let probe = 0; probe < 2_000 && Date.now() < deadline; probe++) {
      const rows = await admin`SELECT pid,query,wait_event_type FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${`responsibility-race:${operation}`}
          AND ${blocker}::int = ANY(pg_blocking_pids(pid))`;
      if (rows.length) {
        expect(rows).toHaveLength(1); expect(rows[0].wait_event_type).toBe("Lock"); expect(Number(rows[0].pid)).not.toBe(blocker);
        return { pid: Number(rows[0].pid), query: String(rows[0].query) };
      }
    }
    throw new Error(`The ${operation} transaction never reached the expected database lock`);
  }
  function observePromise(running: Promise<unknown>[], promise: Promise<unknown>) {
    // Install rejection observation immediately, including a deliberately
    // stale stop, and drain every launched transaction during cleanup.
    running.push(promise.then(() => undefined, () => undefined)); return promise;
  }
  function reachBarrier(reached: Promise<number>, operation: Promise<unknown>) {
    return Promise.race([reached, operation.then(() => { throw new Error("The first transaction completed before its expected commit barrier"); })]);
  }
  function preferencesTransaction(f: Fixture, enabled: boolean) {
    return raceOperation.run("preferences", () => owned(f, async () => await getSql().transaction(async (sql: SqlClient) => {
      const result = await runWithManagedDatabaseTransaction(sql, () => updateTodayPreferences({ notificationsEnabled: enabled }, {
        ...f.owner, actorId: email, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(f.context),
      }));
      return result;
    })));
  }
  async function assertCommittedDelivery(f: Fixture, history: Awaited<ReturnType<typeof getResponsibilityNotifications>>, expectedCandidateIds: string[]) {
    const delivered = history.candidates.filter((item) => item.state === "delivered");
    expect(delivered.map((item) => item.id).sort()).toEqual([...expectedCandidateIds].sort());
    const inbox = await admin`SELECT id,actor_id,kind,source_id,occurrence_key FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`;
    const dispositions = await admin`SELECT id,owner_actor_id,source_kind,source_id,occurrence_key,delivery_kind,delivery_binding_sha256
      FROM omni_notification_dispositions WHERE tenant_id = ${f.owner.tenantId} AND state = 'terminal'`;
    expect(inbox).toHaveLength(delivered.length); expect(dispositions).toHaveLength(delivered.length);
    for (const item of delivered) {
      expect(inbox.find((row) => row.id === item.notificationId)).toEqual({ id: item.notificationId, actor_id: f.owner.actorId,
        kind: "responsibility_change", source_id: f.record.id, occurrence_key: item.id });
      expect(dispositions.find((row) => row.id === item.dispositionId)).toEqual({ id: item.dispositionId, owner_actor_id: f.owner.actorId,
        source_kind: "responsibility_change", source_id: f.record.id, occurrence_key: item.id, delivery_kind: "notification_ledger",
        delivery_binding_sha256: item.deliveryBindingSha256 });
      expect(history.receipts.find((receipt) => receipt.action === "deliver" && receipt.candidate?.id === item.id)?.candidate).toEqual(item);
    }
  }

  test.each(["stop", "delivery"] as const)("serializes %s-first delivery/stop on independent serving connections", async (first) => {
    const f = await fixture(`race-stop-${first}`); const candidate = await pending(f);
    await changeMeeting(f, `${f.tag}:second-source`); await observe(f, `${f.tag}:second-observation`, true);
    const before = await getResponsibilityNotifications(f.context, f.record.id); expect(before.current?.reserved).toBe(2);
    const stopRequest = { action: "stop" as const, expectedRevision: before.current!.revision, expectedGeneration: before.current!.generation };
    const barrier = commitBarrier(first);
    await withTwoServingConnections(async (transactions) => {
      const running: Promise<unknown>[] = [];
      const deliver = () => raceOperation.run("delivery", () => attemptResponsibilityNotification(f.owner, f.record.id, candidate.id));
      const stop = () => raceOperation.run("stop", () => changeResponsibilityNotifications(f.context, f.record.id, stopRequest, `${f.tag}:stop`));
      try {
        const firstResult = observePromise(running, first === "stop" ? stop() : deliver());
        const blocker = await reachBarrier(barrier.reached.promise, firstResult);
        // The first operation has written its real receipt, but it has not
        // committed. Another connection still sees the previous head/inbox.
        expect((await admin`SELECT snapshot FROM omni_responsibility_notification_admissions WHERE tenant_id = ${f.owner.tenantId}`)[0].snapshot).toEqual(before.current);
        expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
        const secondResult = observePromise(running, first === "stop" ? deliver() : stop());
        const waiter = await blockedBy(blocker, first === "stop" ? "delivery" : "stop");
        expect(waiter.query).toContain("pg_advisory_xact_lock");
        expect(transactions.some((item) => item.pid === blocker && item.operation === first)).toBe(true);
        expect(transactions.some((item) => item.pid === waiter.pid && item.operation === (first === "stop" ? "delivery" : "stop"))).toBe(true);
        barrier.release.resolve();
        if (first === "stop") {
          expect(await firstResult).toMatchObject({ current: { state: "ended", reason: "owner_stopped", used: 0, reserved: 0 }, receipt: { action: "stop" } });
          expect(await secondResult).toBe("unchanged");
        } else {
          expect(await firstResult).toBe("delivered");
          await expect(secondResult).rejects.toMatchObject({ code: "responsibility_notification_changed", status: 409 });
          const fresh = await getResponsibilityNotifications(f.context, f.record.id);
          expect(fresh.current).toMatchObject({ used: 1, reserved: 1 });
          // The stale CAS did not claim a stop. A fresh explicit owner request
          // cancels only the remaining candidate and retains committed use.
          expect(await changeResponsibilityNotifications(f.context, f.record.id, { action: "stop", expectedRevision: fresh.current!.revision,
            expectedGeneration: fresh.current!.generation }, `${f.tag}:fresh-stop`)).toMatchObject({ current: { state: "ended", used: 1, reserved: 0 } });
        }
        const after = await getResponsibilityNotifications(f.context, f.record.id);
        expect(after.current).toMatchObject({ state: "ended", reason: "owner_stopped", used: first === "delivery" ? 1 : 0, reserved: 0 });
        expect(after.receipts.filter((item) => item.action === "stop")).toHaveLength(1);
        expect(after.receipts.filter((item) => item.action === "deliver")).toHaveLength(first === "delivery" ? 1 : 0);
        for (const item of after.candidates) expect(await attemptResponsibilityNotification(f.owner, f.record.id, item.id)).toBe("unchanged");
        expect(await getResponsibilityNotifications(f.context, f.record.id)).toEqual(after);
        await assertCommittedDelivery(f, after, first === "delivery" ? [candidate.id] : []);
        await assertNoExternal(f.owner.tenantId);
      } finally { barrier.release.resolve(); await Promise.allSettled(running); }
    }, barrier.beforeCommit);
  }, 45_000);

  test.each(["preferences", "delivery"] as const)("serializes %s-first preference revocation/delivery on independent serving connections", async (first) => {
    const f = await fixture(`race-preferences-${first}`); const candidate = await pending(f);
    await changeMeeting(f, `${f.tag}:second-source`); await observe(f, `${f.tag}:second-observation`, true);
    const before = await getResponsibilityNotifications(f.context, f.record.id); expect(before.current?.reserved).toBe(2);
    const barrier = commitBarrier(first);
    await withTwoServingConnections(async (transactions) => {
      const running: Promise<unknown>[] = [];
      const deliver = () => raceOperation.run("delivery", () => attemptResponsibilityNotification(f.owner, f.record.id, candidate.id));
      const disable = () => preferencesTransaction(f, false);
      try {
        const firstResult = observePromise(running, first === "preferences" ? disable() : deliver());
        const blocker = await reachBarrier(barrier.reached.promise, firstResult);
        expect((await admin`SELECT notifications_enabled FROM omni_today_preferences WHERE tenant_id = ${f.owner.tenantId}`)[0].notifications_enabled).toBe(true);
        expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
        const secondResult = observePromise(running, first === "preferences" ? deliver() : disable());
        const waiter = await blockedBy(blocker, first === "preferences" ? "delivery" : "preferences");
        expect(waiter.query).toContain("omni_today_preferences");
        expect(waiter.query).toContain(first === "preferences" ? "FOR SHARE" : "INSERT INTO");
        expect(transactions.some((item) => item.pid === blocker && item.operation === first)).toBe(true);
        expect(transactions.some((item) => item.pid === waiter.pid && item.operation === (first === "preferences" ? "delivery" : "preferences"))).toBe(true);
        barrier.release.resolve();
        if (first === "preferences") { expect(await firstResult).toMatchObject({ notificationsEnabled: false }); expect(await secondResult).toBe("closed"); }
        else { expect(await firstResult).toBe("delivered"); expect(await secondResult).toMatchObject({ notificationsEnabled: false }); }
        const after = await getResponsibilityNotifications(f.context, f.record.id);
        const firstCandidate = after.candidates.find((item) => item.id === candidate.id)!;
        expect(firstCandidate).toMatchObject(first === "delivery" ? { state: "delivered", reason: "in_app_recorded" } : { state: "blocked", reason: "notifications_disabled" });
        // A later attempt must observe the committed preference revocation,
        // even when an earlier delivery legitimately committed first.
        const other = after.candidates.find((item) => item.id !== candidate.id)!;
        expect(await attemptResponsibilityNotification(f.owner, f.record.id, other.id)).toBe("closed");
        const final = await getResponsibilityNotifications(f.context, f.record.id);
        expect(final.current).toMatchObject({ used: first === "delivery" ? 1 : 0, reserved: 0 });
        expect(final.candidates.find((item) => item.id === other.id)).toMatchObject({ state: "blocked", reason: "notifications_disabled" });
        expect(final.receipts.filter((item) => item.action === "deliver")).toHaveLength(first === "delivery" ? 1 : 0);
        await assertCommittedDelivery(f, final, first === "delivery" ? [candidate.id] : []);
        // Turning preferences back on cannot resurrect either terminal row.
        await preferencesTransaction(f, true);
        for (const item of final.candidates) expect(await attemptResponsibilityNotification(f.owner, f.record.id, item.id)).toBe("unchanged");
        expect(await getResponsibilityNotifications(f.context, f.record.id)).toEqual(final);
        await assertCommittedDelivery(f, final, first === "delivery" ? [candidate.id] : []);
        await assertNoExternal(f.owner.tenantId);
      } finally { barrier.release.resolve(); await Promise.allSettled(running); }
    }, barrier.beforeCommit);
  }, 45_000);

  test("requires saved preferences and separate exact enable while preserving old none authority", async () => {
    const f = await fixture("admission", { preferences: false });
    const result = await getResponsibilityNotifications(f.context, f.record.id, true);
    expect(result).toMatchObject({ current: null, preview: { state: "blocked", reason: "responsibility_notification_preferences_unavailable" } });
    expect(await admin`SELECT actor_id FROM omni_today_preferences WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
    expect((await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current?.configuration.notificationAuthority).toBe("none");
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
  }, 30_000);

  test("drains a final governed material change exactly once after check exhaustion and exposes the canonical inbox", async () => {
    const f = await fixture("final", { maximumChecks: 1 }); const candidate = await pending(f, true);
    expect((await getResponsibilityNotifications(f.context, f.record.id)).current).toMatchObject({ state: "draining", reserved: 1, used: 0 });
    expect(await processDueResponsibilityNotifications({ context: f.context, limit: 1 })).toMatchObject({ inspected: 1, delivered: 1, failed: 0 });
    const delivered = await getResponsibilityNotifications(f.context, f.record.id);
    expect(delivered.current).toMatchObject({ state: "draining", used: 1, reserved: 0 }); expect(delivered.candidates[0]).toMatchObject({ id: candidate.id, state: "delivered" });
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("unchanged");
    const inbox = await owned(f, () => listNotifications(20, { ...f.owner, actorId: email, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(f.context) }));
    expect(inbox).toHaveLength(1); expect(inbox[0]).toMatchObject({ actorId: email, kind: "responsibility_change", sourceId: f.record.id, title: "Responsibility change" });
    const oldOptions = { ...f.owner, actorId: email, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(f.context), includeResponsibilityChanges: false };
    expect(await owned(f, () => listNotifications(1, oldOptions))).toEqual([]);
    const oldBulk = notificationBulkMutationFromRequest(new Request("https://example.test/api/notifications", { headers: { "Idempotency-Key": `${f.tag}:old-read-all` } }), f.context);
    await owned(f, () => markAllNotificationsRead({ ...oldOptions, mutation: oldBulk }));
    expect((await admin`SELECT status FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`)[0].status).toBe("unread");
    expect(JSON.stringify(delivered)).not.toContain("PRIVATE_SOURCE_PROSE");
    for (const action of ["read", "dismiss"] as const) {
      const mutation = notificationMutationFromRequest(new Request("https://example.test/api/notifications", { headers: { "Idempotency-Key": `${f.tag}:${action}` } }), f.context, inbox[0].id);
      const options = { tenantId: f.owner.tenantId, actorId: email, requestActorBinding: canonicalRequestActorBindingFromSecurityContext(f.context), mutation };
      expect(await owned(f, () => updatePersonalNotification(inbox[0].id, action, options))).toMatchObject({ status: action === "read" ? "read" : "dismissed" });
      expect(await owned(f, () => updatePersonalNotification(inbox[0].id, action, options))).toMatchObject({ status: action === "read" ? "read" : "dismissed" });
    }
    const [physical] = await admin`SELECT actor_id,status FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`;
    expect(physical).toEqual({ actor_id: actorId, status: "dismissed" });
    expect(await admin`SELECT id FROM omni_notification_dispositions WHERE tenant_id = ${f.owner.tenantId} AND state = 'terminal'`).toHaveLength(1);
    await assertNoExternal(f.owner.tenantId);
  }, 30_000);

  test("retains a quiet pending change across no-change and failed observations, then retries without replacing its identity", async () => {
    const f = await fixture("quiet"); const candidate = await pending(f);
    // Pick a quiet interval around the actual UTC clock, including midnight.
    const currentMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const clock = (minutes: number) => `${String(Math.floor(((minutes + 1440) % 1440) / 60)).padStart(2, "0")}:${String((minutes + 1440) % 60).padStart(2, "0")}`;
    await admin`UPDATE omni_today_preferences SET quiet_hours_enabled = true, quiet_hours_start = ${clock(currentMinutes - 1)}, quiet_hours_end = ${clock(currentMinutes + 30)} WHERE tenant_id = ${f.owner.tenantId}`;
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("held");
    const held = await getResponsibilityNotifications(f.context, f.record.id); expect(held.candidates[0]).toMatchObject({ id: candidate.id, reason: "quiet_hours", notificationId: null });
    const equal = await observe(f, `${f.tag}:equal`, true); expect(equal.receipt.plan.outcome).toBe("no_change");
    const failed = await observe(f, `${f.tag}:failed`, true, true); expect(failed.receipt.plan.outcome).toBe("failed");
    expect(failed.currentBaseline).toEqual(equal.currentBaseline);
    expect((await getResponsibilityNotifications(f.context, f.record.id)).candidates).toEqual(held.candidates);
    await admin`UPDATE omni_today_preferences SET quiet_hours_enabled = false WHERE tenant_id = ${f.owner.tenantId}`;
    vi.spyOn(runtimeStore, "runtimeDatabaseNow").mockResolvedValue(held.candidates[0].nextAttemptAt!);
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("delivered");
    expect((await getResponsibilityNotifications(f.context, f.record.id)).current).toMatchObject({ used: 1, reserved: 0 });
    await assertNoExternal(f.owner.tenantId);
  }, 30_000);

  test("stops a held final drain permanently and recovers its exact stop receipt after response loss", async () => {
    const f = await fixture("stop-final", { maximumChecks: 1 }); const candidate = await pending(f, true);
    const minutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const clock = (value: number) => `${String(Math.floor(((value + 1440) % 1440) / 60)).padStart(2, "0")}:${String((value + 1440) % 60).padStart(2, "0")}`;
    await admin`UPDATE omni_today_preferences SET quiet_hours_enabled = true,quiet_hours_start = ${clock(minutes - 1)},quiet_hours_end = ${clock(minutes + 30)} WHERE tenant_id = ${f.owner.tenantId}`;
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("held");
    const before = await getResponsibilityNotifications(f.context, f.record.id); expect(before.current?.state).toBe("draining");
    const request = { action: "stop", expectedRevision: before.current!.revision, expectedGeneration: before.current!.generation };
    // Discard the first returned receipt as if the response was lost; durable
    // recovery must use the same frozen body/key, without repeating the stop.
    await changeResponsibilityNotifications(f.context, f.record.id, request, `${f.tag}:stop`);
    const recovered = await changeResponsibilityNotifications(f.context, f.record.id, request, `${f.tag}:stop`);
    expect(recovered).toMatchObject({ replayed: true, current: { state: "ended", reason: "owner_stopped", used: 0, reserved: 0 }, receipt: { action: "stop" } });
    const after = await getResponsibilityNotifications(f.context, f.record.id);
    expect(after.candidates[0]).toMatchObject({ state: "canceled", reason: "owner_stopped", dispositionId: before.candidates[0].dispositionId });
    expect(after.receipts.filter((receipt) => receipt.action === "stop")).toHaveLength(1);
    const runtime = (await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current!;
    expect(runtime).toMatchObject({ state: "ended", reason: "budget_exhausted" });
    await runtimeStore.withResponsibilityRuntimeTransaction(f.owner, (sql) => syncNotificationLifecycleWithSql(sql, runtime, runtime.configuration.cadence.expiresAt));
    expect((await getResponsibilityNotifications(f.context, f.record.id)).current).toEqual(recovered.current);
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("unchanged");
    await expect(enable(f)).rejects.toThrow();
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
    await assertNoExternal(f.owner.tenantId);
  }, 30_000);

  test("expires the same ended runtime's draining admission with a distinct immutable lifecycle receipt", async () => {
    const f = await fixture("drain-expiry", { maximumChecks: 1 }); await pending(f, true);
    const runtime = (await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current!;
    const before = await getResponsibilityNotifications(f.context, f.record.id); expect(before.current?.state).toBe("draining");
    await runtimeStore.withResponsibilityRuntimeTransaction(f.owner, (sql) => syncNotificationLifecycleWithSql(sql, runtime, runtime.configuration.cadence.expiresAt));
    const after = await getResponsibilityNotifications(f.context, f.record.id);
    expect(after.current).toMatchObject({ state: "ended", reason: "expired", reserved: 0, used: 0 });
    expect(after.candidates[0]).toMatchObject({ state: "expired", reason: "expired" });
    const transitions = after.receipts.filter((receipt) => receipt.action === "lifecycle");
    expect(transitions.map((receipt) => receipt.snapshot.reason)).toEqual(["expired", "checks_exhausted"]);
    expect(new Set(transitions.map((receipt) => receipt.id)).size).toBe(2);
    expect((await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current).toEqual(runtime);
  }, 30_000);

  test("rejects an orphan terminal send disposition even when its generic delivery binding is valid", async () => {
    const f = await fixture("orphan"); const candidate = await pending(f);
    await expect(runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const now = await runtimeStore.runtimeDatabaseNow(sql);
      const coordinates = { ...f.owner, sourceKind: "responsibility_change" as const, sourceId: f.record.id, occurrenceKey: candidate.id };
      const decision = decideServerNotification({ candidate: responsibilityChangeNotificationCandidate(coordinates), policy: { evaluatedAt: now, quietHoursActive: false, cooldownActive: false, digestEnabled: false } });
      await applyNotificationDispositionDecision({ sql, now: new Date(now), decision,
        coordinates: notificationDispositionCoordinates({ ...coordinates, ownerActorId: actorId, decision }),
        executionScope: notificationDecisionExecutionScope({ ...f.owner, sourceId: f.record.id, producerId: "responsibility-in-app", decision }),
        directDelivery: async () => ({ deliveryKind: "notification_ledger", deliveryIds: [`notification_${"d".repeat(48)}`], targetSha256: "e".repeat(64) }),
      });
    })).rejects.toThrow("Responsibility disposition requires its exact candidate");
    expect(await admin`SELECT id FROM omni_notification_dispositions WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
    expect((await getResponsibilityNotifications(f.context, f.record.id)).candidates[0]).toEqual(candidate);
  }, 30_000);

  test("pause cancels a held generation, resume preserves the spent budget and cannot revive its candidate", async () => {
    const f = await fixture("pause"); const candidate = await pending(f);
    const active = (await runtimeStore.readResponsibilityRuntime(f.owner, f.record.id, false)).current!;
    const paused = await runtimeStore.controlResponsibilityRuntime(f.owner, f.record.id, { action: "pause", expectedRevision: active.revision, expectedGeneration: active.generation }, `${f.tag}:pause`);
    const stopped = await getResponsibilityNotifications(f.context, f.record.id);
    expect(stopped.current).toMatchObject({ state: "paused", generation: 2, used: 0, reserved: 0 }); expect(stopped.candidates[0]).toMatchObject({ state: "canceled", reason: "owner_paused" });
    await runtimeStore.controlResponsibilityRuntime(f.owner, f.record.id, { action: "resume", expectedRevision: paused.current.revision, expectedGeneration: paused.current.generation,
      configurationSha256: paused.current.configuration.configurationSha256, acknowledgePilot: RESPONSIBILITY_PILOT }, `${f.tag}:resume`);
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("unchanged");
    expect((await getResponsibilityNotifications(f.context, f.record.id)).current).toMatchObject({ state: "enabled", generation: 2, used: 0, reserved: 0 });
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
  }, 30_000);

  test("revoked owner and declined consent close pending delivery without exposing source content", async () => {
    for (const mode of ["owner", "consent"] as const) {
      const f = await fixture(`revoke-${mode}`); const candidate = await pending(f);
      if (mode === "owner") await admin`UPDATE omni_auth_memberships SET status = 'disabled' WHERE tenant_id = ${f.owner.tenantId}`;
      else await changeMeeting(f, `${f.tag}:declined`, true);
      expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("closed");
      const [row] = await admin`SELECT snapshot FROM omni_responsibility_notification_candidates WHERE tenant_id = ${f.owner.tenantId}`;
      expect(row.snapshot).toMatchObject({ state: "blocked", reason: mode === "owner" ? "destination_unavailable" : "source_unavailable", notificationId: null });
      expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
    }
  }, 30_000);

  test("rolls back a failed ledger insert, retains its reservation, and safely retries on the next finite attempt", async () => {
    const f = await fixture("retry"); const candidate = await pending(f);
    await admin`CREATE FUNCTION public.fixture_refuse_responsibility_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = 'notification-retry' THEN RAISE EXCEPTION 'fixture ledger unavailable'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER fixture_refuse_responsibility_inbox BEFORE INSERT ON omni_personal_notifications FOR EACH ROW EXECUTE FUNCTION public.fixture_refuse_responsibility_inbox()`;
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("held");
    const held = await getResponsibilityNotifications(f.context, f.record.id); expect(held.current).toMatchObject({ used: 0, reserved: 1 });
    expect(held.candidates[0]).toMatchObject({ reason: "delivery_retry", notificationId: null, dispositionId: null });
    expect(await admin`SELECT id FROM omni_notification_dispositions WHERE tenant_id = ${f.owner.tenantId}`).toEqual([]);
    await admin`DROP TRIGGER fixture_refuse_responsibility_inbox ON omni_personal_notifications`; await admin`DROP FUNCTION public.fixture_refuse_responsibility_inbox()`;
    vi.spyOn(runtimeStore, "runtimeDatabaseNow").mockResolvedValue(held.candidates[0].nextAttemptAt!);
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("delivered");
    expect((await getResponsibilityNotifications(f.context, f.record.id)).current).toMatchObject({ used: 1, reserved: 0 });
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${f.owner.tenantId}`).toHaveLength(1);
  }, 30_000);

  test("enforces cumulative delivery limits and candidate expiry without another inbox item", async () => {
    const f = await fixture("limit", { maximumNotifications: 1 }); const candidate = await pending(f);
    expect(await attemptResponsibilityNotification(f.owner, f.record.id, candidate.id)).toBe("delivered");
    await changeMeeting(f, `${f.tag}:next`); await observe(f, `${f.tag}:next-change`, true);
    const limited = await getResponsibilityNotifications(f.context, f.record.id);
    expect(limited.current).toMatchObject({ used: 1, reserved: 0 }); expect(limited.candidates.some((item) => item.state === "blocked" && item.reason === "notification_limit")).toBe(true);
    const other = await fixture("expiry"); const expiring = await pending(other);
    vi.spyOn(runtimeStore, "runtimeDatabaseNow").mockResolvedValue(expiring.expiresAt);
    expect(await attemptResponsibilityNotification(other.owner, other.record.id, expiring.id)).toBe("closed");
    expect((await getResponsibilityNotifications(other.context, other.record.id)).candidates[0]).toMatchObject({ state: "expired", notificationId: null });
    expect(await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id = ${other.owner.tenantId}`).toEqual([]);
  }, 30_000);

  test("preserves owner RLS and rejects a fabricated delivery receipt without ledger or disposition", async () => {
    const f = await fixture("binding"); const candidate = await pending(f);
    const foreign = "actor:55555555-5555-4555-8555-555555555555";
    expect(await runWithDatabaseActorScope(f.owner.tenantId, [foreign], () => getSql()`SELECT id FROM omni_responsibility_notification_candidates WHERE tenant_id = ${f.owner.tenantId}`)).toEqual([]);
    await expect(runtimeStore.withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const forged = { ...candidate, revision: candidate.revision + 1, state: "delivered", reason: "in_app_recorded", nextAttemptAt: null,
        notificationId: `notification_${"a".repeat(48)}`, dispositionId: `notification_disposition_${"b".repeat(48)}`, deliveryBindingSha256: "c".repeat(64), terminalAt: candidate.updatedAt };
      await sql`UPDATE omni_responsibility_notification_candidates SET revision = ${forged.revision},state = 'delivered',next_attempt_at = NULL,snapshot = ${forged}::jsonb
        WHERE tenant_id = ${f.owner.tenantId} AND actor_id = ${actorId} AND id = ${candidate.id}`;
    })).rejects.toThrow();
    expect((await getResponsibilityNotifications(f.context, f.record.id)).candidates[0]).toEqual(candidate);
    expect((await readResponsibilityObservationHistory(f.owner, f.record.id, 20)).baseline).not.toBeNull();
  }, 30_000);
});
