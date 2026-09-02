"use client";

import { Moon, Monitor, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { getStoredTheme, setStoredTheme, type ThemePreference } from "@/components/theme/theme-provider";

const order: ThemePreference[] = ["system", "dark", "light"];
const options: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useSyncExternalStore(subscribeToTheme, getStoredTheme, getServerTheme);

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light";

  if (!compact) {
    return (
      <div
        className="inline-flex items-center gap-0.5 rounded-full border border-line bg-surface/80 p-1 shadow-[0_8px_24px_-20px_rgba(0,0,0,0.45)] backdrop-blur"
        role="group"
        aria-label="Color theme"
      >
        {options.map((option) => {
          const OptionIcon = option.icon;
          const selected = theme === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              title={`Use ${option.label.toLowerCase()} theme`}
              onClick={() => setStoredTheme(option.value)}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold transition ${
                selected
                  ? "bg-foreground text-background shadow-sm"
                  : "text-muted hover:bg-surface-raised hover:text-foreground"
              }`}
            >
              <OptionIcon size={14} aria-hidden="true" />
              <span className="hidden xl:inline">{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Theme: ${label}`}
      title={`Theme: ${label}`}
      onClick={() => {
        const next = order[(order.indexOf(theme) + 1) % order.length];
        setStoredTheme(next);
      }}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface/80 px-3 text-sm font-medium text-foreground shadow-[0_8px_24px_-20px_rgba(0,0,0,0.45)] backdrop-blur transition hover:border-primary/50 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-primary/40"
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
