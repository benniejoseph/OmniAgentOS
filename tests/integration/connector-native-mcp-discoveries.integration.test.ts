import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { reviewNativeConnector } from "@/lib/connectors/native-control-store";
import { connectorNativeKeySha256, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import * as C from "@/lib/connectors/native-mcp-discovery-contracts";
import { submitNativeMcpDiscovery, readNativeMcpDiscovery, closeNativeMcpDiscovery } from "@/lib/connectors/native-mcp-discovery-store";
import { storeMcpBearerCredential } from "@/lib/connectors/credential-store";
import { createMcpToolId, getMcpConnector, listMcpTools } from "@/lib/connectors/store";
import type { McpToolRecord } from "@/lib/connectors/types";
import * as client from "@/lib/connectors/mcp-client";
import { createExecutionScope } from "@/lib/security/execution-scope";
const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const owner = "discovery-owner@example.test", other = "discovery-other@example.test", canonical = `actor:${user}`;
const role = "mcp_discovery_store_runtime", envName = "OMNIAGENT_CONNECTOR_DISCOVERY_FIXTURE_TOKEN", origin = "https://93.184.216.34";
type Auth = "none" | "bearer_env" | "bearer_vault";
type Catalog = Awaited<ReturnType<typeof client.discoverMcpTools>>;
integration("native MCP discovery transaction and recovery under serving RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 4, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions TO ${role}`);
    // Only preexisting connector/event grants belong to this fixture. New
    // discovery table/column/validator privileges come exclusively from243.
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${role}`); await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture'),(${otherUser},${other},'fixture')`;
    const serving = new URL(databaseUrl!); serving.username = role; serving.password = password;
    await closeDatabaseClient(); vi.stubEnv("DATABASE_URL", serving.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", "");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3"); vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv(envName, "fixture-only-environment-value"); vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", "{}");
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({ activeKeyId: "discovery", keys: { discovery: randomBytes(32).toString("base64url") } }));
    await ensureDatabaseSchema();
    expect(await runWithDatabaseActorScope("discovery-role-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_mcp_discoveries') AS rls FROM pg_roles WHERE rolname=current_user`))
      .toEqual([{ role, rolsuper: false, rolbypassrls: false, rls: true }]);
  }, 180_000);
  afterAll(async () => {
    vi.restoreAllMocks(); await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); } await admin.end(); }
  });
  function authority(f: { scope: ConnectorNativeScope; id: string }, close = false) {
    return { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId, initiatingActorId: f.scope.ownerActorId,
      executingPrincipalType: "user", executingPrincipalId: f.scope.ownerActorId, causationId: f.id, correlationId: "discovery-fixture",
      purpose: close ? "api.connectors.native.mcp_discovery_close" : "api.connectors.native.mcp_discovery" }) };
  }
  const inOwner = <T,>(f: { scope: ConnectorNativeScope }, fn: () => Promise<T>) => runWithDatabaseActorScope(f.scope.tenantId, [f.scope.ownerActorId, f.scope.canonicalActorId], fn);
  async function fixture(tag: string, authType: Auth = "none") {
    const scope: ConnectorNativeScope = { tenantId: `discovery-store-${tag}`, ownerActorId: owner, canonicalActorId: canonical }, id = `discovery-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${scope.tenantId},${tag},${scope.tenantId})`;
    for (const who of [user, otherUser]) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tag}:${who}`},${scope.tenantId},${who},'admin')`;
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,status,auth_type,auth_token_env,transport,credential_version)
      VALUES(${id},${scope.tenantId},'Fixture discovery',${`${origin}/mcp`},'disabled',${authType === 'bearer_env' ? authType : 'none'},${authType === 'bearer_env' ? envName : null},'streamable_http',NULL)`;
    const bindings = JSON.parse(process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS || "{}");
    bindings[envName] = { tenants: [...(bindings[envName]?.tenants ?? []), scope.tenantId], origins: [origin] };
    vi.stubEnv("OMNIAGENT_CONNECTOR_SECRET_BINDINGS", JSON.stringify(bindings));
    const base = { scope, id, authType };
    if (authType === "bearer_vault") await inOwner(base, () => storeMcpBearerCredential({ tenantId: scope.tenantId, connectorId: id,
      endpoint: `${origin}/mcp`, bearerToken: "fixture-only-vault-value", executionScope: authority(base).executionScope }));
    const review = await reviewNativeConnector({ scope }, "mcp", id); expect(review?.pin).not.toBeNull();
    const request = C.connectorNativeMcpDiscoveryRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: id,
      action: "discover", review: review!.pin, preview: null });
    return { ...base, request };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const submit = (f: Fixture, key = "attempt") => submitNativeMcpDiscovery({ authority: authority(f), request: f.request, idempotencyKey: key });
  const keySha = (f: Fixture, key = "attempt") => connectorNativeKeySha256(f.scope, key);
  const read = (f: Fixture, key = "attempt") => readNativeMcpDiscovery({ scope: f.scope }, keySha(f, key));
  const close = (f: Fixture, key = "attempt") => closeNativeMcpDiscovery({ authority: authority(f, true), idempotencyKey: key, keySha256: keySha(f, key),
    request: C.connectorNativeMcpDiscoveryCloseRequestSchema.parse({ contract: "asael-mcp-discovery-close:1", intent: C.buildConnectorNativeMcpDiscoveryIntent(f.scope, key, f.request) }) });
  async function catalog(f: Fixture, names = ["kept", "new"]): Promise<Catalog> {
    const connector = await inOwner(f, () => getMcpConnector(f.id, { tenantId: f.scope.tenantId })); const now = new Date().toISOString();
    return { capabilities: { tools: { listChanged: false } }, instructions: "Synthetic instructions", serverVersion: { name: "Fixture", version: "1" },
      tools: names.map((name): McpToolRecord => ({ id: createMcpToolId(f.id, name), tenantId: f.scope.tenantId, connectorId: f.id,
        connectorName: connector!.name, name, inputSchema: { type: "object", properties: {} }, riskLevel: 2, approvalRequired: true,
        status: "pending_review", createdAt: now, updatedAt: now })) };
  }
  function provider(f: Fixture, value: Catalog | (() => Promise<Catalog>)) {
    return vi.spyOn(client, "discoverMcpTools").mockImplementation(async (_connector, options) => {
      expect(_connector.id).toBe(f.id); expect(options?.deadlineAt).toBeTypeOf("number");
      options?.verifyCredential?.(f.authType === "none" ? [] : [f.authType === "bearer_env" ? process.env[envName]! : "fixture-only-vault-value"]);
      // The durable attempt is visible before provider work and neither
      // per-key nor target advisory transaction locks survives admission.
      expect((await admin`SELECT state FROM omni_native_mcp_discoveries WHERE tenant_id=${f.scope.tenantId}`)[0]?.state).toBe("pending");
      await admin.begin(async (sql) => {
        expect((await sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`native-mcp-discovery-target:${f.scope.tenantId}:${f.id}`},0)) AS unlocked`)[0].unlocked).toBe(true);
      });
      return typeof value === "function" ? value() : value;
    });
  }
  const snapshot = (f: Fixture) => admin`SELECT row_to_json(c) AS connector,(SELECT jsonb_agg(t ORDER BY t.id) FROM omni_mcp_tools t
    WHERE t.tenant_id=c.tenant_id AND t.connector_id=c.id) AS tools FROM omni_mcp_connectors c WHERE c.tenant_id=${f.scope.tenantId} AND c.id=${f.id}`;
  const signal = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  const deferred = () => { let resolve!: (value: Catalog) => void; const promise = new Promise<Catalog>((done) => { resolve = done; }); return { promise, resolve }; };
  async function waitAdmission(f: Fixture) {
    for (let i = 0; i < 100; i++) { const value = await read(f); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 5)); }
    throw new Error("The discovery admission was not observed.");
  }
  test.each(["none", "bearer_env", "bearer_vault"] as const)("%s publishes complete disabled catalog with unchanged credential generation and no retry", async (mode) => {
    const f = await fixture(`success-${mode}`, mode), value = await catalog(f), mock = provider(f, value);
    try {
      const result = await submit(f); expect(result.discovery.state).toBe("settled");
      if (result.discovery.state !== "settled") throw new Error("Missing settlement");
      expect(result.discovery.settlement.result).toMatchObject({ status: "complete", connectorStatus: "disabled", contractCount: 2, pendingCount: 2,
        credentialVersion: mode === "bearer_vault" ? 1 : 0 });
      expect((await inOwner(f, () => getMcpConnector(f.id, { tenantId: f.scope.tenantId })))?.status).toBe("disabled");
      expect((await submit(f)).replayed).toBe(true); expect(await read(f)).toEqual(result.discovery);
      expect((await close(f)).discovery).toEqual(result.discovery); expect(mock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("fixture-only");
    } finally { mock.mockRestore(); }
  });
  test("accepts an empty complete catalog and rejects a partial oversized catalog without replacing prior rows", async () => {
    for (const count of [0, 201]) {
      const f = await fixture(`count-${count}`), before = await snapshot(f), mock = provider(f, await catalog(f, Array.from({ length: count }, (_, index) => `tool-${index}`)));
      try {
        const result = await submit(f); if (result.discovery.state !== "settled") throw new Error("Missing settlement");
        expect(result.discovery.settlement.result).toMatchObject(count ? { status: "failed", failureCode: "catalog_unreviewable" } : { status: "complete", contractCount: 0, pendingCount: 0 });
        if (count) expect(await snapshot(f)).toEqual(before);
      } finally { mock.mockRestore(); }
    }
  });
  test("pending replay makes no second provider call and close permanently fences late publication", async () => {
    const f = await fixture("close-race"), before = await snapshot(f), gate = deferred(), entered = signal(), value = await catalog(f),
      mock = provider(f, () => { entered.resolve(); return gate.promise; });
    const inflight = submit(f);
    try {
      expect((await waitAdmission(f)).state).toBe("pending");
      await Promise.race([entered.promise, inflight.then(() => { throw new Error("Provider did not enter the held successful response"); })]);
      expect((await submit(f)).discovery.state).toBe("pending");
      const closed = await close(f); expect(closed.discovery.state).toBe("closed"); gate.resolve(value);
      expect((await inflight).discovery).toEqual(closed.discovery); expect(await snapshot(f)).toEqual(before); expect(mock).toHaveBeenCalledTimes(1);
      expect((await submit(f)).discovery).toEqual(closed.discovery);
    } finally { gate.resolve(value); await inflight.catch(() => undefined); mock.mockRestore(); }
  });
  test("absent close creates an honest tombstone, never discovers and cannot later reopen", async () => {
    const f = await fixture("tombstone"), before = await snapshot(f), mock = vi.spyOn(client, "discoverMcpTools");
    try {
      const closed = await close(f); expect(closed.discovery).toMatchObject({ state: "closed", attempt: null, closure: { attemptId: null, attemptSha256: null } });
      expect((await submit(f)).discovery).toEqual(closed.discovery); expect((await close(f)).replayed).toBe(true);
      expect(await snapshot(f)).toEqual(before); expect(mock).not.toHaveBeenCalled();
    } finally { mock.mockRestore(); }
  });
  test("target configuration drift during network work settles failure and preserves the changed live target", async () => {
    const f = await fixture("drift"), gate = deferred(), value = await catalog(f), mock = provider(f, () => gate.promise), inflight = submit(f);
    try {
      await waitAdmission(f); await admin`UPDATE omni_mcp_connectors SET approval_required=FALSE WHERE id=${f.id}`; const changed = await snapshot(f);
      gate.resolve(value); const result = await inflight;
      expect(result.discovery.state === "settled" && result.discovery.settlement.result).toMatchObject({ status: "failed", failureCode: "target_changed" });
      expect(await snapshot(f)).toEqual(changed);
    } finally { gate.resolve(value); await inflight.catch(() => undefined); mock.mockRestore(); }
  });
  test("management loss prevents publication but active original owner can read and close", async () => {
    const f = await fixture("role-loss"), gate = deferred(), value = await catalog(f), mock = provider(f, () => gate.promise), inflight = submit(f);
    const outcome = inflight.catch((error: unknown) => error);
    try {
      await waitAdmission(f); await admin`UPDATE omni_auth_memberships SET role='viewer' WHERE tenant_id=${f.scope.tenantId} AND user_id=${user}`;
      const before = await snapshot(f); gate.resolve(value); expect(await outcome).toBeInstanceOf(Error);
      expect((await read(f))?.state).toBe("pending"); expect((await close(f)).discovery.state).toBe("closed"); expect(await snapshot(f)).toEqual(before);
    } finally { gate.resolve(value); await outcome; mock.mockRestore(); }
  });
  test("same-target admission is exclusive across owner keys and cross-owner recovery remains invisible", async () => {
    const f = await fixture("exclusive"), gate = deferred(), entered = signal(), value = await catalog(f),
      mock = provider(f, () => { entered.resolve(); return gate.promise; }), inflight = submit(f);
    try {
      await waitAdmission(f);
      await Promise.race([entered.promise, inflight.then(() => { throw new Error("Provider did not enter the held successful response"); })]);
      await expect(submit(f, "second")).rejects.toMatchObject({ status: 409 });
      const outsider = { ...f, scope: { ...f.scope, ownerActorId: other, canonicalActorId: `actor:${otherUser}` } };
      expect(await readNativeMcpDiscovery({ scope: outsider.scope }, keySha(f))).toBeNull();
      await expect(submit(outsider, "other")).rejects.toMatchObject({ status: 409 });
      const closed = await close(f); gate.resolve(value); expect((await inflight).discovery).toEqual(closed.discovery); expect(mock).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(value); await inflight.catch(() => undefined); mock.mockRestore(); }
  });
  test("publication event failure rolls back catalog replacement and leaves exact pending recovery", async () => {
    const f = await fixture("event-rollback"), before = await snapshot(f), mock = provider(f, await catalog(f));
    await admin`CREATE FUNCTION fail_discovery_fixture_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id=TG_ARGV[0] AND NEW.type='connector.native.mcp_discovery.settled' THEN RAISE EXCEPTION 'synthetic event rollback'; END IF; RETURN NEW; END $$`;
    await admin.unsafe(`CREATE TRIGGER fail_discovery_fixture_event BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION fail_discovery_fixture_event('${f.scope.tenantId}')`);
    try {
      await expect(submit(f)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before); expect((await read(f))?.state).toBe("pending");
      expect(await admin`SELECT type FROM omni_events WHERE tenant_id=${f.scope.tenantId} AND type IN ('connector.mcp.discovery_saved','connector.native.mcp_discovery.settled')`).toEqual([]);
      expect((await submit(f)).discovery.state).toBe("pending"); expect(mock).toHaveBeenCalledTimes(1);
    } finally { await admin`DROP TRIGGER fail_discovery_fixture_event ON omni_events`; await admin`DROP FUNCTION fail_discovery_fixture_event()`; mock.mockRestore(); }
  });
  test("provider failure is static and settled replay never rediscovers", async () => {
    const f = await fixture("provider-failed"), before = await snapshot(f), mock = vi.spyOn(client, "discoverMcpTools").mockRejectedValue(new Error("synthetic-private-provider-body"));
    try {
      const result = await submit(f); expect(result.discovery.state === "settled" && result.discovery.settlement.result).toMatchObject({ status: "failed", failureCode: "discovery_failed" });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-provider-body"); expect(await snapshot(f)).toEqual(before);
      expect((await submit(f)).discovery).toEqual(result.discovery); expect(mock).toHaveBeenCalledTimes(1);
    } finally { mock.mockRestore(); }
  });
  test("preserves reviewed risk and approval while new and changed contracts remain pending", async () => {
    const f = await fixture("policy"), first = await catalog(f, ["kept", "changed"]), mock = provider(f, first);
    try {
      await submit(f); await admin`UPDATE omni_mcp_tools SET status='active',risk_level=3,approval_required=TRUE WHERE tenant_id=${f.scope.tenantId}`;
      const current = await reviewNativeConnector({ scope: f.scope }, "mcp", f.id); f.request = C.connectorNativeMcpDiscoveryRequestSchema.parse({ ...f.request, review: current!.pin });
      const next = await catalog(f, ["kept", "changed", "new"]); next.tools[1].inputSchema = { type: "object", required: ["added"], properties: { added: { type: "string" } } };
      mock.mockImplementation(async (_connector, options) => { options?.verifyCredential?.([]); return next; });
      await submit(f, "next"); const tools = await inOwner(f, () => listMcpTools(f.id, { tenantId: f.scope.tenantId }));
      expect(tools.find((tool) => tool.name === "kept")).toMatchObject({ status: "active", riskLevel: 3, approvalRequired: true });
      expect(tools.find((tool) => tool.name === "changed")).toMatchObject({ status: "pending_review", riskLevel: 3, approvalRequired: true });
      expect(tools.find((tool) => tool.name === "new")).toMatchObject({ status: "pending_review" });
      expect((await inOwner(f, () => getMcpConnector(f.id, { tenantId: f.scope.tenantId })))?.status).toBe("disabled");
    } finally { mock.mockRestore(); }
  });
});
