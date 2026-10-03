import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, runWithDatabaseActorScope } from "@/lib/db/client";
import { DEFAULT_COMPANION_PREFERENCES, type CompanionChange } from "@/lib/companion/contracts";
import { getCompanionPreferences, saveCompanionPreferences } from "@/lib/companion/service";
import { changeCompanionPreferences, readCompanionPreferences } from "@/lib/companion/store";
import type { SecurityContext } from "@/lib/security/types";

const databaseUrl = process.env.DATABASE_URL;
const resetAllowed = process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true";
const databaseDescribe = databaseUrl && resetAllowed ? describe : describe.skip;
const initial: CompanionChange = { action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES, intensity: "quiet" } };
type Transaction = postgres.TransactionSql;

// This file is selected by the existing hosted PostgreSQL integration lane.
// It must never run against an application database: the explicit reset opt-in
// is the same disposable-database boundary as the surrounding integration suite.
databaseDescribe("Companion durable preferences", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, {
      max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require",
      onnotice: () => undefined,
    });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    // Match the deployment's schema access, without broadening table privileges.
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
  });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); });

  async function asRuntime<T>(tenantId: string, actorId: string, operation: (sql: Transaction) => Promise<T>) {
    return admin.begin(async (sql) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      await sql`SELECT set_config('omni.system_scope', 'false', true)`;
      await sql`SELECT set_config('omni.tenant_id', ${tenantId}, true)`;
      await sql`SELECT set_config('omni.actor_scope_v1', ${JSON.stringify({ version: 1, tenantId, actorIds: [actorId] })}, true)`;
      return operation(sql);
    });
  }

  test("uses real scoped store reads and writes and preserves tenant/actor separation", async () => {
    const owner = { tenantId: "companion-store-tenant", actorId: "owner-a" };
    expect(await readCompanionPreferences(owner)).toBeUndefined();
    const saved = await changeCompanionPreferences(owner, initial, "store-save-a");
    expect(saved.current.revision).toBe(1);
    expect(await readCompanionPreferences(owner)).toEqual(saved.current);
    expect(await readCompanionPreferences({ ...owner, actorId: "owner-b" })).toBeUndefined();
    expect(await readCompanionPreferences({ ...owner, tenantId: "other-tenant" })).toBeUndefined();
    const rows = await admin`SELECT revision FROM public.omni_companion_preferences WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}`;
    const receipts = await admin`SELECT revision FROM public.omni_companion_preference_mutations WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}`;
    expect(rows).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].revision)).toBe(Number(rows[0].revision));
  });

  test("serializes competing CAS writes and returns current snapshot separately from an older replay receipt", async () => {
    const owner = { tenantId: "companion-cas-tenant", actorId: "owner-a" };
    const contenders = await Promise.allSettled([
      changeCompanionPreferences(owner, initial, "race-a"),
      changeCompanionPreferences(owner, { ...initial, preferences: { ...initial.preferences, visible: false } }, "race-b"),
    ]);
    expect(contenders.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect((contenders.find((value) => value.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "companion_revision_conflict" });
    const owner2 = { ...owner, actorId: "replay-owner" };
    const [first, replay] = await Promise.all([
      changeCompanionPreferences(owner2, initial, "same-save"),
      changeCompanionPreferences(owner2, initial, "same-save"),
    ]);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(first.receipt).toEqual(replay.receipt);
    await changeCompanionPreferences(owner2, { action: "reset", expectedRevision: 1 }, "reset-save");
    const older = await changeCompanionPreferences(owner2, initial, "same-save");
    expect(older.current.revision).toBe(2);
    expect(older.current.preferences).toEqual(DEFAULT_COMPANION_PREFERENCES);
    expect(older.receipt.revision).toBe(1);
    expect(older.receipt.preferences.intensity).toBe("quiet");
    await expect(changeCompanionPreferences(owner2, { action: "reset", expectedRevision: 0 }, "same-save")).rejects.toMatchObject({ code: "companion_idempotency_conflict" });
    const receipts = await admin`SELECT id FROM public.omni_companion_preference_mutations WHERE tenant_id = ${owner2.tenantId} AND actor_id = ${owner2.actorId}`;
    expect(receipts).toHaveLength(2);
  });

  test("uses a validated canonical owner and fails closed on two physical readable-owner rows", async () => {
    const actorId = "canonical-owner@example.test";
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const canonicalActorId = `actor:${authUserId}`;
    const owner = { tenantId: "companion-canonical-tenant", actorId, requestActorBinding: {
      version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId,
      legacyOwnerActorIds: [actorId], readableOwnerActorIds: [canonicalActorId, actorId],
    } };
    const saved = await changeCompanionPreferences(owner, initial, "canonical-save");
    expect(saved.current.actorId).toBe(canonicalActorId);
    expect(await readCompanionPreferences(owner)).toEqual(saved.current);
    expect(await readCompanionPreferences({ tenantId: owner.tenantId, actorId })).toBeUndefined();
    await changeCompanionPreferences({ tenantId: owner.tenantId, actorId }, initial, "legacy-save");
    await expect(readCompanionPreferences(owner)).rejects.toMatchObject({ code: "companion_owner_conflict" });
  });

  test("enforces both actor and tenant RLS for a runtime role on preferences and receipts", async () => {
    const owner = { tenantId: "companion-rls-tenant", actorId: "owner-a" };
    await changeCompanionPreferences(owner, initial, "rls-save");
    const visible = await asRuntime(owner.tenantId, owner.actorId, async (sql) => ({
      preferences: await sql`SELECT actor_id FROM public.omni_companion_preferences`,
      receipts: await sql`SELECT actor_id FROM public.omni_companion_preference_mutations`,
    }));
    expect(visible.preferences).toEqual([{ actor_id: owner.actorId }]);
    expect(visible.receipts).toEqual([{ actor_id: owner.actorId }]);
    for (const [tenant, actor] of [[owner.tenantId, "owner-b"], ["other-tenant", owner.actorId]]) {
      const hidden = await asRuntime(tenant, actor, async (sql) => ({
        preferences: await sql`SELECT actor_id FROM public.omni_companion_preferences`,
        receipts: await sql`SELECT actor_id FROM public.omni_companion_preference_mutations`,
      }));
      expect(hidden.preferences).toEqual([]);
      expect(hidden.receipts).toEqual([]);
    }
    await expect(asRuntime(owner.tenantId, "owner-b", async (sql) => sql`
      INSERT INTO public.omni_companion_preferences (
        schema_version, tenant_id, actor_id, revision, intensity, visible, motion,
        default_destination, preferred_thread_id, created_at, updated_at
      ) VALUES (1, ${owner.tenantId}, 'owner-c', 1, 'quiet', true, 'full', 'assistant', NULL, now(), now())
    `)).rejects.toMatchObject({ code: "42501" });
  });

  test("denies receipt mutation, identity column updates, invalid revision jumps and mismatched receipts", async () => {
    const owner = { tenantId: "companion-guards-tenant", actorId: "owner-a" };
    const saved = await changeCompanionPreferences(owner, initial, "guard-save");
    await expect(asRuntime(owner.tenantId, owner.actorId, async (sql) => sql`
      UPDATE public.omni_companion_preferences SET actor_id = 'other-owner'
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
    `)).rejects.toMatchObject({ code: "42501" });
    await expect(asRuntime(owner.tenantId, owner.actorId, async (sql) => sql`
      UPDATE public.omni_companion_preferences SET revision = 3
      WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
    `)).rejects.toMatchObject({ code: "23514" });
    await expect(asRuntime(owner.tenantId, owner.actorId, async (sql) => sql`
      UPDATE public.omni_companion_preference_mutations SET request_sha256 = ${"f".repeat(64)} WHERE id = ${saved.receipt.id}
    `)).rejects.toMatchObject({ code: "42501" });
    await expect(admin`DELETE FROM public.omni_companion_preference_mutations WHERE id = ${saved.receipt.id}`).rejects.toMatchObject({ code: "55000" });
    await expect(admin`UPDATE public.omni_companion_preference_mutations SET request_sha256 = ${"f".repeat(64)} WHERE id = ${saved.receipt.id}`).rejects.toMatchObject({ code: "55000" });
    await expect(asRuntime(owner.tenantId, owner.actorId, async (sql) => sql`
      INSERT INTO public.omni_companion_preference_mutations (
        schema_version, id, tenant_id, actor_id, idempotency_sha256, request_sha256,
        expected_revision, revision, preferences, saved_at
      ) VALUES (
        1, ${`companion:${"a".repeat(64)}`}, ${owner.tenantId}, ${owner.actorId}, ${"a".repeat(64)}, ${"b".repeat(64)},
        1, 2, ${sql.json(initial.preferences)}::jsonb, now()
      )
    `)).rejects.toMatchObject({ code: "23514" });
    expect((await readCompanionPreferences(owner))?.revision).toBe(1);
  });

  test("resolves real owned threads and retains a deleted home without changing the saved revision", async () => {
    const owner = { tenantId: "companion-home-tenant", actorId: "owner-a" };
    const context: SecurityContext = { ...owner, role: "viewer", source: "headers" };
    const threadId = "22222222-2222-4222-8222-222222222222";
    const foreignActorThread = "33333333-3333-4333-8333-333333333333";
    const foreignTenantThread = "44444444-4444-4444-8444-444444444444";
    await admin`
      INSERT INTO public.omni_threads (id, tenant_id, actor_id, title, mode, created_at, updated_at)
      VALUES
        (${threadId}, ${owner.tenantId}, ${owner.actorId}, 'Owned home fixture', 'orchestrate', now(), now()),
        (${foreignActorThread}, ${owner.tenantId}, 'other-owner', 'Foreign actor fixture', 'orchestrate', now(), now()),
        (${foreignTenantThread}, 'other-home-tenant', ${owner.actorId}, 'Foreign tenant fixture', 'orchestrate', now(), now())
    `;
    const inScope = <T>(operation: () => Promise<T>) => runWithDatabaseActorScope(owner.tenantId, [owner.actorId], operation);
    for (const inaccessibleId of [foreignActorThread, foreignTenantThread]) {
      const change: CompanionChange = { ...initial, preferences: { ...initial.preferences, preferredThreadId: inaccessibleId } };
      await expect(inScope(() => saveCompanionPreferences(context, change, `home-${inaccessibleId}`))).rejects.toMatchObject({ code: "companion_thread_unavailable" });
    }
    expect(await readCompanionPreferences(owner)).toBeUndefined();
    const change: CompanionChange = { ...initial, preferences: { ...initial.preferences, preferredThreadId: threadId } };
    const saved = await inScope(() => saveCompanionPreferences(context, change, "home-save"));
    expect(saved.home).toMatchObject({ state: "available", preferredThreadId: threadId, href: `/app/command?thread=${threadId}` });
    await admin`DELETE FROM public.omni_threads WHERE id = ${threadId}`;
    const afterDeletion = await inScope(() => getCompanionPreferences(context));
    expect(afterDeletion.snapshot).toEqual(saved.snapshot);
    expect(afterDeletion.home).toMatchObject({ state: "unavailable", preferredThreadId: threadId, href: null });
    expect(afterDeletion.destination).toEqual({ href: "/app/command", state: "fallback" });
    const untouchedReceipts = await admin`SELECT revision FROM public.omni_companion_preference_mutations WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}`;
    expect(untouchedReceipts).toHaveLength(1);
    expect(await admin`SELECT id FROM public.omni_threads WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}`).toHaveLength(0);
    const reset = await inScope(() => saveCompanionPreferences(context, { action: "reset", expectedRevision: 1 }, "home-reset"));
    expect(reset.snapshot.revision).toBe(2);
    expect(reset.snapshot.preferences.preferredThreadId).toBeNull();
    expect(saved.mutation?.preferences.preferredThreadId).toBe(threadId);
  });
});
