"use client";

import { clsx } from "clsx";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Coins,
  DatabaseZap,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { TruthfulIntegrationsOverview } from "@/lib/connectors/truthful-overview";
import styles from "./integrations-workspace.module.css";

const OVERVIEW_VERSION = "p11.7-truthful-integrations:1";

export function IntegrationTruthPanel() {
  const [overview, setOverview] = useState<TruthfulIntegrationsOverview>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setState("loading");
    setError(undefined);
    try {
      setOverview(await fetchIntegrationOverview());
      setState("ready");
    } catch (loadError) {
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Integration access could not be loaded.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchIntegrationOverview().then((loaded) => {
      if (!active) return;
      setOverview(loaded);
      setState("ready");
    }).catch((loadError: unknown) => {
      if (!active) return;
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Integration access could not be loaded.");
    });
    return () => { active = false; };
  }, []);

  const unavailableSources = overview
    ? Object.entries(overview.inventory).filter(([, source]) => source.state === "unavailable")
    : [];

  return (
    <section className={styles.truthPanel} aria-labelledby="integration-truth-title" aria-busy={state === "loading"}>
      <header className={styles.truthHeader}>
        <div>
          <p>Live access truth</p>
          <h1 id="integration-truth-title">What Asael can access and do now</h1>
          <span>Installed systems come from owner-scoped grants and reviewed contracts. Catalog ideas never count as connected.</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={state === "loading"}>
          {state === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          Refresh truth
        </button>
      </header>

      {state === "error" ? (
        <div className={styles.truthError} role="alert">
          <AlertTriangle size={17} aria-hidden="true" />
          <div><strong>Access truth is unavailable</strong><span>{error}</span></div>
          <button type="button" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {overview ? (
        <>
          <div className={styles.truthSummary} aria-label="Integration status summary">
            <SummaryStat label="Installed" value={overview.summary.installed} icon={DatabaseZap} />
            <SummaryStat label="Working" value={overview.summary.working} icon={CheckCircle2} tone="working" />
            <SummaryStat label="Degraded" value={overview.summary.degraded} icon={Clock3} tone="degraded" />
            <SummaryStat label="Needs action" value={overview.summary.actionRequired} icon={AlertTriangle} tone="attention" />
            <SummaryStat label="Not installed" value={overview.summary.suggestions} icon={Unplug} />
          </div>

          <div className={styles.inventoryStrip} aria-label="Integration inventory sources">
            {Object.entries(overview.inventory).map(([name, source]) => (
              <span key={name} className={clsx(source.state === "ready" ? styles.inventoryReady : styles.inventoryUnavailable)} title={source.detail}>
                {source.state === "ready" ? <CheckCircle2 size={12} aria-hidden="true" /> : <CircleHelp size={12} aria-hidden="true" />}
                {inventoryLabel(name)} · {source.state === "ready" ? "Current" : "Unavailable"}
              </span>
            ))}
          </div>

          {unavailableSources.length ? (
            <div className={styles.partialNotice} role="status">
              <CircleHelp size={16} aria-hidden="true" />
              <p><strong>Partial view.</strong> {unavailableSources.map(([, source]) => source.detail).join(" ")}</p>
            </div>
          ) : null}

          <section className={styles.installedSection} aria-labelledby="installed-integrations-title">
            <div className={styles.sectionHeading}>
              <div><p>Installed</p><h2 id="installed-integrations-title">Connected and retained systems</h2></div>
              <span>{overview.installed.length} verified records</span>
            </div>
            {overview.installed.length ? (
              <div className={styles.integrationGrid}>
                {overview.installed.map((integration) => (
                  <article key={integration.id} className={clsx(styles.integrationCard, styles[`state_${integration.state}`])}>
                    <header>
                      <div>
                        <p>{adapterLabel(integration.adapter)} · {integration.installation === "installed" ? "Installed" : "Retained read-only"}</p>
                        <h3>{integration.name}</h3>
                      </div>
                      <StatusPill state={integration.state} />
                    </header>

                    <div className={styles.factGrid}>
                      <Fact icon={ShieldCheck} label="Access" value={permissionLabel(integration.permissions.mode)} />
                      <Fact icon={DatabaseZap} label="Operations" value={`${integration.permissions.activeOperations} active · ${integration.permissions.pendingReviewOperations} pending`} />
                      <Fact icon={RefreshCw} label="Sync" value={syncLabel(integration.sync.status)} />
                      <Fact icon={Clock3} label="Freshness" value={freshnessLabel(integration.sync.freshness)} />
                      <Fact icon={KeyRound} label="Cursor" value={cursorLabel(integration.sync.cursor.state)} />
                      <Fact icon={Coins} label="30-day cost" value={costLabel(integration.cost)} />
                    </div>

                    <div className={styles.coverageBlock}>
                      <span>Coverage · {coverageLabel(integration.sync.coverage)}</span>
                      <p>{integration.sync.coverageDetail}</p>
                      <small>{integration.sync.cursor.detail}</small>
                    </div>

                    <div className={styles.permissionBlock}>
                      <div>
                        <span>Granted</span>
                        <p>{integration.permissions.granted.length ? integration.permissions.granted.join(" · ") : "No active access is verified."}</p>
                      </div>
                      {integration.permissions.missing.length ? (
                        <div className={styles.missingPermissions}>
                          <span>Missing or unresolved</span>
                          <p>{integration.permissions.missing.join(" · ")}</p>
                        </div>
                      ) : null}
                    </div>

                    {integration.failure.state !== "none" ? (
                      <div className={styles.failureBlock} role={integration.failure.state === "present" ? "alert" : "status"}>
                        <AlertTriangle size={14} aria-hidden="true" />
                        <p><strong>{integration.failure.message}</strong><span>{integration.failure.recovery}</span></p>
                      </div>
                    ) : null}

                    <footer>
                      <p><strong>Next:</strong> {integration.nextAction}</p>
                      <Link href={integration.manageHref}>Manage <ArrowRight size={13} aria-hidden="true" /></Link>
                    </footer>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.emptyTruth}>No installed integration record is visible. Unavailable inventories remain unknown, not disconnected.</div>
            )}
          </section>

          <section className={styles.suggestionsSection} aria-labelledby="integration-suggestions-title">
            <div className={styles.sectionHeading}>
              <div><p>Not installed</p><h2 id="integration-suggestions-title">Catalog suggestions</h2></div>
              <span>Suggestions cannot access data or run tools</span>
            </div>
            <div className={styles.suggestionGrid}>
              {overview.suggestions.map((suggestion) => (
                <article key={suggestion.id}>
                  <header><div><p>{adapterLabel(suggestion.adapter)}</p><h3>{suggestion.name}</h3></div><span>{suggestionLabel(suggestion.state)}</span></header>
                  <p>{suggestion.detail}</p>
                  <small>{suggestion.capabilities.join(" · ")}</small>
                </article>
              ))}
            </div>
          </section>

          <p className={styles.disclosureNote}>Costs show only usage that Asael can attribute from recorded receipts. Unknown never means free, and no recorded activity never means a zero provider subscription bill.</p>
        </>
      ) : state === "loading" ? (
        <div className={styles.truthLoading} role="status"><Loader2 size={20} className="animate-spin" aria-hidden="true" /> Reading grants, contracts, sync checkpoints, and cost receipts…</div>
      ) : null}
    </section>
  );
}

function SummaryStat({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof DatabaseZap; tone?: "working" | "degraded" | "attention" }) {
  return <div className={clsx(styles.summaryStat, tone && styles[`summary_${tone}`])}><Icon size={15} aria-hidden="true" /><span><strong>{value}</strong><small>{label}</small></span></div>;
}

function Fact({ icon: Icon, label, value }: { icon: typeof DatabaseZap; label: string; value: string }) {
  return <div><Icon size={13} aria-hidden="true" /><span><small>{label}</small><strong>{value}</strong></span></div>;
}

function StatusPill({ state }: { state: TruthfulIntegrationsOverview["installed"][number]["state"] }) {
  const label = ({ working: "Working", degraded: "Degraded", action_required: "Action required", unavailable: "Unavailable" })[state];
  return <span className={clsx(styles.statusPill, styles[`pill_${state}`])}>{label}</span>;
}

function permissionLabel(mode: TruthfulIntegrationsOverview["installed"][number]["permissions"]["mode"]) {
  return ({ no_access: "No access", read_only: "Read only", read_write: "Read + write", write_approval_required: "Writes need approval", unclassified: "Read/write unresolved" })[mode];
}

function syncLabel(state: TruthfulIntegrationsOverview["installed"][number]["sync"]["status"]) {
  return ({ not_applicable: "Not a sync source", not_started: "Not started", syncing: "In progress", current: "Current", stale: "Stale", partial: "Partial", error: "Failed", unavailable: "Unavailable" })[state];
}

function cursorLabel(state: TruthfulIntegrationsOverview["installed"][number]["sync"]["cursor"]["state"]) {
  return ({ not_applicable: "Not applicable", not_started: "Not started", advancing: "Advancing", checkpointed: "Checkpointed", unknown: "Unknown", unavailable: "Owner-only" })[state];
}

function coverageLabel(state: TruthfulIntegrationsOverview["installed"][number]["sync"]["coverage"]) {
  return ({ not_applicable: "Not applicable", none: "None", partial: "Partial", complete: "Complete", unknown: "Unknown" })[state];
}

function freshnessLabel(freshness: TruthfulIntegrationsOverview["installed"][number]["sync"]["freshness"]) {
  if (freshness.state === "not_applicable") return "Not applicable";
  if (freshness.state === "never") return "Never verified";
  if (freshness.state === "unavailable" || freshness.ageSeconds === null) return "Unavailable";
  return `${freshness.state === "stale" ? "Stale" : "Current"} · ${formatAge(freshness.ageSeconds)}`;
}

function costLabel(cost: TruthfulIntegrationsOverview["installed"][number]["cost"]) {
  if (cost.state === "unavailable") return "Unavailable";
  if (cost.state === "unknown") return "Unknown";
  if (cost.state === "no_recorded_activity") return "No recorded usage";
  const value = (cost.knownEstimatedCostMicrousd || 0) / 1_000_000;
  return `${cost.state === "partial" ? "Partial · " : ""}$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function adapterLabel(adapter: "native" | "mcp" | "openapi") {
  return adapter === "mcp" ? "MCP" : adapter === "openapi" ? "OpenAPI" : "Native";
}

function suggestionLabel(state: TruthfulIntegrationsOverview["suggestions"][number]["state"]) {
  return ({ setup_available: "Setup available", credentials_required: "Credentials required", configuration_required: "App setup required", planned: "Planned", availability_unknown: "Install status unknown" })[state];
}

function inventoryLabel(value: string) {
  return ({ oauth: "OAuth", mcp: "MCP", openapi: "OpenAPI", salesforce: "Salesforce", usage: "Cost ledger" } as Record<string, string>)[value] || value;
}

async function fetchIntegrationOverview() {
  const response = await fetch("/api/integrations/overview", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as {
    overview?: TruthfulIntegrationsOverview;
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error || "Integration access could not be loaded.");
  if (payload.overview?.version !== OVERVIEW_VERSION ||
      !Array.isArray(payload.overview.installed) ||
      !Array.isArray(payload.overview.suggestions)) {
    throw new Error("Integration access returned an unsupported contract.");
  }
  return payload.overview;
}
