import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { databaseMemoryAccessScopeFromExecutionScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  forgetMemoryWithReceipt, getPrivateMemoryReconciliationReview, listPrivateMemoryReconciliationReviews,
  previewMemoryDeletion, resolvePrivateMemoryReconciliationReview, type MemoryReconciliationNativeAuthority,
} from "@/lib/memory/store";
import type { MemoryReconciliationNativeRequest } from "@/lib/memory/reconciliation-native-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const actor = "actor:11111111-1111-4111-8111-111111111111", otherActor = "actor:22222222-2222-4222-8222-222222222222";
const runtimeRole = "memory_reconciliation_test_runtime";

// Only a disposable database may run this destructive fixture. All product
// reads and decisions run as a real serving role with forced RLS still on.
databaseDescribe("native Memory reconciliation serving-role acceptance", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);
    await closeDatabaseClient();
    const url = new URL(databaseUrl!); url.username = runtimeRole; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    await ensureDatabaseSchema();
    const [role] = await runWithDatabaseActorScope("review-proof", [actor], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_memories') AS memory_rls,
      row_security_active('public.omni_memory_reconciliation_reviews') AS review_rls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ role: runtimeRole, rolsuper: false, rolbypassrls: false, memory_rls: true, review_rls: true });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${runtimeRole}`); await admin.unsafe(`DROP ROLE ${runtimeRole}`); }
      await admin.end();
    }
  });

  function authority(tenantId: string, purpose: string = MEMORY_PURPOSE_IDS.read, ownerActorId = actor): MemoryReconciliationNativeAuthority {
    const executionScope = createExecutionScope({ tenantId, initiatingActorId: ownerActorId, executingPrincipalType: "user", executingPrincipalId: ownerActorId,
      correlationId: `review-fixture:${tenantId}`, purpose: purpose === MEMORY_PURPOSE_IDS.forget ? "memory.forget.v1" : "api.memory.reconciliation.native.v1" });
    return { tenantId, ownerActorId, executionScope, accessScope: databaseMemoryAccessScopeFromExecutionScope(executionScope, { purposeId: purpose, auditPurpose: executionScope.purpose }) };
  }
  function owned<T>(a: MemoryReconciliationNativeAuthority, work: () => Promise<T>) {
    return runWithDatabaseActorScope(a.tenantId, [a.ownerActorId], work);
  }
  async function seed(tag: string, options: { correct?: boolean; actor?: string; tenant?: string; contradiction?: boolean } = {}) {
    const tenantId = options.tenant ?? `review-${tag}`, ownerActorId = options.actor ?? actor;
    const candidateId = `candidate-${tag}`, existingId = options.contradiction === false ? null : `existing-${tag}`, reviewId = `review-${tag}`;
    const binding = buildUserPrivateMemoryAccessBindingV1({ tenantId, ownerActorId, originPurpose: "memory.reconciliation.fixture",
      allowedPurposeIds: [MEMORY_PURPOSE_IDS.read, MEMORY_PURPOSE_IDS.forget, ...(options.correct === false ? [] : [MEMORY_PURPOSE_IDS.correct])] });
    for (const [id, claim] of [...(existingId ? [[existingId, "active"]] : []), [candidateId, "candidate"]]) {
      await admin`INSERT INTO omni_memories(id,tenant_id,type,title,content,tags,scope,source,asserted_by,claim_status,
        access_contract_version,access_state,owner_actor_id,owner_agent_id,workspace_id,project_id,mission_id,visibility,sensitivity,origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
        VALUES(${id},${tenantId},'fact','Private fixture','Do not retain this private claim',${[]},'user','manual','agent',${claim},
          1,'scope_bound',${ownerActorId},NULL,NULL,NULL,NULL,'user_private',${binding.sensitivity},${binding.originPurpose},${[...binding.allowedPurposeIds]},${binding.accessScopeSha256},${binding.accessBoundAt})`;
    }
    await admin`INSERT INTO omni_memory_reconciliation_reviews(id,tenant_id,owner_actor_id,kind,status,detection_reason,candidate_memory_id,existing_memory_id)
      VALUES(${reviewId},${tenantId},${ownerActorId},${existingId ? "contradiction" : "confirmation"},'pending','unverified_inference',${candidateId},${existingId})`;
    return { tenantId, ownerActorId, candidateId, existingId, reviewId };
  }
  type Target = Awaited<ReturnType<typeof seed>>;
  async function read(target: Target) {
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.read, target.ownerActorId);
    return owned(a, () => getPrivateMemoryReconciliationReview(a, target.reviewId));
  }
  async function request(target: Target, decision: MemoryReconciliationNativeRequest["decision"] = "confirm_candidate"): Promise<MemoryReconciliationNativeRequest> {
    const current = await read(target);
    if (!current?.reviewToken) throw new Error("Fixture review has no current decision token.");
    return { contract: "asael-memory-reconciliation-decision:1", reviewId: target.reviewId, decision, expectedReviewToken: current.reviewToken };
  }
  function submit(target: Target, value: MemoryReconciliationNativeRequest, key = "decision-key") {
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.correct, target.ownerActorId);
    return owned(a, () => resolvePrivateMemoryReconciliationReview({ authority: a, reviewId: target.reviewId, idempotencyKey: key, request: value }));
  }
  async function eventCount(target: Target) {
    return Number((await admin`SELECT count(*) AS count FROM omni_events WHERE tenant_id=${target.tenantId} AND type='memory.reconciliation.resolved'`)[0].count);
  }
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  async function blockedBy(pid: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await admin`SELECT pid FROM pg_stat_activity WHERE usename=${runtimeRole} AND ${pid}=ANY(pg_blocking_pids(pid))`;
      if (rows[0]) return;
    }
    throw new Error("Native decision never reached its PostgreSQL parent lock barrier.");
  }

  test("accepts exact private targets and returns the same immutable receipt without a second write", async () => {
    const target = await seed("accept"), value = await request(target);
    const accepted = await submit(target, value);
    expect(accepted.newlyApplied).toBe(true);
    expect(accepted.review.candidate).toMatchObject({ claimStatus: "active", assertedBy: "agent" });
    expect(accepted.acceptance.after.candidate.targetRevision).toBe(accepted.acceptance.before.candidate.targetRevision + 1);
    await admin`UPDATE omni_memories SET title='Later current title' WHERE id=${target.candidateId}`;
    const replay = await submit(target, value);
    expect(replay.acceptance).toEqual(accepted.acceptance); expect(replay.newlyApplied).toBe(false);
    expect(replay.review.candidate.title).toBe("Later current title");
    expect((await read(target))?.acceptance).toEqual(accepted.acceptance);
    expect(await eventCount(target)).toBe(1);
  });

  test("competing decisions and reused keys cannot accept a second interpretation", async () => {
    const target = await seed("race"), value = await request(target);
    const results = await Promise.allSettled([submit(target, value, "first"), submit(target, { ...value, decision: "keep_existing" }, "second")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await eventCount(target)).toBe(1);
    const accepted = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof submit>>>;
    const key = accepted.value.acceptance.decision === "confirm_candidate" ? "first" : "second";
    await expect(submit(target, { ...value, decision: accepted.value.acceptance.decision === "confirm_candidate" ? "keep_existing" : "confirm_candidate" }, key))
      .rejects.toMatchObject({ status: 409, code: "memory_reconciliation_key_conflict" });
  });

  test("a semantic or lifecycle change invalidates a previously inspected decision", async () => {
    const semantic = await seed("semantic"), oldSemantic = await request(semantic);
    await admin`UPDATE omni_memories SET content='Changed exact private claim' WHERE id=${semantic.candidateId}`;
    await expect(submit(semantic, oldSemantic)).rejects.toMatchObject({ code: "memory_reconciliation_target_changed" });
    const lifecycle = await seed("lifecycle"), oldLifecycle = await request(lifecycle);
    await admin`INSERT INTO omni_memory_lifecycle_states(memory_id,tenant_id,access_contract_version,owner_actor_id,policy_version,pinned_at)
      VALUES(${lifecycle.candidateId},${lifecycle.tenantId},1,${actor},1,NOW())`;
    await expect(submit(lifecycle, oldLifecycle)).rejects.toMatchObject({ code: "memory_reconciliation_target_changed" });
    expect(await eventCount(semantic)).toBe(0); expect(await eventCount(lifecycle)).toBe(0);
  });

  test("recomputes revisions after acquiring a contended parent lock", async () => {
    const target = await seed("locked"), value = await request(target), held = deferred(), release = deferred();
    let writerPid = 0;
    const writer = admin.begin(async (sql) => {
      writerPid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);
      await sql`SELECT id FROM omni_memories WHERE id=${target.candidateId} FOR UPDATE`;
      await sql`UPDATE omni_memories SET content='Committed while native request waits' WHERE id=${target.candidateId}`;
      held.resolve(); await release.promise;
    });
    await held.promise;
    const deciding = submit(target, value);
    try { await blockedBy(writerPid); } finally { release.resolve(); }
    await writer;
    await expect(deciding).rejects.toMatchObject({ code: "memory_reconciliation_target_changed" });
    expect(await eventCount(target)).toBe(0);
  });

  test("read-only purpose can inspect but never decide, and other owners cannot see the review", async () => {
    const target = await seed("read-only", { correct: false });
    expect((await read(target))?.reviewToken).toBeNull();
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.read, otherActor);
    expect(await owned(a, () => getPrivateMemoryReconciliationReview(a, target.reviewId))).toBeNull();
    const own = authority(target.tenantId);
    expect((await owned(own, () => listPrivateMemoryReconciliationReviews(own)))[0]?.review.id).toBe(target.reviewId);
    await expect(submit(target, { contract: "asael-memory-reconciliation-decision:1", reviewId: target.reviewId,
      decision: "confirm_candidate", expectedReviewToken: "0".repeat(64) })).rejects.toMatchObject({ status: 404 });
  });

  test("the lifecycle metadata helper cannot grant a correction writer lifecycle mutation authority", async () => {
    const target = await seed("purpose");
    await admin`INSERT INTO omni_memory_lifecycle_states(memory_id,tenant_id,access_contract_version,owner_actor_id,policy_version,pinned_at)
      VALUES(${target.candidateId},${target.tenantId},1,${actor},1,NOW())`;
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.correct);
    await owned(a, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      await setTransactionLocalDatabaseMemoryAccessScope(sql, a.accessScope);
      const snapshots = await sql`SELECT * FROM public.omni_memory_reconciliation_lifecycle_snapshot_v1(${target.tenantId},${actor},${[target.candidateId]},TRUE)`;
      expect(Number(snapshots[0]?.lifecycle_revision)).toBe(1);
      const deleted = await sql`DELETE FROM omni_memory_lifecycle_states WHERE memory_id=${target.candidateId} RETURNING memory_id`;
      expect(deleted).toHaveLength(0);
      expect((await sql`SELECT current_setting('omni.system_scope') AS scope`)[0].scope).toBe("false");
    }));
    expect((await admin`SELECT memory_id FROM omni_memory_lifecycle_states WHERE memory_id=${target.candidateId}`)).toHaveLength(1);
  });

  test.each(["candidate", "existing"] as const)("forgetting either %s target scrubs the event acceptance and forbids replay", async (which) => {
    const target = await seed(`forget-${which}`), value = await request(target);
    await submit(target, value);
    const id = which === "candidate" ? target.candidateId : target.existingId!;
    const a = authority(target.tenantId, MEMORY_PURPOSE_IDS.forget);
    await owned(a, async () => {
      const preview = await previewMemoryDeletion(id, { tenantId: target.tenantId, accessScope: a.accessScope });
      expect(preview).not.toBeNull();
      await forgetMemoryWithReceipt(id, { tenantId: target.tenantId, accessScope: a.accessScope, executionScope: a.executionScope,
        expectedDescendantManifestSha256: preview!.expectedReceiptManifestSha256 });
    });
    expect(await read(target)).toBeNull();
    await expect(submit(target, value)).rejects.toMatchObject({ status: 404 });
    const [event] = await admin`SELECT payload FROM omni_events WHERE tenant_id=${target.tenantId} AND type='memory.reconciliation.resolved'`;
    expect(event.payload.nativeAcceptance).toBeUndefined();
    expect(event.payload.digestsForgottenAt).toBeTruthy();
  });
});
