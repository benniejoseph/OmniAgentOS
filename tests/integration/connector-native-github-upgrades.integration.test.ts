import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, databaseSchemaMigrations, ensureDatabaseSchema, getSql,
  runWithDatabaseActorScope } from "@/lib/db/client";
import { applySqlMigrationFile, readSqlMigrationFile } from "@/lib/db/sql-migration-files";
import { reviewNativeConnector } from "@/lib/connectors/native-control-store";
import { connectorNativeKeySha256, type ConnectorNativeScope } from "@/lib/connectors/native-control-contracts";
import * as D from "@/lib/connectors/native-mcp-discovery-contracts";
import * as G from "@/lib/connectors/native-github-upgrade-contracts";
import { closeNativeMcpDiscovery, readNativeMcpDiscovery, submitNativeMcpDiscovery } from "@/lib/connectors/native-mcp-discovery-store";
import { closeNativeGithubUpgrade, readNativeGithubUpgrade, reviewNativeGithubUpgrade,
  submitNativeGithubUpgrade } from "@/lib/connectors/native-github-upgrade-store";
import { createMcpToolId } from "@/lib/connectors/store";
import type { McpToolRecord } from "@/lib/connectors/types";
import * as client from "@/lib/connectors/mcp-client";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { removeNativeGithubUpgradesForReplay } from "./helpers/native-catalog-replay";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const runtimeRole = "native_github_upgrade_proof_runtime";
const outsiderRole = "native_github_upgrade_proof_outsider";
const users = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;
const owners = ["github-upgrade-owner@example.test", "github-upgrade-other@example.test"] as const;
const legacyEndpoint = "https://api.githubcopilot.com/mcp";

integration("native GitHub upgrade244 serving-role and shared-provider proof", () => {
  let admin: ReturnType<typeof postgres>;
  const createdRoles: string[] = [];
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 4, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require",
      onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    createdRoles.push(runtimeRole);
    await admin.unsafe(`CREATE ROLE ${outsiderRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    createdRoles.push(outsiderRole);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions TO ${runtimeRole}`);
    // v244 grants the new ledger and helper itself. The fixture grants only
    // existing catalog/event access required by the real services.
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_mcp_connectors,omni_mcp_tools TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${runtimeRole}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash)
      VALUES(${users[0]},${owners[0]},'fixture'),(${users[1]},${owners[1]},'fixture')`;
    const serving = new URL(databaseUrl!);
    serving.username = runtimeRole;
    serving.password = password;
    await closeDatabaseClient();
    vi.stubEnv("DATABASE_URL", serving.toString());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    await ensureDatabaseSchema();
  }, 180_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDatabaseClient();
    vi.unstubAllEnvs();
    if (admin) {
      for (const role of createdRoles.reverse()) {
        await admin.unsafe(`DROP OWNED BY ${role}`);
        await admin.unsafe(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });

  async function now() {
    const [row] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
    return String(row.now);
  }
  async function target(tag: string) {
    const tenantId = `github-upgrade-proof-${tag}`, connectorId = `github-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},${tag},${tenantId})`;
    for (let index = 0; index < users.length; index++) {
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role)
        VALUES(${`${tag}:${index}`},${tenantId},${users[index]},'admin')`;
    }
    await admin`INSERT INTO omni_mcp_connectors(id,tenant_id,name,endpoint,status,auth_type,transport,credential_version)
      VALUES(${connectorId},${tenantId},'Synthetic GitHub connector',${legacyEndpoint},'disabled','none','streamable_http',NULL)`;
    return { tenantId, connectorId };
  }
  type Target = Awaited<ReturnType<typeof target>>;
  const scope = (t: Target, index = 0): ConnectorNativeScope => ({
    tenantId: t.tenantId, ownerActorId: owners[index], canonicalActorId: `actor:${users[index]}`,
  });
  const as = <T,>(s: ConnectorNativeScope, work: () => Promise<T>) =>
    runWithDatabaseActorScope(s.tenantId, [s.ownerActorId, s.canonicalActorId], work);
  function authority(s: ConnectorNativeScope, connectorId: string, kind: "github" | "discovery", close = false) {
    const purpose = kind === "github"
      ? close ? "api.connectors.native.github_upgrade_close" : "api.connectors.native.github_upgrade"
      : close ? "api.connectors.native.mcp_discovery_close" : "api.connectors.native.mcp_discovery";
    return { scope: s, executionScope: createExecutionScope({ tenantId: s.tenantId,
      initiatingActorId: s.ownerActorId, executingPrincipalType: "user", executingPrincipalId: s.ownerActorId,
      causationId: connectorId, correlationId: "github-upgrade-disposable-proof", purpose }) };
  }
  async function request(t: Target, s: ConnectorNativeScope, kind: "github" | "discovery") {
    const reviewed = await reviewNativeConnector({ scope: s }, "mcp", t.connectorId);
    expect(reviewed?.pin).not.toBeNull();
    if (kind === "github") {
      expect((await reviewNativeGithubUpgrade({ scope: s }, t.connectorId))?.eligible).toBe(true);
      return G.connectorNativeGithubUpgradeRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1",
        kind: "mcp", connectorId: t.connectorId, action: "upgrade_github", review: reviewed!.pin, preview: null });
    }
    return D.connectorNativeMcpDiscoveryRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1",
      kind: "mcp", connectorId: t.connectorId, action: "discover", review: reviewed!.pin, preview: null });
  }
  async function github(t: Target, s: ConnectorNativeScope, key: string) {
    const reviewed = G.connectorNativeGithubUpgradeRequestSchema.parse(await request(t, s, "github"));
    const intent = G.buildConnectorNativeGithubUpgradeIntent(s, key, reviewed);
    const startedAt = await now(), expiresAt = new Date(Date.parse(startedAt) + 45_000).toISOString();
    const body = { contract: "asael-github-upgrade-attempt:1", id: G.connectorNativeGithubUpgradeAttemptId(s, intent.keySha256),
      scope: s, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), connectorId: t.connectorId,
      reviewSha256: reviewed.review.reviewSha256, targetEndpoint: G.connectorNativeGithubUpgradeAttemptSchema.shape.targetEndpoint.value,
      startedAt, expiresAt };
    const attempt = G.connectorNativeGithubUpgradeAttemptSchema.parse({ ...body, attemptSha256: canonicalJsonSha256(body) });
    return { t, scope: s, key, request: reviewed, intent, attempt,
      token: randomBytes(32).toString("hex"), binding: randomBytes(32).toString("hex") };
  }
  async function discovery(t: Target, s: ConnectorNativeScope, key: string) {
    const reviewed = D.connectorNativeMcpDiscoveryRequestSchema.parse(await request(t, s, "discovery"));
    const intent = D.buildConnectorNativeMcpDiscoveryIntent(s, key, reviewed);
    const startedAt = await now(), expiresAt = new Date(Date.parse(startedAt) + 45_000).toISOString();
    const body = { contract: "asael-mcp-discovery-attempt:1", id: D.connectorNativeMcpDiscoveryAttemptId(s, intent.keySha256),
      scope: s, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), kind: "mcp",
      connectorId: t.connectorId, reviewSha256: reviewed.review.reviewSha256, startedAt, expiresAt };
    const attempt = D.connectorNativeMcpDiscoveryAttemptSchema.parse({ ...body, attemptSha256: canonicalJsonSha256(body) });
    return { t, scope: s, key, request: reviewed, intent, attempt,
      token: randomBytes(32).toString("hex"), binding: randomBytes(32).toString("hex") };
  }
  type Github = Awaited<ReturnType<typeof github>>;
  type Discovery = Awaited<ReturnType<typeof discovery>>;
  const insertGithub = (f: Github) => as(f.scope, () => getSql()`INSERT INTO omni_native_github_upgrades(
    id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,connector_id,
    intent,attempt,attempt_expires_at,publication_token,credential_binding_sha256,state)
    VALUES(${f.attempt.id},${f.t.tenantId},${f.scope.ownerActorId},${f.scope.canonicalActorId},
      ${f.intent.keySha256},${f.t.connectorId},${f.intent}::jsonb,${f.attempt}::jsonb,
      ${f.attempt.expiresAt},${f.token},${f.binding},'pending') RETURNING id`);
  const insertDiscovery = (f: Discovery) => as(f.scope, () => getSql()`INSERT INTO omni_native_mcp_discoveries(
    id,tenant_id,owner_actor_id,canonical_actor_id,idempotency_key_sha256,connector_id,
    intent,attempt,attempt_expires_at,publication_token,credential_binding_sha256,state)
    VALUES(${f.attempt.id},${f.t.tenantId},${f.scope.ownerActorId},${f.scope.canonicalActorId},
      ${f.intent.keySha256},${f.t.connectorId},${f.intent}::jsonb,${f.attempt}::jsonb,
      ${f.attempt.expiresAt},${f.token},${f.binding},'pending') RETURNING id`);
  async function closeGithubRow(f: Github) {
    const body = { contract: "asael-github-upgrade-closure:1", scope: f.scope,
      keySha256: f.intent.keySha256, intentSha256: canonicalJsonSha256(f.intent),
      attemptId: f.attempt.id, attemptSha256: f.attempt.attemptSha256, closedAt: await now() };
    const closure = G.connectorNativeGithubUpgradeClosureSchema.parse({ ...body,
      closureSha256: canonicalJsonSha256(body) });
    return as(f.scope, () => getSql()`UPDATE omni_native_github_upgrades
      SET state='closed',publication_token=NULL,closure=${closure}::jsonb
      WHERE id=${f.attempt.id} RETURNING id`);
  }
  async function closeDiscoveryRow(f: Discovery) {
    const body = { contract: "asael-mcp-discovery-closure:1", scope: f.scope,
      keySha256: f.intent.keySha256, intentSha256: canonicalJsonSha256(f.intent),
      attemptId: f.attempt.id, attemptSha256: f.attempt.attemptSha256, closedAt: await now() };
    const closure = D.connectorNativeMcpDiscoveryClosureSchema.parse({ ...body,
      closureSha256: canonicalJsonSha256(body) });
    return as(f.scope, () => getSql()`UPDATE omni_native_mcp_discoveries
      SET state='closed',publication_token=NULL,closure=${closure}::jsonb
      WHERE id=${f.attempt.id} RETURNING id`);
  }
  async function expireGithub(f: Github) {
    const expiresAt = new Date(Date.now() - 1_000).toISOString();
    const { attemptSha256: _old, ...original } = f.attempt;
    const body = { ...original, startedAt: new Date(Date.parse(expiresAt) - 45_000).toISOString(), expiresAt };
    const attempt = G.connectorNativeGithubUpgradeAttemptSchema.parse({ ...body, attemptSha256: canonicalJsonSha256(body) });
    // An admin-only clock shift exercises the real serving-role predicate and
    // trigger after the guard is enabled again; no runtime bypass is granted.
    await admin.begin(async (sql) => {
      await sql`ALTER TABLE omni_native_github_upgrades DISABLE TRIGGER omni_native_github_upgrade_guard`;
      await sql`UPDATE omni_native_github_upgrades SET attempt=${sql.json(attempt)},attempt_expires_at=${expiresAt}
        WHERE id=${f.attempt.id}`;
      await sql`ALTER TABLE omni_native_github_upgrades ENABLE TRIGGER omni_native_github_upgrade_guard`;
    });
    return { ...f, attempt };
  }
  async function catalog(t: Target, names = ["get_issue"]): Promise<Awaited<ReturnType<typeof client.discoverMcpTools>>> {
    const capturedAt = new Date().toISOString();
    const tools: McpToolRecord[] = names.map((name) => ({ id: createMcpToolId(t.connectorId, name), tenantId: t.tenantId,
      connectorId: t.connectorId, connectorName: "Synthetic GitHub connector", name,
      inputSchema: { type: "object", properties: {} }, riskLevel: 1, approvalRequired: false,
      status: "pending_review", createdAt: capturedAt, updatedAt: capturedAt }));
    return { capabilities: { tools: { listChanged: false } }, instructions: "Synthetic catalog",
      serverVersion: { name: "Synthetic", version: "1" }, tools };
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  async function waitForRow(table: "omni_native_github_upgrades" | "omni_native_mcp_discoveries", tenantId: string) {
    for (let index = 0; index < 100; index++) {
      const rows = await admin.unsafe(`SELECT state FROM ${table} WHERE tenant_id=$1`, [tenantId]);
      if (rows.length) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The provider admission was not observed.");
  }

  test("244 requires the exact 243 predecessor and installs forced RLS plus a privileged, narrow fence", async () => {
    const [v243, v244] = databaseSchemaMigrations.filter((row) => row.version === 243 || row.version === 244);
    expect([v243?.version, v244?.version]).toEqual([243, 244]);
    expect(await admin`SELECT version,name,checksum FROM omni_schema_version WHERE version IN (243,244) ORDER BY version`)
      .toEqual([v243, v244].map(({ version, name, checksum }) => ({ version, name, checksum })));
    const migration = await readSqlMigrationFile({ file: "20261006103000_native_github_upgrades.sql",
      sha256: v244.checksum, migrations: [v244] });
    await expect(admin.begin(async (sql) => {
      await sql`DELETE FROM omni_schema_version WHERE version IN (243,244,245)`;
      const adapter: Parameters<typeof applySqlMigrationFile>[0] = { unsafe: async (statement, params) => {
        const values = (params ?? []).map((value) => {
          if (typeof value !== "string") throw new Error("Migration settings must be strings.");
          return value;
        });
        return sql.unsafe<Record<string, unknown>[]>(statement, values);
      } };
      await applySqlMigrationFile(adapter, migration, [v244], []);
    })).rejects.toThrow(/Native GitHub upgrade predecessor is invalid/);
    expect(await admin`SELECT version FROM omni_schema_version WHERE version IN (243,244) ORDER BY version`)
      .toEqual([{ version: 243 }, { version: 244 }]);
    expect(await admin`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid IN ('omni_native_github_upgrades'::regclass,'omni_native_mcp_discoveries'::regclass)
      ORDER BY relname`).toEqual([
      { relname: "omni_native_github_upgrades", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "omni_native_mcp_discoveries", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const functions = await admin`SELECT p.proname,p.prosecdef,r.rolsuper,r.rolbypassrls,
      has_function_privilege(${runtimeRole},p.oid,'EXECUTE') AS runtime_execute,
      has_function_privilege(${outsiderRole},p.oid,'EXECUTE') AS outsider_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid IN ('public.omni_native_provider_pending_v1(text,text,text,text)'::regprocedure,
        'public.omni_native_provider_singleflight_v1()'::regprocedure) ORDER BY p.proname`;
    expect(functions).toHaveLength(2);
    expect(functions.map(({ proname, prosecdef, runtime_execute, outsider_execute }) =>
      ({ proname, prosecdef, runtime_execute, outsider_execute }))).toEqual([
      { proname: "omni_native_provider_pending_v1", prosecdef: true,
        runtime_execute: true, outsider_execute: false },
      { proname: "omni_native_provider_singleflight_v1", prosecdef: true,
        runtime_execute: false, outsider_execute: false },
    ]);
    for (const row of functions) expect(row.rolsuper || row.rolbypassrls).toBe(true);
    const triggers = await admin`SELECT c.relname,t.tgname FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid WHERE c.oid IN
      ('omni_native_github_upgrades'::regclass,'omni_native_mcp_discoveries'::regclass)
      AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`;
    for (const table of ["omni_native_github_upgrades", "omni_native_mcp_discoveries"]) {
      const names = triggers.filter((row) => row.relname === table).map((row) => row.tgname);
      expect(names[0]).toBe("omni_native_00_provider_singleflight");
      expect(names).toContain(table === "omni_native_github_upgrades"
        ? "omni_native_github_upgrade_guard" : "omni_native_mcp_discovery_guard");
    }
    expect(await as({ tenantId: "missing-tenant", ownerActorId: owners[0], canonicalActorId: `actor:${users[0]}` },
      () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
        has_table_privilege(current_user,'public.omni_native_github_upgrades','DELETE') AS can_delete,
        has_column_privilege(current_user,'public.omni_native_github_upgrades','intent','UPDATE') AS can_rewrite
        FROM pg_roles WHERE rolname=current_user`))
      .toEqual([{ role: runtimeRole, rolsuper: false, rolbypassrls: false, can_delete: false, can_rewrite: false }]);
  });

  test("245 removes direct grants inherited from production-style default function privileges", async () => {
    const [v244, v245] = databaseSchemaMigrations.filter((row) => row.version === 244 || row.version === 245);
    expect([v244?.version, v245?.version]).toEqual([244, 245]);
    const upgrade = await readSqlMigrationFile({ file: "20261006103000_native_github_upgrades.sql",
      sha256: v244.checksum, migrations: [v244] });
    const repair = await readSqlMigrationFile({ file: "20261006110000_native_provider_function_acl_repair.sql",
      sha256: v245.checksum, migrations: [v245] });
    let verified = false;
    await expect(admin.begin(async (sql) => {
      await removeNativeGithubUpgradesForReplay(sql);
      await sql`DELETE FROM omni_schema_version WHERE version IN (244,245)`;
      for (const role of ["anon", "authenticated", "service_role"]) {
        const [exists] = await sql`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role}) AS exists`;
        if (!exists.exists) await sql.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      }
      await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role,omni_runtime,omni_maintenance`;
      const adapter: Parameters<typeof applySqlMigrationFile>[0] = { unsafe: (statement, params) => {
        const values = (params ?? []).map((value) => {
          if (typeof value !== "string") throw new Error("Migration settings must be strings.");
          return value;
        });
        return sql.unsafe<Record<string, unknown>[]>(statement, values);
      } };
      await applySqlMigrationFile(adapter, upgrade, [v244], []);
      const executions = async () => sql`SELECT p.proname,pg_get_userbyid(p.proowner) AS owner,
        ARRAY(SELECT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE r.rolname END
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
          LEFT JOIN pg_roles r ON r.oid=acl.grantee
          WHERE acl.privilege_type='EXECUTE' ORDER BY 1) AS grantees,
        has_function_privilege('omni_runtime',p.oid,'EXECUTE') AS runtime_execute
        FROM pg_proc p WHERE p.oid IN
        ('public.omni_native_provider_pending_v1(text,text,text,text)'::regprocedure,
         'public.omni_native_provider_singleflight_v1()'::regprocedure)
        ORDER BY p.proname`;
      const before = await executions();
      expect(before).toHaveLength(2);
      for (const row of before) {
        for (const role of ["anon", "authenticated", "service_role", "omni_runtime", "omni_maintenance"])
          expect(row.grantees).toContain(role);
      }
      expect(before[1].runtime_execute).toBe(true);
      await applySqlMigrationFile(adapter, repair, [v245], []);
      const after = await executions();
      expect(after).toEqual([
        { proname: "omni_native_provider_pending_v1", owner: after[0].owner,
          grantees: [after[0].owner, "omni_runtime"].sort(), runtime_execute: true },
        { proname: "omni_native_provider_singleflight_v1", owner: after[1].owner,
          grantees: [after[1].owner], runtime_execute: false },
      ]);
      verified = true;
      throw new Error("Rollback production-default ACL fixture");
    })).rejects.toThrow("Rollback production-default ACL fixture");
    expect(verified).toBe(true);
    expect(await admin`SELECT version FROM omni_schema_version WHERE version IN (244,245) ORDER BY version`)
      .toEqual([{ version: 244 }, { version: 245 }]);
  });

  test("manager sees only a boolean across owner RLS; viewer and cross-tenant calls fail closed", async () => {
    const t = await target("helper"), otherTenant = await target("helper-other");
    const first = await github(t, scope(t), "first");
    await insertGithub(first);
    const secondScope = scope(t, 1);
    expect(await as(secondScope, () => getSql()`SELECT id,intent FROM omni_native_github_upgrades
      WHERE tenant_id=${t.tenantId}`)).toEqual([]);
    expect(await as(secondScope, () => getSql()`SELECT public.omni_native_provider_pending_v1(
      ${t.tenantId},${secondScope.ownerActorId},${secondScope.canonicalActorId},${t.connectorId}) AS pending`))
      .toEqual([{ pending: true }]);
    expect(await as(secondScope, () => getSql()`SELECT public.omni_native_provider_pending_v1(
      ${t.tenantId},${secondScope.ownerActorId},${secondScope.canonicalActorId},'missing-connector') AS pending`))
      .toEqual([{ pending: false }]);
    await expect(as(secondScope, () => getSql()`SELECT public.omni_native_provider_pending_v1(
      ${otherTenant.tenantId},${secondScope.ownerActorId},${secondScope.canonicalActorId},${otherTenant.connectorId})`))
      .rejects.toMatchObject({ code: "42501" });
    await admin`UPDATE omni_auth_memberships SET role='viewer'
      WHERE tenant_id=${t.tenantId} AND user_id=${users[1]}`;
    await expect(as(secondScope, () => getSql()`SELECT public.omni_native_provider_pending_v1(
      ${t.tenantId},${secondScope.ownerActorId},${secondScope.canonicalActorId},${t.connectorId})`))
      .rejects.toMatchObject({ code: "42501" });
    await admin`UPDATE omni_auth_memberships SET role='admin'
      WHERE tenant_id=${t.tenantId} AND user_id=${users[1]}`;
    expect(await closeGithubRow(first)).toHaveLength(1);
  });

  test("concurrent cross-ledger admissions have exactly one winner", async () => {
    const t = await target("race"), gh = await github(t, scope(t), "github"), discover = await discovery(t, scope(t, 1), "discover");
    const raced = await Promise.allSettled([insertGithub(gh), insertDiscovery(discover)]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = raced.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "23505" });
    if (raced[0].status === "fulfilled") await closeGithubRow(gh);
    else await closeDiscoveryRow(discover);
  });

  test.each(["github", "discovery"] as const)("%s pending row fences the reciprocal family until exact close", async (firstFamily) => {
    const t = await target(`direction-${firstFamily}`);
    const gh = await github(t, scope(t), "github"), discover = await discovery(t, scope(t, 1), "discover");
    if (firstFamily === "github") {
      await insertGithub(gh);
      const expired = await expireGithub(gh);
      expect(await as(scope(t, 1), () => getSql()`SELECT public.omni_native_provider_pending_v1(
        ${t.tenantId},${owners[1]},${`actor:${users[1]}`},${t.connectorId}) AS pending`)).toEqual([{ pending: true }]);
      await expect(insertDiscovery(discover)).rejects.toMatchObject({ code: "23505" });
      await closeGithubRow(expired);
      expect(await insertDiscovery(discover)).toHaveLength(1);
    } else {
      await insertDiscovery(discover);
      await expect(insertGithub(gh)).rejects.toMatchObject({ code: "23505" });
      await closeDiscoveryRow(discover);
      expect(await insertGithub(gh)).toHaveLength(1);
    }
  });

  test("a self-consistent but mismatched closure intent digest cannot close an admitted attempt", async () => {
    const t = await target("tamper"), f = await github(t, scope(t), "tamper");
    await insertGithub(f);
    const wrongHash = f.attempt.intentSha256 === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    const body = { contract: "asael-github-upgrade-closure:1", scope: f.scope,
      keySha256: f.intent.keySha256, intentSha256: wrongHash,
      attemptId: f.attempt.id, attemptSha256: f.attempt.attemptSha256, closedAt: await now() };
    const forged = G.connectorNativeGithubUpgradeClosureSchema.parse({ ...body,
      closureSha256: canonicalJsonSha256(body) });
    await expect(as(f.scope, () => getSql()`UPDATE omni_native_github_upgrades
      SET state='closed',publication_token=NULL,closure=${forged}::jsonb WHERE id=${f.attempt.id}`))
      .rejects.toMatchObject({ code: "23514" });
    expect(await admin`SELECT state,closure FROM omni_native_github_upgrades WHERE id=${f.attempt.id}`)
      .toEqual([{ state: "pending", closure: null }]);
    expect(await closeGithubRow(f)).toHaveLength(1);
  });

  test("successful upgrade disables the legacy connector and resets every published tool for review", async () => {
    const t = await target("policy");
    await admin`UPDATE omni_mcp_connectors SET status='active',tool_count=1,
      last_error='old private error',default_risk_level=3,approval_required=TRUE
      WHERE id=${t.connectorId}`;
    await admin`INSERT INTO omni_mcp_tools(id,tenant_id,connector_id,connector_name,name,input_schema,
      risk_level,approval_required,status)
      VALUES(${createMcpToolId(t.connectorId, "get_issue")},${t.tenantId},${t.connectorId},
        'Synthetic GitHub connector','get_issue',${admin.json({ type: "object", properties: {} })},3,TRUE,'active')`;
    const f = await github(t, scope(t), "policy"), discovered = await catalog(t, ["get_issue", "list_projects"]);
    const provider = vi.spyOn(client, "discoverMcpTools").mockImplementation(async (connector, options) => {
      expect(connector.endpoint).toBe("https://api.githubcopilot.com/mcp/x/all");
      options?.verifyCredential?.([]);
      return discovered;
    });
    try {
      const result = await submitNativeGithubUpgrade({ authority: authority(f.scope, t.connectorId, "github"),
        request: f.request, idempotencyKey: f.key });
      expect(result.upgrade.state).toBe("settled");
      if (result.upgrade.state !== "settled") throw new Error("The upgrade did not settle.");
      expect(result.upgrade.settlement.result).toMatchObject({ status: "complete", contractCount: 2,
        pendingCount: 2, connectorStatus: "disabled", defaultRiskLevel: 2, approvalRequired: false });
      expect(await admin`SELECT endpoint,status,default_risk_level,approval_required,tool_count,last_error
        FROM omni_mcp_connectors WHERE id=${t.connectorId}`).toEqual([{
        endpoint: "https://api.githubcopilot.com/mcp/x/all", status: "disabled",
        default_risk_level: 2, approval_required: false, tool_count: 2, last_error: null,
      }]);
      expect(await admin`SELECT name,status,risk_level,approval_required FROM omni_mcp_tools
        WHERE tenant_id=${t.tenantId} AND connector_id=${t.connectorId} ORDER BY name`).toEqual([
        { name: "get_issue", status: "pending_review", risk_level: 1, approval_required: false },
        { name: "list_projects", status: "pending_review", risk_level: 1, approval_required: false },
      ]);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally { provider.mockRestore(); }
  });

  test("GitHub same-key replay is exact; pending upgrade fences v46 discovery by another manager", async () => {
    const t = await target("upgrade-first"), f = await github(t, scope(t), "first"), other = await discovery(t, scope(t, 1), "other");
    const result = await catalog(t), held = deferred<typeof result>();
    const provider = vi.spyOn(client, "discoverMcpTools").mockImplementationOnce(() => held.promise)
      .mockResolvedValue(result);
    const inflight = submitNativeGithubUpgrade({ authority: authority(f.scope, t.connectorId, "github"),
      request: f.request, idempotencyKey: f.key });
    try {
      expect((await waitForRow("omni_native_github_upgrades", t.tenantId)).state).toBe("pending");
      const replay = await submitNativeGithubUpgrade({ authority: authority(f.scope, t.connectorId, "github"),
        request: f.request, idempotencyKey: f.key });
      expect(replay).toMatchObject({ replayed: true, upgrade: { state: "pending" } });
      await expect(submitNativeGithubUpgrade({ authority: authority(f.scope, t.connectorId, "github"),
        request: f.request, idempotencyKey: "different-key" })).rejects.toMatchObject({ status: 409 });
      expect(await readNativeGithubUpgrade({ scope: other.scope }, connectorNativeKeySha256(f.scope, f.key))).toBeNull();
      await expect(submitNativeMcpDiscovery({ authority: authority(other.scope, t.connectorId, "discovery"),
        request: other.request, idempotencyKey: other.key })).rejects.toMatchObject({ status: 409 });
      const closed = await closeNativeGithubUpgrade({ authority: authority(f.scope, t.connectorId, "github", true),
        request: G.connectorNativeGithubUpgradeCloseRequestSchema.parse({ contract: "asael-github-upgrade-close:1", intent: f.intent }),
        idempotencyKey: f.key, keySha256: f.intent.keySha256 });
      expect(closed.upgrade.state).toBe("closed");
      held.resolve(result);
      expect((await inflight).upgrade).toEqual(closed.upgrade);
      expect((await submitNativeMcpDiscovery({ authority: authority(other.scope, t.connectorId, "discovery"),
        request: other.request, idempotencyKey: other.key })).discovery.state).toBe("settled");
      expect(provider).toHaveBeenCalledTimes(2);
    } finally { held.resolve(result); await inflight.catch(() => undefined); provider.mockRestore(); }
  });

  test("v46 discovery pending fences GitHub upgrade by another manager until exact close", async () => {
    const t = await target("discovery-first"), f = await discovery(t, scope(t), "first"), other = await github(t, scope(t, 1), "other");
    const result = await catalog(t), held = deferred<typeof result>();
    const provider = vi.spyOn(client, "discoverMcpTools").mockImplementationOnce(() => held.promise)
      .mockResolvedValue(result);
    const inflight = submitNativeMcpDiscovery({ authority: authority(f.scope, t.connectorId, "discovery"),
      request: f.request, idempotencyKey: f.key });
    try {
      expect((await waitForRow("omni_native_mcp_discoveries", t.tenantId)).state).toBe("pending");
      expect(await readNativeMcpDiscovery({ scope: other.scope }, connectorNativeKeySha256(f.scope, f.key))).toBeNull();
      await expect(submitNativeGithubUpgrade({ authority: authority(other.scope, t.connectorId, "github"),
        request: other.request, idempotencyKey: other.key })).rejects.toMatchObject({ status: 409 });
      const closed = await closeNativeMcpDiscovery({ authority: authority(f.scope, t.connectorId, "discovery", true),
        request: D.connectorNativeMcpDiscoveryCloseRequestSchema.parse({ contract: "asael-mcp-discovery-close:1", intent: f.intent }),
        idempotencyKey: f.key, keySha256: f.intent.keySha256 });
      expect(closed.discovery.state).toBe("closed");
      held.resolve(result);
      expect((await inflight).discovery).toEqual(closed.discovery);
      expect((await submitNativeGithubUpgrade({ authority: authority(other.scope, t.connectorId, "github"),
        request: other.request, idempotencyKey: other.key })).upgrade.state).toBe("settled");
      expect(provider).toHaveBeenCalledTimes(2);
    } finally { held.resolve(result); await inflight.catch(() => undefined); provider.mockRestore(); }
  });
});
