"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CompanionPersonality } from "@/lib/companion/personality";

export type CompanionPersonalityOwner = Readonly<{ tenantId: string; actorId: string }>;
const changeEvent = "asael:companion-personality";
const memoryOnly = new Map<string, CompanionPersonality>();
const defaultPersonality: CompanionPersonality = "butler";

function storageKey(owner: CompanionPersonalityOwner | undefined) {
  return owner ? `asael:companion-personality:1:${JSON.stringify([owner.tenantId, owner.actorId])}` : undefined;
}

function read(key: string | undefined): CompanionPersonality {
  if (!key) return defaultPersonality;
  const fallback = memoryOnly.get(key);
  if (fallback) return fallback;
  try { return window.localStorage.getItem(key) === "playful" ? "playful" : defaultPersonality; }
  catch { return defaultPersonality; }
}

/** A same-origin, owner-scoped preference. Each request captures its own value;
 * changing this setting grants no authority and never changes an active call. */
export function useCompanionPersonality(owner: CompanionPersonalityOwner | undefined) {
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
  const personality = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), () => defaultPersonality);
  const persistenceNotice = useSyncExternalStore(subscribe, useCallback(() => key && memoryOnly.has(key)
    ? "Using this personality for now; it could not be saved on this device." : undefined, [key]), () => undefined);
  const setPersonality = useCallback((value: CompanionPersonality) => {
    if (!key || (value !== "butler" && value !== "playful")) return false;
    try { window.localStorage.setItem(key, value); memoryOnly.delete(key); }
    catch { memoryOnly.set(key, value); }
    window.dispatchEvent(new CustomEvent(changeEvent, { detail: key }));
    return !memoryOnly.has(key);
  }, [key]);
  return { personality, setPersonality, persistenceNotice, available: Boolean(key) };
}
