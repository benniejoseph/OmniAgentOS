import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import { readNativeConnectorAction, reviewNativeConnector, submitNativeConnectorAction } from "@/lib/connectors/native-control-store";
import { readNativeConnectorCredentialRemoval, submitNativeConnectorCredentialRemoval } from "@/lib/connectors/native-credential-removal-store";
import { previewNativeConnectorTrash, readNativeConnectorTrash, submitNativeConnectorTrash } from "@/lib/connectors/native-trash-store";
import { prepareNativeConnectorCredential, readNativeConnectorCredentialRotation, submitNativeConnectorCredentialRotation } from "@/lib/connectors/native-credential-rotation-store";
import { connectorNativeCredentialPrepareRequestSchema, connectorNativeCredentialRotationRequestSchema, nativeCredentialPreparationDeclaration } from "@/lib/connectors/native-credential-rotation-contracts";
import { connectorNativeTrashRequestSchema } from "@/lib/connectors/native-trash-contracts";
import { connectorNativeCredentialRemovalRequestSchema } from "@/lib/connectors/native-credential-removal-contracts";
import { connectorNativeAcceptanceId, connectorNativeKeySha256, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeMcpRegistrationPreparationIntent, buildConnectorNativeMcpRegistrationIntent, connectorNativeMcpRegistrationTargetId,
  connectorNativeMcpRegistrationPreparationId, connectorNativeMcpRegistrationPrepareRequestSchema, nativeMcpRegistrationEndpointProjection,
  connectorNativeMcpRegistrationPreparationSchema, connectorNativeMcpRegistrationPreparationAbandonRequestSchema,
  connectorNativeMcpRegistrationRequestSchema, connectorNativeMcpRegistrationAcceptanceSchema, connectorNativeMcpRegistrationSettlementSchema,
  type ConnectorNativeMcpRegistrationPreparation } from "@/lib/connectors/native-mcp-registration-contracts";
import { prepareNativeMcpRegistration, readNativeMcpRegistrationPreparation, abandonNativeMcpRegistrationPreparation,
  submitNativeMcpRegistration, readNativeMcpRegistration, scrubExpiredNativeMcpRegistrationPreparations,
  nativeMcpRegistrationPreparationBinding } from "@/lib/connectors/native-mcp-registration-store";
import { connectorNativePrivateDigest } from "@/lib/connectors/native-control-private";
import { createExecutionScope } from "@/lib/security/execution-scope";
import * as network from "@/lib/security/network";
import { sealCredentialBundle, openCredentialBundle } from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { removeNativeMcpRegistrationsForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "registration-owner@example.test", other = "registration-other@example.test", canonical = `actor:${user}`;
const runtimeRole = "mcp_registration_test_runtime", maintenanceRole = "mcp_registration_test_maintenance";
const origin = "https://93.184.216.34", envName = "OMNIAGENT_CONNECTOR_REGISTRATION_FIXTURE_TOKEN";
type Auth = "none" | "bearer_env" | "bearer_vault";

integration("prepared MCP registration under serving-role RLS", () => {
  let admin: ReturnType<typeof postgres>, rolesCreated = false, keyring: string;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 4, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex"), maintenancePassword = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`CREATE ROLE ${maintenanceRole} LOGIN PASSWORD '${maintenancePassword}' NOSUPERUSER BYPASSRLS IN ROLE omni_maintenance`); rolesCreated = true;
    for (const role of [runtimeRole, maintenanceRole]) {
      await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions TO ${role}`);
    }
    // Only legacy table grants are fixture-owned. Migration241 grants its own
    // narrow preparation columns and validators to the inherited runtime role.
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools,omni_openapi_connectors,omni_openapi_operations TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${runtimeRole}`); await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture'),(${otherUser},${other},'fixture')`;
    const serving = new URL(databaseUrl!), maintenance = new URL(databaseUrl!);
    serving.username = runtimeRole; serving.password = password; maintenance.username = maintenanceRole; maintenance.password = maintenancePassword;
    await closeDatabaseClient();
    vi.stubEnv("DATABASE_URL", serving.toString()); vi.stubEnv("OMNIAGENT_MAINTENANCE_DATABASE_URL", maintenance.toString());
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv(envName, "synthetic-deployer-fixture-only"); vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", "{}");
    keyring = JSON.stringify({ activeKeyId: "registration-fixture", keys: { "registration-fixture": randomBytes(32).toString("base64url") } });
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("registration-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_mcp_registration_preparations') AS preparation_rls,
      row_security_active('omni_native_connector_actions') AS action_rls,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS registry_read
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toEqual({ role: runtimeRole, rolsuper: false, rolbypassrls: false, preparation_rls: true, action_rls: true, registry_read: false });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) { if (rolesCreated) for (const role of [runtimeRole, maintenanceRole]) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); } await admin.end(); }
  });

  function target(scope: ConnectorNativeScope, tag: string, authType: Auth = "none", privateEndpoint = false) {
    const nonce = randomUUID(), id = connectorNativeMcpRegistrationTargetId(scope, nonce);
    const endpoint = `${origin}/mcp/${tag}${privateEndpoint ? "?fixture=synthetic-private-query#synthetic-fragment" : ""}`;
    const request = connectorNativeMcpRegistrationPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", nonce, operation: "register_mcp", connectorId: id, review: null,
      declaration: { name: "Fixture MCP", ...nativeMcpRegistrationEndpointProjection(endpoint), authType, authTokenEnv: authType === "bearer_env" ? envName : null,
        authHeaderName: null, defaultRiskLevel: 2, approvalRequired: true, specSource: "none", specUrl: null, specUrlRedacted: false },
      payload: { endpoint, specUrl: null, specText: null, bearerToken: authType === "bearer_vault" ? "界界界" : null } });
    return { scope, id, request };
  }
  async function fixture(tag: string, authType: Auth = "none", privateEndpoint = false) {
    const scope: ConnectorNativeScope = { tenantId: `registration-${tag}`, ownerActorId: owner, canonicalActorId: canonical };
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const who of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${who}`},${scope.tenantId},${who},'admin')`;
    const bindings = JSON.parse(process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS || "{}");
    bindings[envName] = { tenants: [...(bindings[envName]?.tenants ?? []), scope.tenantId], origins: [origin] };
    vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", JSON.stringify(bindings));
    return target(scope, tag, authType, privateEndpoint);
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function authority(f: Pick<Fixture, "scope" | "id">, cleanup = false) { return { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId,
    initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner, correlationId: "registration-fixture", causationId: f.id,
    purpose: cleanup ? "api.connectors.native.mcp_registration_preparation.abandon" : "api.connectors.native.action" }) }; }
  const prepare = (f: Fixture, key = "prepare", request = f.request) => prepareNativeMcpRegistration({ authority: authority(f), request, idempotencyKey: key });
  const keySha = (f: Pick<Fixture, "scope">, key = "prepare") => connectorNativeKeySha256(f.scope, key);
  const inOwner = <T,>(f: Pick<Fixture, "scope">, operation: () => Promise<T>) => runWithDatabaseActorScope(f.scope.tenantId, [owner, canonical], operation);
  function registrationRequest(p: ConnectorNativeMcpRegistrationPreparation) { return connectorNativeMcpRegistrationRequestSchema.parse({
    contract: "asael-connector-prepared-action:1", kind: "mcp", connectorId: p.connectorId, action: "register_mcp", preparationId: p.id, preparationSha256: p.preparationSha256, review: null }); }
  const register = (f: Fixture, p: ConnectorNativeMcpRegistrationPreparation, key = "register") => submitNativeMcpRegistration({ authority: authority(f), request: registrationRequest(p), idempotencyKey: key });
  const abandon = (f: Fixture, key = "prepare") => abandonNativeMcpRegistrationPreparation({ authority: authority(f, true), keySha256: keySha(f, key), idempotencyKey: key,
    request: connectorNativeMcpRegistrationPreparationAbandonRequestSchema.parse({ contract: "asael-mcp-registration-preparation-abandon:1", intent: buildConnectorNativeMcpRegistrationPreparationIntent(f.scope, key, f.request) }) });
  async function snapshot(f: Pick<Fixture, "scope" | "id">) { return {
    connectors: await admin`SELECT * FROM omni_mcp_connectors WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    tools: await admin`SELECT * FROM omni_mcp_tools WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    preparations: await admin`SELECT * FROM omni_native_mcp_registration_preparations WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    actions: await admin`SELECT * FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    events: await admin`SELECT id,type,payload FROM omni_events WHERE tenant_id=${f.scope.tenantId} ORDER BY seq` }; }
  async function failEvent(f: Fixture, event: string, operation: () => Promise<void>) {
    await admin`CREATE FUNCTION fail_registration_fixture_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id=TG_ARGV[0] AND NEW.type=TG_ARGV[1] THEN RAISE EXCEPTION 'synthetic event rollback'; END IF; RETURN NEW; END $$`;
    await admin.unsafe(`CREATE TRIGGER fail_registration_fixture_event BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION fail_registration_fixture_event('${f.scope.tenantId}','${event}')`);
    try { await operation(); } finally { await admin`DROP TRIGGER fail_registration_fixture_event ON omni_events`; await admin`DROP FUNCTION fail_registration_fixture_event()`; }
  }
  // Only the superuser fixture changes a clock-bound proof. Every serving call
  // runs with both the database constraints and production triggers restored.
  async function shiftPreparation(f: Fixture, proof: ConnectorNativeMcpRegistrationPreparation, remainingMs: number) {
    const [server] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
    const expiresAt = new Date(Date.parse(String(server.now)) + remainingMs).toISOString();
    const { preparationSha256: _digest, ...body } = proof;
    const shifted = { ...body, preparedAt: new Date(Date.parse(expiresAt) - 900_000).toISOString(), expiresAt };
    const next = connectorNativeMcpRegistrationPreparationSchema.parse({ ...shifted, preparationSha256: canonicalJsonSha256(shifted) });
    const sealed = f.request.declaration.authType === "bearer_vault" || f.request.declaration.endpointRedacted
      ? sealCredentialBundle({ registrationPayload: JSON.stringify({ endpoint: f.request.payload.endpoint, bearerToken: f.request.payload.bearerToken }) }, nativeMcpRegistrationPreparationBinding(next)) : null;
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_mcp_registration_preparations DISABLE TRIGGER omni_native_mcp_registration_preparation_guard`;
      await sql`UPDATE omni_native_mcp_registration_preparations SET preparation=${sql.json(next)},expires_at=${expiresAt},sealed_payload=${sealed ? sql.json(sealed) : null} WHERE id=${proof.id}`;
      await sql`ALTER TABLE omni_native_mcp_registration_preparations ENABLE TRIGGER omni_native_mcp_registration_preparation_guard`;
    });
    return next;
  }

  async function legacy(tag: string, scope?: ConnectorNativeScope) {
    const f = scope ? target(scope, tag) : await fixture(tag), id = `legacy-${tag}`;
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,transport,auth_type,status,tool_count,credential_version,
      credential_key_id,credential_fingerprint,credential_origin,sealed_credential,credential_created_by,credential_created_at)
      VALUES(${id},${f.scope.tenantId},'Legacy fixture',${`${origin}/legacy`},'streamable_http','bearer_vault','active',0,2,
        'fixture-key',${canonicalJsonSha256("synthetic old credential").slice(0,12)},${origin},${admin.json({ encrypted: "synthetic-old-payload" })},${owner},clock_timestamp())`;
    return { scope: f.scope, id, review: (await reviewNativeConnector({ scope: f.scope }, "mcp", id))! };
  }
  async function oldAction(f: Awaited<ReturnType<typeof legacy>>, family: "state" | "removal" | "trash" | "rotation", key = "old-action") {
    if (family === "state") return submitNativeConnectorAction({ authority: authority(f), idempotencyKey: key, request: {
      contract: "asael-connector-action:1", kind: "mcp", connectorId: f.id, action: "disable", review: f.review.pin! } });
    if (family === "removal") return submitNativeConnectorCredentialRemoval({ authority: authority(f), idempotencyKey: key,
      request: connectorNativeCredentialRemovalRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: f.id, action: "remove_credential", review: f.review.pin, preview: null }) });
    if (family === "trash") { const p = await previewNativeConnectorTrash({ scope: f.scope }, f.id); return submitNativeConnectorTrash({ authority: authority(f), idempotencyKey: key,
      request: connectorNativeTrashRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: f.id, action: "trash", review: p.review!.pin, preview: p.preview }) }); }
    const prepared = await prepareNativeConnectorCredential({ authority: authority(f), idempotencyKey: "legacy-preparation", request: connectorNativeCredentialPrepareRequestSchema.parse({
      contract: "asael-connector-prepare:1", nonce: randomUUID(), operation: "rotate_mcp", connectorId: f.id, review: f.review.pin,
      declaration: nativeCredentialPreparationDeclaration(f.review), payload: { endpoint: null, specUrl: null, specText: null, bearerToken: "synthetic-legacy-rotation" } }) });
    const p = prepared.prepared.preparation;
    return submitNativeConnectorCredentialRotation({ authority: authority(f), idempotencyKey: key, request: connectorNativeCredentialRotationRequestSchema.parse({
      contract: "asael-connector-prepared-action:1", kind: "mcp", connectorId: f.id, action: "rotate_mcp", preparationId: p.id, preparationSha256: p.preparationSha256, review: p.review }) });
  }

  test("241 replays over240 with all four historical action families and rotation proofs unchanged", async () => {
    for (const family of ["state", "removal", "trash", "rotation"] as const) await oldAction(await legacy(`replay-${family}`), family);
    const before = await admin`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions ORDER BY id`;
    const stages = await admin`SELECT * FROM omni_native_connector_credential_preparations ORDER BY id`;
    const row = databaseSchemaMigrations.find((migration) => migration.version === 241)!;
    const migration = await readSqlMigrationFile({ file: "20261005203000_native_mcp_registrations.sql", sha256: row.checksum, migrations: [row] });
    await admin.begin(async (sql) => {
      await removeNativeMcpRegistrationsForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=241`;
      await applySqlMigrationFile({ unsafe: async (text, params) => {
        const values = (params ?? []).map((value) => { if (typeof value !== "string") throw new Error("Migration settings must be strings."); return value; });
        return await sql.unsafe<Record<string, unknown>[]>(text, values);
      } }, migration, [row], []);
      expect(await sql`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions ORDER BY id`).toEqual(before);
      expect(await sql`SELECT * FROM omni_native_connector_credential_preparations ORDER BY id`).toEqual(stages);
    });
  });

  test.each([["none", false], ["bearer_env", false], ["bearer_vault", false],
    ["none", true], ["bearer_env", true], ["bearer_vault", true]] as const)("%s private=%s creates only a disabled zero-tool local connector", async (auth, privateEndpoint) => {
    const f = await fixture(`mode-${auth}-${privateEndpoint}`, auth, privateEndpoint), initial = await snapshot(f);
    const outbound = vi.spyOn(network, "fetchPublicHttpUrl").mockRejectedValue(new Error("Registration must remain local"));
    const globalOutbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Registration must remain local"));
    try {
      expect(await readNativeMcpRegistrationPreparation({ scope: f.scope }, keySha(f))).toBeNull();
      const p = (await prepare(f)).prepared.preparation, staged = await snapshot(f), encrypted = auth === "bearer_vault" || privateEndpoint;
      expect(staged.connectors).toEqual(initial.connectors); expect(staged.actions).toHaveLength(0);
      expect(staged.preparations[0].sealed_payload !== null).toBe(encrypted);
      const result = await register(f, p), after = await snapshot(f);
      expect(result.action.settlement?.result).toMatchObject({ status: "complete", connectorStatus: "disabled", contractCount: 0, credentialVersion: auth === "bearer_vault" ? 1 : 0 });
      expect(after.connectors).toHaveLength(1); expect(after.connectors[0]).toMatchObject({ id: f.id, name: "Fixture MCP", endpoint: f.request.payload.endpoint,
        transport: "streamable_http", auth_type: auth, status: "disabled", tool_count: 0, capabilities: {}, instructions: null, server_version: null, last_discovered_at: null, last_error: null,
        credential_version: auth === "bearer_vault" ? 1 : null });
      expect(after.tools).toHaveLength(0); expect(after.actions).toHaveLength(1);
      expect(after.preparations[0]).toMatchObject({ state: "consumed", sealed_payload: null, consumed_by: result.action.acceptance.id, consumed_key_sha256: result.action.acceptance.keySha256 });
      expect(after.events.map((e) => e.type)).toEqual(["connector.native.mcp_registration_preparation.prepared", "connector.scope_bound", "connector.mcp.created",
        ...(auth === "bearer_vault" ? ["connector.mcp.credential_saved"] : []), "connector.native.action.accepted", "connector.native.action.settled"]);
      const safe = JSON.stringify([p, result, after.events, after.actions, staged.preparations[0].sealed_payload]);
      for (const secret of ["synthetic-private-query", "synthetic-fragment", "synthetic-deployer-fixture-only", "界界界"]) expect(safe).not.toContain(secret);
      expect(await readNativeMcpRegistrationPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "consumed", consumedKeySha256: result.action.acceptance.keySha256 });
      expect(await readNativeMcpRegistration({ scope: f.scope }, result.action.acceptance.keySha256)).toEqual(result.action);
      expect(await register(f, p)).toEqual({ action: result.action, replayed: true }); expect(await snapshot(f)).toEqual(after);
      await expect(register(f, p, "second-action")).rejects.toMatchObject({ status: 409 }); await expect(abandon(f)).rejects.toMatchObject({ status: 409 });
      expect(outbound).not.toHaveBeenCalled(); expect(globalOutbound).not.toHaveBeenCalled();
    } finally { outbound.mockRestore(); globalOutbound.mockRestore(); }
  });

  test("concurrent identical preparation/action keys commit once and changed private material cannot replay", async () => {
    const f = await fixture("concurrent", "bearer_vault", true);
    const pair = await Promise.all([prepare(f), prepare(f)]);
    expect(pair.map((p) => p.replayed).sort()).toEqual([false, true]); expect(pair[0].prepared).toEqual(pair[1].prepared);
    const before = await snapshot(f);
    for (const payload of [{ ...f.request.payload, bearerToken: "synthetic-changed-token" }, { ...f.request.payload, endpoint: `${origin}/mcp/concurrent?other-private-value#other-fragment` }]) {
      await expect(prepare(f, "prepare", connectorNativeMcpRegistrationPrepareRequestSchema.parse({ ...f.request, payload }))).rejects.toMatchObject({ status: 409 });
    }
    expect(await snapshot(f)).toEqual(before);
    const results = await Promise.all([register(f, pair[0].prepared.preparation), register(f, pair[0].prepared.preparation)]);
    expect(results.map((p) => p.replayed).sort()).toEqual([false, true]); expect(results[0].action).toEqual(results[1].action);
    const after = await snapshot(f); expect(after.connectors).toHaveLength(1); expect(after.actions).toHaveLength(1);
  });

  test("absent-key abandonment makes an honest immutable tombstone and permanently reserves the target", async () => {
    const f = await fixture("absent-abandon"), closed = await abandon(f), before = await snapshot(f);
    expect(closed.prepared).toMatchObject({ availability: "abandoned", preparation: null, abandonment: { preparationSha256: null } });
    expect(before.preparations[0]).toMatchObject({ state: "abandoned", expires_at: null, sealed_payload: null, payload_commitment: null });
    expect(await abandon(f)).toEqual({ prepared: closed.prepared, replayed: true });
    expect(await readNativeMcpRegistrationPreparation({ scope: f.scope }, keySha(f))).toEqual(closed.prepared);
    await expect(prepare(f)).rejects.toMatchObject({ status: 409 }); await expect(prepare(f, "replacement-key")).rejects.toMatchObject({ status: 409 });
    await expect(abandon(f, "replacement-key")).rejects.toMatchObject({ status: 409 }); expect(await snapshot(f)).toEqual(before);
    expect(before.connectors).toHaveLength(0); expect(before.actions).toHaveLength(0);
  });

  test("ready/expired reservations survive abandonment and consume/abandon races have one terminal winner", async () => {
    const f = await fixture("prepare-abandon-race", "none", true);
    const raced = await Promise.allSettled([prepare(f), abandon(f)]);
    expect(raced[1].status).toBe("fulfilled");
    expect(await readNativeMcpRegistrationPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "abandoned" });
    const ready = await fixture("consume-abandon-race", "bearer_vault"), p = (await prepare(ready)).prepared.preparation;
    const final = await Promise.allSettled([register(ready, p), abandon(ready)]), after = await snapshot(ready);
    expect(final.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(["consumed", "abandoned"]).toContain(after.preparations[0].state); expect(after.preparations[0].sealed_payload).toBeNull();
    expect(after.connectors.length).toBe(after.preparations[0].state === "consumed" ? 1 : 0);
    const expired = await fixture("expired-reservation"); await shiftPreparation(expired, (await prepare(expired)).prepared.preparation, -1000);
    expect(await readNativeMcpRegistrationPreparation({ scope: expired.scope }, keySha(expired))).toMatchObject({ availability: "expired" });
    await expect(prepare(expired, "replacement-key")).rejects.toMatchObject({ status: 409 }); await abandon(expired);
    await expect(prepare(expired, "replacement-key")).rejects.toMatchObject({ status: 409 });
  });

  test.each(["connector.native.mcp_registration_preparation.prepared", "connector.native.mcp_registration_preparation.abandoned"])("%s event failure preserves exact staging and original-key retry", async (event) => {
    const preparing = event.endsWith("prepared"), f = await fixture(preparing ? "fail-prepare" : "fail-abandon", "none", true);
    if (!preparing) await prepare(f);
    const before = await snapshot(f);
    await failEvent(f, event, async () => { await expect(preparing ? prepare(f) : abandon(f)).rejects.toThrow("synthetic event rollback"); expect(await snapshot(f)).toEqual(before); });
    expect((await (preparing ? prepare(f) : abandon(f))).replayed).toBe(false);
  });

  test.each(["connector.scope_bound", "connector.mcp.created", "connector.mcp.credential_saved", "connector.native.action.accepted", "connector.native.action.settled"])("%s failure rolls back creation, credential, staging, and all receipts/events", async (event) => {
    const f = await fixture(`rollback-${event.split(".").at(-1)}`, "bearer_vault", true), p = (await prepare(f)).prepared.preparation, before = await snapshot(f);
    await failEvent(f, event, async () => { await expect(register(f, p)).rejects.toThrow("synthetic event rollback"); expect(await snapshot(f)).toEqual(before); });
    expect((await register(f, p)).replayed).toBe(false);
  });

  test("browser creation between prepare and final is not overwritten, and reservation does not consume", async () => {
    const f = await fixture("insert-only", "bearer_vault"), p = (await prepare(f)).prepared.preparation;
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,transport,auth_type,status,tool_count)
      VALUES(${f.id},${f.scope.tenantId},'Existing browser connector',${`${origin}/browser`},'streamable_http','none','active',0)`;
    const before = await snapshot(f);
    await expect(register(f, p)).rejects.toMatchObject({ status: 409 }); expect(await snapshot(f)).toEqual(before);
    await abandon(f); expect((await snapshot(f)).connectors).toEqual(before.connectors);
    await expect(prepare(f, "new-key")).rejects.toMatchObject({ status: 409 });
  });

  test("role loss preserves exact replay/cleanup but cannot create, while aliases and inactive owners are fenced", async () => {
    const f = await fixture("owner-cleanup"), p = (await prepare(f)).prepared.preparation;
    expect(await readNativeMcpRegistrationPreparation({ scope: { ...f.scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` } }, keySha(f))).toBeNull();
    expect(await runWithDatabaseTenantScope(f.scope.tenantId, () => getSql()`SELECT id FROM omni_native_mcp_registration_preparations`)).toEqual([]);
    await expect(readNativeMcpRegistrationPreparation({ scope: { ...f.scope, ownerActorId: owner.toUpperCase() } }, keySha(f))).rejects.toMatchObject({ status: 403 });
    const alien = await fixture("other-tenant"); expect(await readNativeMcpRegistrationPreparation({ scope: alien.scope }, keySha(f))).toBeNull();
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    expect((await prepare(f)).replayed).toBe(true); await expect(prepare(f, "fresh-key")).rejects.toMatchObject({ status: 403 });
    await expect(register(f, p)).rejects.toMatchObject({ status: 403 }); expect((await abandon(f)).prepared.availability).toBe("abandoned");
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(readNativeMcpRegistrationPreparation({ scope: f.scope }, keySha(f))).rejects.toMatchObject({ status: 403 });
    const accepted = await fixture("demoted-replay", "bearer_env"), proof = (await prepare(accepted)).prepared.preparation, result = await register(accepted, proof), before = await snapshot(accepted);
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${accepted.scope.tenantId} AND user_id=${user}`;
    const bindings = process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS!; vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", "{}");
    try { expect(await register(accepted, proof)).toEqual({ action: result.action, replayed: true }); expect(await snapshot(accepted)).toEqual(before); }
    finally { vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", bindings); }
  });

  test("fresh endpoint/environment admission and optional vault availability precede any local creation", async () => {
    const clean = await fixture("clean-no-key"), privateUrl = await fixture("private-no-key", "none", true), vault = await fixture("vault-no-key", "bearer_vault");
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    try {
      expect((await register(clean, (await prepare(clean)).prepared.preparation)).action.state).toBe("settled");
      for (const f of [privateUrl, vault]) { const before = await snapshot(f); await expect(prepare(f)).rejects.toMatchObject({ status: 503 }); expect(await snapshot(f)).toEqual(before); }
    } finally { vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); }
    const env = await fixture("binding-revoked", "bearer_env"), proof = (await prepare(env)).prepared.preparation, before = await snapshot(env);
    const bindings = process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS!; vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", "{}");
    vi.stubEnv("OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS", "true");
    try { await expect(register(env, proof)).rejects.toMatchObject({ status: 409 }); expect(await snapshot(env)).toEqual(before); expect((await prepare(env)).replayed).toBe(true); }
    finally { vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", bindings); vi.stubEnv("OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS", ""); }
    for (const endpoint of ["https://127.0.0.1/mcp", "https://api.browser-use.com/mcp"]) {
      const f = await fixture(`reject-${endpoint.includes("127") ? "private" : "unsupported"}`);
      const request = connectorNativeMcpRegistrationPrepareRequestSchema.parse({ ...f.request, declaration: { ...f.request.declaration, ...nativeMcpRegistrationEndpointProjection(endpoint) }, payload: { ...f.request.payload, endpoint } });
      const initial = await snapshot(f); await expect(prepare(f, "prepare", request)).rejects.toMatchObject({ status: 400 }); expect(await snapshot(f)).toEqual(initial);
    }
  });

  test("fresh database time rejects expiry after a target-lock wait that began before the deadline", async () => {
    const f = await fixture("expiry-lock", "none", true);
    const [timing] = await inOwner(f, () => getSql()`SELECT EXTRACT(EPOCH FROM current_setting('lock_timeout')::INTERVAL)*1000 AS lock_timeout_ms`);
    const remainingMs = Math.floor(Number(timing.lock_timeout_ms) / 2); expect(remainingMs).toBeGreaterThan(0);
    const p = await shiftPreparation(f, (await prepare(f)).prepared.preparation, remainingMs), before = await snapshot(f);
    let outcome!: Promise<unknown>;
    await admin.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-mcp-registration-target:${f.id}`},0))`;
      outcome = register(f, p).then((value) => value, (error: unknown) => error);
      let startedAt: string | null = null;
      const pollDeadline = Date.now() + 3000;
      while (!startedAt && Date.now() < pollDeadline) {
        const waiting = await admin`SELECT to_char(xact_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
          FROM pg_stat_activity WHERE usename=${runtimeRole} AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1`;
        startedAt = waiting.length ? String(waiting[0].started_at) : null;
        if (!startedAt) await admin`SELECT pg_sleep(0.01)`;
      }
      expect(startedAt).not.toBeNull(); expect(Date.parse(startedAt!)).toBeLessThan(Date.parse(p.expiresAt));
      await sql`SELECT pg_sleep(LEAST(${remainingMs / 1000 + 0.1},GREATEST(0,EXTRACT(EPOCH FROM (${p.expiresAt}::TIMESTAMPTZ-clock_timestamp()))+0.025)))`;
      expect((await sql`SELECT clock_timestamp()>=${p.expiresAt}::TIMESTAMPTZ AS expired`)[0].expired).toBe(true);
    });
    expect(await outcome).toMatchObject({ status: 409 }); expect(await snapshot(f)).toEqual(before);
    expect(await readNativeMcpRegistrationPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "expired" });
    expect((await snapshot(f)).preparations[0].sealed_payload).not.toBeNull();
    expect((await abandon(f)).prepared.availability).toBe("abandoned");
  });

  test("missing staging key cannot consume private preparation, while owner cleanup remains available", async () => {
    const f = await fixture("lost-key", "none", true), proof = (await prepare(f)).prepared.preparation, before = await snapshot(f);
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    try {
      await expect(register(f, proof)).rejects.toMatchObject({ status: 503 }); expect(await snapshot(f)).toEqual(before);
      expect((await abandon(f)).prepared.availability).toBe("abandoned");
      expect((await snapshot(f)).preparations[0].sealed_payload).toBeNull();
    } finally { vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); }
  });

  test("bounded admission rejects a stalled resolver and a late result cannot create staging or connector effects", async () => {
    const f = await fixture("slow-admission"), before = await snapshot(f);
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    // Delay the policy seam only. The production admission deadline and database
    // transaction remain real; no DNS request or provider transport is performed.
    const admission = vi.spyOn(network, "assertPublicHttpUrl").mockReturnValueOnce(pending);
    try {
      await expect(prepare(f)).rejects.toMatchObject({ status: 400 });
      expect(admission).toHaveBeenCalledTimes(1); expect(await snapshot(f)).toEqual(before);
      release(f.request.payload.endpoint); await pending;
      expect(await snapshot(f)).toEqual(before);
    } finally { release(f.request.payload.endpoint); admission.mockRestore(); }
  });

  test("exact preparation/action GET recovery survives removal from connector inventory", async () => {
    const f = await fixture("receipt-after-trash", "bearer_vault"), proof = (await prepare(f)).prepared.preparation, result = await register(f, proof);
    const preview = await previewNativeConnectorTrash({ scope: f.scope }, f.id);
    await submitNativeConnectorTrash({ authority: authority(f), idempotencyKey: "later-trash", request: connectorNativeTrashRequestSchema.parse({
      contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: f.id, action: "trash", review: preview.review!.pin, preview: preview.preview }) });
    expect(await reviewNativeConnector({ scope: f.scope }, "mcp", f.id)).toBeNull();
    expect(await readNativeMcpRegistration({ scope: f.scope }, result.action.acceptance.keySha256)).toEqual(result.action);
    expect(await readNativeMcpRegistrationPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "consumed", consumedKeySha256: result.action.acceptance.keySha256 });
    const before = await snapshot(f); expect(await register(f, proof)).toEqual({ action: result.action, replayed: true }); expect(await snapshot(f)).toEqual(before);
  });

  test("AEAD binds the full private configuration/scope/expiry and cannot swap staged ciphertext", async () => {
    const f = await fixture("aad", "bearer_vault", true), p = (await prepare(f)).prepared.preparation;
    const long = { ...p, scope: { ...p.scope, ownerActorId: "x".repeat(320) } }, binding = nativeMcpRegistrationPreparationBinding(long);
    const sealed = sealCredentialBundle({ registrationPayload: "synthetic protected endpoint and token" }, binding);
    expect(binding.length).toBeLessThan(1000);
    expect(openCredentialBundle(sealed, binding)).toEqual({ registrationPayload: "synthetic protected endpoint and token" });
    for (const changed of [{ ...long, expiresAt: "2026-10-05T23:59:59.999Z" }, { ...long, configurationSha256: canonicalJsonSha256("other endpoint") },
      { ...long, scope: { ...long.scope, tenantId: "other-tenant" } }]) {
      expect(() => openCredentialBundle(sealed, nativeMcpRegistrationPreparationBinding(changed))).toThrow("could not be authenticated");
    }
    const otherTarget = target(f.scope, "aad-other", "bearer_vault", true), otherProof = (await prepare(otherTarget, "other-prepare")).prepared.preparation;
    const [otherRow] = await admin`SELECT sealed_payload FROM omni_native_mcp_registration_preparations WHERE id=${otherProof.id}`;
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_mcp_registration_preparations DISABLE TRIGGER omni_native_mcp_registration_preparation_guard`;
      await sql`UPDATE omni_native_mcp_registration_preparations SET sealed_payload=${sql.json(otherRow.sealed_payload)} WHERE id=${p.id}`;
      await sql`ALTER TABLE omni_native_mcp_registration_preparations ENABLE TRIGGER omni_native_mcp_registration_preparation_guard`;
    });
    const before = await snapshot(f); await expect(register(f, p)).rejects.toMatchObject({ status: 503 }); expect(await snapshot(f)).toEqual(before);
  });

  test("bounded maintenance clamps at100, skips locked rows, and needs neither active owner nor vault keys", async () => {
    const f = await fixture("scrub", "none", true), proof = await shiftPreparation(f, (await prepare(f)).prepared.preparation, -1000);
    const freshTarget = target(f.scope, "scrub-fresh", "none", true), fresh = (await prepare(freshTarget, "fresh")).prepared.preparation;
    const terminalTarget = target(f.scope, "scrub-terminal", "none", true), terminal = (await prepare(terminalTarget, "terminal")).prepared.preparation; await abandon(terminalTarget, "terminal");
    const cleanTarget = target(f.scope, "scrub-clean"), clean = await shiftPreparation(cleanTarget, (await prepare(cleanTarget, "clean")).prepared.preparation, -1000);
    const untouched = await fixture("scrub-other", "bearer_vault"), otherProof = await shiftPreparation(untouched, (await prepare(untouched)).prepared.preparation, -1000);
    const rows = Array.from({ length: 100 }, (_, index) => {
      const copy = target(f.scope, `scrub-copy-${index}`, "none", true), intent = buildConnectorNativeMcpRegistrationPreparationIntent(copy.scope, `copy-${index}`, copy.request);
      const payload = { endpoint: copy.request.payload.endpoint, bearerToken: copy.request.payload.bearerToken };
      const { contract: _contract, ...safe } = intent;
      const body = { ...safe, contract: "asael-connector-preparation:1", id: connectorNativeMcpRegistrationPreparationId(f.scope, intent.keySha256),
        intentSha256: canonicalJsonSha256(intent), configurationSha256: connectorNativePrivateDigest(f.scope.tenantId,
          ["native-mcp-registration-configuration:1", f.scope, copy.id, intent.declaration, "streamable_http", payload.endpoint]), preparedAt: proof.preparedAt, expiresAt: proof.expiresAt };
      const p = connectorNativeMcpRegistrationPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
      return { id: p.id, tenant_id: f.scope.tenantId, owner_actor_id: owner, canonical_actor_id: canonical, idempotency_key_sha256: intent.keySha256,
        connector_id: copy.id, intent, preparation: p, state: "ready", expires_at: p.expiresAt,
        sealed_payload: sealCredentialBundle({ registrationPayload: JSON.stringify(payload) }, nativeMcpRegistrationPreparationBinding(p)),
        payload_commitment: connectorNativePrivateDigest(f.scope.tenantId, ["native-mcp-registration-payload:1", intent, payload]) };
    });
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_mcp_registration_preparations DISABLE TRIGGER omni_native_mcp_registration_preparation_guard`;
      await sql`INSERT INTO omni_native_mcp_registration_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
        connector_id,intent,preparation,state,expires_at,sealed_payload,payload_commitment)
        SELECT * FROM jsonb_to_recordset(${sql.json(rows)}) AS seed(id TEXT,tenant_id TEXT,owner_actor_id TEXT,canonical_actor_id TEXT,
          idempotency_key_sha256 TEXT,connector_id TEXT,intent JSONB,preparation JSONB,state TEXT,expires_at TIMESTAMPTZ,sealed_payload JSONB,payload_commitment TEXT)`;
      await sql`ALTER TABLE omni_native_mcp_registration_preparations ENABLE TRIGGER omni_native_mcp_registration_preparation_guard`;
    });
    const beforeForgedScope = await snapshot(f);
    await inOwner(f, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      await sql`SELECT set_config('omni.system_scope','true',true),set_config('omni.system_reason','forged fixture maintenance',true)`;
      expect(await sql`SELECT omni_system_scope_enabled() AS enabled`).toEqual([{ enabled: false }]);
      expect(await sql`SELECT id FROM omni_native_mcp_registration_preparations WHERE id=${proof.id}`).toEqual([]);
      expect(await sql`UPDATE omni_native_mcp_registration_preparations SET state='expired',sealed_payload=NULL WHERE id=${proof.id} RETURNING id`).toEqual([]);
    }));
    expect(await snapshot(f)).toEqual(beforeForgedScope);
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    try {
      expect(await scrubExpiredNativeMcpRegistrationPreparations({ tenantId: f.scope.tenantId, limit: 10_000, deadlineAt: Date.now() + 5000 }))
        .toMatchObject({ status: "complete", scrubbed: 100, moreAvailable: true, oldestExpiredAt: proof.expiresAt });
      const [pending] = await admin`SELECT id FROM omni_native_mcp_registration_preparations WHERE tenant_id=${f.scope.tenantId} AND state='ready' AND sealed_payload IS NOT NULL AND expires_at<clock_timestamp()`;
      await admin.begin(async (sql) => {
        await sql`SELECT id FROM omni_native_mcp_registration_preparations WHERE id=${pending.id} FOR UPDATE`;
        expect(await scrubExpiredNativeMcpRegistrationPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 })).toMatchObject({ status: "complete", scrubbed: 0, moreAvailable: true });
      });
      expect(await scrubExpiredNativeMcpRegistrationPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 }))
        .toEqual({ status: "complete", scrubbed: 1, moreAvailable: false, oldestExpiredAt: null });
    } finally { vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); }
    expect((await admin`SELECT state,sealed_payload IS NOT NULL AS sealed FROM omni_native_mcp_registration_preparations WHERE id=${fresh.id}`)[0]).toEqual({ state: "ready", sealed: true });
    expect((await admin`SELECT state,sealed_payload FROM omni_native_mcp_registration_preparations WHERE id=${terminal.id}`)[0]).toEqual({ state: "abandoned", sealed_payload: null });
    expect((await admin`SELECT state,sealed_payload FROM omni_native_mcp_registration_preparations WHERE id=${clean.id}`)[0]).toEqual({ state: "ready", sealed_payload: null });
    expect((await admin`SELECT sealed_payload IS NOT NULL AS sealed FROM omni_native_mcp_registration_preparations WHERE id=${otherProof.id}`)[0].sealed).toBe(true);
    expect(await scrubExpiredNativeMcpRegistrationPreparations({ tenantId: untouched.scope.tenantId, deadlineAt: Date.now() - 1 }))
      .toEqual({ status: "deferred", scrubbed: 0, moreAvailable: true, oldestExpiredAt: null });
  }, 120_000);

  test("a timed-out scrub rolls back and leaves the row for the next bounded pass", async () => {
    const f = await fixture("scrub-timeout", "none", true); await shiftPreparation(f, (await prepare(f)).prepared.preparation, -1000);
    const before = await snapshot(f);
    await admin.begin(async (sql) => {
      await sql`LOCK TABLE omni_native_mcp_registration_preparations IN ACCESS EXCLUSIVE MODE`;
      await expect(scrubExpiredNativeMcpRegistrationPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 500 })).rejects.toMatchObject({ code: "57014" });
    });
    expect(await snapshot(f)).toEqual(before);
    expect(await scrubExpiredNativeMcpRegistrationPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 })).toMatchObject({ status: "complete", scrubbed: 1 });
  });

  test("all four prior action families stay isolated from registration keys and effects in both directions", async () => {
    const f = await fixture("cross-register", "bearer_vault"), p = (await prepare(f)).prepared.preparation, result = await register(f, p, "shared");
    const actionKey = result.action.acceptance.keySha256;
    for (const read of [readNativeConnectorAction, readNativeConnectorCredentialRemoval, readNativeConnectorTrash, readNativeConnectorCredentialRotation]) {
      expect(await read({ scope: f.scope }, actionKey)).toBeNull();
    }
    const review = (await reviewNativeConnector({ scope: f.scope }, "mcp", f.id))!, trash = await previewNativeConnectorTrash({ scope: f.scope }, f.id);
    const rotated = await prepareNativeConnectorCredential({ authority: authority(f), idempotencyKey: "old-rotation-prep", request: connectorNativeCredentialPrepareRequestSchema.parse({
      contract: "asael-connector-prepare:1", nonce: randomUUID(), operation: "rotate_mcp", connectorId: f.id, review: review.pin,
      declaration: nativeCredentialPreparationDeclaration(review), payload: { endpoint: null, specUrl: null, specText: null, bearerToken: "synthetic-cross-family" } }) });
    const oldProof = rotated.prepared.preparation, before = await snapshot(f);
    await expect(submitNativeConnectorAction({ authority: authority(f), idempotencyKey: "shared", request: {
      contract: "asael-connector-action:1", kind: "mcp", connectorId: f.id, action: "disable", review: review.pin! } })).rejects.toMatchObject({ status: 409 });
    await expect(submitNativeConnectorCredentialRemoval({ authority: authority(f), idempotencyKey: "shared", request: connectorNativeCredentialRemovalRequestSchema.parse({
      contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: f.id, action: "remove_credential", review: review.pin, preview: null }) })).rejects.toMatchObject({ status: 409 });
    await expect(submitNativeConnectorTrash({ authority: authority(f), idempotencyKey: "shared", request: connectorNativeTrashRequestSchema.parse({
      contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: f.id, action: "trash", review: trash.review!.pin, preview: trash.preview }) })).rejects.toMatchObject({ status: 409 });
    await expect(submitNativeConnectorCredentialRotation({ authority: authority(f), idempotencyKey: "shared", request: connectorNativeCredentialRotationRequestSchema.parse({
      contract: "asael-connector-prepared-action:1", kind: "mcp", connectorId: f.id, action: "rotate_mcp", preparationId: oldProof.id, preparationSha256: oldProof.preparationSha256, review: oldProof.review }) })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f)).toEqual(before);
    for (const family of ["state", "removal", "trash", "rotation"] as const) {
      const next = await fixture(`cross-${family}`), nextProof = (await prepare(next)).prepared.preparation;
      await oldAction(await legacy(`cross-${family}`, next.scope), family, "shared"); const preserved = await snapshot(next);
      expect(await readNativeMcpRegistration({ scope: next.scope }, keySha(next, "shared"))).toBeNull();
      await expect(register(next, nextProof, "shared")).rejects.toMatchObject({ status: 409 }); expect(await snapshot(next)).toEqual(preserved);
    }
  });

  test("strict SQL validators and immutable terminal rows preserve the distinct registration boundary", async () => {
    const f = await fixture("sql-contract", "bearer_vault"), proof = (await prepare(f)).prepared.preparation;
    const result = await register(f, proof), intent = buildConnectorNativeMcpRegistrationIntent(f.scope, "register", registrationRequest(proof));
    for (const invalid of [{ ...intent, request: { ...intent.request, review: {} } }, { ...intent, request: { ...intent.request, unexpected: true } },
      { ...intent, request: { ...intent.request, connectorId: "native:mcp:legacy-delimited" } }]) {
      expect(await admin`SELECT omni_native_connector_intent_valid_v5(${admin.json(invalid)},${admin.json(result.action.acceptance)}) AS valid`).toEqual([{ valid: false }]);
    }
    for (const change of [{ credentialVersion: 2 }, { connectorStatus: "active" }, { contractCount: 1 }, { unexpected: true }]) {
      const settlement = { ...result.action.settlement!, result: { ...result.action.settlement!.result, ...change } };
      expect(await admin`SELECT omni_native_connector_settlement_valid_v5(${admin.json(settlement)},${admin.json(result.action.acceptance)}) AS valid`).toEqual([{ valid: false }]);
    }
    const before = await snapshot(f);
    await expect(inOwner(f, () => getSql()`UPDATE omni_native_mcp_registration_preparations SET state='abandoned' WHERE id=${proof.id}`)).rejects.toMatchObject({ code: "55000" });
    await expect(inOwner(f, () => getSql()`DELETE FROM omni_native_mcp_registration_preparations WHERE id=${proof.id}`)).rejects.toMatchObject({ code: "42501" });
    await expect(inOwner(f, () => getSql()`UPDATE omni_native_connector_actions SET settlement=NULL WHERE id=${result.action.acceptance.id}`)).rejects.toMatchObject({ code: "55000" });
    expect(await snapshot(f)).toEqual(before);
  });

  test.each(["none", "bearer_vault"] as const)("SQL settlement must match the consumed %s proof's original authentication mode", async (auth) => {
    const f = await fixture(`sql-auth-${auth}`, auth), proof = (await prepare(f)).prepared.preparation;
    const intent = buildConnectorNativeMcpRegistrationIntent(f.scope, "forged-settlement", registrationRequest(proof)), before = await snapshot(f);
    await expect(inOwner(f, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const [time] = await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
      const acceptedAt = String(time.now), body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(f.scope, intent.keySha256),
        scope: f.scope, keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: f.id,
        action: "register_mcp", reviewSha256: proof.preparationSha256, acceptedAt };
      const acceptance = connectorNativeMcpRegistrationAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
      await sql`INSERT INTO omni_native_connector_actions(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,kind,connector_id,action,intent,acceptance,accepted_at,state)
        VALUES(${acceptance.id},${f.scope.tenantId},${owner},${canonical},${intent.keySha256},'mcp',${f.id},'register_mcp',${intent}::JSONB,${acceptance}::JSONB,${acceptedAt},'accepted')`;
      await sql`UPDATE omni_native_mcp_registration_preparations SET state='consumed',sealed_payload=NULL,consumed_by=${acceptance.id},consumed_key_sha256=${intent.keySha256} WHERE id=${proof.id}`;
      const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: acceptedAt, result: {
        kind: "mcp", connectorId: f.id, operation: "register_mcp", status: "complete", connectorStatus: "disabled", contractCount: 0,
        credentialVersion: auth === "bearer_vault" ? 0 : 1, connectorSha256: canonicalJsonSha256("synthetic connector"), contractsSha256: canonicalJsonSha256([]),
        configurationSha256: canonicalJsonSha256("synthetic configuration"), trash: null, failureCode: null } };
      const wrong = connectorNativeMcpRegistrationSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
      await sql`UPDATE omni_native_connector_actions SET state='settled',settlement=${wrong}::JSONB WHERE id=${acceptance.id}`;
    }))).rejects.toMatchObject({ code: "23514" });
    expect(await snapshot(f)).toEqual(before);
  });
});
