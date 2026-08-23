"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

type HealthStatus =
  | "checking"
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "unavailable";

export function PublicHealthBadge() {
  const [status, setStatus] = useState<HealthStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;

    const load = () => {
      timer = window.setTimeout(async () => {
        try {
          const response = await fetch("/api/health?public=1", {
            cache: "force-cache",
            signal: controller.signal,
          });
          if (!response.ok) {
            setStatus("unavailable");
            return;
          }
          const data = (await response.json()) as { status?: string };
          setStatus(
            data.status === "healthy" ||
              data.status === "degraded" ||
              data.status === "unhealthy"
              ? data.status
              : "unavailable",
          );
        } catch {
          if (!controller.signal.aborted) {
            setStatus("unavailable");
          }
        }
      }, 0);
    };

    if (document.readyState === "complete") {
      load();
    } else {
      window.addEventListener("load", load, { once: true });
    }
    return () => {
      controller.abort();
      window.removeEventListener("load", load);
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const Icon =
    status === "healthy"
      ? CheckCircle2
      : status === "checking"
        ? Loader2
        : AlertTriangle;

  return (
    <div
      className="mt-6 inline-flex min-h-12 max-w-full items-center gap-3 rounded-md border border-line bg-surface px-4 text-sm text-muted"
      role="status"
      aria-live="polite"
    >
      <Icon
        size={17}
        className={
          status === "healthy"
            ? "text-success"
            : status === "checking"
              ? "animate-spin text-muted"
              : status === "degraded"
                ? "text-warning"
                : status === "unhealthy"
                  ? "text-danger"
                  : "text-muted"
        }
        aria-hidden="true"
      />
      <span>System health:</span>
      <strong className="font-mono text-foreground">{status}</strong>
    </div>
  );
}
