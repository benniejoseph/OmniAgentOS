/** Real project service, owner alias, runtime RLS and worker; the model is replaced by a local receipt. */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createProjectService } from "@/lib/app-services/projects";
import { createBuilderSessionRecord, transitionBuilderSession } from "@/lib/app-builder/store";
import { closeDatabaseClient, getDatabasePoolMax, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SecurityContext } from "@/lib/security/types";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";
import { listAgentRuns } from "@/lib/runs/store";
import { getToolExecution, listToolExecutions } from "@/lib/tools/audit-store";
import { bindToolExecutionScope, getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { collectEngineeringSignalsFromRuns } from "@/lib/self-improvement/evidence";
import { claimManualSelfImprovementCycle, configureSelfImprovement, getSelfImprovementCycle, getSelfImprovementProjectBrief,
  releaseSelfImprovementExecutionLease, updateSelfImprovementCycleRuntime, withSelfImprovementEvidenceOwner } from "@/lib/self-improvement/store";
import { executeSelfImprovementJob } from "@/lib/self-improvement/worker";

const setup = vi.hoisted(() => ({ serving: false, model: vi.fn(), tool: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => setup.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
vi.mock("@/lib/self-improvement/agent", () => ({ runImprovementAgent: setup.model, executeImprovementTool: setup.tool }));
const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `improvement-brief-${randomUUID()}`;
const actors = [randomUUID(), randomUUID()].map((userId) => ({ userId, email: `${userId}@example.test`, canonicalId: `actor:${userId}` }));
const role = `improvement_brief_${randomBytes(6).toString("hex")}`;
const context = (actor: typeof actors[number]): SecurityContext => ({ tenantId, actorId: actor.email, source: "session", role: "admin",
  auth: { userId: actor.userId, email: actor.email, sessionId: "isolated-no-login", tenantName: "Improvement brief regression" } });
const scoped = <T>(actor: typeof actors[number], run: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actor.canonicalId, actor.email], run);
const owner = { tenantId, ownerActorId: actors[0].canonicalId };
const objective = "Inspect the recorded rendering defect, preserve the exact project brief, and verify the repair before publication.";
const correction = "This logged owner correction must reach Atlas.";

candidate("Self-improvement project brief PostgreSQL regression", () => {
  let admin: ReturnType<typeof postgres>;
  const projectIds: string[] = [];
  const runIds: string[] = [], toolIds: string[] = [];
  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("Provide the disposable candidate database URL.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") throw new Error("Only the disposable loopback candidate database is allowed.");
    await closeDatabaseClient();
    admin = postgres(address, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect(Number((await admin`SELECT MAX(version) AS version FROM omni_schema_version`)[0].version)).toBe(265);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_projects,omni_app_builder_sessions,omni_app_builder_events TO ${role}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_auth_users,omni_auth_memberships TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_agent_runs,omni_tool_executions,omni_tenant_capability_rollouts,omni_project_tasks,omni_project_artifacts TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Improvement brief regression',${tenantId})`;
    for (const actor of actors) {
      await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${actor.userId},${actor.email},'synthetic-no-login')`;
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${actor.userId},'admin')`;
    }
    url.username = role; url.password = password;
    // Match the production topology: Vercel caps each pool at one even when
    // the shared configured maximum is higher. Nested evidence reads must join.
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("VERCEL", "1"); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "4"); setup.serving = true;
    expect(getDatabasePoolMax()).toBe(1);
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    for (let index = 0; index < 3; index++) {
      const actor = actors[index === 2 ? 1 : 0];
      await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
      const caller = createRequestMutationAppServiceCaller(new Request("https://fixture.invalid/api/projects", {
        method: "POST", headers: { "Idempotency-Key": `improvement-brief-project-${index}` },
      }), context(actor), { purpose: "app.projects.create" });
      const created = await scoped(actor, () => createProjectService(caller, { title: "Exact engineering brief", objective }));
      projectIds.push(created.data.project.id);
      expect((await admin`SELECT actor_id FROM omni_projects WHERE id=${created.data.project.id}`)[0].actor_id).toBe(actor.email);
    }
    // Both persisted owner formats are supported; only synthetic fixture data is changed.
    await admin`UPDATE omni_projects SET actor_id=${owner.ownerActorId} WHERE tenant_id=${tenantId} AND id=${projectIds[1]}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId + "-other"},'Other isolated tenant',${tenantId + "-other"})`;
    const feedback = JSON.stringify({ verdict: "needs_work", correction, updatedAt: new Date().toISOString() });
    for (let index = 0; index < 6; index++) {
      const recordTenant = index === 5 ? tenantId + "-other" : tenantId;
      const actorId = index === 0 || index === 5 ? actors[0].email : index === 1 ? owner.ownerActorId : actors[1].email;
      const at = new Date(Date.now() - (6 - index) * 60_000).toISOString();
      const runId = randomUUID(), toolId = randomUUID(); runIds.push(runId); toolIds.push(toolId);
      await admin`INSERT INTO omni_agent_runs(id,tenant_id,owner_actor_id,mode,status,prompt,error,feedback,started_at,completed_at)
        VALUES(${runId},${recordTenant},${actorId},'execute',${index === 1 ? "completed" : "failed"},'Synthetic owner observation','Recorded email failure',${index === 0 ? feedback : null}::jsonb,${at},${at})`;
      await admin`INSERT INTO omni_tool_executions(id,tenant_id,actor_id,tool_id,tool_name,risk_level,status,dry_run,approval_required,input,reason,created_at,completed_at)
        VALUES(${toolId},${recordTenant},${actorId},'app.projects.update','Synthetic update',1,'failed',false,false,'{}'::jsonb,'Recorded email tool failure',${at},${at})`;
    }
    // Seed actual typed scope bindings so inspection exercises the same nested
    // Promise.all event reads and run/receipt linkage as the production worker.
    for (let index = 0; index < 2; index++) {
      await scoped(actors[0], async () => {
        const record = await getToolExecution(toolIds[index], { tenantId });
        if (!record?.actorId) throw new Error("The synthetic owner receipt is missing.");
        await bindToolExecutionScope({ record, toolInput: {}, requesterRole: "admin",
          executionScope: createExecutionScope({ tenantId, initiatingActorId: record.actorId,
            executingPrincipalType: "user", executingPrincipalId: record.actorId,
            correlationId: runIds[index], purpose: "isolated_improvement_evidence_regression" }) });
      });
    }
  });
  afterAll(async () => {
    await closeDatabaseClient();
    if (admin) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it("passes the API-created email-owned brief and logged evidence to Atlas with Vercel's single connection", async () => {
    const actor = actors[0], projectId = projectIds[0];
    const sourceRecords = () => scoped(actor, async () => ({
      runs: await listAgentRuns(10, { tenantId, ownerActorIds: [owner.ownerActorId, actor.email] }),
      receipts: await listToolExecutions(10, { tenantId, actorIds: [owner.ownerActorId, actor.email] }),
      bindings: await Promise.all(toolIds.slice(0, 2).map(id => getToolExecutionScopeBinding(id, { tenantId }))),
    }));
    const before = await sourceRecords();
    expect(before.bindings.map(item => item?.executionScope.correlationId)).toEqual(runIds.slice(0, 2));
    expect(await scoped(actor, async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_projects') AS active FROM pg_roles WHERE rolname=current_user`)[0]))
      .toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });
    const configuration = await configureSelfImprovement({ ...owner, projectId, repositoryId: String(100_000 + Number.parseInt(randomBytes(4).toString("hex"), 16)),
      repository: { owner: "isolated", name: `brief-${randomUUID()}`, defaultBranch: "main" }, policy: createSelfImprovementPolicy({ dailyBudgetUsd: 10, notifyOutcomes: false }) });
    const claim = await claimManualSelfImprovementCycle({ owner, configurationId: configuration.id, expectedGeneration: configuration.generation, baseRevision: "a".repeat(40), idempotencyKey: "brief-inspection" });
    let stored = claim.cycle!;
    const created = await scoped(actor, () => createBuilderSessionRecord({ tenantId, actorId: owner.ownerActorId, projectId, workspaceMode: "source_only", idempotencyKey: "local-no-sandbox" }));
    const session = await scoped(actor, () => transitionBuilderSession({ tenantId, actorId: owner.ownerActorId, session: created.session, status: "ready", eventType: "app_builder.session.ready", eventKey: "local-ready" }));
    const leaseToken = stored.leaseToken!;
    stored = await updateSelfImprovementCycleRuntime({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken,
      runtime: { ...initialSelfImprovementRuntime(), phase: "inspect", setupStep: "complete" }, patch: { builderSessionId: session.id } });
    stored = await releaseSelfImprovementExecutionLease({ owner, cycleId: stored.cycle.id, expectedRevision: stored.cycle.revision, leaseToken });
    setup.model.mockImplementation(async (input: { prompt: string; authority: { ownerActorId: string }; onRunStarted: (id: string) => Promise<void> }) => {
      expect(input.prompt).toContain(objective);
      expect(input.prompt).toContain("Exact engineering brief");
      expect(input.prompt).toContain("Recorded email tool failure");
      expect(input.authority.ownerActorId).toBe(actor.canonicalId);
      const runId = randomUUID(); await input.onRunStarted(runId);
      return { runId, response: JSON.stringify({ decision: "no_change", summary: "Synthetic local model receipt; no provider invoked." }), measuredCostUsd: 0 };
    });
    const result = await scoped(actor, () => executeSelfImprovementJob({ tenantId, payload: { actorId: owner.ownerActorId, cycleId: stored.cycle.id } }, new AbortController().signal));
    expect(result).toMatchObject({ resourceId: stored.cycle.id, stage: "no_change" });
    const saved = await getSelfImprovementCycle(owner, stored.cycle.id);
    expect(saved).toMatchObject({ spendUsd: 0, usageState: "known", cycle: { scope: { ownerActorId: actor.canonicalId } } });
    expect(saved?.cycle.runId).toBeTruthy();
    const events = await admin`SELECT actor_id FROM omni_events WHERE tenant_id=${tenantId} AND stream_id=${`self-improvement:${configuration.id}`}`;
    expect(events.length).toBeGreaterThan(0); expect(events.every(item => item.actor_id === actor.canonicalId)).toBe(true);
    expect(setup.model).toHaveBeenCalledTimes(1); expect(setup.tool).not.toHaveBeenCalled();
    expect(await sourceRecords()).toEqual(before);
  });
  it("reads a canonical-owned project through the same exact owner boundary", async () => {
    await expect(getSelfImprovementProjectBrief(owner, projectIds[1])).resolves.toEqual({ title: "Exact engineering brief", objective });
  });
  it("filters exact owner IDs before SQL limits even when newer foreign rows are visible", async () => {
    await runWithDatabaseActorScope(tenantId, [owner.ownerActorId, actors[0].email, actors[1].canonicalId, actors[1].email], async () => {
      expect((await listAgentRuns(2, { tenantId })).every(item => item.ownerActorId === actors[1].email)).toBe(true);
      expect((await listToolExecutions(2, { tenantId })).every(item => item.actorId === actors[1].email)).toBe(true);
      expect((await listAgentRuns(2, { tenantId, ownerActorIds: [owner.ownerActorId, actors[0].email] })).map(item => item.id).sort()).toEqual(runIds.slice(0, 2).sort());
      expect((await listToolExecutions(2, { tenantId, actorIds: [owner.ownerActorId, actors[0].email] })).map(item => item.id).sort()).toEqual(toolIds.slice(0, 2).sort());
      expect(await listAgentRuns(2, { tenantId, ownerActorIds: [] })).toEqual([]);
      expect(await listToolExecutions(2, { tenantId, actorIds: [] })).toEqual([]);
      for (const ids of [[""], ["bad\0alias"], [" a"], ["a", "b", "c"]]) {
        await expect(listAgentRuns(2, { tenantId, ownerActorIds: ids })).rejects.toThrow(/owner filters/);
        await expect(listToolExecutions(2, { tenantId, actorIds: ids })).rejects.toThrow(/owner filters/);
      }
    });
  });
  it("reads only the locked current account aliases and retains email failure/feedback attribution", async () => {
    const read = () => withSelfImprovementEvidenceOwner(owner, projectIds[0], async verifiedOwnerActorIds => {
      expect(verifiedOwnerActorIds).toEqual([owner.ownerActorId, actors[0].email]);
      expect(getSql().transactionScoped).toBe(true);
      const runs = await listAgentRuns(10, { tenantId, ownerActorIds: verifiedOwnerActorIds });
      const receipts = await listToolExecutions(10, { tenantId, actorIds: verifiedOwnerActorIds });
      const bindings = await Promise.all(receipts.map(receipt => getToolExecutionScopeBinding(receipt.id, { tenantId })));
      expect(bindings.map(item => item?.executionScope.correlationId).sort()).toEqual(runIds.slice(0, 2).sort());
      expect(runs.map(item => item.id).sort()).toEqual(runIds.slice(0, 2).sort());
      expect(receipts.map(item => item.id).sort()).toEqual(toolIds.slice(0, 2).sort());
      expect(runs.find(item => item.id === runIds[0])).toMatchObject({ ownerActorId: actors[0].email, status: "failed", feedback: { correction } });
      expect(receipts.find(item => item.id === toolIds[0])?.actorId).toBe(actors[0].email);
      return collectEngineeringSignalsFromRuns({ scope: { tenantId, ownerActorId: owner.ownerActorId, repository: { owner: "isolated", name: "evidence", defaultBranch: "main" }, baseRevision: "a".repeat(40) },
        verifiedOwnerActorIds, runs: runs.map(run => ({ run, receipts: receipts.filter(receipt => receipt.actorId === run.ownerActorId) })) });
    });
    expect((await read()).map(item => item.kind).sort()).toEqual(["failed_run", "owner_correction", "recurrent_tool_failure"]);
    await admin`UPDATE omni_auth_users SET status='disabled' WHERE id=${actors[0].userId}`;
    await expect(read()).rejects.toThrow(/administrator authority/);
    await admin`UPDATE omni_auth_users SET status='active' WHERE id=${actors[0].userId}`;
  });
  it("rejects scope widening inside the joined evidence read and releases the context afterward", async () => {
    for (const [readTenant, actorIds] of [
      [tenantId, [owner.ownerActorId, actors[1].email]],
      [tenantId + "-other", [owner.ownerActorId]],
    ] as const) {
      await expect(withSelfImprovementEvidenceOwner(owner, projectIds[0], () =>
        runWithDatabaseActorScope(readTenant, actorIds, async () => getSql()`SELECT 1`)))
        .rejects.toThrow(/cannot widen or replace its tenant and actor scope/);
    }
    await withSelfImprovementEvidenceOwner(owner, projectIds[0], async actorIds => {
      expect(getSql().transactionScoped).toBe(true);
      expect((await listAgentRuns(10, { tenantId, ownerActorIds: actorIds })).map(item => item.id).sort()).toEqual(runIds.slice(0, 2).sort());
    });
    await scoped(actors[0], async () => {
      expect(getSql().transactionScoped).toBe(false);
      expect((await getSql()`SELECT current_setting('omni.tenant_id') AS tenant`)[0].tenant).toBe(tenantId);
    });
  });
  it("does not keep a former email alias after the account changes", async () => {
    const replacement = `${randomUUID()}@example.test`;
    await admin`UPDATE omni_auth_users SET email=${replacement} WHERE id=${actors[0].userId}`;
    await withSelfImprovementEvidenceOwner(owner, projectIds[1], async actorIds => {
      expect(actorIds).toEqual([owner.ownerActorId, replacement]);
      expect((await listAgentRuns(10, { tenantId, ownerActorIds: actorIds })).map(item => item.id)).toEqual([runIds[1]]);
      expect((await listToolExecutions(10, { tenantId, actorIds })).map(item => item.id)).toEqual([toolIds[1]]);
    });
  });
  it("rejects foreign, missing and archived project briefs without model or tool effects", async () => {
    const calls = setup.model.mock.calls.length;
    for (const projectId of [projectIds[2], "missing-project"]) await expect(getSelfImprovementProjectBrief(owner, projectId)).rejects.toThrow(/owner authority|unavailable/);
    await admin`UPDATE omni_projects SET status='archived' WHERE tenant_id=${tenantId} AND id=${projectIds[1]}`;
    await expect(getSelfImprovementProjectBrief(owner, projectIds[1])).rejects.toThrow(/owner authority|unavailable/);
    expect(setup.model).toHaveBeenCalledTimes(calls); expect(setup.tool).not.toHaveBeenCalled();
  });

});
