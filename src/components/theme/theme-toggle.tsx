"use client";

import { Moon, Monitor, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { getStoredTheme, setStoredTheme, type ThemePreference } from "@/components/theme/theme-provider";

const order: ThemePreference[] = ["system", "dark", "light"];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useSyncExternalStore(subscribeToTheme, getStoredTheme, getServerTheme);

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light";

  return (
    <button
      type="button"
      aria-label={`Theme: ${label}`}
      title={`Theme: ${label}`}
      onClick={() => {
        const next = order[(order.indexOf(theme) + 1) % order.length];
        setStoredTheme(next);
      }}
      className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium text-foreground transition hover:border-primary/50 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-primary/40"
    >
      <Icon size={16} aria-hidden="true" />
      {!compact ? <span>{label}</span> : null}
    </button>
  );
}

function subscribeToTheme(callback: () => void) {
  window.addEventListener("omniagent-theme-change", callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener("omniagent-theme-change", callback);
    window.removeEventListener("storage", callback);
  };
}

function getServerTheme(): ThemePreference {
  return "system";
}
