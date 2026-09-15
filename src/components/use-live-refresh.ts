"use client";

import { useEffect, useRef } from "react";
import { startVisibleRefresh } from "@/lib/client/visible-refresh";

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

    return startVisibleRefresh({
      onRefresh: () => refreshRef.current(),
      pollIntervalMs,
    });
  }, [enabled, pollIntervalMs]);
}
