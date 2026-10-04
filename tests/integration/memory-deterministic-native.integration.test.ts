import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { nativeMemoryDeterministicResourceId, nativeMemoryGraphRebuildPinSchema, nativeMemoryMaintenancePinSchema,
  type NativeMemoryDeterministicKind, type NativeMemoryDeterministicRequest } from "@/lib/memory/deterministic-native-contracts";
import { readNativeMemoryGraphRebuild, readNativeMemoryMaintenanceRun, rebuildNativeMemoryGraph, reviewNativeMemoryGraphRebuild,
  reviewNativeMemoryMaintenance, runNativeMemoryMaintenance } from "@/lib/memory/deterministic-native-store";
import type { PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const role = "native_memory_deterministic_runtime", user = "11111111-1111-4111-8111-111111111111", owner = "deterministic@example.test",
  canonical = `actor:${user}`, other = "actor:22222222-2222-4222-8222-222222222222";
databaseDescribe("private Memory deterministic actions serving-role boundary", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    // Existing serving capabilities normally supplied by role provisioning.
    //234's receipt/function grants are inherited, never patched by this fixture.
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_retrieval_traces,omni_agent_runs,omni_tool_executions TO ${role}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_memories TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_memory_lifecycle_states,omni_memory_promotion_reviews TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON omni_memory_graph_nodes,omni_memory_graph_edges TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_memory_graph_builds,omni_events TO ${role}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${user},${owner},'fixture-only')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("deterministic-proof", [owner, canonical], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_native_private_memory_actions') AS receipt_rls,
      has_table_privilege(current_user,'omni_auth_user_actor_identifiers','SELECT') AS private_registry_read FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role, rolsuper: false, rolbypassrls: false, receipt_rls: true, private_registry_read: false });
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); vi.unstubAllEnvs(); if (admin) {
    if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); } await admin.end(); } });
  async function scope(tag: string): Promise<PrivateActionScope> {
    const tenantId = `deterministic-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tenantId}:member`},${tenantId},${user},'operator')`;
    return { tenantId, ownerActorId: owner, canonicalActorId: canonical };
  }
  async function memory(s: PrivateActionScope, suffix: string, maintenance = false, actor = canonical) {
    const id = `${s.tenantId}:${suffix}`, binding = buildUserPrivateMemoryAccessBindingV1({ tenantId: s.tenantId, ownerActorId: actor,
      originPurpose: "native.memory.fixture", allowedPurposeIds: [MEMORY_PURPOSE_IDS.read, MEMORY_PURPOSE_IDS.write, MEMORY_PURPOSE_IDS.forget,
        ...(maintenance ? [MEMORY_PURPOSE_IDS.maintenance] : [])], accessBoundAt: "2026-10-04T00:00:00.000Z" });
    await admin`INSERT INTO omni_memories(id,tenant_id,type,tier,tier_policy_version,formation_reason,title,content,tags,scope,source,
      importance,confidence,asserted_by,claim_status,evidence_refs,access_contract_version,access_state,owner_actor_id,visibility,sensitivity,
      origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
      VALUES(${id},${s.tenantId},'fact','semantic',1,'explicit_user_request','Private release procedure','Review the deployment report and release checklist',${[]},'user','user',
        0.8,0.9,'user','active',${[]},1,'scope_bound',${actor},'user_private',${binding.sensitivity},${binding.originPurpose},${[...binding.allowedPurposeIds]},${binding.accessScopeSha256},${binding.accessBoundAt})`;
    return id;
  }
  async function request(s: PrivateActionScope, kind: NativeMemoryDeterministicKind): Promise<NativeMemoryDeterministicRequest> {
    const current = await (kind === "maintenance" ? reviewNativeMemoryMaintenance : reviewNativeMemoryGraphRebuild)({ scope: s });
    if (!current.pin) throw new Error(`Fixture inventory unavailable: ${current.reason}`);
    return kind === "maintenance" ? { contract: "asael-memory-maintenance-run:1", review: nativeMemoryMaintenancePinSchema.parse(current.pin) }
      : { contract: "asael-memory-graph-rebuild:1", review: nativeMemoryGraphRebuildPinSchema.parse(current.pin) };
  }
  function submit(s: PrivateActionScope, kind: NativeMemoryDeterministicKind, body: NativeMemoryDeterministicRequest, key = "once") {
    const executionScope = createExecutionScope({ tenantId: s.tenantId, initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner,
      correlationId: key, causationId: nativeMemoryDeterministicResourceId(s, kind), purpose: kind === "maintenance" ? "api.memory.maintenance.run" : "api.memory.graph.rebuild" });
    return (kind === "maintenance" ? runNativeMemoryMaintenance : rebuildNativeMemoryGraph)({ authority: { scope: s, executionScope }, request: body, idempotencyKey: key });
  }
  test("maintenance excludes default private policies and exact competing replay archives once", async () => {
    const s = await scope("maintenance"); await memory(s, "default");
    expect(await reviewNativeMemoryMaintenance({ scope: s })).toMatchObject({ eligible: true, excludedMemoryCount: 1, pin: { eligibleMemoryCount: 0 } });
    await memory(s, "a", true); await memory(s, "b", true);
    const body = await request(s, "maintenance"), results = await Promise.all([submit(s, "maintenance", body), submit(s, "maintenance", body)]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]); expect(results[0].acceptance).toEqual(results[1].acceptance);
    expect(results[0].acceptance.result).toMatchObject({ scanned: 2, autoArchivedDuplicates: 1 });
    expect((await admin`SELECT memory_id FROM omni_memory_lifecycle_states WHERE tenant_id=${s.tenantId} AND archived_at IS NOT NULL`)).toHaveLength(1);
    expect(await readNativeMemoryMaintenanceRun({ scope: s }, results[0].acceptance.keySha256)).toEqual(results[0].acceptance);
    await admin`UPDATE omni_auth_memberships SET role='viewer' WHERE tenant_id=${s.tenantId}`;
    expect(await readNativeMemoryMaintenanceRun({ scope: s }, results[0].acceptance.keySha256)).toEqual(results[0].acceptance);
    await expect(submit(s, "maintenance", body)).rejects.toMatchObject({ status: 403 });
  });
  test("graph binds exact source set and current lifecycle while owner-scoped replay has zero effects", async () => {
    const s = await scope("graph"), first = await memory(s, "a"); await memory(s, "foreign", false, other);
    const stale = await request(s, "graph"); await memory(s, "b");
    await expect(submit(s, "graph", stale)).rejects.toMatchObject({ status: 409 });
    const body = await request(s, "graph"), accepted = await submit(s, "graph", body);
    expect(accepted.acceptance.result).toMatchObject({ memoryCount: 2, traceCount: 0 });
    const graph = await admin`SELECT id,owner_actor_id FROM omni_memory_graph_nodes WHERE tenant_id=${s.tenantId}`;
    expect(graph.length).toBeGreaterThan(0); expect(graph.every((row) => row.owner_actor_id === canonical)).toBe(true);
    await admin`INSERT INTO omni_memory_lifecycle_states(memory_id,tenant_id,access_contract_version,owner_actor_id,policy_version,archived_at,archive_reason)
      VALUES(${first},${s.tenantId},1,${canonical},1,NOW(),'manual')`;
    expect((await submit(s, "graph", body)).acceptance).toEqual(accepted.acceptance);
    expect(await readNativeMemoryGraphRebuild({ scope: s }, accepted.acceptance.keySha256)).toEqual(accepted.acceptance);
    expect((await admin`SELECT id FROM omni_memory_graph_builds WHERE tenant_id=${s.tenantId}`)).toHaveLength(1);
    await expect(submit(s, "graph", body, "fresh-key")).rejects.toMatchObject({ status: 409 });
    expect(await runWithDatabaseTenantScope(s.tenantId, () => getSql()`SELECT acceptance FROM omni_native_private_memory_actions`)).toEqual([]);
    await expect(readNativeMemoryGraphRebuild({ scope: { ...s, ownerActorId: "another@example.test" } }, accepted.acceptance.keySha256)).rejects.toMatchObject({ status: 403 });
  });
  test("event failure rolls back lifecycle, graph, build and immutable acceptance in the same transaction", async () => {
    for (const kind of ["maintenance", "graph"] as const) {
      const s = await scope(`rollback-${kind}`); await memory(s, "a", true); await memory(s, "b", true);
      const body = await request(s, kind);
      await admin`CREATE FUNCTION deterministic_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='private_memory.native_action.accepted' THEN RAISE EXCEPTION 'fixture acceptance event failure'; END IF; RETURN NEW; END $$`;
      await admin`CREATE TRIGGER deterministic_fixture_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION deterministic_fixture_failure()`;
      try {
        await expect(submit(s, kind, body)).rejects.toMatchObject({ code: "P0001" });
        for (const table of ["omni_memory_lifecycle_states", "omni_memory_graph_nodes", "omni_memory_graph_builds", "omni_native_private_memory_actions"]) {
          expect(await admin.unsafe(`SELECT tenant_id FROM ${table} WHERE tenant_id=$1`, [s.tenantId])).toEqual([]);
        }
      } finally { await admin`DROP TRIGGER deterministic_fixture_failure ON omni_events`; await admin`DROP FUNCTION deterministic_fixture_failure()`; }
    }
  });
  test("overflow is refused and default maintenance purpose is not widened", async () => {
    const s = await scope("overflow"), first = await memory(s, "seed", true);
    await admin`INSERT INTO omni_memories(id,tenant_id,type,tier,tier_policy_version,formation_reason,title,content,tags,scope,source,importance,confidence,asserted_by,claim_status,evidence_refs,
      access_contract_version,access_state,owner_actor_id,visibility,sensitivity,origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
      SELECT ${s.tenantId} || ':extra:' || ordinal,m.tenant_id,m.type,m.tier,m.tier_policy_version,m.formation_reason,m.title,m.content,m.tags,m.scope,m.source,m.importance,m.confidence,m.asserted_by,m.claim_status,m.evidence_refs,
        m.access_contract_version,m.access_state,m.owner_actor_id,m.visibility,m.sensitivity,m.origin_purpose,m.allowed_purpose_ids,m.access_scope_sha256,m.access_bound_at
      FROM omni_memories m CROSS JOIN generate_series(1,500) ordinal WHERE m.id=${first}`;
    expect(await reviewNativeMemoryMaintenance({ scope: s })).toMatchObject({ eligible: false, reason: "scope_too_large", pin: null });
    expect(await admin`SELECT acceptance FROM omni_native_private_memory_actions WHERE tenant_id=${s.tenantId}`).toEqual([]);
  });
});
