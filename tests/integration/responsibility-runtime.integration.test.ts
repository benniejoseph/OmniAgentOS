import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { saveMeeting } from "@/lib/meetings/store";
import type { MeetingDraftInput } from "@/lib/meetings/contracts";
import { createProject, createProjectTasks } from "@/lib/projects/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { getWorkflowRunDetail, getWorkflowRunExecutionAuthority, transitionWorkflowRunWithEvents } from "@/lib/workflows/store";
import { SAVED_PROCEDURE_V1_TAG } from "@/lib/workflows/saved-procedures";
import { createResponsibilityDraft, changeResponsibilityDraft, getResponsibilityDraft } from "@/lib/responsibilities/service";
import { controlResponsibilityRuntime, persistRuntimeTransition, readResponsibilityRuntime, readRuntimeHead, readRuntimeWake,
  runtimeDatabaseNow, withResponsibilityRuntimeTransaction } from "@/lib/responsibilities/lifecycle-store";
import { buildRuntimeReceipt, changeResponsibilityLifecycle, settleResponsibilityWake, verifyWake } from "@/lib/responsibilities/lifecycle-state";
import { resolveResponsibilityPilot } from "@/lib/responsibilities/runtime-references";
import { enqueueResponsibilityWake, prepareDueWake, processDueResponsibilities } from "@/lib/responsibilities/scheduler";
import { reconcileResponsibilityWake, tickResponsibilityWorkflow } from "@/lib/responsibilities/runtime";
import { RESPONSIBILITY_PILOT } from "@/lib/responsibilities/runtime-contracts";
import { resolveResponsibilityPins } from "@/lib/responsibilities/references";
import { draftFixture } from "@/lib/responsibilities/test-fixtures";
import { readResponsibilityObservationHistory } from "@/lib/responsibilities/observation-store";
import { touchRuntime } from "@/lib/responsibilities/runtime-state";
import { runWithManagedDatabaseTransaction } from "@/lib/db/client";

// Observe the real executor boundary without substituting its implementation.
// The actual app.meetings.show service, governed audit, observation and terminal
// budget writers all execute on the same managed one-connection transaction.
const trace = vi.hoisted(() => ({ boundaries: [] as Array<{ pid: unknown; role: unknown; memory_scope: unknown }> }));
vi.mock("@/lib/tools/executor", async (original) => {
  const actual = await original<typeof import("@/lib/tools/executor")>();
  return { ...actual, executeGovernedTool: async (...args: Parameters<typeof actual.executeGovernedTool>) => {
    const { getSql: currentSql } = await import("@/lib/db/client");
    const rows = await currentSql()`SELECT pg_backend_pid() AS pid,current_user AS role,NULLIF(current_setting('omni.memory_access_scope_v1',true),'') AS memory_scope`;
    trace.boundaries.push(rows[0] as typeof trace.boundaries[number]);
    return actual.executeGovernedTool(...args);
  } };
});

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const userId = "33333333-3333-4333-8333-333333333333";
const actorId = `actor:${userId}`;
const email = "responsibility-runtime@example.test";
databaseDescribe("Responsibility durable runtime on a one-connection pool", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient(); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema(); await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    // Provision only this fixture's pre-existing serving table privileges. RLS
    // and every production validation/immutability trigger remain enabled.
    await admin`GRANT SELECT, UPDATE ON omni_auth_users,omni_auth_memberships,omni_auth_tenants,
      omni_tenant_workspaces,omni_tenant_workspace_memberships,omni_work_items,omni_meetings,
      omni_memories,omni_memory_lifecycle_states TO omni_runtime`;
    await admin`GRANT SELECT ON omni_schema_version,omni_meeting_revisions,omni_work_projects,omni_work_project_memberships TO omni_runtime`;
    // omni_events' restrictive run policy plans a parent-run subquery even
    // for responsibility/tool streams. Workflow terminal synchronization also
    // performs a read-only lookup for an attached mission attempt. These are
    // legacy serving dependencies, not agent/mission mutation authority.
    await admin`GRANT SELECT ON omni_agent_runs,omni_mission_attempts TO omni_runtime`;
    await admin`GRANT SELECT, INSERT, UPDATE ON omni_events,omni_workflow_runs,omni_workflow_steps,omni_workflow_events,
      omni_operation_jobs,omni_tool_executions TO omni_runtime`;
    await admin`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO omni_runtime`;
    await admin`INSERT INTO omni_auth_users (id,email,password_hash) VALUES (${userId},${email},'fixture-only')`;
  });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs(); });
  async function serving(enabled: boolean) { await getSql().query(enabled ? "SET ROLE omni_runtime" : "SET ROLE NONE"); }

  async function fixture(tag: string, maxChecks = 1) {
    await serving(false); trace.boundaries.length = 0;
    await admin`UPDATE omni_auth_users SET email = ${email} WHERE id = ${userId}`;
    const tenantId = `runtime-${tag}`; const workspaceId = `workspace:runtime-${tag}`;
    const owner = { tenantId, actorId };
    const context: SecurityContext = { tenantId, actorId: email, role: "operator", source: "session", auth: { userId, email, sessionId: `fixture-${tag}`, tenantName: tag } };
    await admin`INSERT INTO omni_auth_tenants (id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships (id,tenant_id,user_id,role) VALUES (${`membership:${tag}`},${tenantId},${userId},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces (tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},${tag},${actorId},'active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    await admin`INSERT INTO omni_tenant_workspace_memberships (tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'user',${actorId},${actorId},1,'manager','active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const scope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId,
      workspaceId, correlationId: `fixture:${tag}`, purpose: "responsibility.fixture" });
    const project = await runWithDatabaseActorScope(tenantId, [actorId], () => createProject({ tenantId, actorId, title: "Review meeting", objective: "A bounded fixture",
      mutation: { executionScope: scope, idempotencyKey: `${tag}:project` } }));
    const [task] = await runWithDatabaseActorScope(tenantId, [actorId], () => createProjectTasks(project.id, [{ title: "Observe meeting" }], {
      tenantId, actorId, mutation: { executionScope: scope, idempotencyKey: `${tag}:task` },
    }));
    const workRows = await admin`SELECT workspace_id,project_id,work_item_id FROM omni_work_items WHERE tenant_id = ${tenantId} AND source_id = ${task.id}`;
    expect(workRows).toHaveLength(1);
    const now = new Date().toISOString(); const startsAt = new Date(Math.floor(Date.parse(now) / 60_000) * 60_000).toISOString();
    const meetingDraft: MeetingDraftInput = { title: "Native meeting", summary: "Stored summary", status: "scheduled",
      scheduledStartAt: new Date(Date.parse(now) + 3_600_000).toISOString(), scheduledEndAt: new Date(Date.parse(now) + 7_200_000).toISOString(), actualStartAt: null, actualEndAt: null,
      timezone: "UTC", location: "", projectId: null, declaredAccessClass: "owner_private", participants: [{ participantId: "owner", displayName: "Owner", email: null, entityId: null,
        role: "organizer", response: "accepted", attendeeConsent: "granted", recordingConsent: "not_required", consentCapturedAt: now, source: "manual" }],
      sourceLinks: [], entityLinks: [], decisions: [], commitments: [], followUps: [] };
    const meetingScope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId,
      workspaceId, correlationId: `fixture:${tag}:meeting`, purpose: "meeting.write" });
    const meetingAuthority = { tenantId, workspaceId, canonicalActorId: actorId, readableActorIds: [actorId], executionScope: meetingScope, idempotencyKey: `${tag}:meeting` };
    const meeting = await saveMeeting({ authority: meetingAuthority, draft: meetingDraft });
    const procedureId = `observe-${tag}`; const binding = buildUserPrivateMemoryAccessBindingV1({ tenantId, ownerActorId: actorId, originPurpose: "responsibility.fixture" });
    const content = JSON.stringify({ schemaVersion: 1, id: procedureId, aliases: [`Observe ${tag}`], toolBindings: [{ toolId: "app.meetings.show", input: { workspaceId, meetingId: meeting.meetingId } }] });
    await admin`INSERT INTO omni_memories (id,tenant_id,type,title,content,tags,scope,source,access_contract_version,access_state,owner_actor_id,visibility,sensitivity,origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
      VALUES (${`procedure:${tag}`},${tenantId},'procedure','Observe meeting',${content},${[SAVED_PROCEDURE_V1_TAG]},'workspace','manual',1,'scope_bound',${actorId},'user_private',
        ${binding.sensitivity},${binding.originPurpose},${[...binding.allowedPurposeIds]},${binding.accessScopeSha256},${binding.accessBoundAt})`;
    await serving(true);
    // The serving-role reference path must see the exact canonical Work owner
    // through its real JSONB containment parameter and project-membership RLS.
    // Pass the array itself: postgres.js serializes JSONB parameters once.
    const visibleWork = await runWithDatabaseActorScope(tenantId, [actorId, email], () => getSql()`
      SELECT workspace_id,project_id,work_item_id FROM omni_work_items
      WHERE tenant_id = ${tenantId} AND work_item_id = ${task.id}
        AND owner_actor_ids @> ${[actorId]}::jsonb`);
    expect(visibleWork).toEqual([{ workspace_id: workspaceId, project_id: project.id, work_item_id: task.id }]);
    const draft = { ...draftFixture, sources: [{ kind: "meeting" as const, id: meeting.meetingId, workspaceId }], procedureId, agentId: "atlas",
      work: { workspaceId, projectId: String(workRows[0].project_id), workItemId: String(workRows[0].work_item_id) },
      cadence: { frequency: "daily" as const, interval: 1, timezone: "UTC", startsAt, expiresAt: new Date(Date.parse(startsAt) + 7 * 86_400_000).toISOString(), missedPolicy: "skip" as const },
      limits: { ...draftFixture.limits!, maxChecks, maxNotifications: 0 } };
    const created = await createResponsibilityDraft(context, { action: "create", expectedRevision: 0, draft }, `${tag}:create`);
    // Exercise the actual resolver directly so a serving-role refusal retains
    // its failing source line instead of the public preview's safe summary.
    const pins = await resolveResponsibilityPins(context, owner, created.current);
    expect(pins.procedure.id).toBe(procedureId);
    const preview = await getResponsibilityDraft(context, created.current.id, true);
    if (!("reviewSha256" in preview.readiness)) throw new Error(`Fixture review blocked: ${JSON.stringify(preview.readiness)}`);
    const reviewed = await changeResponsibilityDraft(context, created.current.id, { action: "review", expectedRevision: created.current.revision,
      draftSha256: preview.readiness.draftSha256, reviewSha256: preview.readiness.reviewSha256 }, `${tag}:review`);
    return { owner, context, record: reviewed.current, startsAt, meeting, meetingDraft, meetingAuthority };
  }
  async function activateDue(f: Awaited<ReturnType<typeof fixture>>) {
    // Persist an already-due active fixture through the real transition writer.
    // Its slot is inside the reviewed cadence and grace; no direct head UPDATE
    // or clock mock bypasses CAS, receipt/event or deferred budget validation.
    return withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const now = await runtimeDatabaseNow(sql); const resolved = await resolveResponsibilityPilot(sql, f.owner, f.record, now, true);
      const current = changeResponsibilityLifecycle({ owner: f.owner, responsibilityId: f.record.id, current: null, configuration: resolved.configuration, now,
        nextDueAt: f.startsAt, request: { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: resolved.configuration.configurationSha256, acknowledgePilot: RESPONSIBILITY_PILOT } });
      return persistRuntimeTransition(sql, { previous: null, current, action: "activate", key: `${f.record.id}:active-fixture`, request: { fixture: "previously-activated-due-slot" } });
    });
  }
  async function enqueued(f: Awaited<ReturnType<typeof fixture>>) {
    await activateDue(f);
    const scheduled = await processDueResponsibilities({ context: f.context, limit: 1 });
    if (scheduled.failed) {
      // Rerun only the exact failed internal admission to expose its original
      // database/validation stack; never substitute a fake successful receipt.
      const selected = await prepareDueWake(f.owner, f.record.id);
      if (selected && selected !== "reconciled" && selected !== "blocked") await enqueueResponsibilityWake(f.owner, f.record.id, selected);
    }
    expect(scheduled).toMatchObject({ inspected: 1, enqueued: 1, failed: 0 });
    const runtime = await readResponsibilityRuntime(f.owner, f.record.id, false); const wake = runtime.wakes[0];
    expect(wake.state).toBe("enqueued"); expect(wake.workflowRunId).not.toBeNull();
    const workflow = await owned(f, () => getWorkflowRunDetail(wake.workflowRunId!, { tenantId: f.owner.tenantId }));
    expect(workflow).toBeDefined(); return { runtime, wake, workflow: workflow! };
  }
  function owned<T>(f: Awaited<ReturnType<typeof fixture>>, work: () => Promise<T>) {
    return runWithDatabaseActorScope(f.owner.tenantId, [actorId, f.context.actorId], work);
  }

  test("reserves, enqueues and commits governed Meeting evidence exactly once on pool one", async () => {
    const f = await fixture("complete");
    // The reviewed canonical owner survives a legitimate current-account email
    // change; the dispatch initiator must be re-resolved, never the stale alias.
    const renamed = "responsibility-renamed@example.test";
    await admin`UPDATE omni_auth_users SET email = ${renamed} WHERE id = ${userId}`;
    f.context = { ...f.context, actorId: renamed, auth: { ...f.context.auth!, email: renamed } };
    const pending = await enqueued(f);
    const queuedAuthority = await owned(f, () => getWorkflowRunExecutionAuthority(pending.workflow.run.id, { tenantId: f.owner.tenantId }));
    expect(queuedAuthority?.executionScope.initiatingActorId).toBe(renamed);
    const result = await owned(f, () => tickResponsibilityWorkflow(pending.workflow));
    expect(result.run.status).toBe("completed");
    const done = await readResponsibilityRuntime(f.owner, f.record.id, false);
    expect(done.current).toMatchObject({ state: "ended", reason: "budget_exhausted", budget: { usedChecks: 1, reservedChecks: 0, used: { toolCalls: 1, wallTimeMs: 30_000, agents: 1 } } });
    expect(done.wakes[0]).toMatchObject({ state: "completed", id: pending.wake.id });
    const observations = await readResponsibilityObservationHistory(f.owner, f.record.id, 25);
    expect(observations.receipts).toHaveLength(1); expect(observations.receipts[0].plan.outcome).toBe("baseline_established");
    expect(done.wakes[0].observationId).toBe(observations.receipts[0].plan.observation.id);
    expect(trace.boundaries).toHaveLength(1); expect(trace.boundaries[0]).toMatchObject({ role: "omni_runtime", memory_scope: null });
    const [{ pid }] = await runWithDatabaseActorScope(f.owner.tenantId, [actorId], () => getSql()`SELECT pg_backend_pid() AS pid`);
    expect(trace.boundaries[0].pid).toBe(pid);
    expect(await admin`SELECT id FROM omni_tool_executions WHERE tenant_id = ${f.owner.tenantId}`).toHaveLength(1);
    await owned(f, () => tickResponsibilityWorkflow(pending.workflow)); await processDueResponsibilities({ context: f.context, limit: 1 });
    expect((await readResponsibilityRuntime(f.owner, f.record.id, false)).wakes).toEqual(done.wakes);
    expect(await admin`SELECT id FROM omni_tool_executions WHERE tenant_id = ${f.owner.tenantId}`).toHaveLength(1);
  }, 30_000);

  test("activates only from an exact preview and preserves its immutable receipt after pause", async () => {
    const f = await fixture("activation", 2); const preview = await readResponsibilityRuntime(f.owner, f.record.id, true);
    if (!("preview" in preview) || preview.preview.state !== "ready") throw new Error("Fixture activation preview unavailable");
    expect(preview.current).toBeNull(); expect(preview.preview.authorityEffect).toBe("none");
    const request = { action: "activate", expectedRevision: 0, expectedGeneration: 0,
      configurationSha256: preview.preview.configuration.configurationSha256, acknowledgePilot: RESPONSIBILITY_PILOT };
    await expect(controlResponsibilityRuntime(f.owner, f.record.id, { ...request, configurationSha256: "f".repeat(64) }, "wrong-preview")).rejects.toMatchObject({ status: 409 });
    const accepted = await controlResponsibilityRuntime(f.owner, f.record.id, request, "activate-once");
    expect(accepted.current.state).toBe("active");
    await controlResponsibilityRuntime(f.owner, f.record.id, { action: "pause", expectedRevision: accepted.current.revision, expectedGeneration: accepted.current.generation }, "pause-active");
    const replay = await controlResponsibilityRuntime(f.owner, f.record.id, request, "activate-once");
    expect(replay.receipt).toEqual(accepted.receipt); expect(replay.current.state).toBe("paused"); expect(replay.replayed).toBe(true);
    expect((await readResponsibilityRuntime(f.owner, f.record.id, false)).wakes).toEqual([]); expect(trace.boundaries).toEqual([]);
  }, 30_000);

  test("keeps explicit activation/replay separate from preview and fences a queued wake after pause", async () => {
    const f = await fixture("pause", 2);
    const preview = await readResponsibilityRuntime(f.owner, f.record.id, true);
    expect(preview.current).toBeNull(); expect(preview.wakes).toEqual([]);
    const pending = await enqueued(f); const head = pending.runtime.current!;
    const request = { action: "pause", expectedRevision: head.revision, expectedGeneration: head.generation };
    const accepted = await controlResponsibilityRuntime(f.owner, f.record.id, request, "pause-once");
    expect(accepted.current.state).toBe("pausing");
    expect((await owned(f, () => tickResponsibilityWorkflow(pending.workflow))).run.status).toBe("canceled");
    const replay = await controlResponsibilityRuntime(f.owner, f.record.id, request, "pause-once");
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(accepted.receipt);
    expect(replay.current).toMatchObject({ state: "paused", budget: { usedChecks: 0, reservedChecks: 0 } });
    expect(trace.boundaries).toEqual([]); expect((await readResponsibilityObservationHistory(f.owner, f.record.id, 25)).baseline).toBeNull();
  }, 30_000);

  test("honors generic workflow pause/cancel before governed dispatch and releases only unstarted reservation", async () => {
    const f = await fixture("workflow-stop", 2); const pending = await enqueued(f);
    const authority = await owned(f, () => getWorkflowRunExecutionAuthority(pending.workflow.run.id, { tenantId: f.owner.tenantId }));
    await owned(f, () => transitionWorkflowRunWithEvents(pending.workflow.run.id, ["queued"], { status: "paused" }, [{ type: "workflow.paused", payload: { reason: "fixture owner pause" } }], { tenantId: f.owner.tenantId, executionAuthority: authority! }));
    expect((await owned(f, () => tickResponsibilityWorkflow(pending.workflow))).run.status).toBe("paused");
    expect((await readResponsibilityRuntime(f.owner, f.record.id, false)).wakes[0].state).toBe("enqueued");
    await owned(f, () => transitionWorkflowRunWithEvents(pending.workflow.run.id, ["paused"], { status: "canceled", completedAt: new Date().toISOString() }, [{ type: "workflow.canceled", payload: { reason: "fixture owner cancel" } }], { tenantId: f.owner.tenantId, executionAuthority: authority! }));
    expect((await owned(f, () => tickResponsibilityWorkflow(pending.workflow))).run.status).toBe("canceled");
    expect((await readResponsibilityRuntime(f.owner, f.record.id, false)).current!.budget).toMatchObject({ usedChecks: 0, reservedChecks: 0 });
    expect(trace.boundaries).toEqual([]);
  }, 30_000);

  test("retains uncertain started budget through end and reconciles its expired lease without advancing a baseline", async () => {
    const f = await fixture("recovery", 2); const pending = await enqueued(f);
    // A receipt for the correct wake ID but a fabricated version must fail at
    // insertion, before deferred commit checks can see a later live version.
    await expect(withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const current = (await readRuntimeHead(sql, f.owner, f.record.id))!;
      const wake = await readRuntimeWake(sql, f.owner, f.record.id, pending.wake.id);
      const now = await runtimeDatabaseNow(sql);
      const forged = buildRuntimeReceipt({ current: touchRuntime(current, now), previousRevision: current.revision,
        wake: { ...wake, operationJobId: "unrelated-job" }, action: "start", key: "forged-wake-version", request: { wakeId: wake.id } });
      await sql`INSERT INTO omni_responsibility_runtime_receipts (id,tenant_id,actor_id,responsibility_id,idempotency_sha256,request_sha256,revision,generation,action,receipt,saved_at)
        VALUES (${forged.id},${f.owner.tenantId},${f.owner.actorId},${f.record.id},${forged.idempotencySha256},${forged.requestSha256},${forged.snapshot.revision},${forged.snapshot.generation},${forged.action},${forged}::jsonb,${forged.savedAt})`;
    })).rejects.toThrow("Runtime transition requires its exact wake");
    expect((await readResponsibilityRuntime(f.owner, f.record.id, false)).wakes[0]).toEqual(pending.wake);
    await withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const current = (await readRuntimeHead(sql, f.owner, f.record.id))!; const wake = await readRuntimeWake(sql, f.owner, f.record.id, pending.wake.id);
      const now = await runtimeDatabaseNow(sql); const started = verifyWake({ ...wake, revision: wake.revision + 1, state: "running", leaseGeneration: 1,
        leaseTokenSha256: canonicalJsonSha256("lost-process"), leaseExpiresAt: now, startedAt: now, updatedAt: now });
      const next = touchRuntime(current, now);
      await persistRuntimeTransition(sql, { previous: current, current: next, previousWake: wake, wake: started, action: "start", key: "recovery-start", request: { wakeId: wake.id } });
      const uncertain = settleResponsibilityWake({ current: next, wake: started, now, outcome: "uncertain" });
      await persistRuntimeTransition(sql, { previous: next, current: uncertain.current, previousWake: started, wake: uncertain.wake, action: "settle", key: "recovery-uncertain", request: { wakeId: wake.id } });
    });
    const uncertain = await readResponsibilityRuntime(f.owner, f.record.id, false); const head = uncertain.current!;
    expect(head.budget).toMatchObject({ usedChecks: 0, reservedChecks: 1 });
    const ended = await controlResponsibilityRuntime(f.owner, f.record.id, { action: "end", expectedRevision: head.revision, expectedGeneration: head.generation }, "end-pending");
    expect(ended.current.state).toBe("ending");
    await withResponsibilityRuntimeTransaction(f.owner, async (sql) => {
      const current = (await readRuntimeHead(sql, f.owner, f.record.id))!; const wake = await readRuntimeWake(sql, f.owner, f.record.id, pending.wake.id);
      const now = await runtimeDatabaseNow(sql);
      await runWithManagedDatabaseTransaction(sql, () => reconcileResponsibilityWake(getSql(), current, wake, now));
    }, [actorId, email]);
    const settled = await readResponsibilityRuntime(f.owner, f.record.id, false);
    expect(settled.current).toMatchObject({ state: "ended", generation: ended.current.generation, budget: { usedChecks: 1, reservedChecks: 0, used: { toolCalls: 1 } } });
    expect(settled.wakes[0]).toMatchObject({ state: "failed", observationId: null });
    expect((await readResponsibilityObservationHistory(f.owner, f.record.id, 25)).baseline).toBeNull(); expect(trace.boundaries).toEqual([]);
  }, 30_000);

  test("blocks a due native source after attendee consent is revoked without reserving or advancing evidence", async () => {
    const f = await fixture("revoked", 2); await activateDue(f);
    await serving(false);
    await saveMeeting({ authority: { ...f.meetingAuthority, idempotencyKey: "revoke-attendee" }, meetingId: f.meeting.meetingId, expectedRevision: f.meeting.revision,
      draft: { ...f.meetingDraft, participants: [{ ...f.meetingDraft.participants[0], attendeeConsent: "declined" }] } });
    await serving(true);
    expect(await processDueResponsibilities({ context: f.context, limit: 1 })).toMatchObject({ inspected: 1, blocked: 1, enqueued: 0, failed: 0 });
    const stopped = await readResponsibilityRuntime(f.owner, f.record.id, false);
    expect(stopped.current).toMatchObject({ state: "blocked", reason: "source_unavailable", budget: { usedChecks: 0, reservedChecks: 0 } });
    expect(stopped.wakes).toEqual([]); expect((await readResponsibilityObservationHistory(f.owner, f.record.id, 25)).baseline).toBeNull(); expect(trace.boundaries).toEqual([]);
  }, 30_000);
});
