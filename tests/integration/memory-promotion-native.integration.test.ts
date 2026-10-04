import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { databaseMemoryAccessScopeFromExecutionScope, setTransactionLocalDatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { memoryClaimFingerprint, memoryPromotedRecordId } from "@/lib/memory/lifecycle";
import { getPrivateMemoryPromotionReview, listPrivateMemoryPromotionReviews, resolvePrivateMemoryPromotionReview, type MemoryPromotionNativeAuthority } from "@/lib/memory/promotion-native-store";
import type { MemoryPromotionNativeRequest } from "@/lib/memory/promotion-native-contracts";
import { forgetMemoryWithReceipt, memoryFromRow, previewMemoryDeletion } from "@/lib/memory/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const actor = "actor:11111111-1111-4111-8111-111111111111", otherActor = "actor:22222222-2222-4222-8222-222222222222";
const runtimeRole = "memory_promotion_test_runtime";

// Product operations use a real non-bypass serving role. Administrative setup
// and failure injection are limited to this explicitly disposable database.
databaseDescribe("native Memory promotion serving-role decisions", () => {
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
    const [role] = await runWithDatabaseActorScope("promotion-proof", [actor], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_memories') AS memory_rls,
      row_security_active('public.omni_memory_promotion_reviews') AS review_rls,
      has_function_privilege(current_user,'public.omni_memory_promotion_source_snapshot_v1(text,text,text[],boolean)','EXECUTE') AS snapshot_execute
      FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ role: runtimeRole, rolsuper: false, rolbypassrls: false, memory_rls: true, review_rls: true, snapshot_execute: true });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${runtimeRole}`); await admin.unsafe(`DROP ROLE ${runtimeRole}`); }
      await admin.end();
    }
  });

  function authority(tenantId: string, reviewId: string, purpose: string = MEMORY_PURPOSE_IDS.read, ownerActorId = actor): MemoryPromotionNativeAuthority {
    const executionScope = createExecutionScope({ tenantId, initiatingActorId: ownerActorId, executingPrincipalType: "user", executingPrincipalId: ownerActorId,
      correlationId: `promotion-fixture:${tenantId}`, causationId: reviewId,
      purpose: purpose === MEMORY_PURPOSE_IDS.forget ? MEMORY_PURPOSE_IDS.forget :
        purpose === MEMORY_PURPOSE_IDS.write ? "api.memory.promotions.decide" : "api.memory.promotions.read" });
    return { tenantId, ownerActorId, executionScope, accessScope: databaseMemoryAccessScopeFromExecutionScope(executionScope, { purposeId: purpose, auditPurpose: executionScope.purpose }) };
  }
  function owned<T>(a: MemoryPromotionNativeAuthority, work: () => Promise<T>) { return runWithDatabaseActorScope(a.tenantId, [a.ownerActorId], work); }
  async function seed(tag: string, write = true) {
    const tenantId = `promotion-${tag}`, sourceIds = [`source-${tag}-a`, `source-${tag}-b`], reviewId = `review-${tag}`;
    const binding = buildUserPrivateMemoryAccessBindingV1({ tenantId, ownerActorId: actor, originPurpose: "native.promotion.fixture",
      allowedPurposeIds: [MEMORY_PURPOSE_IDS.read, MEMORY_PURPOSE_IDS.forget, ...(write ? [MEMORY_PURPOSE_IDS.write] : [])] });
    for (const id of sourceIds) {
      await admin`INSERT INTO omni_memories(id,tenant_id,type,tier,tier_policy_version,formation_reason,title,content,tags,scope,source,
        importance,confidence,asserted_by,claim_status,evidence_refs,
        access_contract_version,access_state,owner_actor_id,owner_agent_id,workspace_id,project_id,mission_id,visibility,sensitivity,
        origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
        VALUES(${id},${tenantId},'episode','episodic',1,'verified_effect','Repeatable procedure','Use the documented private procedure',${[]},'user',${`verified:${id}`},
          0.8,0.9,'system','active',${[`run:${id}`, `tool-execution:${id}`, `effect-receipt:${id}`]},
          1,'scope_bound',${actor},NULL,NULL,NULL,NULL,'user_private',${binding.sensitivity},${binding.originPurpose},${[...binding.allowedPurposeIds]},${binding.accessScopeSha256},${binding.accessBoundAt})`;
    }
    const [source] = await admin`SELECT * FROM omni_memories WHERE id=${sourceIds[0]}`;
    const claimSha = memoryClaimFingerprint(memoryFromRow(source));
    await admin`INSERT INTO omni_memory_promotion_reviews(id,tenant_id,access_contract_version,owner_actor_id,source_memory_ids,canonical_memory_id,source_claim_sha256)
      VALUES(${reviewId},${tenantId},1,${actor},${sourceIds},${sourceIds[0]},${claimSha})`;
    return { tenantId, sourceIds, reviewId, binding };
  }
  type Target = Awaited<ReturnType<typeof seed>>;
  function read(target: Target) {
    const a = authority(target.tenantId, target.reviewId);
    return owned(a, () => getPrivateMemoryPromotionReview(a, target.reviewId));
  }
  async function request(target: Target, decision: "promote" | "dismiss" = "promote"): Promise<MemoryPromotionNativeRequest> {
    const value = await read(target);
    if (!value?.reviewToken) throw new Error("Fixture proposal has no decision token.");
    return { contract: "asael-memory-promotion-decision:1", reviewId: target.reviewId, decision,
      expectedReviewToken: value.reviewToken, expectedPolicySha256: value.policySha256, expectedSourceManifestSha256: value.sourceManifestSha256 };
  }
  function submit(target: Target, value: MemoryPromotionNativeRequest, key = "stable-key") {
    const a = authority(target.tenantId, target.reviewId, MEMORY_PURPOSE_IDS.write);
    return owned(a, () => resolvePrivateMemoryPromotionReview({ authority: a, reviewId: target.reviewId, request: value, idempotencyKey: key }));
  }
  async function counts(target: Target) {
    const [value] = await admin`SELECT
      (SELECT count(*) FROM omni_memories WHERE tenant_id=${target.tenantId} AND formation_reason='maintenance_promotion') AS targets,
      (SELECT count(*) FROM omni_events WHERE tenant_id=${target.tenantId} AND type='memory.promotion.reviewed') AS events`;
    return { targets: Number(value.targets), events: Number(value.events) };
  }

  test("promotion is atomic, preserves authorship, and exact replay returns immutable evidence with no effects", async () => {
    const target = await seed("accept"), value = await request(target), accepted = await submit(target, value);
    expect(accepted.newlyApplied).toBe(true);
    expect(accepted.promotedMemory).toMatchObject({ assertedBy: "system", claimStatus: "active", formationReason: "maintenance_promotion" });
    expect(accepted.acceptance.promotedTargetRevision).toBe(1);
    await admin`UPDATE omni_memories SET title='A later current source title' WHERE id=${target.sourceIds[0]}`;
    const replay = await submit(target, value);
    expect(replay.newlyApplied).toBe(false); expect(replay.promotedMemory).toBeNull();
    expect(replay.acceptance).toEqual(accepted.acceptance);
    expect(replay.canonical.title).toBe("A later current source title");
    expect((await read(target))?.acceptance).toEqual(accepted.acceptance);
    expect(await counts(target)).toEqual({ targets: 1, events: 1 });
    await expect(submit(target, { ...value, decision: "dismiss" })).rejects.toMatchObject({ code: "memory_promotion_key_conflict" });
  });

  test("failed decision event rolls back the created target, receipt, and review resolution", async () => {
    const target = await seed("rollback"), value = await request(target);
    await admin.unsafe(`CREATE FUNCTION public.promotion_fixture_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type='memory.promotion.reviewed' AND NEW.tenant_id='promotion-rollback' THEN RAISE EXCEPTION 'injected promotion event failure'; END IF; RETURN NEW; END $$`);
    await admin.unsafe(`CREATE TRIGGER promotion_fixture_fail_event BEFORE INSERT ON public.omni_events FOR EACH ROW EXECUTE FUNCTION public.promotion_fixture_fail_event()`);
    try { await expect(submit(target, value)).rejects.toThrow("injected promotion event failure"); }
    finally { await admin.unsafe(`DROP TRIGGER promotion_fixture_fail_event ON public.omni_events`); await admin.unsafe(`DROP FUNCTION public.promotion_fixture_fail_event()`); }
    expect(await counts(target)).toEqual({ targets: 0, events: 0 });
    expect((await read(target))?.review.status).toBe("pending");
    expect((await read(target))?.acceptance).toBeNull();
  });

  test("stale semantic and lifecycle pins refuse promotion, while refreshed stale evidence can be dismissed", async () => {
    const target = await seed("stale"), old = await request(target);
    await admin`UPDATE omni_memories SET content='Changed source evidence' WHERE id=${target.sourceIds[1]}`;
    await expect(submit(target, old)).rejects.toMatchObject({ code: "memory_promotion_target_changed" });
    expect((await read(target))?.allowedDecisions).toEqual(["dismiss"]);
    expect((await submit(target, await request(target, "dismiss"))).acceptance.decision).toBe("dismiss");
    const lifecycle = await seed("lifecycle"), oldLifecycle = await request(lifecycle);
    await admin`INSERT INTO omni_memory_lifecycle_states(memory_id,tenant_id,access_contract_version,owner_actor_id,policy_version,archived_at,archive_reason)
      VALUES(${lifecycle.sourceIds[0]},${lifecycle.tenantId},1,${actor},1,NOW(),'manual')`;
    await expect(submit(lifecycle, oldLifecycle)).rejects.toMatchObject({ code: "memory_promotion_target_changed" });
    const current = await read(lifecycle);
    expect(current?.canonical.archivedAt).toBeTruthy(); expect(current?.allowedDecisions).toEqual(["dismiss"]);
    expect(await counts(lifecycle)).toEqual({ targets: 0, events: 0 });
  });

  test("an exact duplicate archive supports its pinned canonical and competing decisions accept only once", async () => {
    const target = await seed("duplicate");
    await admin`INSERT INTO omni_memory_lifecycle_states(memory_id,tenant_id,access_contract_version,owner_actor_id,policy_version,archived_at,archive_reason,duplicate_of_memory_id)
      VALUES(${target.sourceIds[1]},${target.tenantId},1,${actor},1,NOW(),'exact_duplicate',${target.sourceIds[0]})`;
    const value = await request(target);
    expect((await read(target))?.allowedDecisions).toEqual(["promote", "dismiss"]);
    const outcomes = await Promise.allSettled([submit(target, value, "promote-key"), submit(target, { ...value, decision: "dismiss" }, "dismiss-key")]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await counts(target)).events).toBe(1);
  });

  test("revalidates source revisions after waiting for a concurrent parent update", async () => {
    const target = await seed("locked"), value = await request(target);
    let announce!: () => void, release!: () => void, writerPid = 0;
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const writing = admin.begin(async (sql) => {
      writerPid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);
      await sql`SELECT id FROM omni_memories WHERE id=${target.sourceIds[0]} FOR UPDATE`;
      await sql`UPDATE omni_memories SET content='A source change committed while the review waits' WHERE id=${target.sourceIds[0]}`;
      announce(); await released;
    });
    await held;
    const deciding = submit(target, value);
    let blocked = false;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await admin`SELECT pid FROM pg_stat_activity WHERE usename=${runtimeRole} AND ${writerPid}=ANY(pg_blocking_pids(pid))`;
        if (rows[0]) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally { release(); }
    await writing;
    await expect(deciding).rejects.toMatchObject({ code: "memory_promotion_target_changed" });
    expect(blocked).toBe(true); expect(await counts(target)).toEqual({ targets: 0, events: 0 });
  });

  test("historical receipt is recoverable under current read-only purpose without decision authority", async () => {
    const target = await seed("readback"), value = await request(target, "dismiss"), accepted = await submit(target, value);
    // Source bindings are immutable. Current request authority can narrow to
    // read without altering those bindings or granting a decision purpose.
    const readOnly = authority(target.tenantId, target.reviewId, MEMORY_PURPOSE_IDS.read);
    const current = await owned(readOnly, () => getPrivateMemoryPromotionReview(readOnly, target.reviewId));
    expect(current?.acceptance).toEqual(accepted.acceptance);
    expect(current?.sourceTargets).toEqual(accepted.acceptance.sourceTargets);
    expect(current?.reviewToken).toBeNull(); expect(current?.allowedDecisions).toEqual([]);
    await expect(owned(readOnly, () => resolvePrivateMemoryPromotionReview({ authority: readOnly,
      reviewId: target.reviewId, request: value, idempotencyKey: "stable-key" }))).rejects.toMatchObject({ status: 403 });
    expect(await counts(target)).toEqual({ targets: 0, events: 1 });
  });

  test("read-only sources and other owners gain no decision authority or lifecycle mutation purpose", async () => {
    const target = await seed("read-only", false), a = authority(target.tenantId, target.reviewId);
    expect((await read(target))?.reviewToken).toBeNull();
    const other = authority(target.tenantId, target.reviewId, MEMORY_PURPOSE_IDS.read, otherActor);
    expect(await owned(other, () => getPrivateMemoryPromotionReview(other, target.reviewId))).toBeNull();
    expect((await owned(a, () => listPrivateMemoryPromotionReviews(a, { limit: 1 }))).map((item) => item.review.id)).toEqual([target.reviewId]);
    const write = authority(target.tenantId, target.reviewId, MEMORY_PURPOSE_IDS.write);
    await expect(owned(write, () => resolvePrivateMemoryPromotionReview({ authority: write, reviewId: target.reviewId, idempotencyKey: "no-authority",
      request: { contract: "asael-memory-promotion-decision:1", reviewId: target.reviewId, decision: "dismiss",
        expectedReviewToken: "0".repeat(64), expectedPolicySha256: "0".repeat(64), expectedSourceManifestSha256: "0".repeat(64) } }))).rejects.toMatchObject({ status: 404 });
    const allowed = await seed("purpose"), w = authority(allowed.tenantId, allowed.reviewId, MEMORY_PURPOSE_IDS.write);
    await owned(w, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      await setTransactionLocalDatabaseMemoryAccessScope(sql, w.accessScope);
      expect(await sql`DELETE FROM omni_memory_promotion_reviews WHERE id=${allowed.reviewId} RETURNING id`).toHaveLength(0);
      expect((await sql`SELECT * FROM public.omni_memory_promotion_source_snapshot_v1(${allowed.tenantId},${actor},${allowed.sourceIds},TRUE)`)).toHaveLength(2);
      expect((await sql`SELECT current_setting('omni.system_scope') AS scope`)[0].scope).toBe("false");
    }));
  });

  test("legacy resolution and occupied targets never become invented native receipts", async () => {
    const legacy = await seed("legacy"), value = await request(legacy, "dismiss");
    await admin`UPDATE omni_memory_promotion_reviews SET status='resolved',decision='dismiss',resolved_at=NOW() WHERE id=${legacy.reviewId}`;
    expect((await read(legacy))?.acceptance).toBeNull();
    await expect(submit(legacy, value)).rejects.toMatchObject({ code: "memory_promotion_already_resolved" });
    const occupied = await seed("occupied"), next = await request(occupied);
    await admin`INSERT INTO omni_memories(id,tenant_id,type,title,content,tags,scope,source,asserted_by,claim_status,
      access_contract_version,access_state,owner_actor_id,visibility,sensitivity,origin_purpose,allowed_purpose_ids,access_scope_sha256,access_bound_at)
      VALUES(${memoryPromotedRecordId(occupied.reviewId)},${occupied.tenantId},'fact','Existing claim','Do not adopt this target',${[]},'user','manual','user','active',
        1,'scope_bound',${actor},'user_private',${occupied.binding.sensitivity},${occupied.binding.originPurpose},${[...occupied.binding.allowedPurposeIds]},${occupied.binding.accessScopeSha256},${occupied.binding.accessBoundAt})`;
    await expect(submit(occupied, next)).rejects.toMatchObject({ code: "memory_promotion_target_conflict" });
    expect((await read(occupied))?.review.status).toBe("pending"); expect((await counts(occupied)).events).toBe(0);
  });

  test.each(["source", "promoted"] as const)("forgetting %s removes native acceptance and cannot recreate its target", async (which) => {
    const target = await seed(`forget-${which}`), value = await request(target), accepted = await submit(target, value);
    const id = which === "source" ? target.sourceIds[1] : accepted.acceptance.promotedMemoryId!;
    const a = authority(target.tenantId, target.reviewId, MEMORY_PURPOSE_IDS.forget);
    await owned(a, async () => {
      const preview = await previewMemoryDeletion(id, { tenantId: target.tenantId, accessScope: a.accessScope });
      expect(preview).not.toBeNull();
      await forgetMemoryWithReceipt(id, { tenantId: target.tenantId, accessScope: a.accessScope, executionScope: a.executionScope,
        expectedDescendantManifestSha256: preview!.expectedReceiptManifestSha256 });
    });
    expect(await read(target)).toBeNull(); await expect(submit(target, value)).rejects.toMatchObject({ status: 404 });
    expect(await admin`SELECT native_decision FROM omni_memory_promotion_reviews WHERE id=${target.reviewId}`).toHaveLength(0);
    const [event] = await admin`SELECT payload FROM omni_events WHERE tenant_id=${target.tenantId} AND type='memory.promotion.reviewed'`;
    expect(Object.keys(event.payload)).not.toContain("sourceManifestSha256");
    expect(Object.keys(event.payload)).not.toContain("nativeAcceptance");
  });
});
