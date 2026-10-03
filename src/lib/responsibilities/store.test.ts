import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ hasDatabaseUrl: vi.fn(), getSql: vi.fn(), ensureDatabaseSchema: vi.fn(), scope: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ ...mocks, runWithDatabaseActorScope: mocks.scope }));
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: mocks.event }));
import { changeResponsibility, listResponsibilities, readResponsibility } from "./store";
import { prepareResponsibilityChange, responsibilityId } from "./state";
import { draftFixture as draft, nowFixture as now, ownerFixture as owner } from "./test-fixtures";
const id = responsibilityId(owner, "create");
const record = prepareResponsibilityChange({ owner, id, key: "create", now, mutation: { action: "create", expectedRevision: 0, draft } }).current;
function row(value = record) { return { schema_version: 1, id: value.id, tenant_id: value.tenantId, actor_id: value.actorId, revision: value.revision, state: value.state, draft_sha256: value.draftSha256, snapshot: value, created_at: value.createdAt, updated_at: value.updatedAt }; }
beforeEach(() => { vi.clearAllMocks(); mocks.hasDatabaseUrl.mockReturnValue(true); mocks.scope.mockImplementation((_tenant: string, _actors: string[], callback: () => Promise<unknown>) => callback()); });
describe("Responsibility persistence boundary", () => {
  it("fails closed without a durable database and never writes a file fallback", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(false);
    await expect(readResponsibility(owner, id)).rejects.toMatchObject({ status: 503, code: "responsibility_storage_unavailable" });
    await expect(changeResponsibility(owner, id, { action: "create", expectedRevision: 0, draft }, "create")).rejects.toMatchObject({ status: 503 });
    expect(mocks.getSql).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it("binds owner SQL scope, retains a lower bound and rejects inconsistent stored coordinates", async () => {
    const sql = vi.fn().mockResolvedValue([row(), row()]); mocks.getSql.mockReturnValue(sql);
    const result = await listResponsibilities(owner, 1);
    expect(result).toEqual({ records: [record], hasMore: true });
    expect(mocks.scope).toHaveBeenCalledWith(owner.tenantId, [owner.actorId], expect.any(Function));
    expect(sql.mock.calls[0].slice(1)).toEqual([owner.tenantId, owner.actorId, 2]);
    sql.mockResolvedValue([{ ...row(), actor_id: "other" }]);
    await expect(readResponsibility(owner, id)).rejects.toMatchObject({ code: "responsibility_storage_invalid" });
  });
  it("propagates event failure from the same transaction instead of confirming the head alone", async () => {
    const statements: string[] = [];
    const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const statement = parts.join("?"); statements.push(statement);
      if (statement.includes("INSERT INTO omni_responsibilities")) return [row(values[6] as typeof record)];
      return [];
    });
    const transaction = vi.fn((callback: (client: typeof sql) => Promise<unknown>) => callback(sql));
    mocks.getSql.mockReturnValue({ transaction });
    mocks.event.mockRejectedValue(new Error("event insert rejected"));
    await expect(changeResponsibility(owner, id, { action: "create", expectedRevision: 0, draft }, "create")).rejects.toThrow("event insert rejected");
    expect(statements.some((statement) => statement.includes("INSERT INTO omni_responsibility_mutations"))).toBe(true);
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ type: "responsibility.draft.created", payload: expect.objectContaining({ authorityEffect: "none", scheduled: false, notificationCreated: false }) }), { sql });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
