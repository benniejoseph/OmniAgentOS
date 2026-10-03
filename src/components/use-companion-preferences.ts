"use client";

import { useEffect, useState } from "react";
import { parseCompanionResponse } from "@/components/companion-preferences-state";
import type { CompanionPreferencesResponse } from "@/lib/companion/contracts";
import { createCompanionReadGate } from "@/lib/companion/presentation";

/** The caller keys its view by exact tenant/actor scope. No shared cache can
 * carry a prior owner's visibility or home preference into this view. */
export function useCompanionPreferences(scope: string | undefined): {
  response?: CompanionPreferencesResponse; state: "loading" | "ready" | "unavailable";
} {
  const [gate] = useState(createCompanionReadGate);
  const [read, setRead] = useState<{
    scope?: string; response?: CompanionPreferencesResponse; state: "loading" | "ready" | "unavailable";
  }>({ state: "loading" });
  useEffect(() => {
    if (!scope) return;
    const token = gate.begin(scope);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const response = await fetch("/api/companion/preferences", { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
        const payload: unknown = await response.json();
        const parsed = response.ok && !controller.signal.aborted ? parseCompanionResponse(payload) : undefined;
        if (gate.current(token)) setRead(parsed ? { scope, response: parsed, state: "ready" } : { scope, state: "unavailable" });
      } catch {
        if (gate.current(token)) setRead({ scope, state: "unavailable" });
      } finally { window.clearTimeout(timeout); }
    })();
    return () => { gate.invalidate(); controller.abort(); window.clearTimeout(timeout); };
  }, [gate, scope]);
  return read.scope === scope && scope ? read : { state: "loading" as const };
}
