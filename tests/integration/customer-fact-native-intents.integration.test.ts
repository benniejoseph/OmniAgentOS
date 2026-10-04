import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { buildCustomerFactNativeIntent, type CustomerFactNativeRequest } from "@/lib/customer-success/fact-mutation-contracts";
import { readCustomerFactNativeAcceptance, submitCustomerFactNativeMutation } from "@/lib/customer-success/fact-native-store";
import { factFixture } from "@/lib/customer-success/fact-mutation.test-fixtures";
import { recordCustomerFact, submitCustomerAccountMutation, type CustomerAccountMutationAuthority, type CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const actor = `actor:${user}`, otherActor = `actor:${otherUser}`, runtimeRole = "fact_intent_test_runtime";
databaseDescribe("native manual fact intents under serving PostgreSQL RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES (${user},'fact-intent@example.test','fixture-only'),(${otherUser},'fact-other@example.test','fixture-only')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = runtimeRole; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", ""); await ensureDatabaseSchema();
    const [role] = await runWithDatabaseActorScope("fact-proof", [actor], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_customer_fact_revisions') AS fact_rls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ role: runtimeRole, rolsuper: false, rolbypassrls: false, fact_rls: true });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${runtimeRole}`); await admin.unsafe(`DROP ROLE ${runtimeRole}`); } await admin.end(); }
  });
  type Coordinates = { tenantId: string; workspaceId: string };
  function authority(f: Coordinates, key: string, accountId?: string): CustomerAccountMutationAuthority {
    return { ...f, canonicalActorId: actor, readableActorIds: [actor], purposeId: "customer_success.account.manage", idempotencyKey: key,
      executionScope: createExecutionScope({ ...f, initiatingActorId: actor, executingPrincipalType: "user", executingPrincipalId: actor,
        correlationId: key, causationId: accountId, purpose: accountId ? "customer.account.fact.record" : "customer.account.manage" }) };
  }
  function reader(f: Coordinates, owner = actor): CustomerAccountReadAuthority { return { ...f, canonicalActorId: owner, readableActorIds: [owner], purposeId: "customer_success.account.read" }; }
  async function fixture(tag: string) {
    const f = { tenantId: `fact-intent-${tag}`, workspaceId: `workspace:fact-intent-${tag}` };
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${f.tenantId},${tag},${f.tenantId})`;
    for (const id of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`${tag}:${id}`},${f.tenantId},${id},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${f.tenantId},${f.workspaceId},${tag},${actor},'active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    for (const owner of [actor, otherActor]) await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${f.tenantId},${f.workspaceId},'user',${owner},${owner},1,'manager','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const created = await submitCustomerAccountMutation({ authority: authority(f, "account-create"), request: { operation: "account.create", name: "Fact fixture",
      lifecycle: "active", organizationEntityId: null, accountOwner: { ownerKind: "actor", ownerId: actor, displayName: "Owner" },
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"] } });
    const request: CustomerFactNativeRequest = { ...factFixture().request, workspaceId: f.workspaceId,
      expectedAccountRevision: created.account.revision, expectedAccountSha256: created.account.accountSha256 };
    return { ...f, account: created.account, request };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function submit(f: Fixture, key = "fact", request = f.request) { return submitCustomerFactNativeMutation({
    authority: authority(f, key, f.account.accountId), accountId: f.account.accountId, request }); }
  function read(f: Fixture, key = "fact", owner = actor) { return readCustomerFactNativeAcceptance(reader(f, owner), {
    accountId: f.account.accountId, keySha256: idempotencyKeySha256({ tenantId: f.tenantId, idempotencyKey: key }) }); }
  async function count(f: Fixture) { return (await admin`SELECT
    (SELECT count(*)::INTEGER FROM omni_customer_fact_revisions WHERE tenant_id=${f.tenantId}) AS facts,
    (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${f.tenantId} AND type='customer.account.fact.recorded') AS events`)[0]; }

  test("concurrent create accepts once; exact historical replay survives revision, retraction and Account advancement", async () => {
    const f = await fixture("replay"), created = await Promise.all([submit(f), submit(f)]), first = created[0].acceptance;
    expect(created.map((value) => value.replayed).sort()).toEqual([false, true]); expect(created[1].acceptance).toEqual(first);
    expect(await count(f)).toEqual({ facts: 1, events: 1 });
    const revisedRequest: CustomerFactNativeRequest = { ...f.request, operation: "revise", factId: first.factId,
      expectedFactRevision: first.factRevision, expectedFactSha256: first.factSha256, confidenceBasisPoints: 8000 };
    const revised = await submit(f, "revise", revisedRequest);
    const retracted = await submit(f, "retract", { ...revisedRequest, operation: "retract", expectedFactRevision: 2, expectedFactSha256: revised.acceptance.factSha256 });
    expect(retracted.acceptance).toMatchObject({ factRevision: 3, state: "retracted", sourceKind: "manual", permissionBasis: "operator_assertion" });
    await submitCustomerAccountMutation({ authority: authority(f, "account-revise"), accountId: f.account.accountId,
      request: { operation: "account.revise", expectedRevision: 1, name: "Later Account" } });
    expect(await submit(f)).toMatchObject({ replayed: true, currentAccount: { revision: 2 }, acceptance: first });
    expect((await read(f))?.acceptance).toEqual(first); expect(await count(f)).toEqual({ facts: 3, events: 3 });
    await expect(submit(f, "fact", { ...f.request, confidenceBasisPoints: 10 })).rejects.toThrow("matching native fact");
    await expect(submit(f, "new-stale")).rejects.toThrow("reviewed Account changed");
  });

  test("stale fact pins and a non-manual predecessor cannot be revised through manual ingress", async () => {
    const f = await fixture("pins"), created = await submit(f);
    await expect(submit(f, "stale", { ...f.request, operation: "revise", factId: created.acceptance.factId,
      expectedFactRevision: 1, expectedFactSha256: "f".repeat(64) })).rejects.toThrow("exact current manual");
    const intent = buildCustomerFactNativeIntent({ ...authority(f, "legacy", f.account.accountId), accountId: f.account.accountId, request: f.request });
    const sample = factFixture().fact;
    const legacy = await recordCustomerFact({ authority: authority(f, "legacy", f.account.accountId), accountId: f.account.accountId,
      factId: intent.factId, mutationId: intent.mutationId, factKey: f.request.factKey, value: f.request.value, owner: f.request.owner,
      confidenceBasisPoints: f.request.confidenceBasisPoints, validFrom: f.request.validFrom,
      source: { ...sample.source, sourceKind: "computed", permissionBasis: "derived_from_cited_evidence" } });
    expect((await read(f, "legacy"))?.acceptance).toBeNull();
    await expect(submit(f, "legacy")).rejects.toThrow("matching native fact");
    await expect(submit(f, "manual-relabel", { ...f.request, operation: "retract", factId: legacy.factId,
      expectedFactRevision: 1, expectedFactSha256: legacy.factSha256 })).rejects.toThrow("exact current manual");
    expect(await count(f)).toEqual({ facts: 2, events: 2 });
  });

  test("event failure rolls back native fact, intent and acceptance together", async () => {
    const f = await fixture("rollback");
    await admin`CREATE FUNCTION public.fact_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id='fact-intent-rollback' AND NEW.type='customer.account.fact.recorded' THEN RAISE EXCEPTION 'fixture fact event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER fact_fixture_fail BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION public.fact_fixture_fail()`;
    try { await expect(submit(f)).rejects.toThrow("fixture fact event failure"); expect(await count(f)).toEqual({ facts: 0, events: 0 });
      expect((await read(f))?.acceptance).toBeNull(); }
    finally { await admin`DROP TRIGGER fact_fixture_fail ON omni_events`; await admin`DROP FUNCTION public.fact_fixture_fail()`; }
    expect((await submit(f)).replayed).toBe(false);
  });

  test("current reader can recover immutable acceptance while ownership and write checks remain current", async () => {
    const f = await fixture("reader"), accepted = await submit(f);
    expect(await read(f, "fact", otherActor)).toBeNull();
    await admin`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,
      revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId} AND subject_actor_id=${actor}`;
    await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${f.tenantId},${f.workspaceId},'user',${actor},${actor},2,'reader','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    expect((await read(f))?.acceptance).toEqual(accepted.acceptance); expect((await read(f, "missing"))?.acceptance).toBeNull();
    await expect(submit(f)).rejects.toThrow(); expect(await count(f)).toEqual({ facts: 1, events: 1 });
  });

  test("rechecks current authority after waiting for a locked Account parent", async () => {
    const f = await fixture("locked");
    let release!: () => void, announce!: () => void, pid = 0;
    const held = new Promise<void>((resolve) => { announce = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    const lock = admin.begin(async (sql) => {
      pid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);
      await sql`SELECT account_id FROM omni_customer_accounts WHERE tenant_id=${f.tenantId} AND account_id=${f.account.accountId} FOR UPDATE`;
      announce(); await released;
      // Membership withdrawal is a supported authority transition while this
      // parent is held; no immutable Account snapshot is edited for the test.
      await sql`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,
        revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${f.tenantId} AND subject_actor_id=${actor}`;
    });
    await held; const deciding = submit(f).catch((error: unknown) => error); let waiting = false;
    try { const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { const rows = await admin`SELECT pid FROM pg_stat_activity WHERE usename=${runtimeRole} AND ${pid}=ANY(pg_blocking_pids(pid))`;
        if (rows[0]) { waiting = true; break; } await new Promise((resolve) => setTimeout(resolve, 20)); }
    } finally { release(); }
    await lock; expect(await deciding).toBeInstanceOf(Error); expect(waiting).toBe(true); expect(await count(f)).toEqual({ facts: 0, events: 0 });
  }, 30_000);

  test("native intent is immutable and its digest matches the acceptance", async () => {
    const f = await fixture("immutable"), accepted = await submit(f);
    const [row] = await admin`SELECT native_intent,native_intent_sha256 FROM omni_customer_fact_revisions WHERE tenant_id=${f.tenantId}`;
    expect(row.native_intent_sha256).toBe(canonicalJsonSha256(row.native_intent)); expect(row.native_intent_sha256).toBe(accepted.acceptance.requestSha256);
    await expect(runWithDatabaseActorScope(f.tenantId, [actor], () => getSql()`UPDATE omni_customer_fact_revisions
      SET native_intent_sha256=${"f".repeat(64)} WHERE tenant_id=${f.tenantId}`)).rejects.toThrow();
    expect((await read(f))?.acceptance).toEqual(accepted.acceptance);
  });
});
