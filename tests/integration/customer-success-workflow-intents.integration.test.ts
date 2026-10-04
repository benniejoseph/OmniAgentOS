import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import type { CustomerAccountRevision } from "@/lib/customer-success/contracts";
import { submitCustomerAccountMutation, type CustomerAccountMutationAuthority, type CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import { buildCustomerSuccessOutcomeReceipt, getCustomerSuccessWorkflowDefinition } from "@/lib/customer-success/workflow-contracts";
import { buildCustomerSuccessWorkflowNativeIntent, type CustomerSuccessWorkflowNativeStartRequest, type CustomerSuccessWorkflowNativeOutcomeRequest } from "@/lib/customer-success/workflow-mutation-contracts";
import { getCustomerSuccessWorkflowNativeRun, readCustomerSuccessWorkflowNativeAcceptance, submitCustomerSuccessWorkflowNativeStart, submitCustomerSuccessWorkflowNativeOutcome } from "@/lib/customer-success/workflow-native-store";
import { findCustomerSuccessWorkflowOutcomeReplay, saveCustomerSuccessWorkflowOutcome } from "@/lib/customer-success/workflow-store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const actor = `actor:${user}`, otherActor = `actor:${otherUser}`, runtimeRole = "workflow_intent_test_runtime";
const definition = getCustomerSuccessWorkflowDefinition("risk_escalation");

// Actual non-bypass LOGIN connections exercise the product-owned outer
// transaction. The fixture must not adopt a surrounding managed transaction.
databaseDescribe("atomic native Account workflow intents under serving PostgreSQL RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES
      (${user},'workflow-intent@example.test','fixture-only'),(${otherUser},'workflow-intent-other@example.test','fixture-only')`;
    await closeDatabaseClient();
    const url = new URL(databaseUrl!); url.username = runtimeRole; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    await ensureDatabaseSchema();
    const [role] = await runWithDatabaseActorScope("workflow-proof", [actor], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_customer_accounts') AS account_rls,
      row_security_active('public.omni_customer_success_workflow_run_revisions') AS revision_rls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ role: runtimeRole, rolsuper: false, rolbypassrls: false, account_rls: true, revision_rls: true });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${runtimeRole}`); await admin.unsafe(`DROP ROLE ${runtimeRole}`); }
      await admin.end();
    }
  });

  type Coordinates = { tenantId: string; workspaceId: string };
  function authority(f: Coordinates, key: string, operation: "account" | "start" | "outcome", target?: string): CustomerAccountMutationAuthority {
    return { ...f, canonicalActorId: actor, readableActorIds: [actor], purposeId: "customer_success.account.manage", idempotencyKey: key,
      executionScope: createExecutionScope({ ...f, initiatingActorId: actor, executingPrincipalType: "user", executingPrincipalId: actor,
        correlationId: key, causationId: target, purpose: operation === "account" ? "customer.account.manage" : `customer.success.workflow.${operation}` }) };
  }
  function reader(f: Coordinates, owner = actor): CustomerAccountReadAuthority {
    return { ...f, canonicalActorId: owner, readableActorIds: [owner], purposeId: "customer_success.account.read" };
  }
  async function fixture(tag: string) {
    const f = { tenantId: `workflow-intent-${tag}`, workspaceId: `workspace:workflow-intent-${tag}` };
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${f.tenantId},${tag},${f.tenantId})`;
    for (const id of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`${tag}:${id}`},${f.tenantId},${id},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${f.tenantId},${f.workspaceId},${tag},${actor},'active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    for (const owner of [actor, otherActor]) await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${f.tenantId},${f.workspaceId},'user',${owner},${owner},1,'manager','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const created = await submitCustomerAccountMutation({ authority: authority(f, "account-create", "account"), request: {
      operation: "account.create", name: "Workflow fixture", lifecycle: "active", organizationEntityId: null,
      accountOwner: { ownerKind: "actor", ownerId: actor, displayName: "Owner" },
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"],
    } });
    return { ...f, account: created.account };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function startRequest(account: CustomerAccountRevision): CustomerSuccessWorkflowNativeStartRequest {
    return { contract: "customer-success-workflow-start-request:1", workspaceId: account.workspaceId,
      expectedAccountRevision: account.revision, expectedAccountSha256: account.accountSha256,
      expectedDefinitionSha256: definition.definitionSha256, input: { workflowId: "risk_escalation", objective: "Restore customer confidence.",
        targetDate: null, riskTitle: "Adoption stalled", severity: "high", signals: ["Active use dropped."], executiveSponsorId: null } };
  }
  function start(f: Fixture, key = "start", request = startRequest(f.account)) {
    return submitCustomerSuccessWorkflowNativeStart({ authority: authority(f, key, "start", f.account.accountId), accountId: f.account.accountId, request });
  }
  async function currentRun(f: Fixture, runId: string) {
    const result = await getCustomerSuccessWorkflowNativeRun(reader(f), { accountId: f.account.accountId, runId });
    if (!result) throw new Error("Fixture workflow run missing.");
    return result.run;
  }
  function read(f: Fixture, runId: string, key: string, owner = actor) {
    return readCustomerSuccessWorkflowNativeAcceptance(reader(f, owner), { accountId: f.account.accountId, runId,
      keySha256: idempotencyKeySha256({ tenantId: f.tenantId, idempotencyKey: key }) });
  }
  async function counts(f: Fixture) {
    const [row] = await admin`SELECT
      (SELECT count(*)::INTEGER FROM omni_projects WHERE tenant_id=${f.tenantId}) AS projects,
      (SELECT count(*)::INTEGER FROM omni_project_tasks WHERE tenant_id=${f.tenantId}) AS tasks,
      (SELECT count(*)::INTEGER FROM omni_work_projects WHERE tenant_id=${f.tenantId}) AS canonical_projects,
      (SELECT count(*)::INTEGER FROM omni_work_items WHERE tenant_id=${f.tenantId}) AS canonical_items,
      (SELECT count(*)::INTEGER FROM omni_work_compatibility_mappings WHERE tenant_id=${f.tenantId}) AS mappings,
      (SELECT count(*)::INTEGER FROM omni_work_item_status_history WHERE tenant_id=${f.tenantId}) AS histories,
      (SELECT count(*)::INTEGER FROM omni_customer_success_workflow_runs WHERE tenant_id=${f.tenantId}) AS runs,
      (SELECT count(*)::INTEGER FROM omni_customer_success_workflow_run_revisions WHERE tenant_id=${f.tenantId}) AS revisions,
      (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${f.tenantId}) AS events`;
    return row;
  }

  test.each(["task", "event"] as const)("%s failure rolls back project, tasks, canonical graph, intent and all events", async (stage) => {
    const f = await fixture(`rollback-${stage}`), before = await counts(f);
    const table = stage === "task" ? "omni_project_tasks" : "omni_events";
    const predicate = stage === "task"
      ? `EXISTS (SELECT 1 FROM public.omni_project_tasks WHERE tenant_id=NEW.tenant_id)`
      : `NEW.type='customer.success.workflow.started'`;
    await admin.unsafe(`CREATE FUNCTION public.workflow_intent_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id='${f.tenantId}' AND ${predicate} THEN RAISE EXCEPTION 'fixture workflow ${stage} failure'; END IF; RETURN NEW; END $$`);
    await admin.unsafe(`CREATE TRIGGER workflow_intent_fixture_failure BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.workflow_intent_fixture_failure()`);
    try {
      await expect(start(f)).rejects.toThrow(`fixture workflow ${stage} failure`);
      expect(await counts(f)).toEqual(before);
      const intent = buildCustomerSuccessWorkflowNativeIntent({ ...authority(f, "start", "start", f.account.accountId), accountId: f.account.accountId, request: startRequest(f.account) });
      expect((await read(f, intent.runId, "start"))?.acceptance).toBeNull();
    } finally {
      await admin.unsafe(`DROP TRIGGER workflow_intent_fixture_failure ON public.${table}`);
      await admin`DROP FUNCTION public.workflow_intent_fixture_failure()`;
    }
    expect((await start(f)).replayed).toBe(false);
  });

  test("concurrent setup is once-only and immutable setup/outcome replay survives later Account and run revisions", async () => {
    const f = await fixture("replay"), results = await Promise.all([start(f), start(f)]);
    expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
    const accepted = results[0].acceptance;
    expect(results[1].acceptance).toEqual(accepted);
    expect(accepted.projectTaskIds.map((task) => task.taskKey)).toEqual(definition.projectTemplate.tasks.map((task) => task.key));
    expect(await counts(f)).toMatchObject({ projects: 1, tasks: 3, canonical_projects: 1, canonical_items: 3, mappings: 4, histories: 3, runs: 1, revisions: 1 });
    const [project] = await admin`SELECT autonomy_mode,execution_status,tasks_dispatched,require_approval FROM omni_projects WHERE id=${accepted.projectId}`;
    expect(project).toEqual({ autonomy_mode: "manual", execution_status: "idle", tasks_dispatched: 0, require_approval: true });
    const run = await currentRun(f, accepted.runId);
    const revised = await submitCustomerAccountMutation({ authority: authority(f, "account-revise", "account"), accountId: f.account.accountId,
      request: { operation: "account.revise", expectedRevision: 1, name: "Later Account" } });
    const request: CustomerSuccessWorkflowNativeOutcomeRequest = { contract: "customer-success-workflow-outcome-request:1", workspaceId: f.workspaceId,
      runId: run.runId, expectedAccountRevision: revised.account.revision, expectedAccountSha256: revised.account.accountSha256,
      expectedRunRevision: run.revision, expectedRunSha256: run.runSha256, expectedDefinitionSha256: run.definitionSha256,
      status: "blocked", summary: "Waiting for sponsor confirmation.", artifactReceipts: [], nextAction: "Ask the sponsor." };
    const submit = () => submitCustomerSuccessWorkflowNativeOutcome({ authority: authority(f, "outcome", "outcome", run.runId), accountId: f.account.accountId, request });
    const outcome = await submit(), stable = await counts(f);
    expect(outcome.acceptance).toMatchObject({ runRevision: 2, reviewedAccountRevision: 2, runAccountRevision: 1, outcomeStatus: "blocked" });
    expect((await submit()).acceptance).toEqual(outcome.acceptance);
    expect((await start(f))).toMatchObject({ replayed: true, currentAccount: { revision: 2 }, acceptance: accepted });
    expect((await read(f, run.runId, "start"))?.acceptance).toEqual(accepted);
    expect((await read(f, run.runId, "outcome"))?.acceptance).toEqual(outcome.acceptance);
    expect(await counts(f)).toEqual(stable);
    await expect(submitCustomerSuccessWorkflowNativeOutcome({ authority: authority(f, "outcome", "outcome", run.runId), accountId: f.account.accountId,
      request: { ...request, summary: "Changed intent" } })).rejects.toThrow("matching exact native");
    await expect(start(f, "stale-new-key")).rejects.toThrow("reviewed Account changed");
    expect(await counts(f)).toEqual(stable);
  });

  test("current owner can recover as reader while writes and other owners remain denied", async () => {
    const f = await fixture("reader"), accepted = (await start(f)).acceptance;
    expect(await read(f, accepted.runId, "start", otherActor)).toBeNull();
    await admin`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,
      revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId} AND subject_actor_id=${actor}`;
    await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${f.tenantId},${f.workspaceId},'user',${actor},${actor},2,'reader','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    expect((await read(f, accepted.runId, "start"))?.acceptance).toEqual(accepted);
    expect((await read(f, accepted.runId, "missing-key"))?.acceptance).toBeNull();
    await expect(start(f)).rejects.toThrow();
    await admin`UPDATE omni_tenant_workspaces SET state='archived',lifecycle_revision=lifecycle_revision+1,
      archived_by_actor_id=${actor},archived_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId}`;
    expect(await read(f, accepted.runId, "start")).toBeNull();
  });

  test("current authority is rechecked after a blocked admission lock", async () => {
    const f = await fixture("revoked"), intent = buildCustomerSuccessWorkflowNativeIntent({ ...authority(f, "start", "start", f.account.accountId), accountId: f.account.accountId, request: startRequest(f.account) });
    let release!: () => void, announce!: () => void, pid = 0;
    const held = new Promise<void>((resolve) => { announce = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    const lock = admin.begin(async (sql) => {
      pid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-workflow-key:${f.tenantId}:${f.workspaceId}:${actor}:${intent.idempotencyKeySha256}`},0))`;
      announce(); await released;
      await sql`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,
        revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId} AND subject_actor_id=${actor}`;
    });
    await held; const deciding = start(f).catch((error: unknown) => error);
    let waiting = false;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await admin`SELECT pid FROM pg_stat_activity WHERE usename=${runtimeRole} AND ${pid}=ANY(pg_blocking_pids(pid))`;
        if (rows[0]) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally { release(); }
    await lock; expect(await deciding).toBeInstanceOf(Error); expect(waiting).toBe(true);
    expect(await counts(f)).toMatchObject({ projects: 0, tasks: 0, canonical_projects: 0, canonical_items: 0, runs: 0, revisions: 0 });
  }, 30_000);

  test("legacy semantic outcome replay keeps its original time and never invents native proof", async () => {
    const f = await fixture("legacy"), accepted = (await start(f)).acceptance, run = await currentRun(f, accepted.runId);
    const a = authority(f, "legacy-outcome", "outcome", run.runId);
    const fields = { status: "blocked" as const, summary: "Awaiting confirmation.", artifactReceipts: [], nextAction: "Ask the sponsor.", recordedByActorId: actor };
    const outcome = buildCustomerSuccessOutcomeReceipt({ ...fields, recordedAt: new Date(Date.parse(run.outcome.recordedAt) + 1000).toISOString() });
    const saved = await saveCustomerSuccessWorkflowOutcome({ authority: a, runId: run.runId, expectedRevision: run.revision, outcome });
    const before = await counts(f);
    expect(await saveCustomerSuccessWorkflowOutcome({ authority: a, runId: run.runId, expectedRevision: run.revision,
      outcome: buildCustomerSuccessOutcomeReceipt({ ...fields, recordedAt: new Date(Date.parse(outcome.recordedAt) + 1000).toISOString() }) })).toEqual(saved);
    expect(await findCustomerSuccessWorkflowOutcomeReplay({ authority: a, accountId: f.account.accountId, runId: run.runId,
      expectedRevision: run.revision, ...fields })).toEqual(saved);
    expect((await read(f, run.runId, "legacy-outcome"))?.acceptance).toBeNull();
    expect(await counts(f)).toEqual(before);
    const [native] = await admin`SELECT native_intent,native_intent_sha256 FROM omni_customer_success_workflow_run_revisions
      WHERE tenant_id=${f.tenantId} AND revision=1`;
    expect(native.native_intent_sha256).toBe(canonicalJsonSha256(native.native_intent));
    await expect(runWithDatabaseActorScope(f.tenantId, [actor], () => getSql()`UPDATE omni_customer_success_workflow_run_revisions
      SET native_intent_sha256=${"f".repeat(64)} WHERE tenant_id=${f.tenantId} AND revision=1`)).rejects.toThrow();
  });
});
