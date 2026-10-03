import { afterEach, describe, expect, it, vi } from "vitest";
import { PaletteSearchController, mergeSearchGroups } from "./content-search-state";
import { contentSearchCoverage, contentSearchLabels, type ContentSearchResponse } from "@/lib/content-search/contracts";
const payload = (title = "Current report", nextCursor: string | null = null): ContentSearchResponse => ({ query: "report", generatedAt: "2026-10-04T00:00:00.000Z", consistency: "live", groups: [{
  provider: "memory", label: contentSearchLabels.memory, coverage: contentSearchCoverage.memory, status: "ready", nextCursor, message: null,
  items: [{ id: "memory-one", title, detail: "Private memory", href: "/app/memory?memory=memory-one", updatedAt: "2026-10-04T00:00:00.000Z" }],
}] });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("palette search lifecycle", () => {
  it("uses the browser fetch receiver for its default transport", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this instanceof PaletteSearchController) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json(payload()));
    });
    const controller = new PaletteSearchController();
    controller.configure("owner", "report", true);
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().status).toBe("ready");
    expect(controller.getSnapshot().groups[0].items[0].title).toBe("Current report");
    controller.dispose();
  });
  it("debounces, cancels and refuses a response from a previous owner", async () => {
    vi.useFakeTimers(); let release!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const controller = new PaletteSearchController(fetcher as typeof fetch);
    controller.configure("owner-a", "repo", true); controller.configure("owner-a", "report", true);
    await vi.advanceTimersByTimeAsync(250); expect(fetcher).toHaveBeenCalledTimes(1);
    controller.configure("owner-b", "report", true);
    release(Response.json(payload("Old owner's private title"))); await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().groups).toEqual([]);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
    controller.dispose(); await vi.advanceTimersByTimeAsync(500); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps navigation independent by never requesting empty/punctuation or unavailable owner searches", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(); const controller = new PaletteSearchController(fetcher as typeof fetch);
    for (const [owner, query, open] of [["owner", "%%", true], ["", "report", true], ["owner", "report", false]] as const) controller.configure(owner, query, open);
    await vi.advanceTimersByTimeAsync(1000); expect(fetcher).not.toHaveBeenCalled(); controller.dispose();
  });
  it("deduplicates live pagination and preserves unrelated groups", () => {
    const original = payload("Earlier title", "next"); const updated = payload("Updated title");
    const merged = mergeSearchGroups(original.groups, updated, "memory", true);
    expect(merged[0].items).toHaveLength(1); expect(merged[0].items[0].title).toBe("Updated title");
  });
  it("stops delayed requests on close and distinguishes request failure from zero matches", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const controller = new PaletteSearchController(fetcher as typeof fetch);
    controller.configure("owner", "report", true); controller.configure("owner", "report", false);
    await vi.advanceTimersByTimeAsync(300); expect(fetcher).not.toHaveBeenCalled();
    controller.configure("owner", "report", true); await vi.advanceTimersByTimeAsync(300);
    expect(controller.getSnapshot().status).toBe("error"); expect(controller.getSnapshot().error).toContain("Try again"); controller.dispose();
  });
});
