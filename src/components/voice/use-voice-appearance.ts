"use client";

import { useCallback, useSyncExternalStore } from "react";

export type VoiceAppearance = "companion" | "perch";
export type VoiceAppearanceOwner = Readonly<{ tenantId: string; actorId: string }>;
const changeEvent = "asael:voice-appearance";
const memoryOnly = new Map<string, VoiceAppearance>();
const defaultAppearance: VoiceAppearance = "companion";

function storageKey(owner: VoiceAppearanceOwner | undefined) {
  return owner ? `asael:voice-appearance:1:${JSON.stringify([owner.tenantId, owner.actorId])}` : undefined;
}
function read(key: string | undefined): VoiceAppearance {
  if (!key) return defaultAppearance;
  const fallback = memoryOnly.get(key);
  if (fallback) return fallback;
  try { return window.localStorage.getItem(key) === "perch" ? "perch" : defaultAppearance; }
  catch { return defaultAppearance; }
}

/** Device-local presentation only. Tenant and actor are both part of the key;
 * changing this preference never restarts audio or updates server authority. */
export function useVoiceAppearance(owner: VoiceAppearanceOwner | undefined) {
  const key = storageKey(owner);
  const subscribe = useCallback((notify: () => void) => {
    if (!key) return () => undefined;
    const changed = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key !== null && event.key !== key) return;
        memoryOnly.delete(key);
      } else if ((event as CustomEvent<string>).detail !== key) return;
      notify();
    };
    window.addEventListener("storage", changed);
    window.addEventListener(changeEvent, changed);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener(changeEvent, changed); };
  }, [key]);
  const appearance = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), () => defaultAppearance);
  const persistenceNotice = useSyncExternalStore(subscribe, useCallback(() => key && memoryOnly.has(key)
    ? "Using this appearance for now; it could not be saved on this device." : undefined, [key]), () => undefined);
  const setAppearance = useCallback((value: VoiceAppearance) => {
    if (!key || (value !== "companion" && value !== "perch")) return false;
    try { window.localStorage.setItem(key, value); memoryOnly.delete(key); }
    catch { memoryOnly.set(key, value); }
    window.dispatchEvent(new CustomEvent(changeEvent, { detail: key }));
    return !memoryOnly.has(key);
  }, [key]);
  return { appearance, setAppearance, persistenceNotice, available: Boolean(key) };
}
