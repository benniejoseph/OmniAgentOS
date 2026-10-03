import type { ContentSearchGroup, ContentSearchProvider, ContentSearchResponse } from "@/lib/content-search/contracts";
import { parseContentSearchQuery, parseContentSearchResponse } from "@/lib/content-search/client";

export type PaletteSearchState = {
  owner: string; query: string; status: "idle" | "loading" | "ready" | "error";
  groups: ContentSearchGroup[]; generatedAt: string | null; error: string | null;
  loadingProvider: ContentSearchProvider | null;
};
const empty = (owner = "", query = ""): PaletteSearchState => ({ owner, query, status: "idle", groups: [], generatedAt: null, error: null, loadingProvider: null });

/** One abortable generation. Changing owner/role, query, closing or disposal fences all responses. */
export class PaletteSearchController {
  private state = empty();
  private generation = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(private readonly request: typeof fetch = (input, init) => fetch(input, init), private readonly debounceMs = 250) {}
  getSnapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private publish(state: PaletteSearchState) { this.state = state; this.listeners.forEach((listener) => listener()); }
  configure(owner: string, rawQuery: string, open: boolean) {
    const query = parseContentSearchQuery(rawQuery) ?? "";
    this.cancel();
    this.publish(empty(owner, query));
    if (!open || !owner || !query || this.disposed) return;
    this.publish({ ...this.state, status: "loading" });
    const generation = this.generation;
    this.timer = setTimeout(() => void this.load(generation), this.debounceMs);
  }
  refresh() { if (this.state.owner && this.state.query) this.configure(this.state.owner, this.state.query, true); }
  more(provider: ContentSearchProvider) {
    if (this.state.loadingProvider || this.state.status !== "ready") return;
    const group = this.state.groups.find((entry) => entry.provider === provider);
    if (!group || group.items.length >= 100) return;
    if (group.status === "ready" && !group.nextCursor) return;
    this.publish({ ...this.state, loadingProvider: provider, error: null });
    void this.load(this.generation, provider, group.nextCursor ?? undefined);
  }
  private async load(generation: number, provider?: ContentSearchProvider, cursor?: string) {
    if (generation !== this.generation || this.disposed) return;
    this.controller = new AbortController();
    const controller = this.controller;
    const timeout = setTimeout(() => controller.abort(), 25_000);
    const query = this.state.query;
    const params = new URLSearchParams({ q: query, limit: "8" });
    if (provider) params.set("provider", provider);
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await this.request(`/api/content-search?${params}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 409 ? "Search changed. Start this search again." : "Content search could not be loaded. Try again.");
      const result = parseContentSearchResponse(await response.json());
      if (!result) throw new Error("Content search returned an invalid response.");
      if (result.query !== query || (provider && (result.groups.length !== 1 || result.groups[0].provider !== provider))) {
        throw new Error("Content search returned a mismatched page. Start this search again.");
      }
      if (generation !== this.generation || this.disposed || controller.signal.aborted) return;
      this.publish({ ...this.state, status: "ready", groups: mergeSearchGroups(this.state.groups, result, provider, Boolean(cursor)),
        generatedAt: result.generatedAt, loadingProvider: null, error: null });
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      const message = controller.signal.aborted ? "Content search timed out. Try again." :
        error instanceof Error && error.message.startsWith("Search changed") ? error.message : "Content search could not be loaded. Try again.";
      this.publish({ ...this.state, status: provider ? "ready" : "error", loadingProvider: null, error: message });
    } finally { clearTimeout(timeout); }
  }
  private cancel() { this.generation += 1; clearTimeout(this.timer); this.controller?.abort(); }
  dispose() { this.cancel(); this.disposed = true; this.listeners.clear(); }
}

export function mergeSearchGroups(current: ContentSearchGroup[], result: ContentSearchResponse,
  provider?: ContentSearchProvider, append = false): ContentSearchGroup[] {
  if (!provider) return result.groups;
  const replacement = result.groups[0];
  return current.map((group) => {
    if (group.provider !== provider) return group;
    if (!append || replacement.status !== "ready") return replacement;
    const byId = new Map(group.items.map((item) => [item.id, item]));
    replacement.items.forEach((item) => byId.set(item.id, item));
    return { ...replacement, items: [...byId.values()].slice(0, 100) };
  });
}
