import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { databaseMemoryAccessScopeFromExecutionScope } from "@/lib/db/memory-access-scope";
import type { SqlClient } from "@/lib/db/sql-types";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { readMemoryLifecycleTarget, submitMemoryLifecycleMutation, type MemoryLifecycleMutationAuthority } from "@/lib/memory/lifecycle-mutation-store";
import type { MemoryLifecycleMutationRequest } from "@/lib/memory/lifecycle-mutation-contracts";
import { forgetMemoryWithReceipt, previewMemoryDeletion } from "@/lib/memory/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const actor = "actor:11111111-1111-4111-8111-111111111111", otherActor = "actor:22222222-2222-4222-8222-222222222222";
const runtimeRole = "memory_lifecycle_test_runtime";

// Destructive disposable database only. All behavioral stores reconnect as a
// real NOSUPERUSER/NOBYPASSRLS serving role. Admin connections seed fixtures and
// observe deterministic PostgreSQL lock barriers; they never perform the action.
databaseDescribe("exact Memory lifecycle acceptance and forget closure", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 2, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    // Existing legacy grants are deployment provisioning, not installed by the
    // additive migration. RLS and every existing deletion/Memory guard stay on.
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_agent_runs,omni_agent_events,omni_workflow_runs,omni_workflow_plans,omni_tool_executions TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_memories,omni_memory_lifecycle_states,omni_events TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,DELETE ON omni_daily_briefs TO ${runtimeRole}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${runtimeRole}`);
    await closeDatabaseClient();
    const url = new URL(databaseUrl!); url.username = runtimeRole; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    await ensureDatabaseSchema();
    const [role] = await runWithDatabaseActorScope("lifecycle-proof", [actor], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_memories') AS memory_rls,
      row_security_active('public.omni_memory_lifecycle_mutations') AS receipt_rls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ role: runtimeRole, rolsuper: false, rolbypassrls: false, memory_rls: true, receipt_rls: true });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${runtimeRole}`); await admin.unsafe(`DROP ROLE ${runtimeRole}`); }
      await admin.end();
    }
  });

  function authority(tenantId: string, purpose: string = MEMORY_PURPOSE_IDS.maintenance, ownerActorId = actor): MemoryLifecycleMutationAuthority {
    const executionScope = createExecutionScope({ tenantId, initiatingActorId: ownerActorId, executingPrincipalType: "user", executingPrincipalId: ownerActorId,
      correlationId: `lifecycle-fixture:${tenantId}`, purpose: purpose === MEMORY_PURPOSE_IDS.forget ? "memory.forget.v1" : "api.memory.lifecycle.mutate.v1" });
    return { tenantId, ownerActorId, executionScope, accessScope: databaseMemoryAccessScopeFromExecutionScope(executionScope, { purposeId: purpose, auditPurpose: executionScope.purpose }) };
  }
  function owned<T>(a: MemoryLifecycleMutationAuthority, work: () => Promise<T>) {
    return runWithDatabaseActorScope(a.tenantId, [a.ownerActorId], work);
  }
  async function seed(tag: string, options: { tenant?: string; actor?: string; parent?: string } = {}) {
    const tenantId = options.tenant ?? `lifecycle-${tag}`, memoryId = `memory-${tag}`, ownerActorId = options.actor ?? actor;
    const binding = buildUserPrivateMemoryAccessBindingV1({ tenantId, ownerActorId, originPurpose: "memory.lifecycle.fixture" });
    await admin`INSERT INTO omni_memories(id,tenant_id,type,title,content,tags,scope,source,asserted_by,evidence_refs,
      access_contract_version,access_state,owner_actor_id,owner_agent_id,workspace_id,project_id,mission_id,visibility,sensitivity,origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
      VALUES(${memoryId},${tenantId},'fact','Private fixture','Never retain this private fixture text',${[]},'user','manual','user',${options.parent ? [`memory:${options.parent}`] : []},
        1,'scope_bound',${ownerActorId},NULL,NULL,NULL,NULL,'user_private',${binding.sensitivity},${binding.originPurpose},${[...binding.allowedPurposeIds]},${binding.accessScopeSha256},${binding.accessBoundAt})`;
    return { tenantId, memoryId, ownerActorId };
  }
  type Target = Awaited<ReturnType<typeof seed>>;
  async function read(target: Target) {
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.read, target.ownerActorId);
    const result = await owned(a, () => readMemoryLifecycleTarget(a, target.memoryId));
    if (!result) throw new Error("Fixture private Memory is not readable.");
    return result;
  }
  async function request(target: Target, action: MemoryLifecycleMutationRequest["action"]): Promise<MemoryLifecycleMutationRequest> {
    return { contract: "asael-memory-lifecycle-mutation:1", action, expectedTargetToken: (await read(target)).target.token };
  }
  function submit(target: Target, key: string, value: MemoryLifecycleMutationRequest, sql?: SqlClient) {
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.maintenance, target.ownerActorId);
    return owned(a, () => submitMemoryLifecycleMutation({ authority: a, memoryId: target.memoryId, idempotencyKey: key, request: value }, { sql }));
  }
  async function preview(target: Target) {
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.forget, target.ownerActorId);
    const result = await owned(a, () => previewMemoryDeletion(target.memoryId, { tenantId: target.tenantId, accessScope: a.accessScope }));
    if (!result) throw new Error("Fixture forget preview is missing.");
    return result;
  }
  function forget(target: Target, manifest: string) {
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.forget, target.ownerActorId);
    return owned(a, () => forgetMemoryWithReceipt(target.memoryId, { tenantId: target.tenantId, accessScope: a.accessScope,
      executionScope: a.executionScope, expectedDescendantManifestSha256: manifest }));
  }
  async function counts(target: Target) {
    return (await admin`SELECT
      (SELECT count(*)::INTEGER FROM omni_memory_lifecycle_mutations WHERE tenant_id=${target.tenantId}) AS receipts,
      (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${target.tenantId} AND type LIKE 'memory.lifecycle.%') AS events`)[0];
  }
  function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }
  async function blockedBy(pid: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await admin`SELECT pid FROM pg_stat_activity WHERE usename=${runtimeRole} AND ${pid}=ANY(pg_blocking_pids(pid))`;
      if (rows[0]) return Number(rows[0].pid);
    }
    throw new Error("Expected serving transaction never reached its PostgreSQL lock barrier.");
  }

  test("exact accepted replay survives later lifecycle changes without undoing them", async () => {
    const target = await seed("replay"), pin = await request(target, "pin");
    const accepted = await submit(target, "pin-key", pin);
    await submit(target, "unpin-key", await request(target, "unpin"));
    const replay = await submit(target, "pin-key", pin);
    expect(replay.acceptance).toEqual(accepted.acceptance); expect(replay.replayed).toBe(true);
    expect(replay.current.lifecycle.pinnedAt).toBeNull(); expect(replay.current.target.lifecycleRevision).toBe(2);
    expect(await counts(target)).toEqual({ receipts: 2, events: 2 });
    expect(JSON.stringify(replay)).not.toContain("Never retain");
  });
  test("same key with a different action, token or target cannot acquire a second effect", async () => {
    const target = await seed("key"), second = await seed("key-other", { tenant: target.tenantId });
    const pin = await request(target, "pin"); await submit(target, "shared-key", pin);
    await expect(submit(target, "shared-key", { ...pin, action: "unpin" })).rejects.toMatchObject({ code: "memory_lifecycle_key_conflict" });
    await expect(submit(target, "shared-key", await request(target, "pin"))).rejects.toMatchObject({ code: "memory_lifecycle_key_conflict" });
    await expect(submit(second, "shared-key", await request(second, "pin"))).rejects.toMatchObject({ code: "memory_lifecycle_key_conflict" });
    expect(await counts(target)).toEqual({ receipts: 1, events: 1 });
  });
  test("two overlapping sessions admit an identical key once and recover the same receipt", async () => {
    const target = await seed("concurrent-key"), value = await request(target, "pin");
    const held = deferred<number>(), release = deferred<void>(), a = authority(target.tenantId);
    const first = owned(a, () => getSql().transaction(async (sql: SqlClient) => {
      const result = await submit(target, "concurrent-key", value, sql);
      held.resolve(Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid));
      await release.promise; return result;
    }) as Promise<Awaited<ReturnType<typeof submit>>>);
    void first.catch(held.reject);
    const pid = await held.promise;
    const second = submit(target, "concurrent-key", value), outcomes = Promise.all([first, second]);
    try { expect(await blockedBy(pid)).not.toBe(pid); } finally { release.resolve(); }
    const [original, replay] = await outcomes;
    expect(replay.acceptance).toEqual(original.acceptance); expect(replay.replayed).toBe(true);
    expect(await counts(target)).toEqual({ receipts: 1, events: 1 });
  }, 30_000);
  test("target tokens reject semantic and lifecycle ABA but ignore actual usage-only updates", async () => {
    const target = await seed("token"), old = await request(target, "pin");
    await admin`UPDATE omni_memories SET use_count=use_count+1,last_used_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${target.memoryId}`;
    expect((await read(target)).target.token).toBe(old.expectedTargetToken);
    await admin`UPDATE omni_memories SET content='temporary semantic edit' WHERE id=${target.memoryId}`;
    await admin`UPDATE omni_memories SET content='Never retain this private fixture text' WHERE id=${target.memoryId}`;
    await expect(submit(target, "stale-content", old)).rejects.toMatchObject({ code: "memory_lifecycle_target_changed" });
    const fresh = await request(target, "pin"); await submit(target, "pin", fresh);
    await submit(target, "unpin", await request(target, "unpin"));
    await expect(submit(target, "stale-lifecycle", fresh)).rejects.toMatchObject({ code: "memory_lifecycle_target_changed" });
  });
  test("legacy writes bump the lifecycle counter and callers cannot set either revision", async () => {
    const target = await seed("legacy"), before = await read(target);
    await admin`INSERT INTO omni_memory_lifecycle_states(memory_id,tenant_id,access_contract_version,owner_actor_id,pinned_at)
      VALUES(${target.memoryId},${target.tenantId},1,${actor},clock_timestamp())`;
    expect((await read(target)).target.lifecycleRevision).toBe(1);
    await admin`UPDATE omni_memory_lifecycle_states SET pinned_at=NULL,lifecycle_revision=999 WHERE memory_id=${target.memoryId}`;
    expect((await read(target)).target.lifecycleRevision).toBe(2);
    await admin`UPDATE omni_memories SET lifecycle_target_revision=999 WHERE id=${target.memoryId}`;
    expect((await read(target)).target.targetRevision).toBe(before.target.targetRevision);
  });
  test("another actor and tenant cannot read targets or recover an owner's receipt", async () => {
    const target = await seed("owner"), value = await request(target, "pin"); await submit(target, "owner-key", value);
    const foreignActor = authority(target.tenantId, MEMORY_PURPOSE_IDS.maintenance, otherActor);
    await expect(owned(foreignActor, () => submitMemoryLifecycleMutation({ authority: foreignActor, memoryId: target.memoryId, idempotencyKey: "owner-key", request: value }))).rejects.toMatchObject({ status: 404 });
    const foreignTenant = authority("different-tenant");
    await expect(owned(foreignTenant, () => submitMemoryLifecycleMutation({ authority: foreignTenant, memoryId: target.memoryId, idempotencyKey: "owner-key", request: value }))).rejects.toMatchObject({ status: 404 });
    expect(await counts(target)).toEqual({ receipts: 1, events: 1 });
  });
  test("event failure rolls back state and acceptance together", async () => {
    const target = await seed("rollback"), value = await request(target, "pin");
    await admin`CREATE FUNCTION lifecycle_fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='lifecycle-rollback' THEN RAISE EXCEPTION 'fixture lifecycle event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER lifecycle_fixture_event_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION lifecycle_fixture_event_failure()`;
    try { await expect(submit(target, "rollback-key", value)).rejects.toThrow(/fixture lifecycle event failure/); }
    finally { await admin`DROP TRIGGER lifecycle_fixture_event_failure ON omni_events`; await admin`DROP FUNCTION lifecycle_fixture_event_failure()`; }
    expect((await read(target)).target.lifecycleRevision).toBe(0); expect(await counts(target)).toEqual({ receipts: 0, events: 0 });
    expect((await submit(target, "rollback-key", value)).acceptance.afterLifecycleRevision).toBe(1);
  });
  test("forgets root and descendant replay fingerprints atomically and refuses old-key replay", async () => {
    const root = await seed("forget"), child = await seed("forget-child", { tenant: root.tenantId, actor: otherActor, parent: root.memoryId });
    const unrelated = await seed("forget-unrelated", { tenant: root.tenantId, actor: otherActor });
    const rootRequest = await request(root, "pin"), childRequest = await request(child, "archive");
    const unrelatedRequest = await request(unrelated, "pin");
    await submit(root, "root-key", rootRequest); await submit(child, "child-key", childRequest);
    const unrelatedAccepted = await submit(unrelated, "unrelated-key", unrelatedRequest);
    const impact = await preview(root); expect(impact.impact.descendantMemoryCount).toBe(1);
    expect(impact.descendantMemories[0]).toMatchObject({ id: child.memoryId, title: "[restricted descendant]" });
    const result = await forget(root, impact.expectedReceiptManifestSha256); expect(result?.receipt).not.toBeNull();
    const rows = await admin`SELECT request_sha256,expected_target_token,acceptance,forgotten_at,deletion_receipt_id FROM omni_memory_lifecycle_mutations
      WHERE tenant_id=${root.tenantId} AND memory_id=ANY(${[root.memoryId, child.memoryId]}::TEXT[])`;
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(row).toMatchObject({ request_sha256: null, expected_target_token: null, acceptance: null, deletion_receipt_id: result!.receipt!.id }); expect(row.forgotten_at).not.toBeNull(); }
    await expect(submit(root, "root-key", rootRequest)).rejects.toMatchObject({ code: "memory_lifecycle_replay_forgotten" });
    await expect(submit(child, "child-key", childRequest)).rejects.toMatchObject({ code: "memory_lifecycle_replay_forgotten" });
    expect((await submit(unrelated, "unrelated-key", unrelatedRequest)).acceptance).toEqual(unrelatedAccepted.acceptance);
    await forget(root, impact.expectedReceiptManifestSha256);
    expect(await counts(root)).toEqual({ receipts: 3, events: 3 });
  });
  test("a committed lifecycle admission is scrubbed when overlapping forget obtains the lock second", async () => {
    const target = await seed("lifecycle-first"), value = await request(target, "pin"), impact = await preview(target);
    const held = deferred<number>(), release = deferred<void>(), a = authority(target.tenantId);
    const first = owned(a, () => getSql().transaction(async (sql: SqlClient) => {
      const result = await submit(target, "racing-key", value, sql);
      held.resolve(Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid));
      await release.promise; return result;
    }) as Promise<Awaited<ReturnType<typeof submit>>>);
    void first.catch(held.reject);
    const firstPid = await held.promise;
    const second = forget(target, impact.expectedReceiptManifestSha256);
    const outcomes = Promise.allSettled([first, second]);
    try { expect(await blockedBy(firstPid)).not.toBe(firstPid); } finally { release.resolve(); }
    expect((await outcomes).map((value) => value.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await admin`SELECT acceptance,request_sha256,expected_target_token FROM omni_memory_lifecycle_mutations WHERE tenant_id=${target.tenantId}`)[0]).toEqual({ acceptance: null, request_sha256: null, expected_target_token: null });
  }, 30_000);
  test("forget admitted first prevents a later lifecycle receipt even before forget commits", async () => {
    const target = await seed("forget-first"), value = await request(target, "pin"), impact = await preview(target);
    const held = deferred<number>(), release = deferred<void>();
    const gate = admin.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(772222,1)`;
      held.resolve(Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid)); await release.promise;
    });
    const gatePid = await held.promise;
    await admin`CREATE FUNCTION lifecycle_fixture_hold_forget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='lifecycle-forget-first' THEN PERFORM pg_advisory_xact_lock(772222,1); END IF; RETURN NULL; END $$`;
    await admin`CREATE TRIGGER zz_lifecycle_fixture_hold_forget AFTER INSERT ON omni_memory_deletion_receipts FOR EACH ROW EXECUTE FUNCTION lifecycle_fixture_hold_forget()`;
    try {
      const first = forget(target, impact.expectedReceiptManifestSha256);
      const forgetPid = await blockedBy(gatePid);
      const second = submit(target, "late-key", value);
      const outcomes = Promise.allSettled([first, second]);
      try { expect(await blockedBy(forgetPid)).not.toBe(forgetPid); } finally { release.resolve(); }
      await gate;
      const results = await outcomes; expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "memory_lifecycle_target_unavailable" } });
      expect(await counts(target)).toEqual({ receipts: 0, events: 0 });
    } finally {
      release.resolve(); await gate;
      await admin`DROP TRIGGER zz_lifecycle_fixture_hold_forget ON omni_memory_deletion_receipts`;
      await admin`DROP FUNCTION lifecycle_fixture_hold_forget()`;
    }
  }, 30_000);
});
