import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import type { CustomerAccountRevision } from "@/lib/customer-success/contracts";
import { customerHealthEvaluationId, sealCustomerHealthScore, type CustomerHealthScore } from "@/lib/customer-success/health-contracts";
import { buildCustomerHealthEvaluationIntent, type CustomerHealthEvaluationRequest } from "@/lib/customer-success/health-mutation-contracts";
import { CustomerHealthEvaluationRefusedError, evaluateAndSaveCustomerHealth, getCurrentCustomerHealthScore, readCustomerHealthEvaluationAcceptance, submitCustomerHealthEvaluation } from "@/lib/customer-success/health-store";
import { CustomerAccountConflictError, CustomerAccountNotFoundError, submitCustomerAccountMutation, type CustomerAccountMutationAuthority, type CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const actor = `actor:${user}`, otherActor = `actor:${otherUser}`;
const purposes = ["customer_success.account.manage", "customer_success.account.read"] as const;

// Administrative setup is confined to this destructive opt-in fixture. Every
// store operation uses the actual non-bypass serving role and current RLS. A
// two-session barrier verifies overlapping requests rather than pool ordering.
databaseDescribe("exact health evaluation intents under serving PostgreSQL RLS", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    admin = postgres(databaseUrl!, { max: 2, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`GRANT SELECT ON omni_auth_users,omni_auth_memberships,omni_auth_tenants,
      omni_tenant_workspaces,omni_tenant_workspace_memberships,omni_schema_version,
      omni_agent_runs,omni_tool_executions TO omni_runtime`;
    await admin`GRANT SELECT,INSERT ON omni_events TO omni_runtime`;
    await admin`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO omni_runtime`;
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES
      (${user},'health-intent@example.test','fixture-only'),
      (${otherUser},'health-intent-other@example.test','fixture-only')`;
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs(); });

  async function fixture(tag: string) {
    const tenantId = `health-intent-${tag}`, workspaceId = `workspace:health-intent-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    for (const id of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`${tag}:${id}`},${tenantId},${id},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},${tag},${actor},'active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    for (const member of [actor, otherActor]) await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'user',${member},${member},1,'manager','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const f = { tenantId, workspaceId }, a = authority(f, "create");
    const created = await serving(a, () => submitCustomerAccountMutation({ authority: a, request: {
      operation: "account.create", name: "Health fixture", lifecycle: "active", organizationEntityId: null,
      accountOwner: { ownerKind: "actor", ownerId: actor, displayName: "Owner" }, customerDataPurposeIds: [...purposes],
    } }));
    return { ...f, account: created.account };
  }
  type Coordinates = { tenantId: string; workspaceId: string };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function authority(f: Coordinates, key = "health", accountId?: string, canonicalActorId = actor): CustomerAccountMutationAuthority {
    return { ...f, canonicalActorId, readableActorIds: [canonicalActorId], purposeId: "customer_success.account.manage", idempotencyKey: key,
      executionScope: createExecutionScope({ ...f, initiatingActorId: canonicalActorId, executingPrincipalType: "user", executingPrincipalId: canonicalActorId,
        correlationId: key, purpose: accountId ? "customer.health.evaluate" : "customer.account.manage", causationId: accountId }) };
  }
  function readAuthority(f: Coordinates, canonicalActorId = actor): CustomerAccountReadAuthority {
    return { ...f, canonicalActorId, readableActorIds: [canonicalActorId], purposeId: "customer_success.account.read" };
  }
  function request(account: CustomerAccountRevision): CustomerHealthEvaluationRequest {
    return { contract: "customer-health-evaluation-request:1", workspaceId: account.workspaceId,
      expectedAccountRevision: account.revision, expectedAccountSha256: account.accountSha256, modelSuggestions: [] };
  }
  function serving<T>(a: CustomerAccountReadAuthority | CustomerAccountMutationAuthority, operation: (sql: SqlClient) => Promise<T>, ready?: (pid: number) => Promise<void>, adopt = true): Promise<T> {
    return runWithDatabaseActorScope(a.tenantId, a.readableActorIds, () => getSql().transaction(async (sql: SqlClient) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      await sql`SET LOCAL row_security = on`;
      await sql`SELECT set_config('omni.system_scope','false',true)`;
      const proof = await sql`SELECT current_user AS role,rolsuper,rolbypassrls,pg_backend_pid() AS pid,
        row_security_active('public.omni_customer_accounts') AS accounts_rls,
        row_security_active('public.omni_customer_health_score_revisions') AS revisions_rls,
        row_security_active('public.omni_customer_health_scores') AS health_rls,
        omni_system_scope_enabled() AS system_scope FROM pg_roles WHERE rolname=current_user`;
      expect(proof[0]).toMatchObject({ role: "omni_runtime", rolsuper: false, rolbypassrls: false, accounts_rls: true, revisions_rls: true, health_rls: true, system_scope: false });
      if (ready) await ready(Number(proof[0].pid));
      return adopt ? runWithManagedDatabaseTransaction(sql, () => operation(getSql())) : operation(sql);
    }) as Promise<T>);
  }
  function submit(f: Fixture, key = "health", reviewed = request(f.account)) {
    const a = authority(f, key, f.account.accountId);
    return serving(a, () => submitCustomerHealthEvaluation({ authority: a, accountId: f.account.accountId, request: reviewed }));
  }
  function read(f: Fixture, evaluationId: string, a = readAuthority(f)) {
    return serving(a, () => readCustomerHealthEvaluationAcceptance(a, { accountId: f.account.accountId, evaluationId }));
  }
  function count(f: Fixture) {
    return serving(readAuthority(f), async (sql) => (await sql`SELECT
      (SELECT count(*)::INTEGER FROM omni_customer_health_policies WHERE tenant_id=${f.tenantId} AND account_id=${f.account.accountId}) AS policies,
      (SELECT count(*)::INTEGER FROM omni_customer_health_score_revisions WHERE tenant_id=${f.tenantId} AND account_id=${f.account.accountId}) AS revisions,
      (SELECT count(*)::INTEGER FROM omni_customer_health_scores WHERE tenant_id=${f.tenantId} AND account_id=${f.account.accountId}) AS scores,
      (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${f.tenantId} AND stream_id=${f.account.accountId} AND type='customer.account.health.evaluated') AS events`)[0]);
  }
  function barrier() {
    const pids = new Set<number>(); let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    return { pids, ready: async (pid: number) => { pids.add(pid); if (pids.size === 2) release(); await both; } };
  }

  test("concurrent exact duplicates append one immutable intent, score and event", async () => {
    const f = await fixture("concurrent"), a = authority(f, "health", f.account.accountId), b = barrier();
    const results = await Promise.all([1, 2].map(() => serving(a, () => submitCustomerHealthEvaluation({ authority: a, accountId: f.account.accountId, request: request(f.account) }), b.ready)));
    expect(b.pids.size).toBe(2);
    expect(results[0].acceptance).toEqual(results[1].acceptance);
    expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
    expect(results[0].acceptance).toMatchObject({ status: "unknown", scoreBasisPoints: null, accountRevision: 1, scoreRevision: 1 });
    expect(await count(f)).toEqual({ policies: 1, revisions: 1, scores: 1, events: 1 });
    await serving(a, async (sql) => {
      const rows = await sql`SELECT request_intent,request_sha256 FROM omni_customer_health_score_revisions WHERE tenant_id=${f.tenantId}`;
      expect(rows[0].request_sha256).toBe(canonicalJsonSha256(rows[0].request_intent));
      expect(rows[0].request_sha256).toBe(results[0].acceptance.requestSha256);
    });
  }, 30_000);

  test("replay preserves the accepted Account pin after a later revision and refuses changed semantic intent", async () => {
    const f = await fixture("replay"), accepted = await submit(f), a = authority(f, "revise");
    const revised = await serving(a, () => submitCustomerAccountMutation({ authority: a, accountId: f.account.accountId, request: { operation: "account.revise", expectedRevision: 1, name: "Later Account" } }));
    const replayed = await submit(f);
    expect(replayed).toMatchObject({ replayed: true, currentAccount: { revision: 2, accountSha256: revised.account.accountSha256 }, acceptance: accepted.acceptance });
    expect(await read(f, accepted.acceptance.evaluationId)).toEqual({ currentAccount: replayed.currentAccount, acceptance: accepted.acceptance });
    const collision = await submit(f, "health", request(revised.account)).catch((error: unknown) => error);
    expect(collision).toBeInstanceOf(CustomerAccountConflictError);
    expect(collision).not.toBeInstanceOf(CustomerHealthEvaluationRefusedError);
    const intent = buildCustomerHealthEvaluationIntent({ ...authority(f, "new-stale", f.account.accountId), accountId: f.account.accountId, request: request(f.account) });
    await expect(submit(f, "new-stale")).rejects.toMatchObject({ admission: "not_admitted", code: "customer_health_account_changed", evaluationId: intent.evaluationId, requestSha256: canonicalJsonSha256(intent) });
    expect((await read(f, intent.evaluationId)).acceptance).toBeNull();
    expect(await count(f)).toEqual({ policies: 1, revisions: 1, scores: 1, events: 1 });
  });

  test("same current owner can recover as reader without recovering write authority", async () => {
    const f = await fixture("reader"), accepted = await submit(f), foreign = await fixture("foreign");
    await expect(read(f, accepted.acceptance.evaluationId, readAuthority(f, otherActor))).rejects.toBeInstanceOf(CustomerAccountNotFoundError);
    await expect(read(f, accepted.acceptance.evaluationId, readAuthority(foreign))).rejects.toBeInstanceOf(CustomerAccountNotFoundError);
    await admin`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId} AND subject_actor_id=${actor}`;
    await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${f.tenantId},${f.workspaceId},'user',${actor},${actor},2,'reader','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    expect((await read(f, accepted.acceptance.evaluationId)).acceptance).toEqual(accepted.acceptance);
    const denied = await submit(f).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(Error); expect(denied).not.toBeInstanceOf(CustomerHealthEvaluationRefusedError);
    await admin`UPDATE omni_tenant_workspaces SET state='archived',lifecycle_revision=lifecycle_revision+1,archived_by_actor_id=${actor},archived_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId}`;
    await expect(read(f, accepted.acceptance.evaluationId)).rejects.toBeInstanceOf(CustomerAccountNotFoundError);
  });

  test("current membership is rechecked after a blocked admission lock without inventing a refusal proof", async () => {
    const f = await fixture("lock-revocation"), a = authority(f, "health", f.account.accountId);
    let outcome!: Promise<unknown>, ready!: (pid: number) => void;
    const started = new Promise<number>((resolve) => { ready = resolve; });
    await admin.begin(async (lock) => {
      await lock`SELECT pg_advisory_xact_lock(hashtextextended(${`${f.tenantId}:${f.workspaceId}:${f.account.accountId}:health`},0))`;
      outcome = serving(a, () => submitCustomerHealthEvaluation({ authority: a, accountId: f.account.accountId, request: request(f.account) }), async (pid) => { ready(pid); }).catch((error: unknown) => error);
      const pid = await started;
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const rows = await admin`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND NOT granted) AS waiting`;
        waiting = rows[0].waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await lock`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId} AND subject_actor_id=${actor}`;
    });
    const denied = await outcome;
    expect(denied).toBeInstanceOf(Error); expect(denied).not.toBeInstanceOf(CustomerHealthEvaluationRefusedError);
    // Administrative observation is only a rollback witness after authority was
    // revoked; it is never returned to the native requester as absence proof.
    const rows = await admin`SELECT count(*)::INTEGER AS total FROM omni_customer_health_score_revisions WHERE tenant_id=${f.tenantId}`;
    expect(rows[0].total).toBe(0);
  }, 30_000);

  test("legacy NULL intent remains readable but never becomes an exact native receipt", async () => {
    const f = await fixture("legacy"), a = authority(f, "health", f.account.accountId), evaluationId = customerHealthEvaluationId({ accountId: f.account.accountId, idempotencyKey: "health" });
    const score = await serving(a, () => evaluateAndSaveCustomerHealth({ authority: a, accountId: f.account.accountId,
      expectedAccountRevision: f.account.revision, expectedAccountSha256: f.account.accountSha256, evaluationId }));
    expect(await serving(readAuthority(f), () => getCurrentCustomerHealthScore(readAuthority(f), f.account.accountId))).toEqual(score);
    expect((await read(f, evaluationId)).acceptance).toBeNull();
    const denied = await submit(f).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(CustomerAccountConflictError); expect(denied).not.toBeInstanceOf(CustomerHealthEvaluationRefusedError);
    expect(await count(f)).toEqual({ policies: 1, revisions: 1, scores: 1, events: 1 });
  });

  test("event failure atomically rolls back admission and score before an explicit new attempt", async () => {
    const f = await fixture("rollback");
    await admin`CREATE FUNCTION public.health_intent_fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = 'health-intent-rollback' AND NEW.type = 'customer.account.health.evaluated' THEN RAISE EXCEPTION 'fixture health event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER health_intent_fixture_event_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION public.health_intent_fixture_event_failure()`;
    try {
      await expect(submit(f)).rejects.toMatchObject({ code: "P0001", message: "fixture health event failure" });
      expect(await count(f)).toEqual({ policies: 0, revisions: 0, scores: 0, events: 0 });
      expect((await read(f, customerHealthEvaluationId({ accountId: f.account.accountId, idempotencyKey: "health" }))).acceptance).toBeNull();
    } finally {
      await admin`DROP TRIGGER health_intent_fixture_event_failure ON omni_events`;
      await admin`DROP FUNCTION public.health_intent_fixture_event_failure()`;
    }
    expect((await submit(f)).replayed).toBe(false);
    expect(await count(f)).toEqual({ policies: 1, revisions: 1, scores: 1, events: 1 });
  });

  test("the database rejects partial or inconsistent native intent and denies immutable rewrites", async () => {
    const f = await fixture("constraints"), accepted = await submit(f), a = authority(f, "health", f.account.accountId);
    await expect(serving(a, (sql) => sql`UPDATE omni_customer_health_score_revisions SET request_sha256=${"f".repeat(64)} WHERE tenant_id=${f.tenantId}`, undefined, false)).rejects.toMatchObject({ code: "42501" });
    const score = (await serving(readAuthority(f), () => getCurrentCustomerHealthScore(readAuthority(f), f.account.accountId))) as CustomerHealthScore;
    const intent = buildCustomerHealthEvaluationIntent({ ...authority(f, "invalid", f.account.accountId), accountId: f.account.accountId, request: request(f.account) });
    const { scoreSha256: _digest, ...body } = score;
    const snapshot = sealCustomerHealthScore({ ...body, revision: 2, scoreRevisionId: `${score.scoreId}:v2`, previousScoreRevisionId: score.scoreRevisionId, evaluationId: intent.evaluationId });
    const { request: fields, ...withoutRequest } = intent;
    for (const [metadata, digest] of [
      [intent, null], [withoutRequest, canonicalJsonSha256(withoutRequest)],
      [{ ...intent, request: { ...fields, expectedAccountRevision: null } }, "a".repeat(64)],
      [{ ...intent, request: { ...fields, expectedAccountSha256: "b".repeat(64) } }, "a".repeat(64)],
      [{ ...intent, request: { ...fields, modelSuggestions: [{}] } }, "a".repeat(64)],
    ] as const) {
      await expect(serving(a, (sql) => sql`INSERT INTO omni_customer_health_score_revisions(
        tenant_id,workspace_id,account_id,owner_actor_id,score_id,score_revision_id,revision,evaluation_id,policy_id,
        allowed_purpose_ids,account_sha256,input_sha256,score_basis_points,health_status,confidence_basis_points,
        coverage_basis_points,score_sha256,score_snapshot,evaluated_at,request_intent,request_sha256)
        VALUES (${f.tenantId},${f.workspaceId},${f.account.accountId},${actor},${score.scoreId},${snapshot.scoreRevisionId},2,${intent.evaluationId},${score.policy.policyId},
          ${["customer_success.account.read"]},${score.accountSha256},${score.inputSha256},${score.scoreBasisPoints},${score.status},${score.confidenceBasisPoints},
          ${score.coverageBasisPoints},${snapshot.scoreSha256},${snapshot}::JSONB,${score.evaluatedAt},${metadata}::JSONB,${digest})`, undefined, false)).rejects.toMatchObject({ code: "23514", constraint_name: "omni_customer_health_exact_intent" });
    }
    expect((await read(f, accepted.acceptance.evaluationId)).acceptance).toEqual(accepted.acceptance);
    expect(await count(f)).toEqual({ policies: 1, revisions: 1, scores: 1, events: 1 });
  });
});
