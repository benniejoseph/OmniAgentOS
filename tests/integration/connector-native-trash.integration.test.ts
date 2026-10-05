import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import { readNativeConnectorAction, reviewNativeConnector, submitNativeConnectorAction } from "@/lib/connectors/native-control-store";
import { connectorNativeActionSchema, connectorNativeTrashTarget, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import { readNativeConnectorCredentialRemoval, submitNativeConnectorCredentialRemoval } from "@/lib/connectors/native-credential-removal-store";
import { connectorNativeCredentialRemovalActionSchema } from "@/lib/connectors/native-credential-removal-contracts";
import { previewNativeConnectorTrash, readNativeConnectorTrash, submitNativeConnectorTrash } from "@/lib/connectors/native-trash-store";
import { buildConnectorNativeTrashIntent, connectorNativeTrashRequestSchema } from "@/lib/connectors/native-trash-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { createTrashEntry, createTrashLifecyclePreview } from "@/lib/trash/store";
import { buildTrashActionPreviewV1 } from "@/lib/trash/contracts";
import { captureRestorableResource, compensationForSnapshot, restoreTrashResource } from "@/lib/trash/resources";
import { removeNativeConnectorTrashForReplay, removeNativeConnectorCredentialRotationsForReplay, removeNativeMcpRegistrationsForReplay, removeNativeOpenapiImportsForReplay, removeNativeMcpDiscoveriesForReplay, removeNativeGithubUpgradesForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "trash-owner@example.test", other = "trash-other@example.test", canonical = `actor:${user}`, roleName = "connector_trash_test_runtime";
integration("native MCP Trash under forced serving RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    // Only the existing legacy serving grants. Trash/native grants come from the migrations.
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools,omni_openapi_connectors,omni_openapi_operations TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${roleName}`); await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture'),(${otherUser},${other},'fixture')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex")); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("trash-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_connector_actions') AS native_rls,row_security_active('omni_trash_items') AS trash_rls,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS registry_read,
      has_function_privilege(current_user,'public.omni_native_connector_intent_valid_v3(jsonb,jsonb)','EXECUTE') AS intent_check,
      has_function_privilege(current_user,'public.omni_native_connector_settlement_valid_v3(jsonb,jsonb)','EXECUTE') AS settlement_check
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, native_rls: true, trash_rls: true,
      registry_read: false, intent_check: true, settlement_check: true });
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); } await admin.end(); } });

  async function fixture(tag: string) {
    const scope: ConnectorNativeScope = { tenantId: `connector-trash-${tag}`, ownerActorId: owner, canonicalActorId: canonical }, id = `trash-mcp-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const who of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${who}`},${scope.tenantId},${who},'admin')`;
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,transport,auth_type,status,tool_count,last_discovered_at,
      credential_version,credential_key_id,credential_fingerprint,credential_origin,sealed_credential,capabilities,instructions)
      VALUES(${id},${scope.tenantId},'Notes MCP','https://example.test/mcp?secret=private-endpoint-fixture','streamable_http','bearer_vault','active',1,clock_timestamp(),
        2,'fixture-key',${canonicalJsonSha256("Trash fixture fingerprint").slice(0, 12)},'https://example.test',${admin.json({ encrypted: "opaque-never-decrypt-fixture" })},${admin.json({ tools: {} })},'discovered instructions')`;
    await admin`INSERT INTO omni_mcp_tools(id,tenant_id,connector_id,connector_name,name,input_schema,status)
      VALUES(${`${id}:tool`},${scope.tenantId},${id},'Notes MCP','read_notes',${admin.json({ type: "object", properties: {} })},'active')`;
    const review = await previewNativeConnectorTrash({ scope }, id);
    const request = connectorNativeTrashRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: id,
      action: "trash", review: review.review!.pin, preview: review.preview });
    return { scope, id, request, review };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function authority(f: Fixture, key = "one") {
    return { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId, initiatingActorId: owner,
      executingPrincipalType: "user", executingPrincipalId: owner, correlationId: key, causationId: f.id, purpose: "api.connectors.native.action" }) };
  }
  const inOwner = <T,>(f: Fixture, operation: () => Promise<T>) => runWithDatabaseActorScope(f.scope.tenantId, [owner, canonical], operation);
  const submit = (f: Fixture, key = "one", request = f.request) => submitNativeConnectorTrash({ authority: authority(f, key), request, idempotencyKey: key });
  const stateRequest = (f: Fixture) => ({ contract: "asael-connector-action:1" as const, kind: "mcp" as const, connectorId: f.id, action: "disable" as const, review: f.request.review });
  const removalRequest = (f: Fixture) => ({ ...f.request, action: "remove_credential" as const, preview: null });
  const counts = async (f: Fixture) => (await admin`SELECT
    (SELECT count(*)::INTEGER FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}) AS native,
    (SELECT count(*)::INTEGER FROM omni_trash_items WHERE tenant_id=${f.scope.tenantId}) AS trash,
    (SELECT count(*)::INTEGER FROM omni_trash_effect_receipts WHERE tenant_id=${f.scope.tenantId}) AS proofs,
    (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${f.scope.tenantId}) AS events,
    (SELECT count(*)::INTEGER FROM omni_mcp_connectors WHERE tenant_id=${f.scope.tenantId}) AS connectors,
    (SELECT count(*)::INTEGER FROM omni_mcp_tools WHERE tenant_id=${f.scope.tenantId}) AS tools`)[0];
  const beforeCounts = { native: 0, trash: 0, proofs: 0, events: 0, connectors: 1, tools: 1 };
  const movedCounts = { native: 1, trash: 1, proofs: 1, events: 4, connectors: 0, tools: 0 };
  async function snapshot(f: Fixture) {
    return { connectors: await admin`SELECT * FROM omni_mcp_connectors WHERE tenant_id=${f.scope.tenantId}`,
      tools: await admin`SELECT * FROM omni_mcp_tools WHERE tenant_id=${f.scope.tenantId} ORDER BY id` };
  }
  function retime(f: Fixture, issuedAt: string) {
    const { previewSha256: _digest, ...body } = f.request.preview;
    const preview = buildTrashActionPreviewV1({ ...body, issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 600_000).toISOString() });
    return connectorNativeTrashRequestSchema.parse({ ...f.request, preview });
  }

  test("239 replays over238 without changing v40 or v41 receipts or owner protections", async () => {
    const state = await fixture("replay-state"), removal = await fixture("replay-removal");
    const old = await submitNativeConnectorAction({ authority: authority(state), request: stateRequest(state), idempotencyKey: "state" });
    const saved = await submitNativeConnectorCredentialRemoval({ authority: authority(removal), request: removalRequest(removal), idempotencyKey: "removal" });
    const before = await admin`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions ORDER BY id`;
    const row = { version: 239, name: "native_connector_trash_v1", checksum: "6af2db420131c4c68b3279b4030f161d72c85b2a740477fc6f77aa6b85482d83" };
    const migration = await readSqlMigrationFile({ file: "20261005193000_native_connector_trash.sql", sha256: row.checksum, migrations: [row] });
    const next = databaseSchemaMigrations.find((migration) => migration.version === 240)!;
    const rotationMigration = await readSqlMigrationFile({ file: "20261005200000_native_connector_credential_rotations.sql", sha256: next.checksum, migrations: [next] });
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
      await removeNativeConnectorTrashForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=239`;
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
      await applySqlMigrationFile(migrationSql, rotationMigration, [next], []);
      await applySqlMigrationFile(migrationSql, registrationMigration, [registration], []);
      await applySqlMigrationFile(migrationSql, openapiImportMigration, [openapiImport], []);
      await applySqlMigrationFile(migrationSql, discoveryMigration, [discovery], []);
      await applySqlMigrationFile(migrationSql, githubUpgradeMigration, [githubUpgrade], []);
      expect(await sql`SELECT intent,acceptance,state,settlement FROM omni_native_connector_actions ORDER BY id`).toEqual(before);
    });
    expect(connectorNativeActionSchema.parse(await readNativeConnectorAction({ scope: state.scope }, old.action.acceptance.keySha256))).toEqual(old.action);
    expect(connectorNativeCredentialRemovalActionSchema.parse(await readNativeConnectorCredentialRemoval({ scope: removal.scope }, saved.action.acceptance.keySha256))).toEqual(saved.action);
    expect(await admin`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='omni_native_connector_actions'::regclass`)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  test("concurrent same-key moves commit one private snapshot, deletion and bound proof without outbound effects", async () => {
    const f = await fixture("concurrent"), outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Trash must remain local"));
    try {
      expect(await counts(f)).toEqual(beforeCounts);
      const results = await Promise.all([submit(f), submit(f)]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]); expect(results[0].action).toEqual(results[1].action);
      expect(await counts(f)).toEqual(movedCounts); expect(outbound).not.toHaveBeenCalled();
      const action = results[0].action, proof = action.settlement!.result.trash;
      const [stored] = await admin`SELECT item,snapshot FROM omni_trash_items WHERE tenant_id=${f.scope.tenantId}`;
      const [effect] = await admin`SELECT receipt_sha256,receipt FROM omni_trash_effect_receipts WHERE tenant_id=${f.scope.tenantId}`;
      expect(proof.proofSha256).toBe(effect.receipt_sha256);
      expect(stored.item).toMatchObject({ trashId: proof.trashId, ownerActorId: owner, targetSha256: f.request.preview.targetSha256,
        snapshotSha256: canonicalJsonSha256(stored.snapshot), compensation: { kind: "equivalent_action" } });
      expect(stored.snapshot).toMatchObject({ resourceType: "mcp_connector", children: [{ id: `${f.id}:tool` }] });
      expect(JSON.stringify(stored.snapshot)).not.toContain("opaque-never-decrypt-fixture");
      const events = await admin`SELECT payload FROM omni_events WHERE tenant_id=${f.scope.tenantId}`;
      const publicEvidence = JSON.stringify({ review: f.review, action, events });
      expect(publicEvidence).not.toContain("private-endpoint-fixture"); expect(publicEvidence).not.toContain("opaque-never-decrypt-fixture");
      expect(await readNativeConnectorTrash({ scope: f.scope }, action.acceptance.keySha256)).toEqual(action);
      expect(await previewNativeConnectorTrash({ scope: f.scope }, f.id)).toEqual({ review: null, preview: null, compensation: null });
      expect(await submit(f)).toEqual({ action, replayed: true });
      await expect(submit(f, "another-key")).rejects.toMatchObject({ status: 409 });
    } finally { outbound.mockRestore(); }
  });

  test.each(["credential", "endpoint", "contract"])("rejects exact-review %s drift without partial effects", async (drift) => {
    const f = await fixture(`drift-${drift}`);
    if (drift === "credential") await admin`UPDATE omni_mcp_connectors SET credential_version=3 WHERE id=${f.id}`;
    if (drift === "endpoint") await admin`UPDATE omni_mcp_connectors SET endpoint='https://example.test/other' WHERE id=${f.id}`;
    if (drift === "contract") await admin`UPDATE omni_mcp_tools SET risk_level=3 WHERE connector_id=${f.id}`;
    const before = await snapshot(f);
    await expect(submit(f)).rejects.toMatchObject({ status: 409 }); expect(await counts(f)).toEqual(beforeCounts); expect(await snapshot(f)).toEqual(before);
  });

  test("rejects expired/future previews, changed confirmation text and a prior non-native Trash receipt", async () => {
    const f = await fixture("preview");
    for (const start of [Date.now() - 600_001, Date.now() + 60_000]) {
      await expect(submit(f, "one", retime(f, new Date(start).toISOString()))).rejects.toMatchObject({ status: 409 });
    }
    const { previewSha256: _digest, ...body } = f.request.preview;
    const changed = buildTrashActionPreviewV1({ ...body, effectSummary: "No tool contracts change." });
    await expect(submit(f, "one", connectorNativeTrashRequestSchema.parse({ ...f.request, preview: changed }))).rejects.toMatchObject({ status: 409 });
    expect(await counts(f)).toEqual(beforeCounts);
    const executionScope = authority(f).executionScope;
    await inOwner(f, async () => {
      const captured = await captureRestorableResource("mcp_connector", f.id, executionScope);
      await createTrashEntry({ preview: f.request.preview, displayLabel: "Notes MCP", target: connectorNativeTrashTarget(f.request.review),
        snapshot: captured!, compensation: compensationForSnapshot(captured!) }, { executionScope });
    });
    const before = await counts(f);
    await expect(submit(f)).rejects.toMatchObject({ status: 409 }); expect(await counts(f)).toEqual(before);
  });

  test("bounds complete review and private snapshot before admission", async () => {
    const f = await fixture("bounds");
    await admin`UPDATE omni_mcp_connectors SET instructions=repeat('x',1000001) WHERE id=${f.id}`;
    await expect(previewNativeConnectorTrash({ scope: f.scope }, f.id)).rejects.toMatchObject({ status: 409 });
    await admin`UPDATE omni_mcp_connectors SET instructions=NULL WHERE id=${f.id}`;
    await admin`INSERT INTO omni_mcp_tools(id,tenant_id,connector_id,connector_name,name,input_schema,status)
      SELECT ${f.id}||':tool:'||n,${f.scope.tenantId},${f.id},'Notes MCP','tool_'||n,'{}'::JSONB,'active' FROM generate_series(1,200) n`;
    const oversized = await previewNativeConnectorTrash({ scope: f.scope }, f.id);
    expect(oversized).toMatchObject({ preview: null, compensation: null, review: { pin: null, unavailableReason: "scope_too_large" } });
    expect((await counts(f)).native).toBe(0); expect((await counts(f)).trash).toBe(0);
  });

  test("does not promise restoration for a retired remote-browser contract", async () => {
    const f = await fixture("unsupported-child");
    await admin`UPDATE omni_mcp_tools SET name='browser_navigate' WHERE connector_id=${f.id}`;
    await expect(previewNativeConnectorTrash({ scope: f.scope }, f.id)).rejects.toMatchObject({ status: 409 });
    expect(await counts(f)).toEqual(beforeCounts);
  });

  test.each(["trash.item.created", "connector.mcp.deleted", "connector.native.action.settled"])("%s failure restores every live row and leaves no native or Trash receipt", async (eventType) => {
    const tag = eventType === "trash.item.created" ? "trash" : eventType === "connector.mcp.deleted" ? "delete" : "settle";
    const f = await fixture(`rollback-${tag}`), before = await snapshot(f);
    await admin.unsafe(`CREATE FUNCTION connector_trash_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id='${f.scope.tenantId}' AND NEW.type='${eventType}' THEN RAISE EXCEPTION 'fixture Trash event failure'; END IF; RETURN NEW; END $$`);
    await admin`CREATE TRIGGER connector_trash_fixture_fail BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION connector_trash_fixture_fail()`;
    try {
      await expect(submit(f)).rejects.toMatchObject({ code: "P0001" }); expect(await snapshot(f)).toEqual(before); expect(await counts(f)).toEqual(beforeCounts);
    } finally { await admin`DROP TRIGGER connector_trash_fixture_fail ON omni_events`; await admin`DROP FUNCTION connector_trash_fixture_fail()`; }
    expect((await submit(f)).replayed).toBe(false); expect(await counts(f)).toEqual(movedCounts);
  });

  test("preserves exact owner history after management loss while fencing new work and cross-owner reads", async () => {
    const f = await fixture("authority"), accepted = await submit(f), key = accepted.action.acceptance.keySha256;
    await expect(submit(f, "one", retime(f, new Date(Date.parse(f.request.preview.issuedAt) + 1).toISOString()))).rejects.toMatchObject({ status: 409 });
    expect(await readNativeConnectorTrash({ scope: { ...f.scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` } }, key)).toBeNull();
    expect(await runWithDatabaseTenantScope(f.scope.tenantId, () => getSql()`SELECT trash_id FROM omni_trash_items`)).toEqual([]);
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    expect(await readNativeConnectorTrash({ scope: f.scope }, key)).toEqual(accepted.action);
    expect(await submit(f)).toEqual({ action: accepted.action, replayed: true });
    await expect(submit(f, "new")).rejects.toMatchObject({ status: 403 });
    await expect(previewNativeConnectorTrash({ scope: f.scope }, f.id)).rejects.toMatchObject({ status: 403 });
    await expect(inOwner(f, () => getSql()`DELETE FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId}`)).rejects.toMatchObject({ code: "42501" });
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(readNativeConnectorTrash({ scope: f.scope }, key)).rejects.toMatchObject({ status: 403 });
  });

  test("isolates Trash, state and saved-credential action keys in both directions", async () => {
    const f = await fixture("cross-trash"), moved = await submit(f, "shared"), key = moved.action.acceptance.keySha256;
    expect(await readNativeConnectorAction({ scope: f.scope }, key)).toBeNull();
    expect(await readNativeConnectorCredentialRemoval({ scope: f.scope }, key)).toBeNull();
    await expect(submitNativeConnectorAction({ authority: authority(f), request: stateRequest(f), idempotencyKey: "shared" })).rejects.toMatchObject({ status: 409 });
    await expect(submitNativeConnectorCredentialRemoval({ authority: authority(f), request: removalRequest(f), idempotencyKey: "shared" })).rejects.toMatchObject({ status: 409 });
    expect(await counts(f)).toEqual(movedCounts);
    for (const family of ["state", "removal"] as const) {
      const old = await fixture(`cross-${family}`);
      const result = family === "state"
        ? await submitNativeConnectorAction({ authority: authority(old), request: stateRequest(old), idempotencyKey: "shared" })
        : await submitNativeConnectorCredentialRemoval({ authority: authority(old), request: removalRequest(old), idempotencyKey: "shared" });
      const before = await counts(old);
      expect(await readNativeConnectorTrash({ scope: old.scope }, result.action.acceptance.keySha256)).toBeNull();
      await expect(submit(old, "shared")).rejects.toMatchObject({ status: 409 }); expect(await counts(old)).toEqual(before);
    }
  });

  test.each([true, false])("existing browser restore helper preserves vault=%s compensation and immutable native history", async (vault) => {
    const f = await fixture(vault ? "restore-vault" : "restore-none");
    if (!vault) {
      // An absent stored version is NULL; the native review projects it as zero.
      await admin`UPDATE omni_mcp_connectors SET auth_type='none',credential_version=NULL,credential_key_id=NULL,credential_fingerprint=NULL,
        credential_origin=NULL,sealed_credential=NULL WHERE id=${f.id}`;
      const updated = await previewNativeConnectorTrash({ scope: f.scope }, f.id);
      expect(updated.review?.connector).toMatchObject({ authType: "none", credentialConfigured: false, credentialVersion: 0 });
      f.request = connectorNativeTrashRequestSchema.parse({ ...f.request, review: updated.review!.pin, preview: updated.preview });
    }
    const result = await submit(f), trash = result.action.settlement!.result.trash;
    expect(trash.compensation).toBe(vault ? "equivalent_action" : "exact_restore");
    const executionScope = createExecutionScope({ tenantId: f.scope.tenantId, initiatingActorId: owner, executingPrincipalType: "user",
      executingPrincipalId: owner, correlationId: "browser-restore", causationId: trash.trashId, purpose: "trash.restore" });
    await inOwner(f, async () => {
      const preview = await createTrashLifecyclePreview(trash.trashId, "restore", { executionScope });
      const restored = await restoreTrashResource({ preview: preview!, executionScope });
      expect(restored.result.item.state).toBe("restored"); expect(restored.restoredResourceIds).toEqual([f.id, `${f.id}:tool`]);
      expect(restored.limitation).toBe(trash.limitation);
    });
    const live = await reviewNativeConnector({ scope: f.scope }, "mcp", f.id);
    expect(live?.connector).toMatchObject({ authType: "none", credentialConfigured: false, status: vault ? "disabled" : "active" });
    expect(live?.contracts).toHaveLength(1);
    expect((await snapshot(f)).connectors[0].sealed_credential).toBeNull();
    expect(await readNativeConnectorTrash({ scope: f.scope }, result.action.acceptance.keySha256)).toEqual(result.action);
    expect(await submit(f)).toEqual({ action: result.action, replayed: true });
  });

  test("serving-role validators admit only bounded preview and complete absent-target proof shapes", async () => {
    const f = await fixture("database-shapes"), result = await submit(f);
    const intent = buildConnectorNativeTrashIntent(f.scope, "one", f.request), acceptance = result.action.acceptance, settlement = result.action.settlement!;
    await inOwner(f, async () => {
      const sql = getSql();
      expect(await sql`SELECT omni_native_connector_intent_valid_v3(${intent}::JSONB,${acceptance}::JSONB) AS valid`).toEqual([{ valid: true }]);
      for (const patch of [{ resourceId: "other" }, { action: "restore" }, { lifecycleRevision: 1 }, { reversible: false },
        { expiresAt: new Date(Date.parse(f.request.preview.expiresAt) + 1).toISOString() }, { rawCredential: "forbidden" }]) {
        const invalid = { ...intent, request: { ...intent.request, preview: { ...intent.request.preview, ...patch } } };
        expect(await sql`SELECT omni_native_connector_intent_valid_v3(${invalid}::JSONB,${acceptance}::JSONB) AS valid`).toEqual([{ valid: false }]);
      }
      for (const patch of [{ connectorStatus: "disabled" }, { contractCount: 0 }, { providerRevoked: true },
        { trash: { ...settlement.result.trash, compensation: "exact_restore" } }, { trash: { ...settlement.result.trash, proofSha256: "bad" } }]) {
        const invalid = { ...settlement, result: { ...settlement.result, ...patch } };
        expect(await sql`SELECT omni_native_connector_settlement_valid_v3(${invalid}::JSONB,${acceptance}::JSONB) AS valid`).toEqual([{ valid: false }]);
      }
    });
  });
});
