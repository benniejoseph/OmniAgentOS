import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { readNativeConnectorAction, reviewNativeConnector, submitNativeConnectorAction } from "@/lib/connectors/native-control-store";
import { type ConnectorNativeRequest, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "connector-owner@example.test", other = "connector-other@example.test", canonical = `actor:${user}`, roleName = "connector_native_test_runtime";
integration("native connector controls under forced serving RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    // Legacy serving provisioning only; new receipt/helper grants come from237.
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools,omni_openapi_connectors,omni_openapi_operations TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${roleName}`); await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture'),(${otherUser},${other},'fixture')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex")); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("connector-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_connector_actions') AS active,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS registry_read,
      has_function_privilege(current_user,'public.omni_native_connector_actor_v1(text,text,text,boolean)','EXECUTE') AS identity_check
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, active: true, registry_read: false, identity_check: true });
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); } await admin.end(); } });
  async function fixture(tag: string, kind: "mcp" | "openapi" = "mcp") {
    const scope: ConnectorNativeScope = { tenantId: `connector-native-${tag}`, ownerActorId: owner, canonicalActorId: canonical }, id = `connector-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const who of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${who}`},${scope.tenantId},${who},'admin')`;
    if (kind === "mcp") {
      await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,transport,auth_type,status,tool_count,last_discovered_at)
        VALUES(${id},${scope.tenantId},'Reviewed connector','https://example.test/mcp?credential=private-fixture','streamable_http','none','disabled',1,clock_timestamp())`;
      await admin`INSERT INTO omni_mcp_tools(id,tenant_id,connector_id,connector_name,name,input_schema,status)
        VALUES(${`${id}:tool`},${scope.tenantId},${id},'Reviewed connector','read_notes',${admin.json({ type: "object", properties: {} })},'pending_review')`;
    } else {
      await admin`INSERT INTO omni_openapi_connectors(id,tenant_id,name,base_url,auth_type,status,operation_count,last_imported_at)
        VALUES(${id},${scope.tenantId},'Reviewed API','https://example.test/api','none','disabled',1,clock_timestamp())`;
      await admin`INSERT INTO omni_openapi_operations(id,tenant_id,connector_id,connector_name,operation_id,method,path,input_schema,status)
        VALUES(${`${id}:operation`},${scope.tenantId},${id},'Reviewed API','readNotes','GET','/notes',${admin.json({ type: "object", properties: {} })},'pending_review')`;
    }
    const review = await reviewNativeConnector({ scope }, kind, id); expect(review?.pin).not.toBeNull();
    const request: ConnectorNativeRequest = { contract: "asael-connector-action:1", kind, connectorId: id, action: "review_contracts", review: review!.pin! };
    return { scope, id, request, review: review! };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function submit(f: Fixture, key = "one", request = f.request) {
    return submitNativeConnectorAction({ authority: { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId,
      initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner, correlationId: key, causationId: f.id, purpose: "api.connectors.native.action" }) }, request, idempotencyKey: key });
  }
  const count = async (f: Fixture) => (await admin`SELECT
    (SELECT count(*)::INTEGER FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}) AS receipts,
    (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${f.scope.tenantId} AND type LIKE 'connector.native.%') AS events`)[0];
  test("same-key overlap promotes once, exact replay survives later state and changed intent conflicts", async () => {
    const f = await fixture("replay"), pair = await Promise.all([submit(f), submit(f)]);
    expect(pair.map((r) => r.replayed).sort()).toEqual([false, true]); expect(pair[0].action).toEqual(pair[1].action);
    expect(pair[0].action.settlement?.result).toMatchObject({ promotedCount: 1, status: "active" }); expect(await count(f)).toEqual({ receipts: 1, events: 2 });
    await expect(submit(f, "one", { ...f.request, action: "disable" })).rejects.toMatchObject({ status: 409 });
    await admin`UPDATE omni_mcp_connectors SET status='disabled' WHERE id=${f.id}`;
    expect(await submit(f)).toEqual({ action: pair[0].action, replayed: true }); expect(await count(f)).toEqual({ receipts: 1, events: 2 });
    expect(await readNativeConnectorAction({ scope: f.scope }, pair[0].action.acceptance.keySha256)).toEqual(pair[0].action);
  });
  test("hidden endpoint changes invalidate the exact review without exposing secrets", async () => {
    const f = await fixture("stale");
    expect(f.review.connector.endpointRedacted).toBe(true); expect(JSON.stringify(f.review)).not.toContain("private-fixture");
    await admin`UPDATE omni_mcp_connectors SET endpoint='https://example.test/mcp?credential=replaced-fixture' WHERE id=${f.id}`;
    await expect(submit(f)).rejects.toMatchObject({ status: 409 }); expect(await count(f)).toEqual({ receipts: 0, events: 0 });
  });
  test("event failure rolls back both connector promotion and receipt; OpenAPI promotion uses the same atomic seam", async () => {
    const f = await fixture("rollback", "openapi");
    await admin`CREATE FUNCTION connector_native_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id='connector-native-rollback' AND NEW.type='connector.native.action.settled' THEN RAISE EXCEPTION 'fixture connector settlement failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER connector_native_fixture_fail BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION connector_native_fixture_fail()`;
    try { await expect(submit(f)).rejects.toMatchObject({ code: "P0001" }); expect(await count(f)).toEqual({ receipts: 0, events: 0 });
      expect((await admin`SELECT status FROM omni_openapi_operations WHERE connector_id=${f.id}`)[0].status).toBe("pending_review"); }
    finally { await admin`DROP TRIGGER connector_native_fixture_fail ON omni_events`; await admin`DROP FUNCTION connector_native_fixture_fail()`; }
    expect((await submit(f)).action.settlement?.result).toMatchObject({ promotedCount: 1, status: "active" });
  });
  test("receipt reads remain exact-owner after management loss and connector deletion; operators cannot manage", async () => {
    const f = await fixture("owner"), accepted = await submit(f), key = accepted.action.acceptance.keySha256;
    expect(await readNativeConnectorAction({ scope: { ...f.scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` } }, key)).toBeNull();
    expect(await runWithDatabaseTenantScope(f.scope.tenantId, () => getSql()`SELECT id FROM omni_native_connector_actions`)).toEqual([]);
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(submit(f)).rejects.toMatchObject({ status: 403 });
    await admin`DELETE FROM omni_mcp_connectors WHERE id=${f.id}`;
    expect(await readNativeConnectorAction({ scope: f.scope }, key)).toEqual(accepted.action);
    await expect(runWithDatabaseActorScope(f.scope.tenantId, [owner], () => getSql()`DELETE FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}`)).rejects.toMatchObject({ code: "42501" });
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(readNativeConnectorAction({ scope: f.scope }, key)).rejects.toMatchObject({ status: 403 });
  });
});
