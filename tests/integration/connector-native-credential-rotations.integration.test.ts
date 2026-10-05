import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import { readNativeConnectorAction, reviewNativeConnector, submitNativeConnectorAction } from "@/lib/connectors/native-control-store";
import { readNativeConnectorCredentialRemoval, submitNativeConnectorCredentialRemoval } from "@/lib/connectors/native-credential-removal-store";
import { previewNativeConnectorTrash, readNativeConnectorTrash, submitNativeConnectorTrash } from "@/lib/connectors/native-trash-store";
import { connectorNativeTrashRequestSchema } from "@/lib/connectors/native-trash-contracts";
import { connectorNativeCredentialRemovalRequestSchema } from "@/lib/connectors/native-credential-removal-contracts";
import { connectorNativeKeySha256, connectorNativePreparationId, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialPreparationIntent, buildConnectorNativeCredentialRotationIntent, nativeCredentialPreparationDeclaration, connectorNativeCredentialPrepareRequestSchema,
  connectorNativeCredentialPreparationSchema, connectorNativeCredentialPreparationAbandonRequestSchema, connectorNativeCredentialRotationRequestSchema,
  type ConnectorNativeCredentialPreparation } from "@/lib/connectors/native-credential-rotation-contracts";
import { prepareNativeConnectorCredential, readNativeConnectorCredentialPreparation, abandonNativeConnectorCredentialPreparation,
  submitNativeConnectorCredentialRotation, readNativeConnectorCredentialRotation, scrubExpiredNativeConnectorCredentialPreparations,
  nativeCredentialPreparationBinding } from "@/lib/connectors/native-credential-rotation-store";
import { connectorNativePrivateDigest } from "@/lib/connectors/native-control-private";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sealCredentialBundle, openCredentialBundle } from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { removeNativeConnectorCredentialRotationsForReplay, removeNativeMcpRegistrationsForReplay, removeNativeOpenapiImportsForReplay, removeNativeMcpDiscoveriesForReplay, removeNativeGithubUpgradesForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "rotation-owner@example.test", other = "rotation-other@example.test", canonical = `actor:${user}`;
const runtimeRole = "connector_rotation_test_runtime", maintenanceRole = "connector_rotation_test_maintenance";

integration("prepared MCP credential rotation under serving-role RLS", () => {
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
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools,omni_openapi_connectors,omni_openapi_operations TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${runtimeRole}`); await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture'),(${otherUser},${other},'fixture')`;
    const serving = new URL(databaseUrl!), maintenance = new URL(databaseUrl!);
    serving.username = runtimeRole; serving.password = password; maintenance.username = maintenanceRole; maintenance.password = maintenancePassword;
    await closeDatabaseClient();
    vi.stubEnv("DATABASE_URL", serving.toString()); vi.stubEnv("OMNIAGENT_MAINTENANCE_DATABASE_URL", maintenance.toString());
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    keyring = JSON.stringify({ activeKeyId: "rotation-fixture", keys: { "rotation-fixture": randomBytes(32).toString("base64url") } });
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("rotation-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_connector_credential_preparations') AS preparation_rls,
      row_security_active('omni_native_connector_actions') AS action_rls,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS registry_read
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toEqual({ role: runtimeRole, rolsuper: false, rolbypassrls: false, preparation_rls: true, action_rls: true, registry_read: false });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) { if (rolesCreated) for (const role of [runtimeRole, maintenanceRole]) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); } await admin.end(); }
  });

  async function fixture(tag: string, version = 2) {
    const scope: ConnectorNativeScope = { tenantId: `rotation-${tag}`, ownerActorId: owner, canonicalActorId: canonical }, id = `mcp-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const who of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${who}`},${scope.tenantId},${who},'admin')`;
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,transport,auth_type,status,tool_count,last_discovered_at,credential_version,
      credential_key_id,credential_fingerprint,credential_origin,sealed_credential,credential_created_by,credential_created_at,capabilities,instructions)
      VALUES(${id},${scope.tenantId},'Fixture MCP','https://example.test/mcp?private=fixture','streamable_http',${version ? "bearer_vault" : "none"},'active',1,clock_timestamp(),
        ${version || null},${version ? "fixture-key" : null},${version ? canonicalJsonSha256("synthetic old credential").slice(0,12) : null},
        ${version ? "https://example.test" : null},${version ? admin.json({ encrypted: "synthetic-old-vault-payload" }) : null},${version ? owner : null},
        ${version ? new Date().toISOString() : null},${admin.json({ tools: {} })},'discovery metadata')`;
    await admin`INSERT INTO omni_mcp_tools(id,tenant_id,connector_id,connector_name,name,input_schema,status)
      VALUES(${`${id}:tool`},${scope.tenantId},${id},'Fixture MCP','fixture_read',${admin.json({ type: "object", properties: {} })},'active')`;
    const review = (await reviewNativeConnector({ scope }, "mcp", id))!;
    const request = connectorNativeCredentialPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", nonce: randomUUID(), operation: "rotate_mcp",
      connectorId: id, review: review.pin, declaration: nativeCredentialPreparationDeclaration(review),
      payload: { endpoint: null, specUrl: null, specText: null, bearerToken: `synthetic-new-credential-${tag}` } });
    return { scope, id, request, review };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function authority(f: Fixture, cleanup = false) { return { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId,
    initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner, correlationId: "rotation-fixture", causationId: f.id,
    purpose: cleanup ? "api.connectors.native.preparation.abandon" : "api.connectors.native.action" }) }; }
  const prepare = (f: Fixture, key = "prepare", request = f.request) => prepareNativeConnectorCredential({ authority: authority(f), request, idempotencyKey: key });
  const keySha = (f: Fixture, key = "prepare") => connectorNativeKeySha256(f.scope, key);
  const inOwner = <T,>(f: Fixture, operation: () => Promise<T>) => runWithDatabaseActorScope(f.scope.tenantId, [owner, canonical], operation);
  function rotationRequest(proof: ConnectorNativeCredentialPreparation) { return connectorNativeCredentialRotationRequestSchema.parse({
    contract: "asael-connector-prepared-action:1", kind: "mcp", connectorId: proof.connectorId, action: "rotate_mcp",
    preparationId: proof.id, preparationSha256: proof.preparationSha256, review: proof.review }); }
  const rotate = (f: Fixture, proof: ConnectorNativeCredentialPreparation, key = "rotate") => submitNativeConnectorCredentialRotation({ authority: authority(f), request: rotationRequest(proof), idempotencyKey: key });
  const abandon = (f: Fixture, key = "prepare") => abandonNativeConnectorCredentialPreparation({ authority: authority(f, true), keySha256: keySha(f, key), idempotencyKey: key,
    request: connectorNativeCredentialPreparationAbandonRequestSchema.parse({ contract: "asael-connector-credential-preparation-abandon:1", intent: buildConnectorNativeCredentialPreparationIntent(f.scope, key, f.request) }) });
  async function snapshot(f: Fixture) { return { connector: (await admin`SELECT * FROM omni_mcp_connectors WHERE id=${f.id}`)[0],
    tools: await admin`SELECT * FROM omni_mcp_tools WHERE connector_id=${f.id} ORDER BY id`,
    preparations: await admin`SELECT * FROM omni_native_connector_credential_preparations WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    actions: await admin`SELECT * FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    events: await admin`SELECT id,type,payload FROM omni_events WHERE tenant_id=${f.scope.tenantId} ORDER BY seq` }; }
  async function failEvent(f: Fixture, event: string, operation: () => Promise<void>) {
    await admin`CREATE FUNCTION fail_rotation_fixture_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id=TG_ARGV[0] AND NEW.type=TG_ARGV[1] THEN RAISE EXCEPTION 'synthetic event rollback'; END IF; RETURN NEW; END $$`;
    await admin.unsafe(`CREATE TRIGGER fail_rotation_fixture_event BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION fail_rotation_fixture_event('${f.scope.tenantId}','${event}')`);
    try { await operation(); } finally { await admin`DROP TRIGGER fail_rotation_fixture_event ON omni_events`; await admin`DROP FUNCTION fail_rotation_fixture_event()`; }
  }

  // Only the superuser fixture simulates elapsed server time. Production guards
  // remain enabled before any serving-role operation or maintenance call.
  async function shiftPreparation(f: Fixture, proof: ConnectorNativeCredentialPreparation, remainingMs: number) {
    const [server] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
    const expiresAt = new Date(Date.parse(String(server.now)) + remainingMs).toISOString();
    const { preparationSha256: _digest, ...body } = proof;
    const shifted = { ...body, preparedAt: new Date(Date.parse(expiresAt) - 900_000).toISOString(), expiresAt };
    const next = connectorNativeCredentialPreparationSchema.parse({ ...shifted, preparationSha256: canonicalJsonSha256(shifted) });
    const sealed = sealCredentialBundle({ bearerToken: f.request.payload.bearerToken }, nativeCredentialPreparationBinding(next));
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_connector_credential_preparations DISABLE TRIGGER omni_native_credential_preparation_guard`;
      await sql`UPDATE omni_native_connector_credential_preparations SET preparation=${sql.json(next)},expires_at=${expiresAt},sealed_payload=${sql.json(sealed)} WHERE id=${proof.id}`;
      await sql`ALTER TABLE omni_native_connector_credential_preparations ENABLE TRIGGER omni_native_credential_preparation_guard`;
    });
    return next;
  }

  test("240 replays over239 with all three previous native receipt families unchanged", async () => {
    const state = await fixture("replay-state"), removal = await fixture("replay-removal"), trash = await fixture("replay-trash");
    await submitNativeConnectorAction({ authority: authority(state), idempotencyKey: "state", request: { contract: "asael-connector-action:1", kind: "mcp", connectorId: state.id, action: "disable", review: state.request.review } });
    await submitNativeConnectorCredentialRemoval({ authority: authority(removal), idempotencyKey: "removal", request: connectorNativeCredentialRemovalRequestSchema.parse({
      contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: removal.id, action: "remove_credential", review: removal.request.review, preview: null }) });
    const preview = await previewNativeConnectorTrash({ scope: trash.scope }, trash.id);
    await submitNativeConnectorTrash({ authority: authority(trash), idempotencyKey: "trash", request: connectorNativeTrashRequestSchema.parse({
      contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: trash.id, action: "trash", review: preview.review!.pin, preview: preview.preview }) });
    const before = await admin`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions ORDER BY id`;
    const row = databaseSchemaMigrations.find((migration) => migration.version === 240)!;
    const migration = await readSqlMigrationFile({ file: "20261005200000_native_connector_credential_rotations.sql", sha256: row.checksum, migrations: [row] });
    const registration = databaseSchemaMigrations.find((migration) => migration.version === 241)!;
    const registrationMigration = await readSqlMigrationFile({ file: "20261005203000_native_mcp_registrations.sql", sha256: registration.checksum, migrations: [registration] });
    const openapiImport = databaseSchemaMigrations.find((migration) => migration.version === 242)!;
    const openapiImportMigration = await readSqlMigrationFile({ file: "20261005210000_native_openapi_imports.sql", sha256: openapiImport.checksum, migrations: [openapiImport] });
    const discovery = databaseSchemaMigrations.find((migration) => migration.version === 243)!;
    const discoveryMigration = await readSqlMigrationFile({ file: "20261006100000_native_mcp_discoveries.sql", sha256: discovery.checksum, migrations: [discovery] });
    const githubUpgrade = databaseSchemaMigrations.find((migration) => migration.version === 244)!;
    const githubUpgradeMigration = await readSqlMigrationFile({ file: "20261006103000_native_github_upgrades.sql", sha256: githubUpgrade.checksum, migrations: [githubUpgrade] });
    await admin.begin(async (sql) => {
      await removeNativeGithubUpgradesForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=244`;
      await removeNativeMcpDiscoveriesForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=243`;
      await removeNativeOpenapiImportsForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=242`;
      await removeNativeMcpRegistrationsForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=241`;
      await removeNativeConnectorCredentialRotationsForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=240`;
      const migrationSql: Parameters<typeof applySqlMigrationFile>[0] = { unsafe: async (text, params) => {
        const values = (params ?? []).map((value) => { if (typeof value !== "string") throw new Error("Migration settings must be strings."); return value; });
        return await sql.unsafe<Record<string, unknown>[]>(text, values);
      } };
      await applySqlMigrationFile(migrationSql, migration, [row], []);
      await applySqlMigrationFile(migrationSql, registrationMigration, [registration], []);
      await applySqlMigrationFile(migrationSql, openapiImportMigration, [openapiImport], []);
      await applySqlMigrationFile(migrationSql, discoveryMigration, [discovery], []);
      await applySqlMigrationFile(migrationSql, githubUpgradeMigration, [githubUpgrade], []);
      expect(await sql`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions ORDER BY id`).toEqual(before);
    });
  });

  test("concurrent same-key preparation stages once, hides the token and rejects a changed payload", async () => {
    const f = await fixture("prepare-once"), initial = await snapshot(f);
    expect(await readNativeConnectorCredentialPreparation({ scope: f.scope }, keySha(f))).toBeNull();
    const pair = await Promise.all([prepare(f), prepare(f)]);
    expect(pair.map((v) => v.replayed).sort()).toEqual([false, true]); expect(pair[0].prepared).toEqual(pair[1].prepared);
    const after = await snapshot(f);
    expect(after.connector).toEqual(initial.connector); expect(after.tools).toEqual(initial.tools);
    expect(after.preparations).toHaveLength(1); expect(after.events.map((event) => event.type)).toEqual(["connector.native.credential_preparation.prepared"]);
    expect(JSON.stringify([pair, after.events, after.preparations[0].sealed_payload])).not.toContain(f.request.payload.bearerToken);
    expect(JSON.stringify(pair)).not.toContain("payload_commitment");
    await expect(prepare(f, "prepare", connectorNativeCredentialPrepareRequestSchema.parse({ ...f.request,
      payload: { ...f.request.payload, bearerToken: "different-synthetic-value" } }))).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f)).toEqual(after);
  });

  test.each([0, 2])("version %s saves exactly once, disables tools and leaves exact consumed/action recovery", async (version) => {
    const f = await fixture(`rotate-${version}`, version), p = (await prepare(f)).prepared.preparation;
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Rotation must remain local"));
    try {
      const pair = await Promise.all([rotate(f, p), rotate(f, p)]);
      expect(pair.map((v) => v.replayed).sort()).toEqual([false, true]); expect(pair[0].action).toEqual(pair[1].action);
      expect(pair[0].action.settlement?.result).toMatchObject({ status: "complete", connectorStatus: "disabled", contractCount: 0, credentialVersion: version + 1 });
      const after = await snapshot(f);
      expect(after.connector).toMatchObject({ auth_type: "bearer_vault", status: "disabled", tool_count: 0, credential_version: version + 1,
        last_discovered_at: null, instructions: null, server_version: null, capabilities: {} });
      expect(after.tools).toHaveLength(0); expect(after.actions).toHaveLength(1); expect(after.events).toHaveLength(4);
      expect(after.preparations[0]).toMatchObject({ state: "consumed", sealed_payload: null, consumed_by: pair[0].action.acceptance.id,
        consumed_key_sha256: pair[0].action.acceptance.keySha256 });
      expect(await readNativeConnectorCredentialPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "consumed",
        consumedKeySha256: pair[0].action.acceptance.keySha256 });
      expect(await readNativeConnectorCredentialRotation({ scope: f.scope }, pair[0].action.acceptance.keySha256)).toEqual(pair[0].action);
      await expect(rotate(f, p, "another-action")).rejects.toMatchObject({ status: 409 });
      await expect(abandon(f)).rejects.toMatchObject({ status: 409 });
      expect(outbound).not.toHaveBeenCalled();
    } finally { outbound.mockRestore(); }
  });

  test("absent-key tombstone fences late prepare without inventing proof or changing the connector", async () => {
    const f = await fixture("absent-abandon"), initial = await snapshot(f), closed = await abandon(f);
    expect(closed.prepared).toMatchObject({ availability: "abandoned", preparation: null, abandonment: { preparationSha256: null } });
    expect(await abandon(f)).toEqual({ prepared: closed.prepared, replayed: true });
    await expect(prepare(f)).rejects.toMatchObject({ status: 409 });
    expect(await readNativeConnectorCredentialPreparation({ scope: f.scope }, keySha(f))).toEqual(closed.prepared);
    const after = await snapshot(f);
    expect(after.connector).toEqual(initial.connector); expect(after.tools).toEqual(initial.tools); expect(after.actions).toHaveLength(0);
    expect(after.preparations[0]).toMatchObject({ state: "abandoned", expires_at: null, sealed_payload: null, payload_commitment: null });
    expect(after.events).toHaveLength(1);
  });

  test("prepare/abandon and consume/abandon races have one terminal winner", async () => {
    const f = await fixture("prepare-abandon-race");
    const results = await Promise.allSettled([prepare(f), abandon(f)]);
    expect(results[1].status).toBe("fulfilled");
    expect(await readNativeConnectorCredentialPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "abandoned" });
    const ready = await fixture("consume-abandon-race"), p = (await prepare(ready)).prepared.preparation;
    const raced = await Promise.allSettled([rotate(ready, p), abandon(ready)]);
    expect(raced.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const after = await snapshot(ready);
    expect(["consumed", "abandoned"]).toContain(after.preparations[0].state);
    expect(after.preparations[0].sealed_payload).toBeNull();
    expect(after.actions.length).toBe(after.preparations[0].state === "consumed" ? 1 : 0);
  });

  test.each(["connector.native.credential_preparation.prepared", "connector.native.credential_preparation.abandoned"])("%s failure rolls preparation back and the original key can recover", async (event) => {
    const f = await fixture(event.endsWith("prepared") ? "fail-prepare" : "fail-abandon"), isPrepare = event.endsWith("prepared");
    if (!isPrepare) await prepare(f);
    const before = await snapshot(f);
    await failEvent(f, event, async () => { await expect(isPrepare ? prepare(f) : abandon(f)).rejects.toThrow("synthetic event rollback"); expect(await snapshot(f)).toEqual(before); });
    if (isPrepare) expect((await prepare(f)).replayed).toBe(false); else expect((await abandon(f)).replayed).toBe(false);
  });

  test.each(["connector.mcp.credential_rotated", "connector.native.action.settled"])("%s failure restores credential/tools/staging and all native evidence", async (event) => {
    const f = await fixture(event.includes("rotated") ? "fail-credential" : "fail-settlement"), p = (await prepare(f)).prepared.preparation, before = await snapshot(f);
    await failEvent(f, event, async () => { await expect(rotate(f, p)).rejects.toThrow("synthetic event rollback"); expect(await snapshot(f)).toEqual(before); });
    expect((await rotate(f, p)).replayed).toBe(false);
  });

  test("role loss permits only own-stage cleanup, while aliases, tenants and inactive owners remain fenced", async () => {
    const f = await fixture("owner-cleanup"), p = (await prepare(f)).prepared.preparation;
    expect(await readNativeConnectorCredentialPreparation({ scope: { ...f.scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` } }, keySha(f))).toBeNull();
    expect(await runWithDatabaseTenantScope(f.scope.tenantId, () => getSql()`SELECT id FROM omni_native_connector_credential_preparations`)).toEqual([]);
    await expect(readNativeConnectorCredentialPreparation({ scope: { ...f.scope, ownerActorId: owner.toUpperCase() } }, keySha(f))).rejects.toMatchObject({ status: 403 });
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    expect(await readNativeConnectorCredentialPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "ready" });
    await expect(prepare(f, "new-key")).rejects.toMatchObject({ status: 403 });
    await expect(rotate(f, p)).rejects.toMatchObject({ status: 403 });
    expect((await abandon(f)).prepared.availability).toBe("abandoned");
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(readNativeConnectorCredentialPreparation({ scope: f.scope }, keySha(f))).rejects.toMatchObject({ status: 403 });
  });

  test("complete target drift and missing keyring fail before credential or staging consumption", async () => {
    const f = await fixture("drift"), p = (await prepare(f)).prepared.preparation;
    await admin`UPDATE omni_mcp_tools SET input_schema=${admin.json({ type: "object", additionalProperties: false })} WHERE connector_id=${f.id}`;
    const changed = await snapshot(f);
    await expect(rotate(f, p)).rejects.toMatchObject({ status: 409 }); expect(await snapshot(f)).toEqual(changed);
    const noKey = await fixture("missing-key"), staged = (await prepare(noKey)).prepared.preparation, before = await snapshot(noKey);
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    try { await expect(rotate(noKey, staged)).rejects.toMatchObject({ status: 503 }); expect(await snapshot(noKey)).toEqual(before);
      expect((await abandon(noKey)).prepared.availability).toBe("abandoned");
    } finally { vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); }
  });

  test("fresh database time rejects expiry after waiting for the connector lock", async () => {
    const f = await fixture("expiry-lock");
    const [timing] = await inOwner(f, () => getSql()`SELECT EXTRACT(EPOCH FROM current_setting('lock_timeout')::INTERVAL)*1000 AS lock_timeout_ms`);
    // Cross expiry while the real serving lock budget still permits the waiter
    // to resume; a lock-timeout error would not exercise the fresh-time check.
    const remainingMs = Math.floor(Number(timing.lock_timeout_ms) / 2);
    expect(remainingMs).toBeGreaterThan(0);
    const p = await shiftPreparation(f, (await prepare(f)).prepared.preparation, remainingMs), before = await snapshot(f);
    let outcome!: Promise<unknown>;
    await admin.begin(async (sql) => {
      await sql`SELECT id FROM omni_mcp_connectors WHERE id=${f.id} FOR UPDATE`;
      outcome = rotate(f, p).then((value) => value, (error: unknown) => error);
      let startedAt: string | null = null;
      const pollDeadline = Date.now() + 3000;
      while (!startedAt && Date.now() < pollDeadline) {
        const waiting = await admin`SELECT to_char(xact_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
          FROM pg_stat_activity WHERE usename=${runtimeRole} AND wait_event_type='Lock' AND query LIKE '%omni_mcp_connectors%' LIMIT 1`;
        startedAt = waiting.length ? String(waiting[0].started_at) : null;
        if (!startedAt) await admin`SELECT pg_sleep(0.01)`;
      }
      expect(startedAt).not.toBeNull();
      expect(Date.parse(startedAt!)).toBeLessThan(Date.parse(p.expiresAt));
      await sql`SELECT pg_sleep(LEAST(${remainingMs / 1000 + 0.1},GREATEST(0,EXTRACT(EPOCH FROM (${p.expiresAt}::TIMESTAMPTZ-clock_timestamp()))+0.025)))`;
      expect((await sql`SELECT clock_timestamp()>=${p.expiresAt}::TIMESTAMPTZ AS expired`)[0].expired).toBe(true);
    });
    expect(await outcome).toMatchObject({ status: 409 });
    expect(await snapshot(f)).toEqual(before);
    expect(await readNativeConnectorCredentialPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "expired" });
    expect((await snapshot(f)).preparations[0].sealed_payload).not.toBeNull();
    expect((await abandon(f)).prepared.availability).toBe("abandoned");
  });

  test("full-digest AAD authenticates every scope/expiry byte, including tuple fields beyond a raw binding limit", async () => {
    const f = await fixture("aad"), p = (await prepare(f)).prepared.preparation;
    const long = { ...p, scope: { ...p.scope, ownerActorId: "x".repeat(320) }, connectorId: "x".repeat(200) };
    const binding = nativeCredentialPreparationBinding(long), sealed = sealCredentialBundle({ bearerToken: "synthetic-aad-value" }, binding);
    expect(binding.length).toBeLessThan(1000);
    expect(openCredentialBundle(sealed, binding)).toEqual({ bearerToken: "synthetic-aad-value" });
    for (const changed of [{ ...long, expiresAt: "2026-10-05T23:59:59.999Z" }, { ...long, scope: { ...long.scope, tenantId: "other-tenant" } },
      { ...long, review: { ...long.review, configurationSha256: canonicalJsonSha256("another configuration") } }]) {
      expect(() => openCredentialBundle(sealed, nativeCredentialPreparationBinding(changed))).toThrow("could not be authenticated");
    }
  });

  test("bounded maintenance clamps at100, skips locks and scrubs inactive owners without vault access", async () => {
    const f = await fixture("scrub"), proof = await shiftPreparation(f, (await prepare(f)).prepared.preparation, -1000);
    const fresh = await prepare(f, "fresh-control"), terminal = await prepare(f, "abandoned-control");
    await abandon(f, "abandoned-control");
    const untouched = await fixture("scrub-other"), otherProof = await shiftPreparation(untouched, (await prepare(untouched)).prepared.preparation, -1000);
    const rows = Array.from({ length: 100 }, (_, index) => {
      const intent = buildConnectorNativeCredentialPreparationIntent(f.scope, `scrub-copy-${index}`, f.request);
      const { contract: _contract, ...safe } = intent;
      const { preparationSha256: _digest, ...original } = proof;
      const body = { ...original, ...safe, id: connectorNativePreparationId(f.scope, intent.keySha256), intentSha256: canonicalJsonSha256(intent) };
      const prepared = connectorNativeCredentialPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
      return { id: prepared.id, tenant_id: f.scope.tenantId, owner_actor_id: owner, canonical_actor_id: canonical, idempotency_key_sha256: intent.keySha256,
        connector_id: f.id, intent, preparation: prepared, state: "ready", expires_at: prepared.expiresAt,
        sealed_payload: sealCredentialBundle({ bearerToken: f.request.payload.bearerToken }, nativeCredentialPreparationBinding(prepared)),
        payload_commitment: connectorNativePrivateDigest(f.scope.tenantId, ["native-credential-preparation-payload:1", f.scope, intent.keySha256, f.request.payload.bearerToken]) };
    });
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_connector_credential_preparations DISABLE TRIGGER omni_native_credential_preparation_guard`;
      await sql`INSERT INTO omni_native_connector_credential_preparations(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,
        connector_id,intent,preparation,state,expires_at,sealed_payload,payload_commitment)
        SELECT * FROM jsonb_to_recordset(${sql.json(rows)}) AS seed(id TEXT,tenant_id TEXT,owner_actor_id TEXT,canonical_actor_id TEXT,
          idempotency_key_sha256 TEXT,connector_id TEXT,intent JSONB,preparation JSONB,state TEXT,expires_at TIMESTAMPTZ,sealed_payload JSONB,payload_commitment TEXT)`;
      await sql`ALTER TABLE omni_native_connector_credential_preparations ENABLE TRIGGER omni_native_credential_preparation_guard`;
    });
    const beforeForgedScope = await snapshot(f);
    await inOwner(f, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      await sql`SELECT set_config('omni.system_scope','true',true),set_config('omni.system_reason','forged fixture maintenance',true)`;
      expect(await sql`SELECT omni_system_scope_enabled() AS enabled`).toEqual([{ enabled: false }]);
      // Forced RLS hides this row before the UPDATE trigger can reject it.
      expect(await sql`SELECT id FROM omni_native_connector_credential_preparations WHERE id=${proof.id}`).toEqual([]);
      expect(await sql`UPDATE omni_native_connector_credential_preparations SET state='expired',sealed_payload=NULL WHERE id=${proof.id} RETURNING id`).toEqual([]);
    }));
    expect(await snapshot(f)).toEqual(beforeForgedScope);
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    try {
      const first = await scrubExpiredNativeConnectorCredentialPreparations({ tenantId: f.scope.tenantId, limit: 10_000, deadlineAt: Date.now() + 5000 });
      expect(first).toMatchObject({ status: "complete", scrubbed: 100, moreAvailable: true }); expect(first.oldestExpiredAt).not.toBeNull();
      const pending = (await admin`SELECT id FROM omni_native_connector_credential_preparations WHERE tenant_id=${f.scope.tenantId} AND state='ready' AND expires_at<clock_timestamp()`)[0];
      await admin.begin(async (sql) => {
        await sql`SELECT id FROM omni_native_connector_credential_preparations WHERE id=${pending.id} FOR UPDATE`;
        expect(await scrubExpiredNativeConnectorCredentialPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 })).toMatchObject({ status: "complete", scrubbed: 0, moreAvailable: true });
      });
      expect(await scrubExpiredNativeConnectorCredentialPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 }))
        .toEqual({ status: "complete", scrubbed: 1, moreAvailable: false, oldestExpiredAt: null });
    } finally { vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); }
    expect((await admin`SELECT state,sealed_payload IS NOT NULL AS sealed FROM omni_native_connector_credential_preparations WHERE id=${fresh.prepared.preparation.id}`)[0]).toEqual({ state: "ready", sealed: true });
    expect((await admin`SELECT state,sealed_payload FROM omni_native_connector_credential_preparations WHERE id=${terminal.prepared.preparation.id}`)[0]).toEqual({ state: "abandoned", sealed_payload: null });
    expect((await admin`SELECT sealed_payload IS NOT NULL AS sealed FROM omni_native_connector_credential_preparations WHERE id=${otherProof.id}`)[0].sealed).toBe(true);
    expect(await scrubExpiredNativeConnectorCredentialPreparations({ tenantId: untouched.scope.tenantId, deadlineAt: Date.now() - 1 }))
      .toEqual({ status: "deferred", scrubbed: 0, moreAvailable: true, oldestExpiredAt: null });
  }, 120_000);

  test("a timed-out scrub rolls back and leaves the same row for the next bounded pass", async () => {
    const f = await fixture("scrub-timeout"); await shiftPreparation(f, (await prepare(f)).prepared.preparation, -1000);
    const before = await snapshot(f);
    await admin.begin(async (sql) => {
      await sql`LOCK TABLE omni_native_connector_credential_preparations IN ACCESS EXCLUSIVE MODE`;
      await expect(scrubExpiredNativeConnectorCredentialPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 500 })).rejects.toMatchObject({ code: "57014" });
    });
    expect(await snapshot(f)).toEqual(before);
    expect(await scrubExpiredNativeConnectorCredentialPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 })).toMatchObject({ status: "complete", scrubbed: 1 });
  });

  test("prior-family keys are isolated from rotation parsers and effects in both directions", async () => {
    const f = await fixture("cross-rotation"), proof = (await prepare(f)).prepared.preparation, result = await rotate(f, proof, "shared"), before = await snapshot(f);
    const actionKey = result.action.acceptance.keySha256;
    expect(await readNativeConnectorAction({ scope: f.scope }, actionKey)).toBeNull();
    expect(await readNativeConnectorCredentialRemoval({ scope: f.scope }, actionKey)).toBeNull();
    expect(await readNativeConnectorTrash({ scope: f.scope }, actionKey)).toBeNull();
    await expect(submitNativeConnectorAction({ authority: authority(f), idempotencyKey: "shared", request: { contract: "asael-connector-action:1", kind: "mcp", connectorId: f.id,
      action: "disable", review: f.request.review } })).rejects.toMatchObject({ status: 409 });
    await expect(submitNativeConnectorCredentialRemoval({ authority: authority(f), idempotencyKey: "shared", request: connectorNativeCredentialRemovalRequestSchema.parse({
      contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: f.id, action: "remove_credential", review: f.request.review, preview: null }) })).rejects.toMatchObject({ status: 409 });
    const latestTrash = await previewNativeConnectorTrash({ scope: f.scope }, f.id);
    await expect(submitNativeConnectorTrash({ authority: authority(f), idempotencyKey: "shared", request: connectorNativeTrashRequestSchema.parse({
      contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: f.id, action: "trash", review: latestTrash.review!.pin, preview: latestTrash.preview }) })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f)).toEqual(before);
    for (const family of ["state", "removal", "trash"] as const) {
      const old = await fixture(`cross-${family}`), p = (await prepare(old)).prepared.preparation;
      if (family === "state") await submitNativeConnectorAction({ authority: authority(old), idempotencyKey: "shared", request: { contract: "asael-connector-action:1", kind: "mcp", connectorId: old.id, action: "disable", review: old.request.review } });
      else if (family === "removal") await submitNativeConnectorCredentialRemoval({ authority: authority(old), idempotencyKey: "shared", request: connectorNativeCredentialRemovalRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: old.id, action: "remove_credential", review: old.request.review, preview: null }) });
      else { const preview = await previewNativeConnectorTrash({ scope: old.scope }, old.id); await submitNativeConnectorTrash({ authority: authority(old), idempotencyKey: "shared", request: connectorNativeTrashRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: old.id, action: "trash", review: preview.review!.pin, preview: preview.preview }) }); }
      const preserved = await snapshot(old);
      expect(await readNativeConnectorCredentialRotation({ scope: old.scope }, keySha(old, "shared"))).toBeNull();
      await expect(rotate(old, p, "shared")).rejects.toMatchObject({ status: 409 }); expect(await snapshot(old)).toEqual(preserved);
    }
  });

  test("serving validators and immutable evidence reject malformed rotation and forged cleanup writes", async () => {
    const f = await fixture("database-shapes"), p = (await prepare(f)).prepared.preparation, result = await rotate(f, p);
    const intent = buildConnectorNativeCredentialRotationIntent(f.scope, "rotate", rotationRequest(p)), a = result.action.acceptance, s = result.action.settlement!;
    await inOwner(f, async () => {
      const sql = getSql();
      expect(await sql`SELECT omni_native_connector_intent_valid_v4(${intent}::JSONB,${a}::JSONB) AS valid`).toEqual([{ valid: true }]);
      for (const patch of [{ action: "register_mcp" }, { bearerToken: "synthetic-not-allowed" }, { preparationSha256: canonicalJsonSha256("wrong preparation") }]) {
        const invalid = { ...intent, request: { ...intent.request, ...patch } };
        expect(await sql`SELECT omni_native_connector_intent_valid_v4(${invalid}::JSONB,${a}::JSONB) AS valid`).toEqual([{ valid: false }]);
      }
      for (const patch of [{ credentialVersion: 0 }, { connectorStatus: "active" }, { contractCount: 1 }, { providerRevoked: true }]) {
        const invalid = { ...s, result: { ...s.result, ...patch } };
        expect(await sql`SELECT omni_native_connector_settlement_valid_v4(${invalid}::JSONB,${a}::JSONB) AS valid`).toEqual([{ valid: false }]);
      }
    });
    await expect(inOwner(f, () => getSql()`UPDATE omni_native_connector_credential_preparations SET state='abandoned' WHERE id=${p.id}`)).rejects.toMatchObject({ code: "55000" });
    await expect(inOwner(f, () => getSql()`DELETE FROM omni_native_connector_credential_preparations WHERE id=${p.id}`)).rejects.toMatchObject({ code: "42501" });
    const tombstone = await fixture("database-tombstone"), closed = await abandon(tombstone), id = connectorNativePreparationId(tombstone.scope, keySha(tombstone));
    await expect(inOwner(tombstone, () => getSql()`UPDATE omni_native_connector_credential_preparations SET state='ready' WHERE id=${id}`)).rejects.toMatchObject({ code: "55000" });
    expect(await readNativeConnectorCredentialPreparation({ scope: tombstone.scope }, keySha(tombstone))).toEqual(closed.prepared);
  });
});
