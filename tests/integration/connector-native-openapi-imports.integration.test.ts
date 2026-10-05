import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import { readNativeConnectorAction, reviewNativeConnector, submitNativeConnectorAction } from "@/lib/connectors/native-control-store";
import { readNativeConnectorCredentialRemoval } from "@/lib/connectors/native-credential-removal-store";
import { readNativeConnectorTrash } from "@/lib/connectors/native-trash-store";
import { readNativeConnectorCredentialRotation } from "@/lib/connectors/native-credential-rotation-store";
import { prepareNativeMcpRegistration, readNativeMcpRegistration, submitNativeMcpRegistration } from "@/lib/connectors/native-mcp-registration-store";
import { connectorNativeMcpRegistrationPrepareRequestSchema, connectorNativeMcpRegistrationRequestSchema, connectorNativeMcpRegistrationTargetId } from "@/lib/connectors/native-mcp-registration-contracts";
import { connectorNativeKeySha256, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import * as C from "@/lib/connectors/native-openapi-import-contracts";
import { prepareNativeOpenapiImport, readNativeOpenapiImportPreparation, abandonNativeOpenapiImportPreparation,
  submitNativeOpenapiImport, readNativeOpenapiImport, nativeOpenapiImportSnapshotBinding, scrubExpiredNativeOpenapiImportPreparations } from "@/lib/connectors/native-openapi-import-store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import * as network from "@/lib/security/network";
import { openNativeOpenapiImportSnapshot, sealNativeOpenapiImportSnapshot } from "@/lib/settings/credential-vault";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { removeNativeOpenapiImportsForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "openapi-import-owner@example.test", other = "openapi-import-other@example.test", canonical = `actor:${user}`;
const runtimeRole = "openapi_import_test_runtime", maintenanceRole = "openapi_import_test_maintenance";
const origin = "https://93.184.216.34", specOrigin = "https://8.8.8.8", envName = "OMNIAGENT_CONNECTOR_OPENAPI_FIXTURE_TOKEN";
type Auth = "none" | "bearer_env" | "api_key_header_env";
const specification = () => JSON.stringify({ openapi: "3.1.0", info: { title: "Synthetic private source marker", version: "1", z: "order", aa: "binding" },
  servers: [{ url: `${origin}/api` }], paths: { "/items": {
    get: { operationId: "listItems", summary: "Synthetic private operation description", responses: { "200": { description: "ok" } } },
    post: { operationId: "createItem", requestBody: { required: true, content: { "application/json": { schema: {
      type: "object", properties: { name: { type: "string" } }, required: ["name"] } } } }, responses: { "201": { description: "created" } } },
  } } });

integration("prepared native OpenAPI import under serving-role RLS", () => {
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
    // Only legacy grants are fixture-owned;242 must grant its own validators,
    // table and exact mutable columns. Never grant the private actor registry.
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools,omni_openapi_connectors,omni_openapi_operations TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${runtimeRole}`); await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture'),(${otherUser},${other},'fixture')`;
    const serving = new URL(databaseUrl!), maintenance = new URL(databaseUrl!);
    serving.username = runtimeRole; serving.password = password; maintenance.username = maintenanceRole; maintenance.password = maintenancePassword;
    await closeDatabaseClient(); vi.stubEnv("DATABASE_URL", serving.toString()); vi.stubEnv("OMNIAGENT_MAINTENANCE_DATABASE_URL", maintenance.toString());
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv(envName, "synthetic-deployer-value-never-fetch-or-journal"); vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", "{}");
    keyring = JSON.stringify({ activeKeyId: "openapi-fixture", keys: { "openapi-fixture": randomBytes(32).toString("base64url") } });
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("openapi-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_openapi_import_preparations') AS preparation_rls,row_security_active('omni_native_connector_actions') AS action_rls,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS registry_read FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toEqual({ role: runtimeRole, rolsuper: false, rolbypassrls: false, preparation_rls: true, action_rls: true, registry_read: false });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) { if (rolesCreated) for (const role of [runtimeRole, maintenanceRole]) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); } await admin.end(); }
  });
  function target(scope: ConnectorNativeScope, authType: Auth = "none", source: "url" | "text" = "text") {
    const nonce = randomUUID(), id = C.connectorNativeOpenapiImportTargetId(scope, nonce), specUrl = `${specOrigin}/spec?synthetic-private-query#synthetic-fragment`;
    const request = C.connectorNativeOpenapiImportPrepareRequestSchema.parse({ contract: "asael-openapi-import-prepare:1", kind: "openapi", nonce,
      operation: "import_openapi", connectorId: id, review: null, declaration: { name: "Synthetic OpenAPI", endpoint: null, endpointRedacted: false,
        authType, authTokenEnv: authType === "none" ? null : envName, authHeaderName: authType === "api_key_header_env" ? "X-Api-Key" : null,
        defaultRiskLevel: 1, approvalRequired: false, specSource: source,
        ...(source === "url" ? C.nativeOpenapiImportSourceProjection(specUrl) : { specUrl: null, specUrlRedacted: false }) },
      payload: { endpoint: null, specUrl: source === "url" ? specUrl : null, specText: source === "text" ? specification() : null } });
    return { scope, id, request };
  }
  async function fixture(tag: string, auth: Auth = "none", source: "url" | "text" = "text") {
    const scope: ConnectorNativeScope = { tenantId: `openapi-${tag}`, ownerActorId: owner, canonicalActorId: canonical };
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const who of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${who}`},${scope.tenantId},${who},'admin')`;
    const bindings = JSON.parse(process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS || "{}");
    bindings[envName] = { tenants: [...(bindings[envName]?.tenants ?? []), scope.tenantId], origins: [origin] };
    vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", JSON.stringify(bindings)); return target(scope, auth, source);
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function authority(f: Pick<Fixture, "scope" | "id">, cleanup = false) { return { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId,
    initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner, correlationId: "openapi-fixture", causationId: f.id,
    purpose: cleanup ? "api.connectors.native.openapi_import_preparation.abandon" : "api.connectors.native.action" }) }; }
  const keySha = (f: Pick<Fixture, "scope">, key = "prepare") => connectorNativeKeySha256(f.scope, key);
  const prepare = (f: Fixture, key = "prepare", request = f.request) => prepareNativeOpenapiImport({ authority: authority(f), idempotencyKey: key, request });
  const ready = async (f: Fixture, key = "prepare") => C.connectorNativeOpenapiImportPreparationReadyReadSchema.parse((await prepare(f, key)).prepared);
  function finalRequest(p: C.ConnectorNativeOpenapiImportPreparation) { return C.connectorNativeOpenapiImportRequestSchema.parse({
    contract: "asael-connector-prepared-action:1", kind: "openapi", connectorId: p.connectorId, action: "import_openapi", preparationId: p.id,
    preparationSha256: p.preparationSha256, review: null }); }
  const submit = (f: Fixture, proof: C.ConnectorNativeOpenapiImportPreparation, key = "import") => submitNativeOpenapiImport({ authority: authority(f), request: finalRequest(proof), idempotencyKey: key });
  const abandon = (f: Fixture, key = "prepare") => abandonNativeOpenapiImportPreparation({ authority: authority(f, true), idempotencyKey: key, keySha256: keySha(f, key),
    request: C.connectorNativeOpenapiImportPreparationAbandonRequestSchema.parse({ contract: "asael-openapi-import-preparation-abandon:1",
      intent: C.buildConnectorNativeOpenapiImportPreparationIntent(f.scope, key, f.request) }) });
  const inOwner = <T,>(f: Pick<Fixture, "scope">, operation: () => Promise<T>) => runWithDatabaseActorScope(f.scope.tenantId, [owner, canonical], operation);
  async function snapshot(f: Pick<Fixture, "scope">) { return {
    connectors: await admin`SELECT * FROM omni_openapi_connectors WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    operations: await admin`SELECT * FROM omni_openapi_operations WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    preparations: await admin`SELECT * FROM omni_native_openapi_import_preparations WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    actions: await admin`SELECT * FROM omni_native_connector_actions WHERE tenant_id=${f.scope.tenantId} ORDER BY id`,
    events: await admin`SELECT id,type,payload FROM omni_events WHERE tenant_id=${f.scope.tenantId} ORDER BY seq` }; }
  async function failEvent(f: Fixture, type: string, operation: () => Promise<void>) {
    await admin`CREATE FUNCTION fail_openapi_fixture_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id=TG_ARGV[0] AND NEW.type=TG_ARGV[1] THEN RAISE EXCEPTION 'synthetic event rollback'; END IF; RETURN NEW; END $$`;
    await admin.unsafe(`CREATE TRIGGER fail_openapi_fixture_event BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION fail_openapi_fixture_event('${f.scope.tenantId}','${type}')`);
    try { await operation(); } finally { await admin`DROP TRIGGER fail_openapi_fixture_event ON omni_events`; await admin`DROP FUNCTION fail_openapi_fixture_event()`; }
  }
  // Admin-only clock fixture; restore the trigger and all CHECKs before any
  // serving call. Both immutable attempt and proof remain internally valid.
  async function shiftReady(p: C.ConnectorNativeOpenapiImportPreparation, remainingMs: number) {
    const [row] = await admin`SELECT attempt,sealed_snapshot,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
      FROM omni_native_openapi_import_preparations WHERE id=${p.id}`;
    const material = openNativeOpenapiImportSnapshot(row.sealed_snapshot, nativeOpenapiImportSnapshotBinding(p));
    const expiresAt = new Date(Date.parse(String(row.now)) + remainingMs).toISOString(), preparedAt = new Date(Date.parse(expiresAt) - 900_000).toISOString();
    const { attemptSha256: _attemptSha, ...attemptBody } = C.connectorNativeOpenapiImportAttemptSchema.parse(row.attempt);
    const nextAttemptBody = { ...attemptBody, startedAt: new Date(Date.parse(preparedAt) - 1000).toISOString(), expiresAt: new Date(Date.parse(preparedAt) + 44_000).toISOString() };
    const attempt = C.connectorNativeOpenapiImportAttemptSchema.parse({ ...nextAttemptBody, attemptSha256: canonicalJsonSha256(nextAttemptBody) });
    const { preparationSha256: _proofSha, ...proofBody } = p, body = { ...proofBody, attemptSha256: attempt.attemptSha256, preparedAt, expiresAt };
    const proof = C.connectorNativeOpenapiImportPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
    const sealed = sealNativeOpenapiImportSnapshot(material, nativeOpenapiImportSnapshotBinding(proof));
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_openapi_import_preparations DISABLE TRIGGER omni_native_openapi_import_preparation_guard`;
      await sql`UPDATE omni_native_openapi_import_preparations SET attempt=${sql.json(attempt)},attempt_expires_at=${attempt.expiresAt},
        preparation=${sql.json(proof)},expires_at=${proof.expiresAt},sealed_snapshot=${sql.json(sealed)} WHERE id=${p.id}`;
      await sql`ALTER TABLE omni_native_openapi_import_preparations ENABLE TRIGGER omni_native_openapi_import_preparation_guard`;
    });
    return proof;
  }

  test("242 replays over241 without rewriting an accepted MCP registration", async () => {
    const f = await fixture("replay"), nonce = randomUUID(), id = connectorNativeMcpRegistrationTargetId(f.scope, nonce), auth = authority({ ...f, id });
    const request = connectorNativeMcpRegistrationPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", nonce, operation: "register_mcp", connectorId: id, review: null,
      declaration: { name: "Legacy MCP", endpoint: `${origin}/mcp`, endpointRedacted: false, authType: "none", authTokenEnv: null, authHeaderName: null,
        defaultRiskLevel: 1, approvalRequired: false, specSource: "none", specUrl: null, specUrlRedacted: false },
      payload: { endpoint: `${origin}/mcp`, bearerToken: null, specUrl: null, specText: null } });
    const proof = (await prepareNativeMcpRegistration({ authority: auth, request, idempotencyKey: "legacy-prepare" })).prepared.preparation;
    await submitNativeMcpRegistration({ authority: auth, idempotencyKey: "legacy-action", request: connectorNativeMcpRegistrationRequestSchema.parse({
      contract: "asael-connector-prepared-action:1", kind: "mcp", action: "register_mcp", connectorId: id, preparationId: proof.id, preparationSha256: proof.preparationSha256, review: null }) });
    const before = await admin`SELECT * FROM omni_native_connector_actions ORDER BY id`, stages = await admin`SELECT * FROM omni_native_mcp_registration_preparations ORDER BY id`;
    const row = databaseSchemaMigrations.find((migration) => migration.version === 242)!;
    const migration = await readSqlMigrationFile({ file: "20261005210000_native_openapi_imports.sql", sha256: row.checksum, migrations: [row] });
    await admin.begin(async (sql) => {
      await removeNativeOpenapiImportsForReplay(sql); await sql`DELETE FROM omni_schema_version WHERE version=242`;
      const adapter: Parameters<typeof applySqlMigrationFile>[0] = { unsafe: async (text, params) => {
        const values = (params ?? []).map((value) => { if (typeof value !== "string") throw new Error("Migration settings must be strings."); return value; });
        return await sql.unsafe<Record<string, unknown>[]>(text, values);
      } };
      await applySqlMigrationFile(adapter, migration, [row], []);
      expect(await sql`SELECT * FROM omni_native_connector_actions ORDER BY id`).toEqual(before);
      expect(await sql`SELECT * FROM omni_native_mcp_registration_preparations ORDER BY id`).toEqual(stages);
    });
  });

  test.each([["none", "text"], ["none", "url"], ["bearer_env", "text"], ["bearer_env", "url"], ["api_key_header_env", "text"], ["api_key_header_env", "url"]] as const)(
    "%s from%s creates the exact disabled pending snapshot with one unauthenticated source read", async (auth, source) => {
      const f = await fixture(`mode-${auth}-${source}`, auth, source);
      const outbound = vi.spyOn(network, "fetchPublicHttpUrl").mockImplementation(async (_url, options) => {
        expect(options?.headers).toEqual({ accept: "application/json, application/yaml, text/yaml, text/plain" });
        expect(options?.credentials).toBe("omit");
        expect((await snapshot(f)).preparations[0].state).toBe("preparing");
        return new Response(specification(), { status: 200 });
      });
      try {
        expect(await readNativeOpenapiImportPreparation({ scope: f.scope }, keySha(f))).toBeNull();
        const p = await ready(f), staged = await snapshot(f);
        expect(staged.connectors).toHaveLength(0); expect(staged.operations).toHaveLength(0); expect(staged.actions).toHaveLength(0);
        expect(staged.preparations[0].sealed_snapshot).not.toBeNull(); expect(p.summary.operations).toHaveLength(2);
        expect((await prepare(f))).toEqual({ prepared: p, replayed: true });
        const result = await submit(f, p.preparation), after = await snapshot(f);
        expect(result.action.settlement?.result).toMatchObject({ status: "complete", connectorStatus: "disabled", contractCount: 2,
          credentialVersion: 0, configurationSha256: p.preparation.configurationSha256 });
        expect(after.connectors).toHaveLength(1); expect(after.connectors[0]).toMatchObject({ id: f.id, status: "disabled", operation_count: 2, auth_type: auth, base_url: `${origin}/api` });
        expect(after.operations.map((op) => op.status)).toEqual(["pending_review", "pending_review"]);
        expect(after.preparations[0]).toMatchObject({ state: "consumed", sealed_snapshot: null, consumed_by: result.action.acceptance.id, consumed_key_sha256: keySha(f, "import") });
        expect(after.events.map((row) => row.type)).toEqual(["connector.native.openapi_import_preparation.reserved", "connector.native.openapi_import_preparation.prepared",
          "openapi_connector.scope_bound", "connector.openapi.created", "connector.openapi.import_saved", "connector.native.action.accepted", "connector.native.action.settled"]);
        const safe = JSON.stringify([p, result, after.events, after.actions, staged.preparations[0].sealed_snapshot]);
        for (const secret of ["synthetic-private-query", "synthetic-fragment", "Synthetic private source marker", "Synthetic private operation description", "synthetic-deployer-value-never-fetch-or-journal"]) expect(safe).not.toContain(secret);
        expect(outbound).toHaveBeenCalledTimes(source === "url" ? 1 : 0);
        expect(await submit(f, p.preparation)).toEqual({ action: result.action, replayed: true }); expect(await snapshot(f)).toEqual(after);
        expect(await readNativeOpenapiImport({ scope: f.scope }, keySha(f, "import"))).toEqual(result.action);
        expect(await readNativeOpenapiImportPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "consumed", consumedKeySha256: keySha(f, "import") });
        await expect(submit(f, p.preparation, "other-final")).rejects.toMatchObject({ status: 409 }); await expect(abandon(f)).rejects.toMatchObject({ status: 409 });
      } finally { outbound.mockRestore(); }
    });

  test("duplicate in-flight POST and GET never fetch again; abandon fences its eventual completion", async () => {
    const f = await fixture("pending", "none", "url"); let release!: (response: Response) => void, arrived!: () => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { arrived = resolve; });
    const outbound = vi.spyOn(network, "fetchPublicHttpUrl").mockImplementation(() => { arrived(); return pending; });
    const first = prepare(f);
    try {
      await started;
      const read = await readNativeOpenapiImportPreparation({ scope: f.scope }, keySha(f)); expect(read?.availability).toBe("preparing");
      expect(await prepare(f)).toEqual({ prepared: read, replayed: true }); expect(outbound).toHaveBeenCalledTimes(1);
      const closed = await abandon(f); release(new Response(specification()));
      expect((await first).prepared).toEqual(closed.prepared); expect(outbound).toHaveBeenCalledTimes(1);
      const after = await snapshot(f); expect(after.connectors).toHaveLength(0); expect(after.operations).toHaveLength(0); expect(after.preparations[0].sealed_snapshot).toBeNull();
    } finally { release(new Response(specification())); await first.catch(() => undefined); outbound.mockRestore(); }
  });

  test("changed private input conflicts both before and after abandonment; absent tombstone stays honest", async () => {
    const f = await fixture("input-binding"), p = await ready(f);
    const changed = C.connectorNativeOpenapiImportPrepareRequestSchema.parse({ ...f.request, payload: { ...f.request.payload, specText: `${specification()}\n` } });
    await expect(prepare(f, "prepare", changed)).rejects.toMatchObject({ status: 409 });
    await abandon(f); await expect(prepare(f, "prepare", changed)).rejects.toMatchObject({ status: 409 });
    expect((await prepare(f)).prepared.availability).toBe("abandoned"); await expect(submit(f, p.preparation)).rejects.toMatchObject({ status: 409 });
    const fresh = await fixture("absent-tombstone"), closed = await abandon(fresh);
    expect(closed.prepared).toMatchObject({ availability: "abandoned", attempt: null, preparation: null, abandonment: { attemptSha256: null, preparationSha256: null } });
    expect(await prepare(fresh)).toEqual({ prepared: closed.prepared, replayed: true });
    await expect(prepare(fresh, "replacement-key")).rejects.toMatchObject({ status: 409 });
    expect((await snapshot(fresh)).preparations[0]).toMatchObject({ input_commitment: null, sealed_snapshot: null, attempt: null });
  });

  test("known source failure is durable, bounded and never refetched by recovery", async () => {
    const f = await fixture("failed", "none", "url"), outbound = vi.spyOn(network, "fetchPublicHttpUrl").mockRejectedValue(new Error("synthetic private provider exception"));
    try {
      const result = await prepare(f); expect(result.prepared).toMatchObject({ availability: "failed", failure: { code: "source_unavailable" } });
      expect(JSON.stringify(result)).not.toContain("synthetic private provider exception");
      expect(await prepare(f)).toEqual({ prepared: result.prepared, replayed: true }); expect(outbound).toHaveBeenCalledTimes(1);
      expect(await readNativeOpenapiImportPreparation({ scope: f.scope }, keySha(f))).toEqual(result.prepared);
      expect((await snapshot(f)).connectors).toHaveLength(0); await abandon(f);
    } finally { outbound.mockRestore(); }
  });

  test.each(["openapi_connector.scope_bound", "connector.openapi.created", "connector.openapi.import_saved", "connector.native.action.accepted", "connector.native.action.settled"])(
    "%s failure rolls back connector, all operations, consume and immutable receipts", async (type) => {
      const f = await fixture(`rollback-${type.replaceAll(".", "-")}`), p = await ready(f), before = await snapshot(f);
      await failEvent(f, type, async () => { await expect(submit(f, p.preparation)).rejects.toThrow("synthetic event rollback"); expect(await snapshot(f)).toEqual(before); });
      expect((await submit(f, p.preparation)).replayed).toBe(false);
    });

  test("reservation event failure fetches nothing, while failed ready-event preserves only the durable attempt", async () => {
    const f = await fixture("reserve-event", "none", "url"), outbound = vi.spyOn(network, "fetchPublicHttpUrl").mockResolvedValue(new Response(specification()));
    try {
      await failEvent(f, "connector.native.openapi_import_preparation.reserved", async () => { await expect(prepare(f)).rejects.toThrow("synthetic event rollback"); });
      expect(outbound).not.toHaveBeenCalled(); expect((await snapshot(f)).preparations).toHaveLength(0);
      await failEvent(f, "connector.native.openapi_import_preparation.prepared", async () => {
        expect((await prepare(f)).prepared).toMatchObject({ availability: "failed", failure: { code: "admission_failed" } });
      });
      const after = await snapshot(f); expect(after.preparations[0]).toMatchObject({ state: "failed", preparation: null, sealed_snapshot: null });
      expect(after.connectors).toHaveLength(0); expect(after.actions).toHaveLength(0); expect(outbound).toHaveBeenCalledTimes(1);
      expect((await prepare(f)).replayed).toBe(true); expect(outbound).toHaveBeenCalledTimes(1);
    } finally { outbound.mockRestore(); }
  });

  test("abandon event rollback preserves snapshot and permits exact same-key cleanup", async () => {
    const f = await fixture("abandon-event"); await ready(f); const before = await snapshot(f);
    await failEvent(f, "connector.native.openapi_import_preparation.abandoned", async () => { await expect(abandon(f)).rejects.toThrow("synthetic event rollback"); expect(await snapshot(f)).toEqual(before); });
    expect((await abandon(f)).replayed).toBe(false); expect((await abandon(f)).replayed).toBe(true);
  });

  test("current owner, demotion, tenant and canonical identity fences preserve cleanup only", async () => {
    const f = await fixture("owner"), p = await ready(f);
    expect(await readNativeOpenapiImportPreparation({ scope: { ...f.scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` } }, keySha(f))).toBeNull();
    expect(await runWithDatabaseTenantScope(f.scope.tenantId, () => getSql()`SELECT id FROM omni_native_openapi_import_preparations`)).toEqual([]);
    await expect(readNativeOpenapiImportPreparation({ scope: { ...f.scope, ownerActorId: owner.toUpperCase() } }, keySha(f))).rejects.toMatchObject({ status: 403 });
    const alien = await fixture("alien"); expect(await readNativeOpenapiImportPreparation({ scope: alien.scope }, keySha(f))).toBeNull();
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    expect((await prepare(f)).replayed).toBe(true); await expect(prepare(f, "fresh")).rejects.toMatchObject({ status: 403 });
    await expect(submit(f, p.preparation)).rejects.toMatchObject({ status: 403 }); expect((await abandon(f)).prepared.availability).toBe("abandoned");
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    await expect(readNativeOpenapiImportPreparation({ scope: f.scope }, keySha(f))).rejects.toMatchObject({ status: 403 });
  });

  test("revoked environment binding or a competing browser connector cannot consume/overwrite the snapshot", async () => {
    const f = await fixture("binding", "bearer_env"), p = await ready(f), before = await snapshot(f);
    const bindings = process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS!; vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", "{}");
    try { await expect(submit(f, p.preparation)).rejects.toMatchObject({ status: 409 }); expect(await snapshot(f)).toEqual(before); }
    finally { vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", bindings); }
    await admin`INSERT INTO omni_openapi_connectors(id,tenant_id,name,base_url,auth_type,status,operation_count)
      VALUES(${f.id},${f.scope.tenantId},'Competing browser connector',${`${origin}/other`},'none','active',0)`;
    const competing = await snapshot(f); await expect(submit(f, p.preparation)).rejects.toMatchObject({ status: 409 }); expect(await snapshot(f)).toEqual(competing);
  });

  test("final history survives separate contract approval and later target deletion; all old GET families stay isolated", async () => {
    const f = await fixture("history"), p = await ready(f), result = await submit(f, p.preparation), key = keySha(f, "import");
    for (const read of [readNativeConnectorAction, readNativeConnectorCredentialRemoval, readNativeConnectorTrash, readNativeConnectorCredentialRotation, readNativeMcpRegistration]) {
      expect(await read({ scope: f.scope }, key)).toBeNull();
    }
    const review = (await reviewNativeConnector({ scope: f.scope }, "openapi", f.id))!;
    await expect(submitNativeConnectorAction({ authority: authority(f), idempotencyKey: "import", request: {
      contract: "asael-connector-action:1", kind: "openapi", connectorId: f.id, action: "review_contracts", review: review.pin! } })).rejects.toMatchObject({ status: 409 });
    await submitNativeConnectorAction({ authority: authority(f), idempotencyKey: "approve-contracts", request: {
      contract: "asael-connector-action:1", kind: "openapi", connectorId: f.id, action: "review_contracts", review: review.pin! } });
    expect(await readNativeOpenapiImport({ scope: f.scope }, key)).toEqual(result.action);
    expect(await readNativeOpenapiImport({ scope: f.scope }, keySha(f, "approve-contracts"))).toBeNull();
    await expect(submit(f, p.preparation, "approve-contracts")).rejects.toMatchObject({ status: 409 });
    await admin`DELETE FROM omni_openapi_operations WHERE connector_id=${f.id}`; await admin`DELETE FROM omni_openapi_connectors WHERE id=${f.id}`;
    expect(await reviewNativeConnector({ scope: f.scope }, "openapi", f.id)).toBeNull();
    expect(await readNativeOpenapiImport({ scope: f.scope }, key)).toEqual(result.action);
    expect(await submit(f, p.preparation)).toEqual({ action: result.action, replayed: true });
  });

  test("encrypted snapshot swapping fails closed and cleanup needs no remaining vault key", async () => {
    const f = await fixture("cipher"), p = await ready(f), next = target(f.scope), q = await ready(next, "second");
    const [row] = await admin`SELECT sealed_snapshot FROM omni_native_openapi_import_preparations WHERE id=${q.preparation.id}`;
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_openapi_import_preparations DISABLE TRIGGER omni_native_openapi_import_preparation_guard`;
      await sql`UPDATE omni_native_openapi_import_preparations SET sealed_snapshot=${sql.json(row.sealed_snapshot)} WHERE id=${p.preparation.id}`;
      await sql`ALTER TABLE omni_native_openapi_import_preparations ENABLE TRIGGER omni_native_openapi_import_preparation_guard`;
    });
    const before = await snapshot(f); await expect(submit(f, p.preparation)).rejects.toMatchObject({ status: 503 }); expect(await snapshot(f)).toEqual(before);
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    try { expect((await abandon(f)).prepared.availability).toBe("abandoned"); }
    finally { vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); }
  });

  test("actual-role maintenance scrubs only expired ready snapshots, skips locks and ignores forged system scope", async () => {
    const f = await fixture("scrub"), p = await shiftReady((await ready(f)).preparation, -1000);
    const fresh = target(f.scope), q = (await ready(fresh, "fresh")).preparation, before = await snapshot(f);
    expect(await readNativeOpenapiImportPreparation({ scope: f.scope }, keySha(f))).toMatchObject({ availability: "expired" });
    await expect(submit(f, p)).rejects.toMatchObject({ status: 409 });
    await inOwner(f, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      await sql`SELECT set_config('omni.system_scope','true',true),set_config('omni.system_reason','forged fixture',true)`;
      expect(await sql`SELECT omni_system_scope_enabled() AS enabled`).toEqual([{ enabled: false }]);
      expect(await sql`UPDATE omni_native_openapi_import_preparations SET state='expired',sealed_snapshot=NULL WHERE id=${p.id} RETURNING id`).toEqual([]);
    }));
    expect(await snapshot(f)).toEqual(before);
    await admin.begin(async (sql) => {
      await sql`SELECT id FROM omni_native_openapi_import_preparations WHERE id=${p.id} FOR UPDATE`;
      expect(await scrubExpiredNativeOpenapiImportPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 })).toMatchObject({ status: "complete", scrubbed: 0, moreAvailable: true });
    });
    await admin`UPDATE omni_auth_memberships SET status='suspended' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    try { expect(await scrubExpiredNativeOpenapiImportPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() + 5000 }))
      .toEqual({ status: "complete", scrubbed: 1, moreAvailable: false, oldestExpiredAt: null }); }
    finally { vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", keyring); }
    expect((await admin`SELECT state,sealed_snapshot IS NOT NULL AS sealed FROM omni_native_openapi_import_preparations WHERE id=${q.id}`)[0]).toEqual({ state: "ready", sealed: true });
    expect(await scrubExpiredNativeOpenapiImportPreparations({ tenantId: f.scope.tenantId, deadlineAt: Date.now() - 1 })).toMatchObject({ status: "deferred", scrubbed: 0 });
  });

  test("SQL validators reject missing action/bad UUID and immutable final evidence cannot change", async () => {
    const f = await fixture("validators"), p = await ready(f), result = await submit(f, p.preparation);
    const intent = C.buildConnectorNativeOpenapiImportIntent(f.scope, "import", finalRequest(p.preparation));
    const { action: _action, ...missingAction } = intent.request;
    for (const request of [missingAction, { ...intent.request, action: null }, { ...intent.request, review: {} }, { ...intent.request, extra: true }]) {
      expect(await admin`SELECT omni_native_connector_intent_valid_v6(${admin.json({ ...intent, request })},${admin.json(result.action.acceptance)}) AS valid`).toEqual([{ valid: false }]);
    }
    for (const nonce of ["11111111-1111-0111-8111-111111111111", "11111111-1111-4111-7111-111111111111"]) {
      expect(await admin`SELECT omni_native_openapi_import_preparation_intent_valid_v1(${admin.json({ ...p.intent, nonce })}) AS valid`).toEqual([{ valid: false }]);
    }
    for (const change of [{ contractCount: 0 }, { credentialVersion: 1 }, { connectorStatus: "active" }, { extra: true }]) {
      expect(await admin`SELECT omni_native_connector_settlement_valid_v6(${admin.json({ ...result.action.settlement!, result: { ...result.action.settlement!.result, ...change } })},
        ${admin.json(result.action.acceptance)}) AS valid`).toEqual([{ valid: false }]);
    }
    const before = await snapshot(f);
    await expect(inOwner(f, () => getSql()`UPDATE omni_native_openapi_import_preparations SET state='abandoned' WHERE id=${p.preparation.id}`)).rejects.toMatchObject({ code: "55000" });
    await expect(inOwner(f, () => getSql()`DELETE FROM omni_native_openapi_import_preparations WHERE id=${p.preparation.id}`)).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(f)).toEqual(before);
  });
});
