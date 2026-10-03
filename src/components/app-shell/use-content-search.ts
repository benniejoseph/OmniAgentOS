"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { PaletteSearchController } from "./content-search-state";

export function useContentSearch(owner: string, query: string, open: boolean) {
  const [controller] = useState(() => new PaletteSearchController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.configure(owner, query, open); return () => controller.configure("", "", false); }, [controller, owner, query, open]);
  // Render fencing is immediate, before effects abort requests from an old owner or query.
  const valid = state.owner === owner && state.query === query.trim() && open && Boolean(owner);
  return { state: valid ? state : { ...state, groups: [], generatedAt: null, error: null, status: "idle" as const },
    more: (provider: Parameters<PaletteSearchController["more"]>[0]) => controller.more(provider),
    refresh: () => controller.refresh() };
}
