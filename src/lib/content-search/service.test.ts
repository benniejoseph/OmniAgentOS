import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/threads/store", () => ({ searchOwnedThreadsPage: vi.fn() }));
vi.mock("@/lib/memory/store", () => ({ searchPrivateMemoryPage: vi.fn() }));
vi.mock("@/lib/library/store", () => ({ listWorkspaceLibrary: vi.fn() }));
vi.mock("./work-reader", () => ({ searchOwnedWorkPage: vi.fn() }));
import { searchContent, type ContentSearchReaders } from "./service";
import { searchContext, searchTimestamp, searchThreadId } from "./test-fixtures";
function readers() {
  return {
    conversations: vi.fn().mockResolvedValue({ items: [{ id: searchThreadId, title: "Report conversation", updatedAt: searchTimestamp }], next: null }),
    work: vi.fn().mockResolvedValue({ items: [], next: null }), memory: vi.fn().mockResolvedValue({ items: [], next: null }),
    library: vi.fn().mockResolvedValue({ items: [], nextOffset: null }),
  } as unknown as ContentSearchReaders;
}
describe("scoped content search aggregation", () => {
  it("serializes provider reads, isolates an unavailable provider and uses canonical private scope", async () => {
    const deps = readers(); const order: string[] = [];
    for (const provider of ["conversations", "work", "memory", "library"] as const) {
      const previous = deps[provider];
      deps[provider] = vi.fn(async (...args: Parameters<typeof previous>) => {
        order.push(provider); if (provider === "work") throw new Error("internal database detail");
        return Reflect.apply(previous, undefined, args);
      }) as never;
    }
    const result = await searchContent(searchContext, { query: "report", limit: 8 }, deps);
    expect(order).toEqual(["conversations", "work", "memory", "library"]);
    expect(result.groups.map((group) => group.status)).toEqual(["ready", "unavailable", "ready", "ready"]);
    expect(JSON.stringify(result)).not.toContain("internal database detail");
    expect(result.groups[0].items[0].href).toBe(`/app/command?thread=${searchThreadId}`);
    expect(deps.memory).toHaveBeenCalledWith(expect.objectContaining({ accessScope: expect.objectContaining({
      tenantId: searchContext.tenantId, initiatingActorId: `actor:${searchContext.auth!.userId}`, executingPrincipalType: "user", purposeId: "memory.read.v1",
    }) }));
    expect(deps.library).toHaveBeenCalledWith(expect.objectContaining({ sourceAuthorities: ["capture_asset", "capture_recording", "capture_transcript", "project_artifact", "source_item"] }));
  });
  it("does not invent canonical ownership for missing/legacy/service actors", async () => {
    const deps = readers();
    const result = await searchContent({ ...searchContext, source: "service", auth: undefined }, { query: "report", limit: 8 }, deps);
    expect(result.groups.every((group) => group.status === "unavailable" && !group.items.length)).toBe(true);
    Object.values(deps).forEach((reader) => expect(reader).not.toHaveBeenCalled());
  });
  it("rejects malformed provider output inside that group, not the complete search", async () => {
    const deps = readers(); vi.mocked(deps.conversations).mockResolvedValue({ items: [{ id: searchThreadId, title: "", updatedAt: "invalid" }], next: null });
    const result = await searchContent(searchContext, { query: "report", limit: 8 }, deps);
    expect(result.groups[0].status).toBe("unavailable"); expect(result.groups[1].status).toBe("ready");
  });
  it("reads only the requested page provider and preserves microsecond cursor precision", async () => {
    const deps = readers(); vi.mocked(deps.conversations).mockResolvedValue({ items: [], next: { id: searchThreadId, updatedAt: searchTimestamp } });
    const result = await searchContent(searchContext, { query: "report", limit: 8, provider: "conversations" }, deps);
    expect(result.groups).toHaveLength(1); expect(result.groups[0].nextCursor).toBeTruthy();
    expect(deps.work).not.toHaveBeenCalled(); expect(deps.memory).not.toHaveBeenCalled(); expect(deps.library).not.toHaveBeenCalled();
  });
});
