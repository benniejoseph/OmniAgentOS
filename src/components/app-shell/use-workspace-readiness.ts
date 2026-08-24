"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceReadiness } from "@/lib/workspace/readiness";

export type WorkspaceReadinessState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: WorkspaceReadiness }
  | { status: "refreshing"; data: WorkspaceReadiness }
  | { status: "error"; error: string; data?: WorkspaceReadiness };

export function useWorkspaceReadiness({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<WorkspaceReadinessState>({
    status: "idle",
  });
  const activeRequestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;

    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setState((current) => {
      const data = readinessData(current);
      return data ? { status: "refreshing", data } : { status: "loading" };
    });

    try {
      const response = await fetch("/api/workspace-readiness", {
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const record = asRecord(body);
        throw new Error(
          stringValue(
            record.message || record.error,
            `Readiness request returned ${response.status}.`,
          ),
        );
      }
      if (controller.signal.aborted || activeRequestRef.current !== controller) {
        return;
      }
      setState({
        status: "ready",
        data: body as WorkspaceReadiness,
      });
    } catch (error) {
      if (controller.signal.aborted || activeRequestRef.current !== controller) {
        return;
      }
      setState((current) => {
        const data = readinessData(current);
        return {
          status: "error",
          error: error instanceof Error ? error.message : "Readiness request failed.",
          ...(data ? { data } : {}),
        };
      });
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      activeRequestRef.current?.abort();
    };
  }, [enabled, refresh]);

  return { state, refresh };
}

function readinessData(state: WorkspaceReadinessState) {
  return "data" in state ? state.data : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}
