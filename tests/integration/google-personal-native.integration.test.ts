import { randomBytes,randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll,beforeAll,describe,expect,test,vi } from "vitest";
import { closeDatabaseClient,ensureDatabaseSchema,getSql,runWithDatabaseActorScope,runWithDatabaseTenantScope } from "@/lib/db/client";
import { admitGooglePersonalNativeAction,googlePersonalNativeSyncExecution,readGooglePersonalNativeAction,reviewGooglePersonalNativeActions,
  settleGooglePersonalNativeAction,type GooglePersonalNativeAuthority } from "@/lib/connectors/google-personal-native-store";
import { sealGooglePersonalNativeReview } from "@/lib/connectors/google-personal-native-contracts";
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE,GOOGLE_GMAIL_READ_SCOPE } from "@/lib/connectors/google-workspace-capabilities";
import { claimOAuthSyncLease } from "@/lib/connectors/oauth-store";
import { openOAuthTokens,sealOAuthTokens } from "@/lib/connectors/oauth-token-vault";
import { createExecutionScope } from "@/lib/security/execution-scope";
const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const role = "google_personal_native_test_runtime",user = "11111111-1111-4111-8111-111111111111",owner = "google-owner@example.test",canonical = `actor:${user}`;
// Disposable database only. Real serving-role admission/projection graphs,
// synthetic encrypted tokens, and no provider calls.
integration("native Google current-owner admission and exact recovery",() => {
  let admin: ReturnType<typeof postgres>,roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient(); admin = postgres(databaseUrl!,{ max: 3,prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require",onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_agent_runs,omni_tool_executions TO ${role}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_oauth_grants TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${role}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture-only')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL",url.toString()); vi.stubEnv("NODE_ENV","production"); vi.stubEnv("VERCEL",""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX","2");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET",randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING",JSON.stringify({ activeKeyId: "test",keys: { test: randomBytes(32).toString("base64url") } }));
    await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("google-proof",[owner,canonical],() => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_google_personal_native_actions') AS receipt_rls,
      has_table_privilege(current_user,'omni_auth_user_actor_identifiers','SELECT') AS private_registry_read FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role,rolsuper: false,rolbypassrls: false,receipt_rls: true,private_registry_read: false });
  },180_000);
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) {
    if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); } await admin.end(); } });
  async function seed(tag: string,action: "sync"|"disconnect" = "sync") {
    const tenantId = `google-${tag}`,connectionId = randomUUID(),scope = { tenantId,ownerActorId: owner,canonicalActorId: canonical };
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tenantId}:member`},${tenantId},${user},'operator')`;
    const binding = `oauth-grant:${tenantId}:${owner}:google:${connectionId}`,tokens = sealOAuthTokens({ refresh_token: `synthetic-old-${tag}` },binding);
    await admin`INSERT INTO omni_oauth_grants(id,tenant_id,actor_id,provider,account_email,connection_purpose,scopes,sealed_tokens,authorization_generation)
      VALUES(${connectionId},${tenantId},${owner},'google',${owner},'personal',${[GOOGLE_GMAIL_READ_SCOPE,GOOGLE_CALENDAR_EVENTS_READ_SCOPE]},${admin.json({ ...tokens })}::JSONB,3)`;
    const readAuthority = { scope,accountEmail: owner },view = await reviewGooglePersonalNativeActions(readAuthority,true);
    if (!view.current.connection) throw new Error("Missing fixture connection review.");
    const authority: GooglePersonalNativeAuthority = { ...readAuthority,executionScope: createExecutionScope({ tenantId,initiatingActorId: owner,
      executingPrincipalType: "user",executingPrincipalId: owner,correlationId: tag,causationId: connectionId,purpose: "connector.google.personal.native_action" }) };
    return { authority,readAuthority,request: { contract: "asael-google-personal-action:1" as const,action,review: view.current.connection },binding,connectionId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const admit = (f: Fixture,key = "once") => admitGooglePersonalNativeAction({ authority: f.authority,request: f.request,idempotencyKey: key });
  const owned = <T>(f: Fixture,work: () => Promise<T>) => runWithDatabaseActorScope(f.authority.scope.tenantId,[owner,canonical],work);
  const eventCount = async (f: Fixture) => Number((await admin`SELECT count(*) AS count FROM omni_events WHERE tenant_id=${f.authority.scope.tenantId} AND type LIKE 'google.personal.native.%'`)[0].count);
  test("co-commits the lease and receipt; unknown work survives expiry and hidden membership",async () => {
    const f = await seed("held"),first = await admit(f),replay = await admit(f);
    expect(first.newlyAccepted).toBe(true); expect(first.lease).toBeTruthy();
    expect(replay).toMatchObject({ newlyAccepted: false,action: first.action,lease: null,providerToken: null });
    if (!first.lease) throw new Error("Expected exact accepted lease.");
    const execution = googlePersonalNativeSyncExecution(f.authority,first.intent,first.lease);
    await expect(execution.commit(async () => { await getSql()`UPDATE omni_oauth_grants SET sync_error='must-rollback' WHERE id=${f.connectionId}`; throw new Error("projection stopped"); })).rejects.toThrow("projection stopped");
    expect((await admin`SELECT sync_error FROM omni_oauth_grants WHERE id=${f.connectionId}`)[0].sync_error).toBeNull();
    await admin`UPDATE omni_oauth_grants SET sync_lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=${f.connectionId}`;
    await expect(admit(f,"new-key")).rejects.toMatchObject({ status: 409 });
    const legacyClaim = () => owned(f,() => claimOAuthSyncLease({ tenantId: f.authority.scope.tenantId,actorId: owner,provider: "google",connectionId: f.connectionId }));
    expect(await legacyClaim()).toEqual({ status: "busy" });
    expect((await readGooglePersonalNativeAction(f.readAuthority,first.intent.idempotencyKeySha256,true)).action).toEqual(first.action);
    await admin`UPDATE omni_auth_memberships SET status='inactive' WHERE tenant_id=${f.authority.scope.tenantId} AND user_id=${user}`;
    expect(await owned(f,() => getSql()`SELECT id FROM omni_google_personal_native_actions WHERE tenant_id=${f.authority.scope.tenantId}`)).toEqual([]);
    expect(await legacyClaim()).toEqual({ status: "busy" });
    await expect(readGooglePersonalNativeAction(f.readAuthority,first.intent.idempotencyKeySha256,false)).rejects.toMatchObject({ status: 403 });
    expect(await eventCount(f)).toBe(1);
  });
  test("revokes local credentials atomically, settles once, and never reopens a token on replay",async () => {
    const f = await seed("disconnect","disconnect"),first = await admit(f);
    expect(first.providerToken).toBe("synthetic-old-disconnect"); expect(first.action.acceptance.localRevoked).toBe(true);
    const [grant] = await admin`SELECT status,authorization_generation,sealed_tokens,sync_cursor,sync_lease_owner_id FROM omni_oauth_grants WHERE id=${f.connectionId}`;
    expect(grant).toMatchObject({ status: "revoked",authorization_generation: "4",sync_cursor: null,sync_lease_owner_id: null });
    expect(openOAuthTokens(grant.sealed_tokens,f.binding).tokens).toEqual({});
    const settled = await settleGooglePersonalNativeAction(f.authority,first.intent,{ action: "disconnect",status: "local_revoked",providerRevocation: "unconfirmed",settledAt: new Date().toISOString() });
    expect((await admit(f)).action).toEqual(settled); expect((await admit(f)).providerToken).toBeNull(); expect(await eventCount(f)).toBe(2);
    expect((await readGooglePersonalNativeAction(f.readAuthority,first.intent.idempotencyKeySha256,false)).action).toEqual(settled);
    for (const actor of ["another-owner",null]) {
      const query = () => getSql()`SELECT id FROM omni_google_personal_native_actions WHERE tenant_id=${f.authority.scope.tenantId}`;
      expect(await (actor ? runWithDatabaseActorScope(f.authority.scope.tenantId,[actor],query) : runWithDatabaseTenantScope(f.authority.scope.tenantId,query))).toEqual([]);
    }
  });
  test("rolls back both lease and revocation when the acceptance event cannot commit",async () => {
    await admin.unsafe(`CREATE FUNCTION reject_google_native_fixture_event() RETURNS TRIGGER LANGUAGE plpgsql AS $f$ BEGIN
      IF NEW.tenant_id LIKE 'google-rollback-%' AND NEW.type='google.personal.native.accepted' THEN RAISE EXCEPTION 'fixture event rejected'; END IF; RETURN NEW; END $f$`);
    await admin.unsafe(`CREATE TRIGGER reject_google_native_fixture_event BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION reject_google_native_fixture_event()`);
    try {
      for (const action of ["sync","disconnect"] as const) {
        const f = await seed(`rollback-${action}`,action);
        await expect(admit(f)).rejects.toThrow("fixture event rejected");
        const [grant] = await admin`SELECT status,authorization_generation,sync_lease_owner_id,sealed_tokens FROM omni_oauth_grants WHERE id=${f.connectionId}`;
        expect(grant).toMatchObject({ status: "active",authorization_generation: "3",sync_lease_owner_id: null });
        expect(openOAuthTokens(grant.sealed_tokens,f.binding).tokens.refresh_token).toBe(`synthetic-old-rollback-${action}`);
        expect((await reviewGooglePersonalNativeActions(f.readAuthority,true)).current.blockedAction).toBeNull(); expect(await eventCount(f)).toBe(0);
      }
    } finally { await admin.unsafe(`DROP TRIGGER reject_google_native_fixture_event ON omni_events`); await admin.unsafe(`DROP FUNCTION reject_google_native_fixture_event()`); }
  });
  test("rejects changed exact source scope and immutable key collisions before another admission",async () => {
    const f = await seed("pins");
    await admin`UPDATE omni_oauth_grants SET scopes=${[GOOGLE_CALENDAR_EVENTS_READ_SCOPE]} WHERE id=${f.connectionId}`;
    await expect(admit(f)).rejects.toMatchObject({ status: 409 }); expect(await eventCount(f)).toBe(0);
    const view = await reviewGooglePersonalNativeActions(f.readAuthority,true); if (!view.current.connection) throw new Error("Missing current review.");
    const changed = { ...f,request: { ...f.request,review: view.current.connection } },first = await admit(changed);
    const { review: pin } = changed.request;
    const body = { connectionId: pin.connectionId,accountEmail: pin.accountEmail,authorizationGeneration: pin.authorizationGeneration,
      status: pin.status,sourceScopeSha256: pin.sourceScopeSha256,permittedSources: pin.permittedSources };
    await expect(admit({ ...changed,request: { ...changed.request,review: sealGooglePersonalNativeReview({ ...body,authorizationGeneration: 4 }) } })).rejects.toMatchObject({ status: 409 });
    expect((await readGooglePersonalNativeAction(f.readAuthority,first.intent.idempotencyKeySha256,true)).action).toEqual(first.action); expect(await eventCount(f)).toBe(1);
  });
});
