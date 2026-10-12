import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "./contracts";
import { showWorkItemService } from "./work-items";

const mocked = vi.hoisted(() => ({ read: vi.fn(), sql: vi.fn(), transaction: vi.fn(), actorScope: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getSql: () => Object.assign(mocked.sql, { transactionScoped: true, transaction: mocked.transaction }),
  runWithDatabaseActorScope: mocked.actorScope }));
vi.mock("@/lib/responsibilities/work-item-source", () => ({ readOwnedWorkItemWithSql: mocked.read }));
const owner = "actor:11111111-1111-4111-8111-111111111111";
const caller = createAppServiceCaller({ context: { tenantId: "tenant-a", actorId: "owner@example.test", role: "operator", source: "session",
  auth: { userId: owner.slice(6), email: "owner@example.test", sessionId: "s", tenantName: "Fixture" } } });
const input = { workspaceId: "workspace:a", projectId: "project-a", workItemId: "work-a" };
beforeEach(() => {
  vi.clearAllMocks();
  mocked.actorScope.mockImplementation(async (_tenant, _actors, read) => read());
  mocked.sql.mockResolvedValue([{ checked_at: new Date("2026-10-12T00:00:00.000Z") }]);
  mocked.read.mockResolvedValue({ workItem: { title: "Owned work" }, checkedAt: "2026-10-12T00:00:00.000Z" });
});
describe("Exact governed work-item read", () => {
  it("joins the admitted transaction with canonical owner and exact workspace/project/item input", async () => {
    const result = await showWorkItemService(caller, input);
    expect(mocked.transaction).not.toHaveBeenCalled();
    expect(mocked.read).toHaveBeenCalledExactlyOnceWith(mocked.sql, { tenantId: "tenant-a", actorId: owner }, input, "2026-10-12T00:00:00.000Z");
    expect(result.data).toEqual({ workItem: { title: "Owned work" }, checkedAt: "2026-10-12T00:00:00.000Z" });
    expect(result.receipt).toMatchObject({ operation: "app.work_items.show", accessMode: "read" });
  });
  it("rejects an injected owner, missing scope, and an unauthenticated caller before source reads", async () => {
    await expect(showWorkItemService(caller, { ...input, actorId: "other" })).rejects.toBeDefined();
    await expect(showWorkItemService(caller, { workItemId: "work-a" })).rejects.toBeDefined();
    await expect(showWorkItemService({ ...caller, context: { ...caller.context, auth: undefined } }, input)).rejects.toBeDefined();
    expect(mocked.read).not.toHaveBeenCalled();
  });
});
