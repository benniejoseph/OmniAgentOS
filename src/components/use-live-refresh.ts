"use client";

import { useEffect, useRef } from "react";

export function useLiveRefresh({
  enabled,
  onRefresh,
  pollIntervalMs,
}: {
  enabled: boolean;
  onRefresh: () => Promise<void>;
  pollIntervalMs?: number;
}) {
  const refreshRef = useRef(onRefresh);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (
        disposed ||
        refreshing ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      refreshing = true;
      try {
        await refreshRef.current();
      } finally {
        refreshing = false;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibility);
    const interval = pollIntervalMs
      ? window.setInterval(() => void refresh(), pollIntervalMs)
      : undefined;

    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [enabled, pollIntervalMs]);
}
