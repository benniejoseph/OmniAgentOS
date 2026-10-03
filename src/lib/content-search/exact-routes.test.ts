import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), library: vi.fn(), privateMemory: vi.fn(), resolveWork: vi.fn(), project: vi.fn(), task: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/contracts", () => ({ createAppServiceCaller: (input: unknown) => input, createRequestMutationAppServiceCaller: vi.fn() }));
vi.mock("@/lib/app-services/library", () => ({ showWorkspaceLibraryItemService: mocks.library }));
vi.mock("@/lib/app-services/memory", () => ({ publicMemoryServiceRecord: (memory: unknown) => memory }));
vi.mock("@/lib/memory/store", () => ({ getPrivateSearchMemory: mocks.privateMemory }));
vi.mock("@/lib/content-search/work-reader", () => ({ resolveOwnedSearchWork: mocks.resolveWork }));
vi.mock("@/lib/app-services/projects", () => ({ showProjectService: mocks.project, showProjectTaskService: mocks.task, updateWorkItemService: vi.fn() }));
vi.mock("@/lib/projects/store", () => ({ ProjectTransitionError: class extends Error {} }));
import { GET as openLibrary } from "@/app/api/library/[id]/route";
import { GET as openMemory } from "@/app/api/content-search/memory/[id]/route";
import { GET as openWork } from "@/app/api/content-search/work/[id]/route";
import { GET as openTask } from "@/app/api/projects/[id]/tasks/[taskId]/route";
import { searchContext } from "./test-fixtures";
const request = (path = "") => new Request(`https://asael.example/api/${path}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue(searchContext); });
describe("exact content search destinations", () => {
  it("blocks unsupported historical sources before the Library resolver and distinguishes deleted items", async () => {
    expect((await openLibrary(request(), params("library:mission_artifact:source"))).status).toBe(400);
    expect(mocks.library).not.toHaveBeenCalled();
    mocks.library.mockResolvedValue({ data: { item: null } });
    const response = await openLibrary(request(), params("library:capture_asset:deleted"));
    expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rechecks connected-source access at the exact scoped Library resolver on every open", async () => {
    const id = "library:source_item:source:full/current-identity";
    mocks.library.mockResolvedValueOnce({ data: { item: { id } }, receipt: { observed: true } }).mockResolvedValueOnce({ data: { item: null } });
    const first = await openLibrary(request(), params(id));
    expect(first.status).toBe(200);
    expect(mocks.library).toHaveBeenLastCalledWith({ context: searchContext }, { libraryItemId: id });
    const revoked = await openLibrary(request(), params(id));
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).not.toHaveProperty("item");
    expect(revoked.headers.get("cache-control")).toBe("private, no-store");
  });
  it("binds private memory to canonical owner and never uses a legacy detail fallback", async () => {
    mocks.privateMemory.mockResolvedValue(null);
    expect((await openMemory(request(), params("expired"))).status).toBe(404);
    expect(mocks.privateMemory).toHaveBeenCalledWith(expect.objectContaining({ tenantId: searchContext.tenantId,
      accessScope: expect.objectContaining({ initiatingActorId: `actor:${searchContext.auth!.userId}` }) }));
    mocks.privateMemory.mockClear(); mocks.authorize.mockResolvedValue({ ...searchContext, source: "service", auth: undefined });
    expect((await openMemory(request(), params("legacy"))).status).toBe(403); expect(mocks.privateMemory).not.toHaveBeenCalled();
  });
  it("refuses revoked Work mappings before reading original project or task contents", async () => {
    mocks.resolveWork.mockResolvedValue(null);
    const response = await openWork(request("content-search/work/project?task=task"), params("project"));
    expect(response.status).toBe(404); expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.task).not.toHaveBeenCalled();
  });
  it("opens an exact task omitted by the bounded project detail window", async () => {
    mocks.resolveWork.mockResolvedValue({ projectId: "project", taskId: "outside-window" });
    mocks.project.mockResolvedValue({ data: { project: { id: "project", tasks: [{ id: "first" }] } } });
    mocks.task.mockResolvedValue({ data: { task: { id: "outside-window" } } });
    const response = await openWork(request("content-search/work/project?task=outside-window"), params("project"));
    expect(response.status).toBe(200); expect((await response.json()).project.tasks.map((task: { id: string }) => task.id)).toEqual(["outside-window", "first"]);
  });
  it("authorizes the task's parent and delegates exact ownership to the existing service boundary", async () => {
    mocks.task.mockResolvedValue({ data: { task: null } });
    const response = await openTask(request(), { params: Promise.resolve({ id: "parent", taskId: "other-parent-task" }) });
    expect(response.status).toBe(404);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "read", resourceType: "project", resourceId: "parent" }));
    expect(mocks.task).toHaveBeenCalledWith({ context: searchContext }, { projectId: "parent", taskId: "other-parent-task" });
  });
});
