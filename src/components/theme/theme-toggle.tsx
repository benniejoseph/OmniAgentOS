"use client";

import { Moon, Monitor, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import styles from "./theme-toggle.module.css";
import {
  getStoredTheme,
  setStoredTheme,
  themeChangeEvent,
  type ThemePreference,
} from "@/components/theme/theme-provider";

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
        className={styles.group}
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
              aria-label={`${option.label} theme`}
              title={`Use ${option.label.toLowerCase()} theme`}
              onClick={() => setStoredTheme(option.value)}
              className={styles.option}
            >
              <OptionIcon size={16} aria-hidden="true" />
              <span className={styles.label}>{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Theme: ${label}. Switch to ${order[(order.indexOf(theme) + 1) % order.length]} theme`}
      title={`Theme: ${label}`}
      onClick={() => {
        const next = order[(order.indexOf(theme) + 1) % order.length];
        setStoredTheme(next);
      }}
      className={styles.compact}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

function subscribeToTheme(callback: () => void) {
  window.addEventListener(themeChangeEvent, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(themeChangeEvent, callback);
    window.removeEventListener("storage", callback);
  };
}

function getServerTheme(): ThemePreference {
  return "system";
}
