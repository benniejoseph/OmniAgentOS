"use client";
import { useSyncExternalStore } from "react";
const eventName = "asael:content-search-location";
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(eventName, listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(eventName, listener); };
}
const snapshot = () => `${window.location.pathname}${window.location.search}`;
const serverSnapshot = () => "";
/** Native history is integrated with the Next router; this event also updates exact inspectors. */
export function openSearchOnCurrentPage(href: string) {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return false;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(eventName));
  return true;
}
export function useContentSearchLocation() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
