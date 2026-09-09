"use client";

import { clsx } from "clsx";
import {
  AlertTriangle,
  ArrowRight,
  Braces,
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  Cloud,
  Coins,
  DatabaseZap,
  HardDrive,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Mail,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import type { TruthfulIntegrationsOverview } from "@/lib/connectors/truthful-overview";
import styles from "./integrations-workspace.module.css";

const OVERVIEW_VERSION = "p11.7-truthful-integrations:1";

type InstalledIntegration = TruthfulIntegrationsOverview["installed"][number];

export function IntegrationTruthPanel({ children }: { children?: ReactNode }) {
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
  const googleIntegrations = overview?.installed.filter((integration) => integration.kind === "google_service") || [];
  const otherIntegrations = overview?.installed.filter((integration) => integration.kind !== "google_service") || [];

  return (
    <>
      <section className={styles.truthPanel} aria-labelledby="connected-systems-title" aria-busy={state === "loading"}>
        <header className={styles.truthHeader}>
          <div>
            <h2 id="connected-systems-title">Connected systems</h2>
            <p>Only installed, owner-scoped records appear here. Catalog ideas never count as connected.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={state === "loading"}>
            {state === "loading" ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            Refresh status
          </button>
        </header>

        {state === "error" ? (
          <div className={styles.truthError} role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <div><strong>Connection status is unavailable</strong><span>{error}</span></div>
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        ) : null}

        {overview ? (
          <>
            <div className={styles.truthSummary} aria-label="Integration status summary">
              <SummaryStat label="Connected" description="Installed records" value={overview.summary.installed} icon={DatabaseZap} />
              <SummaryStat label="Working" description="Ready to use" value={overview.summary.working} icon={CheckCircle2} tone="working" />
              <SummaryStat label="Syncing or partial" description="Still becoming current" value={overview.summary.degraded} icon={RefreshCw} tone="degraded" />
              <SummaryStat label="Needs attention" description="A decision or fix is required" value={overview.summary.actionRequired} icon={AlertTriangle} tone="attention" />
              <SummaryStat label="Available" description="Not connected yet" value={overview.summary.suggestions} icon={Unplug} />
            </div>

            {unavailableSources.length ? (
              <div className={styles.partialNotice} role="status">
                <CircleHelp size={17} aria-hidden="true" />
                <p><strong>This view is partial.</strong> {unavailableSources.map(([, source]) => source.detail).join(" ")}</p>
              </div>
            ) : null}

            <div className={styles.systemList}>
              {googleIntegrations.length ? (
                <ConnectedSystem
                  title="Google Workspace"
                  description="Gmail, Calendar, Drive, and selected Photos use one Google connection. Each source keeps its own sync proof."
                  integrations={googleIntegrations}
                  manageHref="#personal-sources"
                />
              ) : null}

              {otherIntegrations.map((integration) => (
                <ConnectedSystem
                  key={integration.id}
                  title={integration.name}
                  description={systemDescription(integration)}
                  integrations={[integration]}
                  manageHref={managementHref(integration)}
                />
              ))}

              {!overview.installed.length ? (
                <div className={styles.emptyTruth}>
                  <Unplug size={20} aria-hidden="true" />
                  <div><strong>No connected systems are visible</strong><span>If an inventory source is unavailable, its connections remain unknown rather than being shown as disconnected.</span></div>
                </div>
              ) : null}
            </div>

            <details className={styles.inventoryDetails}>
              <summary>
                <span><ShieldCheck size={15} aria-hidden="true" />How this status is verified</span>
                <small>{unavailableSources.length ? `${unavailableSources.length} source${unavailableSources.length === 1 ? "" : "s"} unavailable` : "All inventory sources responded"}</small>
              </summary>
              <div className={styles.inventoryStrip} aria-label="Integration inventory sources">
                {Object.entries(overview.inventory).map(([name, source]) => (
                  <span key={name} className={source.state === "ready" ? styles.inventoryReady : styles.inventoryUnavailable} title={source.detail}>
                    {source.state === "ready" ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleHelp size={13} aria-hidden="true" />}
                    <strong>{inventoryLabel(name)}</strong>
                    <small>{source.state === "ready" ? "Current" : "Unavailable"}</small>
                  </span>
                ))}
              </div>
            </details>
          </>
        ) : state === "loading" ? (
          <div className={styles.truthLoading} role="status">
            <Loader2 size={20} className="animate-spin" aria-hidden="true" />
            Checking connections, permissions, sync progress, and recorded usage…
          </div>
        ) : null}
      </section>

      {children}

      {overview ? (
        <section className={styles.availableSection} aria-labelledby="available-integrations-title">
          <header className={styles.sectionHeading}>
            <div>
              <h2 id="available-integrations-title">Available integrations</h2>
              <p>These are options you can add. They cannot read data or run tools until setup is complete.</p>
            </div>
            <span>{overview.suggestions.length} options</span>
          </header>
          {overview.suggestions.length ? (
            <div className={styles.suggestionList}>
              {overview.suggestions.map((suggestion) => (
                <article key={suggestion.id}>
                  <div>
                    <span>{adapterLabel(suggestion.adapter)}</span>
                    <h3>{suggestion.name}</h3>
                    <p>{suggestion.detail}</p>
                  </div>
                  <div className={styles.suggestionMeta}>
                    <strong>{suggestionLabel(suggestion.state)}</strong>
                    <small>{suggestion.capabilities.join(" · ")}</small>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.emptyTruth}>No additional integrations are available in the catalog.</div>
          )}
          <p className={styles.disclosureNote}>Costs come only from recorded usage receipts. Unknown never means free, and no recorded activity does not mean a provider subscription costs zero.</p>
        </section>
      ) : null}
    </>
  );
}

function ConnectedSystem({
  title,
  description,
  integrations,
  manageHref,
}: {
  title: string;
  description: string;
  integrations: InstalledIntegration[];
  manageHref: string;
}) {
  const status = combinedState(integrations);
  return (
    <article className={styles.connectedSystem}>
      <header className={styles.systemHeader}>
        <div className={styles.systemIdentity}>
          <span><SystemIcon integration={integrations.every((integration) => integration.kind === "google_service") ? undefined : integrations[0]} /></span>
          <div><h3>{title}</h3><p>{description}</p></div>
        </div>
        <div className={styles.systemActions}>
          <StatusPill state={status} />
          <Link href={manageHref}>Manage system <ArrowRight size={14} aria-hidden="true" /></Link>
        </div>
      </header>
      <ul className={styles.sourceList}>
        {integrations.map((integration) => <IntegrationSourceRow key={integration.id} integration={integration} />)}
      </ul>
    </article>
  );
}

function IntegrationSourceRow({ integration }: { integration: InstalledIntegration }) {
  const needsAttention = integration.failure.state !== "none" || integration.state === "action_required";
  return (
    <li className={styles.sourceRow}>
      <div className={styles.sourceIdentity}>
        <span><SystemIcon integration={integration} /></span>
        <div>
          <strong>{integration.name}</strong>
          <small>{needsAttention ? integration.failure.message : integration.nextAction}</small>
        </div>
      </div>
      <dl className={styles.sourceFacts}>
        <div><dt>Access</dt><dd>{permissionLabel(integration.permissions.mode)}</dd></div>
        <div><dt>Sync</dt><dd>{syncLabel(integration.sync.status)}</dd></div>
        <div><dt>Coverage</dt><dd>{coverageLabel(integration.sync.coverage)}</dd></div>
        <div><dt>Last verified</dt><dd>{freshnessLabel(integration.sync.freshness)}</dd></div>
      </dl>
      <details className={styles.technicalDetails}>
        <summary>Technical details</summary>
        <dl>
          <div><dt><KeyRound size={13} aria-hidden="true" />Sync checkpoint</dt><dd>{cursorLabel(integration.sync.cursor.state)}. {integration.sync.cursor.detail}</dd></div>
          <div><dt><DatabaseZap size={13} aria-hidden="true" />Operations</dt><dd>{integration.permissions.activeOperations} active, {integration.permissions.pendingReviewOperations} awaiting review, {integration.permissions.disabledOperations} disabled.</dd></div>
          <div><dt><ShieldCheck size={13} aria-hidden="true" />Granted access</dt><dd>{integration.permissions.granted.length ? integration.permissions.granted.join(" · ") : "No active access has been verified."}</dd></div>
          <div><dt><Coins size={13} aria-hidden="true" />Recorded 30-day cost</dt><dd>{costLabel(integration.cost)}. {integration.cost.detail}</dd></div>
        </dl>
        <p><strong>Coverage:</strong> {integration.sync.coverageDetail}</p>
        {integration.permissions.missing.length ? <p className={styles.missingAccess}><strong>Missing access:</strong> {integration.permissions.missing.join(" · ")}</p> : null}
        {integration.failure.state !== "none" ? <p className={styles.recovery}><strong>How to recover:</strong> {integration.failure.recovery}</p> : null}
      </details>
    </li>
  );
}

function SummaryStat({
  label,
  description,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  description: string;
  value: number;
  icon: typeof DatabaseZap;
  tone?: "working" | "degraded" | "attention";
}) {
  return (
    <div className={clsx(styles.summaryStat, tone && styles[`summary_${tone}`])}>
      <Icon size={17} aria-hidden="true" />
      <span><strong>{value}</strong><span>{label}</span><small>{description}</small></span>
    </div>
  );
}

function StatusPill({ state }: { state: InstalledIntegration["state"] }) {
  const label = ({ working: "Working", degraded: "Syncing or partial", action_required: "Needs attention", unavailable: "Unavailable" })[state];
  return <span className={clsx(styles.statusPill, styles[`pill_${state}`])}><span aria-hidden="true" />{label}</span>;
}

function SystemIcon({ integration }: { integration?: InstalledIntegration }) {
  if (!integration) return <Cloud size={17} aria-hidden="true" />;
  if (integration.kind === "mcp") return <ServerCog size={17} aria-hidden="true" />;
  if (integration.kind === "openapi") return <Braces size={17} aria-hidden="true" />;
  if (integration.name.toLowerCase().includes("gmail")) return <Mail size={17} aria-hidden="true" />;
  if (integration.name.toLowerCase().includes("calendar")) return <CalendarDays size={17} aria-hidden="true" />;
  if (integration.name.toLowerCase().includes("drive")) return <HardDrive size={17} aria-hidden="true" />;
  if (integration.name.toLowerCase().includes("photo")) return <ImageIcon size={17} aria-hidden="true" />;
  return <Cloud size={17} aria-hidden="true" />;
}

function combinedState(integrations: InstalledIntegration[]): InstalledIntegration["state"] {
  const rank: Record<InstalledIntegration["state"], number> = {
    unavailable: 4,
    action_required: 3,
    degraded: 2,
    working: 1,
  };
  return integrations.reduce<InstalledIntegration["state"]>((current, integration) =>
    rank[integration.state] > rank[current] ? integration.state : current, "working");
}

function managementHref(integration: InstalledIntegration) {
  if (integration.kind === "mcp" || integration.kind === "openapi") return "#manage-connections";
  return integration.manageHref;
}

function systemDescription(integration: InstalledIntegration) {
  if (integration.kind === "mcp") return "A reviewed MCP server whose discovered operations run through Asael's tool controls.";
  if (integration.kind === "openapi") return "A REST API imported as reviewed operations with explicit risk and approval rules.";
  if (integration.kind === "salesforce") return "Customer records and activity synchronized from the connected Salesforce organization.";
  return "An owner-connected source available to Asael.";
}

function permissionLabel(mode: InstalledIntegration["permissions"]["mode"]) {
  return ({ no_access: "No access", read_only: "Read only", read_write: "Read and write", write_approval_required: "Writes need approval", unclassified: "Access not classified" })[mode];
}

function syncLabel(syncState: InstalledIntegration["sync"]["status"]) {
  return ({ not_applicable: "No sync needed", not_started: "Not started", syncing: "Syncing", current: "Current", stale: "Out of date", partial: "Partially synced", error: "Sync failed", unavailable: "Not available" })[syncState];
}

function cursorLabel(cursorState: InstalledIntegration["sync"]["cursor"]["state"]) {
  return ({ not_applicable: "Not needed", not_started: "Not started", advancing: "Moving through history", checkpointed: "Saved", unknown: "Not verified", unavailable: "Owner-only" })[cursorState];
}

function coverageLabel(coverageState: InstalledIntegration["sync"]["coverage"]) {
  return ({ not_applicable: "Not needed", none: "Nothing indexed", partial: "Partially indexed", complete: "Complete", unknown: "Not measured" })[coverageState];
}

function freshnessLabel(freshness: InstalledIntegration["sync"]["freshness"]) {
  if (freshness.state === "not_applicable") return "Not needed";
  if (freshness.state === "never") return "Never";
  if (freshness.state === "unavailable" || freshness.ageSeconds === null) return "Not available";
  return `${freshness.state === "stale" ? "Out of date" : "Current"}, ${formatAge(freshness.ageSeconds)}`;
}

function costLabel(cost: InstalledIntegration["cost"]) {
  if (cost.state === "unavailable") return "Not available";
  if (cost.state === "unknown") return "Not measured";
  if (cost.state === "no_recorded_activity") return "No recorded usage";
  const value = (cost.knownEstimatedCostMicrousd || 0) / 1_000_000;
  return `${cost.state === "partial" ? "Partial, " : ""}$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function adapterLabel(adapter: "native" | "mcp" | "openapi") {
  return adapter === "mcp" ? "MCP server" : adapter === "openapi" ? "REST API" : "Built in";
}

function suggestionLabel(suggestionState: TruthfulIntegrationsOverview["suggestions"][number]["state"]) {
  return ({ setup_available: "Ready to set up", credentials_required: "Credentials needed", configuration_required: "App setup needed", planned: "Planned", availability_unknown: "Availability not verified" })[suggestionState];
}

function inventoryLabel(value: string) {
  return ({ oauth: "Personal connections", mcp: "MCP servers", openapi: "REST APIs", salesforce: "Salesforce", usage: "Usage records" } as Record<string, string>)[value] || value;
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
