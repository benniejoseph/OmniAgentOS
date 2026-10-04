import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { buildCustomerAccountMutationIntent, type CustomerAccountMutationRequest } from "@/lib/customer-success/account-mutation-contracts";
import { customerAccountId, customerMutationId } from "@/lib/customer-success/contracts";
import { CustomerAccountConflictError, CustomerAccountNotFoundError, getCustomerAccount360, saveCustomerAccount, submitCustomerAccountMutation, type CustomerAccountMutationAuthority } from "@/lib/customer-success/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222", readerUser = "33333333-3333-4333-8333-333333333333";
const actor = `actor:${user}`, otherActor = `actor:${otherUser}`, readerActor = `actor:${readerUser}`;
const owner = { ownerKind: "actor" as const, ownerId: actor, displayName: "Owner" };
const purposes = ["customer_success.account.manage", "customer_success.account.read"] as const;
const create: CustomerAccountMutationRequest = { operation: "account.create", name: "Acme", lifecycle: "active", organizationEntityId: null, accountOwner: owner, customerDataPurposeIds: [...purposes] };

// Destructive opt-in fixture. Administrative setup never supplies authority to
// behavioral reads/writes. Every store call runs as omni_runtime with RLS on.
// Pool two is intentional: barriers prove overlapping distinct PostgreSQL
// sessions, rather than calling Promise.all against a serialized pool of one.
databaseDescribe("exact Account mutation intent under serving PostgreSQL RLS", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2");
    vi.stubEnv("VERCEL", "");
    admin = postgres(databaseUrl!, { max: 1, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
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
      (${user},'account-intent@example.test','fixture-only'),
      (${otherUser},'account-intent-other@example.test','fixture-only'),
      (${readerUser},'account-intent-reader@example.test','fixture-only')`;
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs(); });

  async function fixture(tag: string) {
    const tenantId = `account-intent-${tag}`, workspaceId = `workspace:account-intent-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    for (const id of [user, otherUser, readerUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`${tag}:${id}`},${tenantId},${id},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},${tag},${actor},'active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    for (const member of [actor, otherActor, readerActor]) await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'user',${member},${member},1,${member === readerActor ? "reader" : "manager"},'active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    return { tenantId, workspaceId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function authority(f: Fixture, key = "create", canonicalActorId = actor): CustomerAccountMutationAuthority {
    return { ...f, canonicalActorId, readableActorIds: [canonicalActorId], purposeId: "customer_success.account.manage", idempotencyKey: key,
      executionScope: createExecutionScope({ ...f, initiatingActorId: canonicalActorId, executingPrincipalType: "user", executingPrincipalId: canonicalActorId, correlationId: key, purpose: "customer.account.manage" }) };
  }
  function serving<T>(a: CustomerAccountMutationAuthority, operation: (sql: SqlClient) => Promise<T>, ready?: (pid: number) => Promise<void>, adopt = true): Promise<T> {
    return runWithDatabaseActorScope(a.tenantId, a.readableActorIds, () => getSql().transaction(async (sql: SqlClient) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      await sql`SET LOCAL row_security = on`;
      await sql`SELECT set_config('omni.system_scope','false',true)`;
      const proof = await sql`SELECT current_user AS role,rolsuper,rolbypassrls,pg_backend_pid() AS pid,
        row_security_active('public.omni_customer_accounts') AS accounts_rls,
        row_security_active('public.omni_customer_account_revisions') AS revisions_rls,
        omni_system_scope_enabled() AS system_scope FROM pg_roles WHERE rolname=current_user`;
      expect(proof[0]).toMatchObject({ role: "omni_runtime", rolsuper: false, rolbypassrls: false, accounts_rls: true, revisions_rls: true, system_scope: false });
      if (ready) await ready(Number(proof[0].pid));
      // Direct SQL needs no nested getSql composition. Keep it on the same
      // proven serving transaction so a rejected constraint retains its exact
      // error before PostgreSQL enters the aborted-transaction state.
      return adopt ? runWithManagedDatabaseTransaction(sql, () => operation(getSql())) : operation(sql);
    }) as Promise<T>);
  }
  function submit(f: Fixture, key = "create", request = create, accountId?: string, canonicalActorId = actor) {
    const a = authority(f, key, canonicalActorId);
    return serving(a, () => submitCustomerAccountMutation({ authority: a, accountId, request }));
  }
  async function count(f: Fixture, accountId: string) {
    return serving(authority(f), async (sql) => {
      const rows = await sql`SELECT
        (SELECT count(*)::INTEGER FROM omni_customer_account_revisions WHERE tenant_id=${f.tenantId} AND workspace_id=${f.workspaceId} AND account_id=${accountId}) AS revisions,
        (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${f.tenantId} AND stream_id=${accountId}) AS events`;
      return rows[0];
    });
  }
  function barrier() {
    const pids = new Set<number>();
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    return { pids, ready: async (pid: number) => { pids.add(pid); if (pids.size === 2) release(); await both; } };
  }

  test("replays accepted create after CAS advanced without appending another revision or event", async () => {
    const f = await fixture("create-replay"), accepted = await submit(f);
    await submit(f, "revise", { operation: "account.revise", expectedRevision: 1, name: "Later" }, accepted.account.accountId);
    const replay = await submit(f);
    expect(replay).toEqual(accepted);
    expect(await count(f, accepted.account.accountId)).toEqual({ revisions: 2, events: 2 });
    await serving(authority(f), async (sql) => {
      const rows = await sql`SELECT request_intent,request_sha256 FROM omni_customer_account_revisions WHERE tenant_id=${f.tenantId} AND mutation_id=${accepted.account.mutationId}`;
      expect(rows[0].request_sha256).toBe(canonicalJsonSha256(rows[0].request_intent));
      expect(rows[0].request_sha256).toBe(accepted.acceptance.requestSha256);
    });
  });
  test("returns the exact accepted revise before a stale original CAS, including after another change", async () => {
    const f = await fixture("revise-replay"), initial = await submit(f), id = initial.account.accountId;
    const patch: CustomerAccountMutationRequest = { operation: "account.revise", expectedRevision: 1, lifecycle: "at_risk" };
    const accepted = await submit(f, "revise", patch, id);
    await submit(f, "third", { operation: "account.revise", expectedRevision: 2, name: "Later" }, id);
    expect(await submit(f, "revise", patch, id)).toEqual(accepted);
    expect(await count(f, id)).toEqual({ revisions: 3, events: 3 });
  });
  test("rejects same create key with changed fields and same sparse patch key with explicit extra input", async () => {
    const f = await fixture("drift"), initial = await submit(f), id = initial.account.accountId;
    await expect(submit(f, "create", { ...create, name: "Changed" })).rejects.toBeInstanceOf(CustomerAccountConflictError);
    const patch: CustomerAccountMutationRequest = { operation: "account.revise", expectedRevision: 1, lifecycle: "at_risk" };
    await submit(f, "revise", patch, id);
    await expect(submit(f, "revise", { ...patch, organizationEntityId: null }, id)).rejects.toBeInstanceOf(CustomerAccountConflictError);
    expect(await count(f, id)).toEqual({ revisions: 2, events: 2 });
  });
  test("another canonical manager cannot claim a shared create key or read the owner's accepted revise", async () => {
    const f = await fixture("actor"), initial = await submit(f), id = initial.account.accountId;
    const patch: CustomerAccountMutationRequest = { operation: "account.revise", expectedRevision: 1, name: "Revised" };
    await submit(f, "revise", patch, id);
    await expect(submit(f, "create", create, undefined, otherActor)).rejects.toBeInstanceOf(CustomerAccountConflictError);
    await expect(submit(f, "revise", patch, id, otherActor)).rejects.toBeInstanceOf(CustomerAccountNotFoundError);
    expect(await count(f, id)).toEqual({ revisions: 2, events: 2 });
  });
  test("reader, wrong workspace, wrong tenant and wrong purpose cannot obtain accepted evidence", async () => {
    const f = await fixture("scope"), other = await fixture("foreign"), initial = await submit(f), id = initial.account.accountId;
    const patch: CustomerAccountMutationRequest = { operation: "account.revise", expectedRevision: 1, name: "Revised" };
    await submit(f, "revise", patch, id);
    await expect(submit(f, "revise", patch, id, readerActor)).rejects.toBeInstanceOf(CustomerAccountConflictError);
    await expect(submit({ ...f, workspaceId: other.workspaceId }, "revise", patch, id)).rejects.toBeInstanceOf(CustomerAccountConflictError);
    await expect(submit(other, "revise", patch, id)).rejects.toBeInstanceOf(CustomerAccountNotFoundError);
    const invalid = { ...authority(f), purposeId: "customer_success.account.read" } as unknown as CustomerAccountMutationAuthority;
    await expect(serving(invalid, () => submitCustomerAccountMutation({ authority: invalid, request: create }))).rejects.toThrow(/authority/);
    expect(await count(f, id)).toEqual({ revisions: 2, events: 2 });
  });
  test("current workspace archival and membership revocation prevent accepted replay", async () => {
    const archived = await fixture("archived"), revoked = await fixture("revoked");
    await submit(archived); await submit(revoked);
    await admin`UPDATE omni_tenant_workspaces SET state='archived',lifecycle_revision=lifecycle_revision+1,archived_by_actor_id=${actor},archived_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${archived.tenantId}`;
    await admin`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${revoked.tenantId} AND subject_actor_id=${actor}`;
    await expect(submit(archived)).rejects.toBeInstanceOf(CustomerAccountConflictError);
    await expect(submit(revoked)).rejects.toBeInstanceOf(CustomerAccountConflictError);
  });
  test("legacy NULL intents remain readable but cannot be promoted to exact accepted replay", async () => {
    const f = await fixture("legacy"), a = authority(f), id = customerAccountId({ ...f, idempotencyKey: "create" });
    const legacy = await serving(a, () => saveCustomerAccount({ authority: a, accountId: id, mutationId: customerMutationId({ accountId: id, idempotencyKey: "create", operation: "account.create" }), name: "Acme", lifecycle: "active", organizationEntityId: null, accountOwner: owner, crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: [...purposes] } }));
    const read = await serving(a, () => getCustomerAccount360({ ...a, purposeId: "customer_success.account.read" }, id));
    expect(read?.account).toEqual(legacy);
    await expect(submit(f)).rejects.toBeInstanceOf(CustomerAccountConflictError);
    expect(await count(f, id)).toEqual({ revisions: 1, events: 1 });
  });
  test("concurrent exact duplicates use two serving sessions and append once", async () => {
    const f = await fixture("concurrent-same"), a = authority(f), b = barrier();
    const results = await Promise.all([1, 2].map(() => serving(a, () => submitCustomerAccountMutation({ authority: a, request: create }), b.ready)));
    expect(b.pids.size).toBe(2);
    expect(results[0]).toEqual(results[1]);
    expect(await count(f, results[0].account.accountId)).toEqual({ revisions: 1, events: 1 });
  }, 30_000);
  test("concurrent same-key drift admits only one immutable decision", async () => {
    const f = await fixture("concurrent-drift"), a = authority(f), b = barrier();
    const outcomes = await Promise.allSettled(["One", "Two"].map((name) => serving(a, () => submitCustomerAccountMutation({ authority: a, request: { ...create, name } }), b.ready)));
    expect(b.pids.size).toBe(2);
    const success = outcomes.filter((value) => value.status === "fulfilled"), rejected = outcomes.filter((value) => value.status === "rejected");
    expect(success).toHaveLength(1); expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CustomerAccountConflictError);
    expect(await count(f, success[0].value.account.accountId)).toEqual({ revisions: 1, events: 1 });
  }, 30_000);
  test("different concurrent keys still require one current CAS winner", async () => {
    const f = await fixture("concurrent-cas"), initial = await submit(f), b = barrier(), id = initial.account.accountId;
    const outcomes = await Promise.allSettled(["one", "two"].map((key) => {
      const a = authority(f, key);
      return serving(a, () => submitCustomerAccountMutation({ authority: a, accountId: id, request: { operation: "account.revise", expectedRevision: 1, name: key } }), b.ready);
    }));
    expect(b.pids.size).toBe(2);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((value) => value.status === "rejected");
    expect(failure?.reason).toBeInstanceOf(CustomerAccountConflictError);
    expect(await count(f, id)).toEqual({ revisions: 2, events: 2 });
  }, 30_000);
  test("event failure rolls back intent, revision and projection before an explicit identical new attempt", async () => {
    const f = await fixture("rollback"), id = customerAccountId({ ...f, idempotencyKey: "create" });
    // Sequence advancement survives rollback and witnesses the exact injected
    // failure. The joined client must retain that first diagnostic even when
    // its final scope restoration also sees PostgreSQL's aborted transaction.
    // This is a disposable fixture witness, never a production application effect.
    await admin`CREATE SEQUENCE public.account_intent_fixture_event_witness`;
    await admin`GRANT USAGE,SELECT ON SEQUENCE public.account_intent_fixture_event_witness TO omni_runtime`;
    await admin`CREATE FUNCTION public.account_intent_fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = 'account-intent-rollback' THEN PERFORM nextval('public.account_intent_fixture_event_witness'); RAISE EXCEPTION 'fixture event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER account_intent_fixture_event_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION public.account_intent_fixture_event_failure()`;
    try {
      await expect(submit(f)).rejects.toMatchObject({ code: "P0001", message: "fixture event failure" });
      await serving(authority(f), async (sql) => {
        const witness = await sql`SELECT last_value,is_called FROM public.account_intent_fixture_event_witness`;
        expect(Number(witness[0].last_value)).toBe(1);
        expect(witness[0].is_called).toBe(true);
      });
      expect(await count(f, id)).toEqual({ revisions: 0, events: 0 });
    } finally { await admin`DROP TRIGGER account_intent_fixture_event_failure ON omni_events`; await admin`DROP FUNCTION public.account_intent_fixture_event_failure()`; await admin`DROP SEQUENCE public.account_intent_fixture_event_witness`; }
    const accepted = await submit(f);
    expect(accepted.account.revision).toBe(1);
    expect(await count(f, id)).toEqual({ revisions: 1, events: 1 });
  });
  test("the database rejects unpaired intent columns and immutable evidence rewrites", async () => {
    const f = await fixture("immutable"), accepted = await submit(f), a = authority(f);
    await expect(serving(a, (sql) => sql`UPDATE omni_customer_account_revisions SET request_sha256=${"f".repeat(64)} WHERE tenant_id=${f.tenantId} AND account_id=${accepted.account.accountId}`, undefined, false)).rejects.toMatchObject({ code: "42501" });
    const intent = buildCustomerAccountMutationIntent({ ...a, idempotencyKey: "invalid-pair", request: create });
    const snapshot = { ...accepted.account, accountId: intent.accountId, mutationId: intent.mutationId, revisionId: `${intent.accountId}:v1` };
    await expect(serving(a, (sql) => sql`INSERT INTO omni_customer_account_revisions(tenant_id,workspace_id,account_id,revision_id,revision,mutation_id,owner_actor_id,allowed_purpose_ids,account_sha256,account_snapshot,revised_at,request_intent,request_sha256)
      VALUES (${f.tenantId},${f.workspaceId},${snapshot.accountId},${snapshot.revisionId},1,${snapshot.mutationId},${actor},${[...purposes]},${snapshot.accountSha256},${snapshot}::JSONB,${snapshot.revisedAt},${intent}::JSONB,NULL)`, undefined, false)).rejects.toMatchObject({ code: "23514", constraint_name: "omni_customer_account_exact_intent" });
    expect(await count(f, accepted.account.accountId)).toEqual({ revisions: 1, events: 1 });
    expect(await count(f, snapshot.accountId)).toEqual({ revisions: 0, events: 0 });
    expect(await submit(f)).toEqual(accepted);
  });
});
