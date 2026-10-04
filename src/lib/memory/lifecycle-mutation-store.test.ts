import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import { databaseMemoryAccessScopeFromExecutionScope } from "@/lib/db/memory-access-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { memoryLifecycleIntent, memoryLifecycleTargetToken, type MemoryLifecycleMutationRequest } from "@/lib/memory/lifecycle-mutation-contracts";

const mocks = vi.hoisted(() => ({ apply: vi.fn(), enter: vi.fn(), hasDatabase: vi.fn(() => false) }));
vi.mock("@/lib/db/client", () => ({ ensureDatabaseSchema: vi.fn(), getSql: vi.fn(), hasDatabaseUrl: mocks.hasDatabase }));
vi.mock("@/lib/db/memory-access-scope", async (original) => ({
  ...await original<typeof import("@/lib/db/memory-access-scope")>(), setTransactionLocalDatabaseMemoryAccessScope: mocks.enter,
}));
vi.mock("@/lib/memory/maintenance-store", () => ({ applyMemoryLifecycleInTransaction: mocks.apply, MemoryLifecycleConflictError: class extends Error {} }));
import { readMemoryLifecycleTarget, submitMemoryLifecycleMutation } from "@/lib/memory/lifecycle-mutation-store";

const ownerActorId = "actor:11111111-1111-4111-8111-111111111111", tenantId = "tenant-a", memoryId = "memory-a";
const executionScope = createExecutionScope({ tenantId, initiatingActorId: ownerActorId, executingPrincipalType: "user", executingPrincipalId: ownerActorId, correlationId: "key", purpose: "api.memory.lifecycle.mutate.v1" });
const authority = { tenantId, ownerActorId, executionScope, accessScope: databaseMemoryAccessScopeFromExecutionScope(executionScope, { purposeId: MEMORY_PURPOSE_IDS.maintenance, auditPurpose: executionScope.purpose }) };
const token = memoryLifecycleTargetToken({ tenantId, ownerActorId, memoryId, visibility: "user_private", claimStatus: "active", targetRevision: 1, lifecycleRevision: 0 });
const request: MemoryLifecycleMutationRequest = { contract: "asael-memory-lifecycle-mutation:1", action: "pin", expectedTargetToken: token };
const input = { authority, memoryId, idempotencyKey: "key", request };
const now = "2026-10-04T00:00:00.000Z";
const initial = { id: memoryId, claim_status: "active", lifecycle_target_revision: 1, lifecycle_revision: 0 };
const updated = { ...initial, lifecycle_revision: 1, pinned_at: now, lifecycle_updated_at: now };

function database(options: { prior?: Record<string, unknown>; current?: Record<string, unknown>; missing?: boolean; insertError?: Error } = {}) {
  const statements: string[] = [];
  let applied = false;
  mocks.apply.mockImplementation(async () => { applied = true; });
  const query = vi.fn(async (parts: TemplateStringsArray) => {
    const text = parts.join("?"); statements.push(text);
    if (text.includes("SELECT id FROM omni_memories")) return options.missing ? [] : [{ id: memoryId }];
    if (text.includes("SELECT * FROM omni_memory_lifecycle_mutations")) return options.prior ? [options.prior] : [];
    if (text.includes("SELECT memory.id")) return [options.current || (applied ? updated : initial)];
    if (text.includes("clock_timestamp")) return [{ now }];
    if (text.includes("INSERT INTO omni_memory_lifecycle_mutations") && options.insertError) throw options.insertError;
    return [];
  });
  return { sql: Object.assign(query, { transactionScoped: true }) as unknown as SqlClient, statements };
}

describe("Memory lifecycle admission and replay", () => {
  beforeEach(() => vi.clearAllMocks());
  it("accepts one transition and co-writes its receipt after the primary lifecycle/event seam", async () => {
    const db = database();
    const result = await submitMemoryLifecycleMutation(input, db);
    expect(result.replayed).toBe(false);
    expect(result.acceptance).toMatchObject({ action: "pin", beforeLifecycleRevision: 0, afterLifecycleRevision: 1 });
    expect(result.current.target.lifecycleRevision).toBe(1);
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
  it("returns immutable acceptance before CAS even when a later action changed the current lifecycle", async () => {
    const accepted = (await submitMemoryLifecycleMutation(input, database())).acceptance;
    mocks.apply.mockClear();
    const intent = memoryLifecycleIntent({ tenantId, ownerActorId, ...input });
    const db = database({ prior: { memory_id: memoryId, request_sha256: intent.requestSha256, acceptance: accepted }, current: { ...initial, lifecycle_revision: 2 } });
    const replay = await submitMemoryLifecycleMutation(input, db);
    expect(replay).toMatchObject({ acceptance: accepted, replayed: true });
    expect(replay.current.target.lifecycleRevision).toBe(2);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("rejects a reused key for changed action and a new key with a stale token before any effect", async () => {
    const intent = memoryLifecycleIntent({ tenantId, ownerActorId, ...input });
    await expect(submitMemoryLifecycleMutation({ ...input, request: { ...request, action: "unpin" } }, database({ prior: { memory_id: memoryId, request_sha256: intent.requestSha256 } }))).rejects.toMatchObject({ code: "memory_lifecycle_key_conflict" });
    await expect(submitMemoryLifecycleMutation(input, database({ current: { ...initial, lifecycle_target_revision: 2 } }))).rejects.toMatchObject({ code: "memory_lifecycle_target_changed" });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("never treats a scrubbed tombstone as accepted replay or revives its target", async () => {
    await expect(submitMemoryLifecycleMutation(input, database({ prior: { forgotten_at: now, acceptance: null, request_sha256: null }, missing: true }))).rejects.toMatchObject({ code: "memory_lifecycle_replay_forgotten" });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("refuses absent and substituted owners and lacks a file-mode durability fallback", async () => {
    await expect(submitMemoryLifecycleMutation(input, database({ missing: true }))).rejects.toMatchObject({ status: 404 });
    await expect(submitMemoryLifecycleMutation({ ...input, authority: { ...authority, ownerActorId: "actor:22222222-2222-4222-8222-222222222222" } }, database())).rejects.toMatchObject({ status: 403 });
    await expect(submitMemoryLifecycleMutation(input)).rejects.toMatchObject({ status: 503 });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("does not produce acceptance when its final ledger write fails", async () => {
    await expect(submitMemoryLifecycleMutation(input, database({ insertError: new Error("receipt insert failed") }))).rejects.toThrow("receipt insert failed");
  });
  it("issues an exact read token with read scope and no mutation", async () => {
    const readAuthority = { ...authority, accessScope: databaseMemoryAccessScopeFromExecutionScope(executionScope, { purposeId: MEMORY_PURPOSE_IDS.read, auditPurpose: executionScope.purpose }) };
    expect((await readMemoryLifecycleTarget(readAuthority, memoryId, database()))?.target.token).toBe(token);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
