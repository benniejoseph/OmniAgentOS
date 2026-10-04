import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ database: vi.fn(), ensure: vi.fn(), sql: vi.fn(), actorScope: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  hasDatabaseUrl: mocks.database, ensureDatabaseSchema: mocks.ensure,
  getSql: () => mocks.sql, runWithDatabaseActorScope: mocks.actorScope,
}));
vi.mock("@/lib/storage/json", async (original) => ({
  ...(await original<typeof import("@/lib/storage/json")>()), readJsonFile: mocks.read,
}));

import { buildEntityAccessBinding, buildEntityRecord, ENTITY_PURPOSE_IDS, transitionEntityRecord } from "./registry";
import { requestEntityAccessFromSecurityContext } from "./request-access";
import { readEntityOptions } from "./store";

const now = "2026-10-04T12:00:00.000Z";
function access(userId = "11111111-1111-4111-8111-111111111111", tenantId = "tenant-a") {
  return requestEntityAccessFromSecurityContext({ tenantId, actorId: "owner@example.test", role: "viewer", source: "session",
    auth: { userId, email: "owner@example.test", sessionId: "session-a", tenantName: "Tenant A" } },
  { purposeId: "entity.read.v1", correlationId: "options-test" })!;
}
function entity(entityId: string, options: { access?: ReturnType<typeof access>; type?: "person" | "organization" | "account" | "project" | "meeting"; label?: string } = {}) {
  return buildEntityRecord({ entityId, entityTypeId: options.type ?? "person", canonicalLabel: options.label ?? entityId,
    accessBinding: (options.access ?? access()).accessBinding,
    lineage: [{ kind: "evidence_unit", referenceId: "evidence:one", referenceSha256: "a".repeat(64) }], createdAt: now });
}
function ledger(entities: ReturnType<typeof entity>[]) {
  return { schemaVersion: 1, entities, aliases: [], resolutions: [], mergeReviews: [] };
}

beforeEach(() => {
  mocks.database.mockReset().mockReturnValue(false);
  mocks.ensure.mockReset().mockResolvedValue(undefined);
  mocks.sql.mockReset().mockResolvedValue([]);
  mocks.actorScope.mockReset().mockImplementation(async (_tenant: string, _actors: string[], read: () => Promise<unknown>) => read());
  mocks.read.mockReset().mockResolvedValue(ledger([]));
});

describe("current actor-private Entity options projection", () => {
  it("filters exact tenant, canonical account, access hash, state and relationship types", async () => {
    const current = access();
    const alternate = { ...current, accessBinding: buildEntityAccessBinding({ tenantId: "tenant-a",
      ownerActorId: current.actorBinding.canonicalActorId, visibility: "user_private", sensitivity: "restricted",
      allowedPurposeIds: ENTITY_PURPOSE_IDS, boundAt: now }) };
    const merged = transitionEntityRecord({ entity: entity("entity:merged"), state: "merged", mergedIntoEntityId: "entity:a", updatedAt: now });
    const retired = transitionEntityRecord({ entity: entity("entity:retired"), state: "retired", updatedAt: now });
    mocks.read.mockResolvedValue(ledger([entity("entity:b", { type: "account" }), entity("entity:other-tenant", { access: access(undefined, "tenant-b") }),
      entity("entity:recreated-account", { access: access("22222222-2222-4222-8222-222222222222") }),
      entity("entity:other-hash", { access: alternate }), merged, retired, entity("entity:meeting", { type: "meeting" }), entity("entity:a", { type: "organization" })]));
    const result = await readEntityOptions(current);
    expect(result.items.map((item) => item.entityId)).toEqual(["entity:a", "entity:b"]);
    expect(result.scope).toMatchObject({ ownerActorId: current.actorBinding.canonicalActorId, accessScopeSha256: current.accessBinding.accessScopeSha256 });
    expect(JSON.stringify(result)).not.toMatch(/lineage|evidence:one|entitySha256|aliases|resolutions/);
  });

  it("paginates exact IDs in C ordering and preserves full labels", async () => {
    mocks.read.mockResolvedValue(ledger([entity("entity:a"), entity("entity:Z", { label: "L".repeat(320) }), entity("entity:A"), entity("entity:z")]));
    const first = await readEntityOptions(access(), { limit: 2 });
    expect(first.items.map((item) => item.entityId)).toEqual(["entity:A", "entity:Z"]);
    expect(first.items[1].canonicalLabel).toHaveLength(320);
    expect(first).toMatchObject({ hasMore: true, nextAfter: "entity:Z", coverage: { total: null, returned: 2 } });
    const second = await readEntityOptions(access(), { limit: 2, after: first.nextAfter! });
    expect(second.items.map((item) => item.entityId)).toEqual(["entity:a", "entity:z"]);
    expect(second).toMatchObject({ hasMore: false, nextAfter: null });
  });

  it("rechecks current state on each page and a foreign cursor never changes scope", async () => {
    const original = entity("entity:a");
    mocks.read.mockResolvedValueOnce(ledger([original, entity("entity:b")]));
    expect((await readEntityOptions(access(), { limit: 1 })).hasMore).toBe(true);
    mocks.read.mockResolvedValueOnce(ledger([original, transitionEntityRecord({ entity: entity("entity:b"), state: "retired", updatedAt: now })]));
    expect((await readEntityOptions(access(), { limit: 1, after: "entity:a" })).items).toEqual([]);
    mocks.read.mockResolvedValueOnce(ledger([entity("entity:foreign", { access: access(undefined, "tenant-b") })]));
    expect((await readEntityOptions(access(), { after: "entity:a" })).items).toEqual([]);
  });

  it("rejects malformed windows and mismatched request authority before storage", async () => {
    const current = access();
    await expect(readEntityOptions(current, { limit: 101 })).rejects.toThrow();
    await expect(readEntityOptions({ ...current, executionScope: access(undefined, "tenant-b").executionScope })).rejects.toThrow();
    await expect(readEntityOptions({ ...current, actorBinding: access("22222222-2222-4222-8222-222222222222").actorBinding })).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("reads only one bounded current-record SQL window under the same RLS actor", async () => {
    mocks.database.mockReturnValue(true);
    mocks.sql.mockResolvedValue([entity("entity:b"), entity("entity:c")].map((contract) => ({ contract })));
    const current = access();
    const result = await readEntityOptions(current, { limit: 1, after: "entity:a" });
    expect(result).toMatchObject({ items: [{ entityId: "entity:b" }], hasMore: true, nextAfter: "entity:b" });
    expect(mocks.actorScope).toHaveBeenCalledWith("tenant-a", [current.actorBinding.canonicalActorId], expect.any(Function));
    expect(mocks.sql).toHaveBeenCalledOnce();
    const [strings, ...values] = mocks.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).toEqual(["tenant-a", current.actorBinding.canonicalActorId, current.accessBinding.accessScopeSha256, "entity:a", 2]);
    expect(strings.join("?")).toMatch(/state = 'active'[\s\S]*entity_type_id IN \('person', 'organization', 'account', 'project'\)[\s\S]*ORDER BY id COLLATE "C"[\s\S]*LIMIT/);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("fails closed on a corrupt or wrongly scoped SQL head and on storage failure", async () => {
    mocks.database.mockReturnValue(true);
    for (const contract of [entity("entity:a", { access: access(undefined, "tenant-b") }), { ...entity("entity:a"), canonicalLabel: "tampered" }]) {
      mocks.sql.mockResolvedValueOnce([{ contract }]);
      await expect(readEntityOptions(access())).rejects.toThrow();
    }
    mocks.sql.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(readEntityOptions(access())).rejects.toThrow("Database unavailable");
  });

  it("bounds output at 100 and rejects an over-returning SQL adapter", async () => {
    const records = Array.from({ length: 101 }, (_, index) => entity(`entity:${String(index).padStart(3, "0")}`));
    mocks.database.mockReturnValue(true);
    mocks.sql.mockResolvedValueOnce(records.map((contract) => ({ contract })));
    expect((await readEntityOptions(access(), { limit: 100 })).items).toHaveLength(100);
    mocks.sql.mockResolvedValueOnce(records.map((contract) => ({ contract })));
    await expect(readEntityOptions(access(), { limit: 1 })).rejects.toThrow(/bound/);
  });
});
