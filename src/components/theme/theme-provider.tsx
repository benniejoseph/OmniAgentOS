"use client";

import { useEffect } from "react";

export type ThemePreference = "light" | "dark" | "system";

export const themeStorageKey = "omniagent-theme";

export function ThemeProvider() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const syncTheme = () => {
      applyTheme(getStoredTheme());
    };

    syncTheme();
    media.addEventListener("change", syncTheme);
    window.addEventListener("storage", syncTheme);

    return () => {
      media.removeEventListener("change", syncTheme);
      window.removeEventListener("storage", syncTheme);
    };
  }, []);

  return null;
}

export function getStoredTheme(): ThemePreference {
  const value = window.localStorage.getItem(themeStorageKey);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function setStoredTheme(theme: ThemePreference) {
  window.localStorage.setItem(themeStorageKey, theme);
  // Update the control immediately, then move the full-page color-token swap
  // past the interaction's first paint. Recoloring a rich workspace can
  // otherwise dominate INP even though the click handler itself is tiny.
  document.documentElement.dataset.themePreference = theme;
  window.dispatchEvent(new Event("omniagent-theme-change"));
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      if (getStoredTheme() === theme) applyTheme(theme);
    }, 0);
  });
}

export function resolveTheme(theme: ThemePreference) {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  return theme;
}

export function applyTheme(theme: ThemePreference) {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = theme;
  document.documentElement.style.colorScheme = resolved;
}
