"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { canPerform, useWorkspaceSession } from "@/components/app-shell/session-context";
import { agentsScopeKey, createAgentsGate, readAgentsJson, type AgentsGate } from "@/components/agents-workspace-state";

const AgentsLifecycleContext = createContext<AgentsGate | undefined>(undefined);

/** A composition owns its coordinator; individual inspectors never dispose a parent's slot. */
export function AgentsLifecycleBoundary({ scope = "", children }: { scope?: string; children: ReactNode }) {
  const parent = useContext(AgentsLifecycleContext);
  const { session, role } = useWorkspaceSession();
  const identity = agentsScopeKey({ tenantId: session?.context?.tenantId, actorId: session?.context?.actorId, email: session?.user?.email, role, authEnabled: session?.authEnabled, authenticated: session?.authenticated, route: [scope] });
  return parent ? <div key={identity} style={{ display: "contents" }}>{children}</div> : <AgentsLifecycleOwner key={identity}>{children}</AgentsLifecycleOwner>;
}
function AgentsLifecycleOwner({ children }: { children: ReactNode }) {
  const [gate] = useState(createAgentsGate);
  useLayoutEffect(() => { gate.mount(); return () => gate.dispose(); }, [gate]);
  return <AgentsLifecycleContext.Provider value={gate}>{children}</AgentsLifecycleContext.Provider>;
}
export function useAgentsLifecycle() {
  const gate = useContext(AgentsLifecycleContext);
  if (!gate) throw new Error("Agent controls require a scoped lifecycle coordinator.");
  const generation = useSyncExternalStore(gate.subscribe, gate.snapshot, () => 0);
  const busy = gate.label();
  const { session, status, role } = useWorkspaceSession();
  const available = status === "ready" && Boolean(session && (!session.authEnabled || session.authenticated));
  const reason = !available ? "Waiting for the current workspace session." : !canPerform(role, "manage.workflow") ? "Your workspace role cannot manage Agents or their authority." : undefined;
  return { gate, busy, generation, reason, available, session, role };
}
export function useAgentRead<T>(path: string, parse: (value: Record<string, unknown>) => T) {
  const { gate, busy, generation, available } = useAgentsLifecycle();
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const parser = useRef(parse);
  const alive = useRef(false);
  useLayoutEffect(() => { parser.current = parse; }, [parse]);
  const refresh = useCallback(async () => {
    if (!available || gate.busy()) return;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const current = gate.read(path);
    setLoading(true); setError(undefined);
    try {
      const raw = await readAgentsJson(path, { signal: request.signal });
      if (!alive.current || request.signal.aborted || !current()) return;
      const next = parser.current(raw); setData(next);
    } catch (caught) {
      if (!alive.current || request.signal.aborted || !current()) return;
      setError(caught instanceof Error ? caught.message : "This source is unavailable.");
    } finally {
      if (alive.current && !request.signal.aborted && current()) setLoading(false);
    }
  }, [available, gate, path]);
  useLayoutEffect(() => {
    alive.current = true;
    const timer = window.setTimeout(() => {
      if (busy) { controller.current?.abort(); setLoading(false); }
      else void refresh();
    }, 0);
    return () => { alive.current = false; window.clearTimeout(timer); controller.current?.abort(); };
  }, [busy, generation, refresh]);
  return { data, loading, error, refresh, accept: setData, current: !loading && !error && data !== undefined, label: data !== undefined ? loading ? "Refreshing · last loaded" : error ? "Refresh unavailable · last loaded" : "Loaded" : loading ? "Loading" : "Unavailable" };
}
