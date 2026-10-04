import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { sealOAuthTokens } from "@/lib/connectors/oauth-token-vault";
import { bindSalesforceConnection } from "@/lib/customer-success/salesforce-store";
import { admitSalesforceNativeAction, mayRevokeSalesforceNativeProviderToken, readSalesforceNativeAction, reviewSalesforceNativeActions,
  salesforceNativeSyncExecution, settleSalesforceNativeAction, type SalesforceNativeAuthority } from "@/lib/customer-success/salesforce-native-store";
import { type SalesforceNativeRequest } from "@/lib/customer-success/salesforce-native-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", actor = `actor:${user}`, otherUser = "22222222-2222-4222-8222-222222222222", other = `actor:${otherUser}`;
const roleName = "salesforce_native_test_runtime";
integration("native Salesforce action admission under serving role", () => {
  let admin: ReturnType<typeof postgres>, createdRole = false;
  beforeAll(async () => {
    await closeDatabaseClient(); admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); createdRole = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    // Legacy serving grants only. The new action table uses migration232 ACLs.
    await admin.unsafe(`GRANT SELECT ON public.omni_schema_version,public.omni_auth_users,public.omni_auth_tenants,public.omni_auth_memberships,public.omni_agent_runs,public.omni_tool_executions,public.omni_tenant_workspaces,public.omni_tenant_workspace_memberships TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON public.omni_oauth_grants TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON public.omni_events TO ${roleName}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE public.omni_events_seq_seq TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},'sf-native@example.test','fixture'),(${otherUser},'sf-other@example.test','fixture')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({ activeKeyId: "test", keys: { test: randomBytes(32).toString("base64url") } }));
    await ensureDatabaseSchema();
    const [role] = await runWithDatabaseActorScope("sf-proof", [actor], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_salesforce_native_actions') AS active FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, active: true });
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) { if (createdRole) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); } await admin.end(); } });
  async function fixture(tag: string, action: SalesforceNativeRequest["action"] = "sync") {
    const scope = { tenantId: `sf-native-${tag}`, workspaceId: `workspace:sf-native-${tag}`, ownerActorId: actor }, grantId = randomUUID();
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const id of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${id}`},${scope.tenantId},${id},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES(${scope.tenantId},${scope.workspaceId},${tag},${actor},'active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    for (const owner of [actor, other]) await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES(${scope.tenantId},${scope.workspaceId},'user',${owner},${owner},1,'manager','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const tokens = { access_token: "fixture-access", refresh_token: "fixture-old-token", instance_url: "https://tenant.my.salesforce.com", id: "https://login.salesforce.com/id/00D000000000001/005000000000001" };
    const sealed = sealOAuthTokens(tokens, `oauth-grant:${scope.tenantId}:${actor}:salesforce:${grantId}`);
    await admin`INSERT INTO omni_oauth_grants(id,tenant_id,actor_id,provider,scopes,sealed_tokens,authorization_generation)
      VALUES(${grantId},${scope.tenantId},${actor},'salesforce',${["api", "refresh_token"]},${admin.json({ ...sealed })},3)`;
    const base = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, canonicalActorId: actor, readableActorIds: [actor] };
    const connection = await bindSalesforceConnection({ authority: { ...base, executionScope: createExecutionScope({ ...base, initiatingActorId: actor,
      executingPrincipalType: "user", executingPrincipalId: actor, correlationId: tag, purpose: "customer.salesforce.read_sync" }) }, oauthGrantId: grantId, authorizationGeneration: 3, tokens });
    const authority: SalesforceNativeAuthority = { scope, executionScope: createExecutionScope({ tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      initiatingActorId: actor, executingPrincipalType: "user", executingPrincipalId: actor, correlationId: tag, causationId: connection.connectionId, purpose: "customer.salesforce.native_action" }) };
    const reviewed = await reviewSalesforceNativeActions({ scope }, true);
    expect(reviewed.current.connection).not.toBeNull();
    const request: SalesforceNativeRequest = { contract: "customer-salesforce-action-request:1", workspaceId: scope.workspaceId, action, review: reviewed.current.connection! };
    return { authority, request, grantId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const admit = (f: Fixture, key = "one", request = f.request) => admitSalesforceNativeAction({ authority: f.authority, request, idempotencyKey: key });
  const read = (f: Fixture, key = "one", ownerActorId = actor) => readSalesforceNativeAction({ scope: { ...f.authority.scope, ownerActorId } },
    idempotencyKeySha256({ tenantId: f.authority.scope.tenantId, idempotencyKey: key }), false);
  const count = async (f: Fixture) => Number((await admin`SELECT count(*) AS count FROM omni_salesforce_native_actions WHERE tenant_id=${f.authority.scope.tenantId}`)[0].count);

  test("one concurrent admission, exact replay and unresolved competing key fence", async () => {
    const f = await fixture("admission"), pair = await Promise.all([admit(f), admit(f)]);
    expect(pair.map((value) => value.newlyAccepted).sort()).toEqual([false, true]); expect(pair[0].action).toEqual(pair[1].action); expect(await count(f)).toBe(1);
    await expect(admit(f, "one", { ...f.request, action: "reconcile" })).rejects.toThrow("another exact intent");
    await expect(admit(f, "two")).rejects.toThrow("unresolved");
    expect((await read(f)).action).toEqual(pair[0].action); expect((await read(f, "absent")).action).toBeNull(); expect((await read(f, "one", other)).action).toBeNull();
    await expect(runWithDatabaseActorScope(f.authority.scope.tenantId, [actor], () => getSql()`UPDATE omni_salesforce_native_actions SET acceptance='{}'::JSONB WHERE tenant_id=${f.authority.scope.tenantId}`)).rejects.toThrow();
  });

  test("new generation is refused and an accepted native effect cannot commit after grant revocation", async () => {
    const f = await fixture("generation"), accepted = await admit(f);
    const execution = salesforceNativeSyncExecution(f.authority, accepted.intent, accepted.claim!);
    await execution.beforeProvider();
    await admin`UPDATE omni_oauth_grants SET status='revoked',authorization_generation=authorization_generation+1,updated_at=clock_timestamp() WHERE id=${f.grantId}`;
    let called = false;
    await expect(execution.commit(async () => { called = true; })).rejects.toThrow("changed"); expect(called).toBe(false);
    expect((await admit(f)).newlyAccepted).toBe(false); expect((await read(f)).action).toEqual(accepted.action);
    const stale = await fixture("stale");
    await admin`UPDATE omni_oauth_grants SET authorization_generation=authorization_generation+1,updated_at=clock_timestamp() WHERE id=${stale.grantId}`;
    await expect(admit(stale)).rejects.toThrow("changed"); expect(await count(stale)).toBe(0);
  });

  test("disconnect admission and event roll back grant and connection together; settled receipt survives reader recovery", async () => {
    const f = await fixture("rollback", "disconnect");
    await admin`CREATE FUNCTION public.sf_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='sf-native-rollback' AND NEW.type='customer.salesforce.native.accepted' THEN RAISE EXCEPTION 'fixture disconnect event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER sf_fixture_fail BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION public.sf_fixture_fail()`;
    try { await expect(admit(f)).rejects.toThrow("fixture disconnect event failure"); expect(await count(f)).toBe(0);
      expect((await admin`SELECT status,authorization_generation::INTEGER AS authorization_generation FROM omni_oauth_grants WHERE id=${f.grantId}`)[0]).toMatchObject({ status: "active", authorization_generation: 3 }); }
    finally { await admin`DROP TRIGGER sf_fixture_fail ON omni_events`; await admin`DROP FUNCTION public.sf_fixture_fail()`; }
    const accepted = await admit(f); expect(accepted.action.acceptance.localRevoked).toBe(true); expect(accepted.providerToken).toBe("fixture-old-token");
    expect((await admin`SELECT status,authorization_generation::INTEGER AS authorization_generation FROM omni_oauth_grants WHERE id=${f.grantId}`)[0]).toMatchObject({ status: "revoked", authorization_generation: 4 });
    expect(await mayRevokeSalesforceNativeProviderToken(f.authority, accepted.intent)).toBe(true);
    const settlement = { action: "disconnect" as const, status: "local_revoked" as const, providerRevocation: "unconfirmed" as const, settledAt: new Date().toISOString() };
    const settled = await settleSalesforceNativeAction(f.authority, accepted.intent, settlement);
    expect(await settleSalesforceNativeAction(f.authority, accepted.intent, settlement)).toEqual(settled);
    await expect(settleSalesforceNativeAction(f.authority, accepted.intent, { ...settlement, providerRevocation: "revoked" })).rejects.toThrow("settled differently");
    await admin`UPDATE omni_tenant_workspace_memberships SET state='revoked',lifecycle_revision=lifecycle_revision+1,revoked_by_actor_id=${actor},revoked_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=${f.authority.scope.tenantId} AND subject_actor_id=${actor}`;
    await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES(${f.authority.scope.tenantId},${f.authority.scope.workspaceId},'user',${actor},${actor},2,'reader','active',1,${actor},${actor},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    expect((await read(f)).action).toEqual(settled); expect((await read(f)).current.availableActions).toEqual([]);
    expect((await admit(f)).providerToken).toBeNull();
  });
});
