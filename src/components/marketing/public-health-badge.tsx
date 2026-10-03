"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parsePublicHealth, type PublicHealth } from "./public-health";
import styles from "./public-surface.module.css";

const labels = { checking: "Checking", healthy: "Healthy", degraded: "Degraded", unhealthy: "Unhealthy", unavailable: "Unavailable" } as const;
export function PublicHealthBadge() {
  const [health, setHealth] = useState<PublicHealth>();
  const [loading, setLoading] = useState(true);
  const [failedRefresh, setFailedRefresh] = useState(false);
  const current = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    setLoading(true); setFailedRefresh(false);
    try {
      const response = await fetch("/api/health?public=1", { cache: "no-store", signal: controller.signal });
      const body: unknown = await response.json();
      if (current.current !== controller) return;
      if (controller.signal.aborted) throw new Error("The public status read did not finish.");
      const parsed = parsePublicHealth(response.status, body);
      if (parsed.status === "unavailable") { setFailedRefresh(true); setHealth((previous) => previous ?? parsed); }
      else setHealth(parsed);
    } catch {
      if (current.current === controller) { setFailedRefresh(true); setHealth((previous) => previous ?? { status: "unavailable" }); }
    } finally {
      window.clearTimeout(timer);
      if (current.current === controller) { current.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    let start: number | undefined;
    const schedule = () => { start = window.setTimeout(() => void load(), 0); };
    if (document.readyState === "complete") schedule(); else window.addEventListener("load", schedule, { once: true });
    return () => { window.removeEventListener("load", schedule); window.clearTimeout(start); current.current?.abort(); current.current = null; };
  }, [load]);
  const status = health?.status ?? "checking";
  return <div className={styles.health} data-testid="public-health" data-status={status}>
    <div className={styles.healthLine}><p role="status" aria-live="polite">{failedRefresh && health?.status !== "unavailable" ? "Last reported public health" : "Public health snapshot"}: <strong>{labels[status]}</strong>{loading && health ? " · Refreshing…" : ""}</p>
      <button type="button" className={styles.button} disabled={loading} onClick={() => void load()}>{loading ? "Checking status…" : "Refresh status"}</button></div>
    {health?.checkedAt ? <p className={styles.support}>Reported <time dateTime={health.checkedAt}>{health.checkedAt}</time></p> : null}
    <p className={styles.support}>{failedRefresh ? "The latest status could not be confirmed. Refresh to try again." : "A public status snapshot; individual workflows and connected services may have a different state."}</p>
  </div>;
}
