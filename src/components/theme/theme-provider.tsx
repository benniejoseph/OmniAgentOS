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
    window.addEventListener("omniagent-theme-change", syncTheme);

    return () => {
      media.removeEventListener("change", syncTheme);
      window.removeEventListener("omniagent-theme-change", syncTheme);
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
  applyTheme(theme);
  window.dispatchEvent(new Event("omniagent-theme-change"));
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
