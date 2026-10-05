import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import { readNativeConnectorAction, reviewNativeConnector, submitNativeConnectorAction } from "@/lib/connectors/native-control-store";
import { connectorNativeActionSchema, sealConnectorNativePin, type ConnectorNativeRequest, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { readNativeConnectorCredentialRemoval, submitNativeConnectorCredentialRemoval } from "@/lib/connectors/native-credential-removal-store";
import { buildConnectorNativeCredentialRemovalIntent, canRemoveNativeConnectorCredential, type ConnectorNativeCredentialRemovalRequest } from "@/lib/connectors/native-credential-removal-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { removeNativeConnectorCredentialRemovalsForReplay, removeNativeConnectorTrashForReplay, removeNativeConnectorCredentialRotationsForReplay, removeNativeMcpRegistrationsForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "removal-owner@example.test", other = "removal-other@example.test", canonical = `actor:${user}`;
const roleName = "connector_removal_test_runtime";
integration("native credential removal under forced serving RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    // Legacy serving grants only. Receipt, owner predicate and v2 function grants come from237/238.
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools,omni_openapi_connectors,omni_openapi_operations TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${roleName}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture'),(${otherUser},${other},'fixture')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex")); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("removal-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_connector_actions') AS active,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS registry_read,
      has_function_privilege(current_user,'public.omni_native_connector_intent_valid_v2(jsonb,jsonb)','EXECUTE') AS intent_check,
      has_function_privilege(current_user,'public.omni_native_connector_settlement_valid_v2(jsonb,jsonb)','EXECUTE') AS settlement_check
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, active: true, registry_read: false, intent_check: true, settlement_check: true });
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); } await admin.end(); } });

  async function fixture(tag: string) {
    const scope: ConnectorNativeScope = { tenantId: `connector-removal-${tag}`, ownerActorId: owner, canonicalActorId: canonical }, id = `removal-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const who of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${who}`},${scope.tenantId},${who},'admin')`;
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,transport,auth_type,status,tool_count,last_discovered_at,
      credential_version,credential_key_id,credential_fingerprint,credential_origin,sealed_credential,capabilities,instructions,server_version,last_error)
      VALUES(${id},${scope.tenantId},'Saved credential fixture','https://example.test/mcp?credential=private-endpoint-fixture','streamable_http','bearer_vault','active',1,clock_timestamp(),
        2,'fixture-key','000000000000','https://example.test',${admin.json({ encrypted: "opaque-never-decrypt-fixture" })},${admin.json({ tools: {} })},'discovered instructions',${admin.json({ name: "fixture", version: "1" })},'old discovery error')`;
    await admin`INSERT INTO omni_mcp_tools(id,tenant_id,connector_id,connector_name,name,input_schema,status)
      VALUES(${`${id}:tool`},${scope.tenantId},${id},'Saved credential fixture','read_notes',${admin.json({ type: "object", properties: {} })},'active')`;
    const review = await reviewNativeConnector({ scope }, "mcp", id);
    expect(review?.pin).not.toBeNull(); expect(canRemoveNativeConnectorCredential(review!)).toBe(true);
    const request: ConnectorNativeCredentialRemovalRequest = { contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: id,
      action: "remove_credential", review: review!.pin!, preview: null };
    return { scope, id, request };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function authority(f: Fixture, key = "one") {
    return { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId,
      initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner,
      correlationId: key, causationId: f.id, purpose: "api.connectors.native.action" }) };
  }
  function submit(f: Fixture, key = "one", request = f.request) {
    return submitNativeConnectorCredentialRemoval({ authority: authority(f, key), request, idempotencyKey: key });
  }
  function stateRequest(f: Fixture): ConnectorNativeRequest {
    return { contract: "asael-connector-action:1", kind: "mcp", connectorId: f.id, action: "disable", review: f.request.review };
  }
  const counts = async (f: Fixture) => (await admin`SELECT
    (SELECT count(*)::INTEGER FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}) AS receipts,
    (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${f.scope.tenantId}) AS events,
    (SELECT count(*)::INTEGER FROM omni_mcp_tools WHERE tenant_id=${f.scope.tenantId}) AS tools`)[0];
  const snapshot = async (f: Fixture) => (await admin`SELECT status,credential_version,credential_key_id,credential_fingerprint,credential_origin,sealed_credential,
    tool_count,capabilities,instructions,server_version,last_discovered_at,last_error,updated_at FROM omni_mcp_connectors WHERE tenant_id=${f.scope.tenantId} AND id=${f.id}`)[0];

  test("238 replays over237 with the original v1 receipt and owner protections retained", async () => {
    const f = await fixture("migration"), legacy = await submitNativeConnectorAction({ authority: authority(f), request: stateRequest(f), idempotencyKey: "legacy" });
    const before = (await admin`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}`)[0];
    const checksum = "9b77ab90dd862d16a4cb1c670fa11f41436e58cfc8e7273c3e50e95725906ebe";
    const row = { version: 238, name: "native_connector_credential_removals_v1", checksum };
    const migration = await readSqlMigrationFile({ file: "20261005190000_native_connector_credential_removals.sql", sha256: checksum, migrations: [row] });
    const next = { version: 239, name: "native_connector_trash_v1", checksum: "6af2db420131c4c68b3279b4030f161d72c85b2a740477fc6f77aa6b85482d83" };
    const trashMigration = await readSqlMigrationFile({ file: "20261005193000_native_connector_trash.sql", sha256: next.checksum, migrations: [next] });
    const latest = databaseSchemaMigrations.find((migration) => migration.version === 240)!;
    const rotationMigration = await readSqlMigrationFile({ file: "20261005200000_native_connector_credential_rotations.sql", sha256: latest.checksum, migrations: [latest] });
    const registration = databaseSchemaMigrations.find((migration) => migration.version === 241)!;
    const registrationMigration = await readSqlMigrationFile({ file: "20261005203000_native_mcp_registrations.sql", sha256: registration.checksum, migrations: [registration] });
    await admin.begin(async (sql) => {
      await removeNativeMcpRegistrationsForReplay(sql);
      await sql`DELETE FROM omni_schema_version WHERE version=241`;
      await removeNativeConnectorCredentialRotationsForReplay(sql);
      await sql`DELETE FROM omni_schema_version WHERE version=240`;
      await removeNativeConnectorTrashForReplay(sql);
      await sql`DELETE FROM omni_schema_version WHERE version=239`;
      await removeNativeConnectorCredentialRemovalsForReplay(sql);
      await sql`DELETE FROM omni_schema_version WHERE version=238`;
      const migrationSql: Parameters<typeof applySqlMigrationFile>[0] = {
        unsafe: async (text, params) => {
          const values = (params ?? []).map((value) => {
            if (typeof value !== "string") throw new Error("Migration replay settings must use string parameters.");
            return value;
          });
          return await sql.unsafe<Record<string, unknown>[]>(text, values);
        },
      };
      await applySqlMigrationFile(migrationSql, migration, [row], []);
      await applySqlMigrationFile(migrationSql, trashMigration, [next], []);
      await applySqlMigrationFile(migrationSql, rotationMigration, [latest], []);
      await applySqlMigrationFile(migrationSql, registrationMigration, [registration], []);
      expect((await sql`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}`)[0]).toEqual(before);
    });
    expect(connectorNativeActionSchema.parse(await readNativeConnectorAction({ scope: f.scope }, legacy.action.acceptance.keySha256))).toEqual(legacy.action);
    expect(await admin`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='omni_native_connector_actions'::regclass`)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  test("concurrent same-key removal commits once and clears encrypted credential, tools and discovery metadata", async () => {
    const f = await fixture("concurrent"), outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Removal must remain local"));
    try {
      const pair = await Promise.all([submit(f), submit(f)]);
      expect(pair.map((result) => result.replayed).sort()).toEqual([false, true]); expect(pair[0].action).toEqual(pair[1].action);
      expect(pair[0].action.settlement?.result).toMatchObject({ operation: "remove_credential", connectorStatus: "disabled", contractCount: 0, credentialVersion: 3 });
      expect(await snapshot(f)).toMatchObject({ status: "disabled", credential_version: 3, credential_key_id: null, credential_fingerprint: null,
        credential_origin: null, sealed_credential: null, tool_count: 0, capabilities: {}, instructions: null, server_version: null, last_discovered_at: null, last_error: null });
      expect(await counts(f)).toEqual({ receipts: 1, events: 3, tools: 0 }); expect(outbound).not.toHaveBeenCalled();
      expect(await submit(f)).toEqual({ action: pair[0].action, replayed: true });
      await expect(submit(f, "fresh-after-removal")).rejects.toMatchObject({ status: 409 });
      const events = await admin`SELECT payload FROM omni_events WHERE tenant_id=${f.scope.tenantId}`;
      const persisted = JSON.stringify({ action: pair[0].action, events });
      expect(persisted).not.toContain("opaque-never-decrypt-fixture"); expect(persisted).not.toContain("private-endpoint-fixture");
    } finally { outbound.mockRestore(); }
  });

  test.each(["version", "endpoint", "contracts"])("rejects exact-review %s drift before admitting removal", async (drift) => {
    const f = await fixture(`drift-${drift}`);
    if (drift === "version") await admin`UPDATE omni_mcp_connectors SET credential_version=3 WHERE id=${f.id}`;
    if (drift === "endpoint") await admin`UPDATE omni_mcp_connectors SET endpoint='https://example.test/changed' WHERE id=${f.id}`;
    if (drift === "contracts") await admin`UPDATE omni_mcp_tools SET risk_level=3 WHERE connector_id=${f.id}`;
    await expect(submit(f)).rejects.toMatchObject({ status: 409 });
    expect(await counts(f)).toEqual({ receipts: 0, events: 0, tools: 1 }); expect((await snapshot(f)).sealed_credential).not.toBeNull();
  });

  test.each(["connector.mcp.credential_removed", "connector.native.action.settled"])("%s failure rolls back the full removal and acceptance", async (eventType) => {
    const f = await fixture(eventType.endsWith("credential_removed") ? "credential-rollback" : "settlement-rollback"), before = await snapshot(f);
    await admin.unsafe(`CREATE FUNCTION connector_removal_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id='${f.scope.tenantId}' AND NEW.type='${eventType}' THEN RAISE EXCEPTION 'fixture removal event failure'; END IF; RETURN NEW; END $$`);
    await admin`CREATE TRIGGER connector_removal_fixture_fail BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION connector_removal_fixture_fail()`;
    try {
      await expect(submit(f)).rejects.toMatchObject({ code: "P0001" });
      expect(await snapshot(f)).toEqual(before); expect(await counts(f)).toEqual({ receipts: 0, events: 0, tools: 1 });
    } finally { await admin`DROP TRIGGER connector_removal_fixture_fail ON omni_events`; await admin`DROP FUNCTION connector_removal_fixture_fail()`; }
    expect((await submit(f)).replayed).toBe(false); expect(await counts(f)).toEqual({ receipts: 1, events: 3, tools: 0 });
  });

  test("same key changed intent conflicts, fresh authority is fenced, exact owner recovery survives management loss", async () => {
    const f = await fixture("authority"), accepted = await submit(f), key = accepted.action.acceptance.keySha256;
    const { reviewSha256: _digest, ...body } = f.request.review;
    const changed = { ...f.request, review: sealConnectorNativePin({ ...body, credentialVersion: 3 }) };
    await expect(submit(f, "one", changed)).rejects.toMatchObject({ status: 409 });
    expect(await readNativeConnectorCredentialRemoval({ scope: { ...f.scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` } }, key)).toBeNull();
    expect(await runWithDatabaseTenantScope(f.scope.tenantId, () => getSql()`SELECT id FROM omni_native_connector_actions`)).toEqual([]);
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(submit(f, "new-key")).rejects.toMatchObject({ status: 403 });
    expect(await readNativeConnectorCredentialRemoval({ scope: f.scope }, key)).toEqual(accepted.action);
    await admin`DELETE FROM omni_mcp_connectors WHERE id=${f.id}`;
    expect(await readNativeConnectorCredentialRemoval({ scope: f.scope }, key)).toEqual(accepted.action);
    await expect(runWithDatabaseActorScope(f.scope.tenantId, [owner], () => getSql()`DELETE FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}`)).rejects.toMatchObject({ code: "42501" });
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(readNativeConnectorCredentialRemoval({ scope: f.scope }, key)).rejects.toMatchObject({ status: 403 });
  });

  test("state/removal keys do not cross parsers or repeat effects in either direction", async () => {
    const removed = await fixture("cross-removal"), removal = await submit(removed, "shared");
    expect(await readNativeConnectorAction({ scope: removed.scope }, removal.action.acceptance.keySha256)).toBeNull();
    await expect(submitNativeConnectorAction({ authority: authority(removed), request: stateRequest(removed), idempotencyKey: "shared" })).rejects.toMatchObject({ status: 409 });
    expect(await counts(removed)).toEqual({ receipts: 1, events: 3, tools: 0 });
    const state = await fixture("cross-state"), legacy = await submitNativeConnectorAction({ authority: authority(state), request: stateRequest(state), idempotencyKey: "shared" });
    expect(await readNativeConnectorCredentialRemoval({ scope: state.scope }, legacy.action.acceptance.keySha256)).toBeNull();
    await expect(submit(state, "shared")).rejects.toMatchObject({ status: 409 });
    expect(connectorNativeActionSchema.safeParse(legacy.action).success).toBe(true);
    expect((await snapshot(state)).sealed_credential).not.toBeNull();
  });

  test("serving-role v2 validators reject other lifecycle operations and malformed complete settlements", async () => {
    const f = await fixture("database-shapes"), result = await submit(f);
    const intent = buildConnectorNativeCredentialRemovalIntent(f.scope, "one", f.request), acceptance = result.action.acceptance;
    const settlement = result.action.settlement!;
    await runWithDatabaseActorScope(f.scope.tenantId, [owner, canonical], async () => {
      const sql = getSql();
      expect(await sql`SELECT omni_native_connector_intent_valid_v2(${intent}::JSONB,${acceptance}::JSONB) AS valid`).toEqual([{ valid: true }]);
      for (const patch of [{ action: "discover" }, { preview: {} }, { bearerToken: "never-persist" },
        { review: { ...intent.request.review, credentialVersion: 2147483647 } }]) {
        const invalid = { ...intent, request: { ...intent.request, ...patch } };
        expect(await sql`SELECT omni_native_connector_intent_valid_v2(${invalid}::JSONB,${acceptance}::JSONB) AS valid`).toEqual([{ valid: false }]);
      }
      for (const patch of [{ operation: "discover" }, { connectorStatus: "active" }, { contractCount: 1 },
        { credentialVersion: 2147483648 }, { contractsSha256: "f".repeat(64) }, { providerRevoked: true }]) {
        const invalid = { ...settlement, result: { ...settlement.result, ...patch } };
        expect(await sql`SELECT omni_native_connector_settlement_valid_v2(${invalid}::JSONB,${acceptance}::JSONB) AS valid`).toEqual([{ valid: false }]);
      }
    });
    expect(await counts(f)).toEqual({ receipts: 1, events: 3, tools: 0 });
  });
});
