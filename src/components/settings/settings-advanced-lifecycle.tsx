"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { permissionMessage, useWorkspaceSession, type WorkspacePermission } from "@/components/app-shell/session-context";
import { createAdvancedSettingsGate, settingsError } from "./settings-advanced-state";

type Action<T> = {
  label: string;
  permission: WorkspacePermission;
  fingerprint: string;
  replayable: boolean;
  execute: (input: { idempotencyKey: string; current: () => boolean }) => Promise<T | undefined>;
  success: string;
};
function useController() {
  const { session, status } = useWorkspaceSession();
  const [gate] = useState(createAdvancedSettingsGate);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const alive = useRef(false);
  const authority = useRef({ session, status });
  useLayoutEffect(() => {
    alive.current = true; gate.mount();
    return () => { alive.current = false; gate.dispose(); };
  }, [gate]);
  useLayoutEffect(() => {
    authority.current = { session, status };
    gate.availability(permissionMessage(session, status, "read") === undefined);
  }, [gate, session, status]);
  const run = useCallback(async <T,>(action: Action<T>): Promise<{ value: T } | undefined> => {
    const blocked = permissionMessage(authority.current.session, authority.current.status, action.permission);
    if (blocked) { setError(blocked); return; }
    if (gate.pending()) return;
    let ticket: ReturnType<typeof gate.begin>;
    try { ticket = gate.begin(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Settings action is unavailable."); return; }
    setBusy(action.label); setError(undefined); setNotice(undefined);
    let fingerprint: string | undefined;
    try {
      // Store only a digest, never credential values, passphrases or a one-time token in the retry ledger.
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(action.fingerprint));
      fingerprint = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!ticket.current()) return;
      const idempotencyKey = gate.retry(fingerprint, action.replayable, () => crypto.randomUUID());
      const value = await action.execute({ idempotencyKey, current: ticket.current });
      if (!ticket.current()) { if (alive.current) setError("Session verification changed while the request was pending. Its outcome is not applied to this view. Refresh before continuing."); return; }
      if (value === undefined) { gate.confirmed(fingerprint); return; }
      gate.confirmed(fingerprint); setNotice(action.success);
      return { value };
    } catch (failure) {
      if (ticket.current()) setError(failure instanceof Error ? failure.message : "The settings action could not be confirmed. Refresh the current records before continuing.");
      return;
    } finally {
      ticket.release();
      if (alive.current) setBusy(undefined);
    }
  }, [gate]);
  const blocked = useCallback((permission: WorkspacePermission) => permissionMessage(session, status, permission), [session, status]);
  return useMemo(() => ({ gate, busy, error, notice, run, blocked, session, status }), [gate, busy, error, notice, run, blocked, session, status]);
}
type Controller = ReturnType<typeof useController>;
const Context = createContext<Controller | undefined>(undefined);
function Provider({ children }: { children: ReactNode }) {
  const controller = useController();
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
/** Also supports the legacy DomainConsole composition without changing that shared caller. */
export function AdvancedSettingsBoundary({ children }: { children: ReactNode }) {
  const existing = useContext(Context);
  const { session } = useWorkspaceSession();
  const scope = JSON.stringify([session?.context?.tenantId, session?.context?.actorId, session?.membership?.role ?? session?.context?.role]);
  return existing ? children : <Provider key={scope}>{children}</Provider>;
}
export function useAdvancedSettingsActions() {
  const value = useContext(Context);
  if (!value) throw new Error("Advanced Settings controls require their scoped action boundary.");
  return value;
}
export async function settingsJson(path: string, init?: RequestInit, timeoutMs = 60_000): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(path, { cache: "no-store", ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout, headers: { accept: "application/json", ...init?.headers } });
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("The server response could not be verified. Refresh before repeating a change."); }
  if (!response.ok) throw new Error(`${response.status === 409 ? "Conflict: " : ""}${settingsError(value, `Settings request failed (${response.status}).`)}`);
  return value;
}
export function mutationOptions(method: string, body: unknown, idempotencyKey?: string): RequestInit {
  return { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
