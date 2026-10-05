import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import type { SqlClient } from "@/lib/db/sql-types";
import { sealConnectorNativePin, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import * as C from "@/lib/connectors/native-mcp-discovery-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { removeNativeMcpDiscoveriesForReplay, removeNativeGithubUpgradesForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const runtimeRole = "mcp_discovery_schema_runtime", maintenanceRole = "mcp_discovery_schema_maintenance";
const users = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;
const owners = ["discovery-schema-owner@example.test", "discovery-schema-other@example.test"] as const;

integration("native MCP discovery243 schema under serving-role RLS", () => {
  let admin: ReturnType<typeof postgres>, rolesCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`CREATE ROLE ${maintenanceRole} NOLOGIN NOSUPERUSER BYPASSRLS IN ROLE omni_maintenance`); rolesCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships TO ${runtimeRole}`);
    //243 owns its new table/column/function grants. These grants cover only
    //legacy parent/child rows needed by the real trigger's catalog checks.
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_mcp_connectors,omni_mcp_tools TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${users[0]},${owners[0]},'fixture'),(${users[1]},${owners[1]},'fixture')`;
    const serving = new URL(databaseUrl!); serving.username = runtimeRole; serving.password = password;
    await closeDatabaseClient(); vi.stubEnv("DATABASE_URL", serving.toString()); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3"); await ensureDatabaseSchema();
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (rolesCreated) for (const role of [runtimeRole, maintenanceRole]) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); }
      await admin.end();
    }
  });

  async function now() {
    const [row] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
    return String(row.now);
  }
  async function fixture(tag: string) {
    const tenantId = `discovery-schema-${tag}`, connectorId = `discovery-parent-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},${tag},${tenantId})`;
    for (let index = 0; index < users.length; index++) await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role)
      VALUES(${`${tag}:${index}`},${tenantId},${users[index]},'admin')`;
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,status,auth_type,transport,credential_version)
      VALUES(${connectorId},${tenantId},'Synthetic discovery','https://93.184.216.34/mcp','disabled','none','streamable_http',NULL)`;
    return { tenantId, connectorId };
  }
  type Target = Awaited<ReturnType<typeof fixture>>;
  async function evidence(target: Target, key = "attempt", ownerIndex = 0) {
    const scope: ConnectorNativeScope = { tenantId: target.tenantId, ownerActorId: owners[ownerIndex], canonicalActorId: `actor:${users[ownerIndex]}` };
    const pin = sealConnectorNativePin({ kind: "mcp", connectorId: target.connectorId, connectorSha256: canonicalJsonSha256(["original", target.connectorId]),
      configurationSha256: canonicalJsonSha256(["configuration", target.connectorId]), contractsSha256: canonicalJsonSha256([]), credentialVersion: 0, reviewFingerprint: null });
    const request = C.connectorNativeMcpDiscoveryRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: target.connectorId, action: "discover", preview: null, review: pin });
    const intent = C.buildConnectorNativeMcpDiscoveryIntent(scope, key, request), startedAt = await now();
    const body = { contract: "asael-mcp-discovery-attempt:1", id: C.connectorNativeMcpDiscoveryAttemptId(scope, intent.keySha256), scope,
      keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: target.connectorId,
      reviewSha256: request.review.reviewSha256, startedAt, expiresAt: new Date(Date.parse(startedAt) + 45_000).toISOString() };
    const attempt = C.connectorNativeMcpDiscoveryAttemptSchema.parse({ ...body, attemptSha256: canonicalJsonSha256(body) });
    return { ...target, scope, intent, attempt, token: randomBytes(32).toString("hex"), binding: randomBytes(32).toString("hex") };
  }
  type Evidence = Awaited<ReturnType<typeof evidence>>;
  const scoped = <T,>(f: Evidence, operation: () => Promise<T>) => runWithDatabaseActorScope(f.tenantId, [f.scope.ownerActorId, f.scope.canonicalActorId], operation);
  const insert = (f: Evidence) => scoped(f, async () => {
    const sql = getSql();
    return sql`INSERT INTO omni_native_mcp_discoveries(id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,connector_id,
      intent,attempt,attempt_expires_at,publication_token,credential_binding_sha256,state)
      VALUES(${f.attempt.id},${f.tenantId},${f.scope.ownerActorId},${f.scope.canonicalActorId},${f.intent.keySha256},${f.connectorId},
        ${f.intent}::jsonb,${f.attempt}::jsonb,${f.attempt.expiresAt},${f.token},${f.binding},'pending')`;
  });
  async function closure(f: Evidence, admitted: boolean) {
    const body = { contract: "asael-mcp-discovery-closure:1", scope: f.scope, keySha256: f.intent.keySha256, intentSha256: canonicalJsonSha256(f.intent),
      attemptId: admitted ? f.attempt.id : null, attemptSha256: admitted ? f.attempt.attemptSha256 : null, closedAt: await now() };
    return C.connectorNativeMcpDiscoveryClosureSchema.parse({ ...body, closureSha256: canonicalJsonSha256(body) });
  }
  async function close(f: Evidence) {
    const proof = await closure(f, true);
    return scoped(f, async () => { const sql = getSql(); return sql`UPDATE omni_native_mcp_discoveries
      SET state='closed',publication_token=NULL,closure=${proof}::jsonb WHERE id=${f.attempt.id} RETURNING id`; });
  }
  async function settlement(f: Evidence, count = 0, pendingCount = count, settledAt?: string) {
    const { reviewSha256: _originalDigest, ...originalPin } = f.intent.request.review;
    const review = sealConnectorNativePin({ ...originalPin, connectorSha256: canonicalJsonSha256(["result", f.connectorId, count]),
      contractsSha256: canonicalJsonSha256(Array.from({ length: count }, (_, index) => ({ tool: index }))) });
    const body = { contract: "asael-mcp-discovery-settlement:1", attemptId: f.attempt.id, attemptSha256: f.attempt.attemptSha256,
      settledAt: settledAt ?? await now(), result: { status: "complete", kind: "mcp", connectorId: f.connectorId, connectorStatus: "disabled",
        contractCount: count, pendingCount, credentialVersion: 0, review } };
    return C.connectorNativeMcpDiscoverySettlementSchema.parse({ ...body, settlementSha256: canonicalJsonSha256(body) });
  }
  const settle = (f: Evidence, proof: C.ConnectorNativeMcpDiscoverySettlement) => scoped(f, async () => {
    const sql = getSql(); return sql`UPDATE omni_native_mcp_discoveries SET state='settled',publication_token=NULL,settlement=${proof}::jsonb WHERE id=${f.attempt.id} RETURNING id`;
  });
  const rows = (f: Evidence) => admin`SELECT * FROM omni_native_mcp_discoveries WHERE tenant_id=${f.tenantId} ORDER BY id`;
  async function expire(f: Evidence) {
    const expiresAt = new Date(Date.parse(await now()) - 1).toISOString(), { attemptSha256: _old, ...original } = f.attempt;
    const body = { ...original, startedAt: new Date(Date.parse(expiresAt) - 45_000).toISOString(), expiresAt };
    const attempt = C.connectorNativeMcpDiscoveryAttemptSchema.parse({ ...body, attemptSha256: canonicalJsonSha256(body) });
    //Fixture retiming is admin-only. All constraints and the trigger are active
    //again before the serving-role statement whose behavior this test proves.
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_mcp_discoveries DISABLE TRIGGER omni_native_mcp_discovery_guard`;
      await sql`UPDATE omni_native_mcp_discoveries SET attempt=${sql.json(attempt)},attempt_expires_at=${expiresAt} WHERE id=${attempt.id}`;
      await sql`ALTER TABLE omni_native_mcp_discoveries ENABLE TRIGGER omni_native_mcp_discovery_guard`;
    });
    return { ...f, attempt };
  }

  test("243 adds only its family and replays without changing the v45 catalog boundary", async () => {
    const row = databaseSchemaMigrations.find((migration) => migration.version === 243)!;
    expect(row).toBeDefined();
    const migration = await readSqlMigrationFile({ file: "20261006100000_native_mcp_discoveries.sql", sha256: row.checksum, migrations: [row] });
    const githubUpgrade = databaseSchemaMigrations.find((entry) => entry.version === 244)!;
    const githubUpgradeMigration = await readSqlMigrationFile({ file: "20261006103000_native_github_upgrades.sql", sha256: githubUpgrade.checksum, migrations: [githubUpgrade] });
    const snapshot = (sql: postgres.TransactionSql) => sql`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('omni_native_connector_actions'::regclass,'omni_native_openapi_import_preparations'::regclass) ORDER BY conrelid,conname`;
    await admin.begin(async (sql) => {
      const before = await snapshot(sql), legacy = await sql`SELECT * FROM omni_schema_version WHERE version IS NULL`;
      await removeNativeGithubUpgradesForReplay(sql);
      await sql`DELETE FROM omni_schema_version WHERE version=244`;
      await removeNativeMcpDiscoveriesForReplay(sql);
      await sql`DELETE FROM omni_schema_version WHERE version=243`;
      const adapter: Parameters<typeof applySqlMigrationFile>[0] = { unsafe: async (text, params) => {
        const values = (params ?? []).map((value) => { if (typeof value !== "string") throw new Error("Migration settings must be strings."); return value; });
        return await sql.unsafe<Record<string, unknown>[]>(text, values);
      } };
      await applySqlMigrationFile(adapter, migration, [row], []);
      await applySqlMigrationFile(adapter, githubUpgradeMigration, [githubUpgrade], []);
      expect(await snapshot(sql)).toEqual(before);
      expect(await sql`SELECT * FROM omni_schema_version WHERE version IS NULL`).toEqual(legacy);
    });
  });

  test("runtime has forced owner RLS and narrow grants; maintenance has no mutation grants", async () => {
    const f = await evidence(await fixture("roles"));
    const [proof] = await scoped(f, () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_mcp_discoveries') AS rls,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS registry_read,
      has_table_privilege(current_user,'public.omni_native_mcp_discoveries','DELETE') AS can_delete,
      has_table_privilege(current_user,'public.omni_native_mcp_discoveries','TRUNCATE') AS can_truncate,
      has_column_privilege(current_user,'public.omni_native_mcp_discoveries','intent','UPDATE') AS can_rewrite
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toEqual({ role: runtimeRole, rolsuper: false, rolbypassrls: false, rls: true, registry_read: false, can_delete: false, can_truncate: false, can_rewrite: false });
    expect(await admin`SELECT has_table_privilege(${maintenanceRole},'public.omni_native_mcp_discoveries','INSERT') AS admit,
      has_any_column_privilege(${maintenanceRole},'public.omni_native_mcp_discoveries','UPDATE') AS mutate`).toEqual([{ admit: false, mutate: false }]);
  });

  test("one pending target fences a competing owner, including after logical expiry", async () => {
    const target = await fixture("reservation"), first = await evidence(target), other = await evidence(target, "other", 1);
    await insert(first); const expired = await expire(first);
    await expect(insert(other)).rejects.toMatchObject({ code: "23505" });
    const before = await rows(first);
    expect(before[0].state).toBe("pending"); expect(before[0].publication_token).toBe(first.token);
    await close(expired); await insert(other);
    expect((await rows(first)).map((row) => row.state).sort()).toEqual(["closed", "pending"]);
  });

  test("absent close is an immutable tombstone without an invented attempt", async () => {
    const f = await evidence(await fixture("tombstone")), proof = await closure(f, false);
    await scoped(f, async () => { const sql = getSql(); await sql`INSERT INTO omni_native_mcp_discoveries(id,tenant_id,owner_actor_id,canonical_actor_id,
      idempotency_key_sha256,connector_id,intent,state,closure) VALUES(${f.attempt.id},${f.tenantId},${f.scope.ownerActorId},${f.scope.canonicalActorId},
      ${f.intent.keySha256},${f.connectorId},${f.intent}::jsonb,'closed',${proof}::jsonb)`; });
    const before = await rows(f);
    expect(before[0]).toMatchObject({ state: "closed", attempt: null, attempt_expires_at: null, publication_token: null, credential_binding_sha256: null });
    await expect(insert(f)).rejects.toMatchObject({ code: "23505" });
    await expect(close(f)).rejects.toMatchObject({ code: "55000" });
    expect(await rows(f)).toEqual(before);
  });

  test("active owner can close after demotion but cannot settle", async () => {
    const f = await evidence(await fixture("demotion")); await insert(f);
    await admin`UPDATE omni_auth_memberships SET role='operator' WHERE tenant_id=${f.tenantId} AND user_id=${users[0]}`;
    await expect(settle(f, await settlement(f))).rejects.toMatchObject({ code: "42501" });
    expect(await close(f)).toHaveLength(1);
    expect((await rows(f))[0]).toMatchObject({ state: "closed", publication_token: null, credential_binding_sha256: f.binding });
  });

  test("other owners, tenants and inactive members cannot read or close private evidence", async () => {
    const target = await fixture("isolation"), f = await evidence(target); await insert(f); const before = await rows(f);
    const other = await evidence(target, "other", 1);
    expect(await scoped(other, () => getSql()`SELECT id FROM omni_native_mcp_discoveries WHERE id=${f.attempt.id}`)).toEqual([]);
    expect(await scoped(other, () => getSql()`UPDATE omni_native_mcp_discoveries SET publication_token=NULL WHERE id=${f.attempt.id} RETURNING id`)).toEqual([]);
    expect(await runWithDatabaseActorScope("discovery-unrelated-tenant", [f.scope.ownerActorId, f.scope.canonicalActorId], () => getSql()`SELECT id FROM omni_native_mcp_discoveries WHERE id=${f.attempt.id}`)).toEqual([]);
    await admin`UPDATE omni_auth_memberships SET status='inactive' WHERE tenant_id=${f.tenantId} AND user_id=${users[0]}`;
    expect(await close(f)).toEqual([]);
    expect(await rows(f)).toEqual(before);
  });

  test("forged system GUC grants no privilege and cannot mutate another owner", async () => {
    const target = await fixture("forged-system"), f = await evidence(target); await insert(f); const before = await rows(f);
    const other = await evidence(target, "other", 1);
    await scoped(other, () => getSql().transaction(async (sql: SqlClient) => {
      await sql`SELECT set_config('omni.system_scope','true',true)`;
      expect(await sql`SELECT omni_system_scope_enabled() AS enabled`).toEqual([{ enabled: false }]);
      expect(await sql`UPDATE omni_native_mcp_discoveries SET publication_token=NULL WHERE id=${f.attempt.id} RETURNING id`).toEqual([]);
    }));
    expect(await rows(f)).toEqual(before);
  });

  test("successful empty catalog is disabled and terminal evidence survives parent deletion", async () => {
    const f = await evidence(await fixture("empty-success")); await insert(f);
    expect(await settle(f, await settlement(f))).toHaveLength(1);
    const before = await rows(f);
    expect(before[0]).toMatchObject({ state: "settled", publication_token: null, credential_binding_sha256: f.binding });
    await expect(close(f)).rejects.toMatchObject({ code: "55000" });
    await admin`DELETE FROM omni_mcp_connectors WHERE tenant_id=${f.tenantId} AND id=${f.connectorId}`;
    expect(await scoped(f, () => getSql()`SELECT id,state FROM omni_native_mcp_discoveries WHERE id=${f.attempt.id}`)).toEqual([{ id: f.attempt.id, state: "settled" }]);
    expect(await rows(f)).toEqual(before);
  });

  test("completion binds the entire current count and pending policy count", async () => {
    const f = await evidence(await fixture("counts")); await insert(f);
    await admin`INSERT INTO omni_mcp_tools(id,tenant_id,connector_id,connector_name,name,status)
      VALUES(${`${f.connectorId}:one`},${f.tenantId},${f.connectorId},'Synthetic discovery','one','active')`;
    await admin`UPDATE omni_mcp_connectors SET tool_count=1 WHERE id=${f.connectorId}`;
    await expect(settle(f, await settlement(f, 0))).rejects.toMatchObject({ code: "23514" });
    await expect(settle(f, await settlement(f, 1, 1))).rejects.toMatchObject({ code: "23514" });
    expect(await settle(f, await settlement(f, 1, 0))).toHaveLength(1);
  });

  test("SQL publication uses fresh DB time even with an in-window settlement timestamp", async () => {
    const f = await evidence(await fixture("expired-complete")); await insert(f); const expired = await expire(f);
    const earlier = new Date(Date.parse(expired.attempt.expiresAt) - 1).toISOString();
    await expect(settle(expired, await settlement(expired, 0, 0, earlier))).rejects.toMatchObject({ code: "23514" });
    expect((await rows(f))[0].state).toBe("pending");
  });

  test("deadline failure cannot precede DB deadline, then settles without parent changes", async () => {
    const f = await evidence(await fixture("deadline-failure")); await insert(f);
    const failed = async (value: Evidence) => { const body = { contract: "asael-mcp-discovery-settlement:1", attemptId: value.attempt.id,
      attemptSha256: value.attempt.attemptSha256, settledAt: await now(), result: { status: "failed", kind: "mcp", connectorId: value.connectorId, failureCode: "deadline_exceeded" } };
      return C.connectorNativeMcpDiscoverySettlementSchema.parse({ ...body, settlementSha256: canonicalJsonSha256(body) }); };
    const parent = await admin`SELECT * FROM omni_mcp_connectors WHERE id=${f.connectorId}`;
    await expect(settle(f, await failed(f))).rejects.toMatchObject({ code: "23514" });
    const expired = await expire(f); expect(await settle(expired, await failed(expired))).toHaveLength(1);
    expect(await admin`SELECT * FROM omni_mcp_connectors WHERE id=${f.connectorId}`).toEqual(parent);
  });

  test("a parent status change prevents successful publication without losing the pending evidence", async () => {
    const f = await evidence(await fixture("parent-drift")); await insert(f); const before = await rows(f);
    await admin`UPDATE omni_mcp_connectors SET status='active' WHERE id=${f.connectorId}`;
    await expect(settle(f, await settlement(f))).rejects.toMatchObject({ code: "23514" });
    expect(await rows(f)).toEqual(before);
  });

  test("validators reject wire widening, mismatched evidence and over-native counts", async () => {
    const f = await evidence(await fixture("validators")), valid = await settlement(f), closed = await closure(f, true);
    const [result] = await scoped(f, async () => { const sql = getSql(); return sql`SELECT
      omni_native_mcp_discovery_intent_valid_v1(${f.intent}::jsonb) AS valid,
      omni_native_mcp_discovery_intent_valid_v1(${{ ...f.intent, request: { ...f.intent.request, action: null } }}::jsonb) AS missing_action,
      omni_native_mcp_discovery_intent_valid_v1(${{ ...f.intent, request: { ...f.intent.request, preview: {} } }}::jsonb) AS preview,
      omni_native_mcp_discovery_attempt_valid_v1(${{ ...f.attempt, intentSha256: null }}::jsonb,${f.intent}::jsonb) AS missing_digest,
      omni_native_mcp_discovery_settlement_valid_v1(${{ ...valid, result: { ...valid.result, contractCount: 201 } }}::jsonb,${f.intent}::jsonb,${f.attempt}::jsonb) AS excess,
      omni_native_mcp_discovery_closure_valid_v1(${{ ...closed, attemptId: null, attemptSha256: null }}::jsonb,${f.intent}::jsonb,${f.attempt}::jsonb) AS invented_absence`; });
    expect(result).toEqual({ valid: true, missing_action: false, preview: false, missing_digest: false, excess: false, invented_absence: false });
  });
});
