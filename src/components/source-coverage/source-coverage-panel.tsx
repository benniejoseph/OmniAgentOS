"use client";

import { clsx } from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Database,
  EyeOff,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type {
  SourceCoverageDomain,
  SourceCoverageProjection,
} from "@/lib/sources/coverage";
import styles from "./source-coverage-panel.module.css";

const COVERAGE_VERSION = "p11.9-source-coverage:1";

export function SourceCoveragePanel({
  surface = "integrations",
}: {
  surface?: "today" | "memory" | "integrations";
}) {
  const [coverage, setCoverage] = useState<SourceCoverageProjection>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setState("loading");
    setError(undefined);
    try {
      setCoverage(await fetchSourceCoverage());
      setState("ready");
    } catch (loadError) {
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Coverage could not be loaded.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchSourceCoverage().then((loaded) => {
      if (!active) return;
      setCoverage(loaded);
      setState("ready");
    }).catch((loadError: unknown) => {
      if (!active) return;
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Coverage could not be loaded.");
    });
    return () => { active = false; };
  }, []);

  const supported = coverage?.domains.filter((domain) => domain.availability !== "unsupported") || [];
  const unsupported = coverage?.domains.filter((domain) => domain.availability === "unsupported") || [];

  return (
    <section
      className={clsx(styles.panel, styles[`surface_${surface}`])}
      aria-labelledby={`source-coverage-title-${surface}`}
      aria-busy={state === "loading"}
    >
      <header className={styles.header}>
        <div>
          <p>Knowledge coverage</p>
          <h2 id={`source-coverage-title-${surface}`}>What Asael knows—and where it is blind</h2>
          <span>Coverage is proven from source checkpoints. Missing access always stays unknown; it never becomes a negative fact.</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={state === "loading"}>
          {state === "loading" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          Refresh coverage
        </button>
      </header>

      {state === "error" ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div><strong>Coverage is unavailable</strong><span>{error}</span></div>
          <button type="button" onClick={() => void load()}>Retry</button>
        </div>
      ) : null}

      {coverage ? (
        <>
          <div className={styles.summary} aria-label="Source coverage summary">
            <Metric icon={Database} label="Connected domains" value={coverage.summary.connectedDomains} />
            <Metric icon={CheckCircle2} label="Complete coverage" value={coverage.summary.completeDomains} tone="good" />
            <Metric icon={Clock3} label="Stale sources" value={coverage.summary.staleDomains} tone={coverage.summary.staleDomains ? "warn" : "good"} />
            <Metric icon={EyeOff} label="Blind spots" value={coverage.summary.blindSpots} tone="warn" />
            <Metric icon={CircleHelp} label="Unknown states" value={coverage.summary.unknownDomains} />
            <div className={styles.verifiedMetric}>
              <ShieldCheck size={14} aria-hidden="true" />
              <span><strong>{formatTimestamp(coverage.summary.lastVerifiedAt)}</strong><small>Last verified</small></span>
            </div>
          </div>

          {coverage.state === "partial" ? (
            <div className={styles.partial} role="status">
              <CircleHelp size={15} aria-hidden="true" />
              <p><strong>Partial inventory.</strong> A failed dependency remains unavailable; no missing, empty, or disconnected state was inferred.</p>
            </div>
          ) : null}

          <div className={styles.indexStatus} data-state={coverage.knowledgeIndex.state}>
            <div>
              <span>Knowledge index</span>
              <strong>{label(coverage.knowledgeIndex.state)}</strong>
            </div>
            <p>{coverage.knowledgeIndex.detail}</p>
            <small>
              {coverage.knowledgeIndex.sourceItems === null
                ? "Counts unavailable"
                : `${coverage.knowledgeIndex.indexedDocuments}/${coverage.knowledgeIndex.sourceItems} documents · ${coverage.knowledgeIndex.embeddedChunks}/${coverage.knowledgeIndex.chunks} embedded chunks`}
            </small>
          </div>

          <section className={styles.domains} aria-label="Supported source domains">
            {supported.map((domain) => <DomainCard key={domain.id} domain={domain} />)}
          </section>

          <details className={styles.blindSpots}>
            <summary>
              <span><EyeOff size={15} aria-hidden="true" /><strong>{unsupported.length} unsupported data domains</strong></span>
              <small>Explicit blind spots · expand to review</small>
            </summary>
            <div>
              {unsupported.map((domain) => (
                <article key={domain.id}>
                  <strong>{domain.label}</strong>
                  <p>{domain.limitation}</p>
                </article>
              ))}
            </div>
          </details>

          <p className={styles.disclosure}>No provider content, raw cursors, credentials, or actor identifiers are included in this view.</p>
        </>
      ) : state === "loading" ? (
        <div className={styles.loading} role="status">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          Reading source checkpoints and actor-owned index receipts…
        </div>
      ) : null}
    </section>
  );
}

function DomainCard({ domain }: { domain: SourceCoverageDomain }) {
  const tone = domain.availability === "unavailable" || domain.freshness.state === "unknown"
    ? "unknown"
    : domain.freshness.state === "stale" || domain.coverage.state === "partial"
      ? "warn"
      : domain.coverage.state === "complete"
        ? "good"
        : "neutral";
  return (
    <article className={styles.domainCard} data-tone={tone}>
      <header>
        <div><p>{availabilityLabel(domain.availability)}</p><h3>{domain.label}</h3></div>
        <span>{coverageLabel(domain.coverage.state)}</span>
      </header>
      <dl>
        <div><dt>Backfill</dt><dd>{label(domain.backfill.state)}</dd></div>
        <div><dt>Freshness</dt><dd>{freshnessLabel(domain.freshness)}</dd></div>
        <div><dt>Observed</dt><dd>{domain.coverage.observedItems === null ? "Unknown" : domain.coverage.observedItems.toLocaleString()}</dd></div>
      </dl>
      <p>{domain.coverage.detail}</p>
      <small>{domain.limitation}</small>
      <footer>
        {domain.blindSpot ? <span><EyeOff size={12} aria-hidden="true" /> Blind spot</span> : <span><CheckCircle2 size={12} aria-hidden="true" /> Checkpoint proved</span>}
        {domain.nextAction.href ? <Link href={domain.nextAction.href}>{domain.nextAction.label}</Link> : <em>{domain.nextAction.label}</em>}
      </footer>
    </article>
  );
}

function Metric({
  icon: Icon,
  label: metricLabel,
  value,
  tone = "neutral",
}: {
  icon: typeof Database;
  label: string;
  value: number;
  tone?: "neutral" | "good" | "warn";
}) {
  return <div className={styles.metric} data-tone={tone}><Icon size={14} aria-hidden="true" /><span><strong>{value}</strong><small>{metricLabel}</small></span></div>;
}

async function fetchSourceCoverage(): Promise<SourceCoverageProjection> {
  const response = await fetch("/api/source-coverage", { cache: "no-store" });
  const payload = await response.json() as { coverage?: SourceCoverageProjection; error?: string };
  if (!response.ok) throw new Error(payload.error || "Source coverage is temporarily unavailable.");
  if (!payload.coverage || payload.coverage.version !== COVERAGE_VERSION || !Array.isArray(payload.coverage.domains)) {
    throw new Error("Source coverage returned an unsupported contract.");
  }
  return payload.coverage;
}

function freshnessLabel(freshness: SourceCoverageDomain["freshness"]) {
  if (freshness.state === "current") return `Current · ${formatTimestamp(freshness.lastVerifiedAt)}`;
  if (freshness.state === "stale") return `Stale · ${formatTimestamp(freshness.lastVerifiedAt)}`;
  if (freshness.state === "never") return "Never verified";
  if (freshness.state === "not_applicable") return "Not applicable";
  return freshness.lastVerifiedAt ? `Unknown · last verified ${formatTimestamp(freshness.lastVerifiedAt)}` : "Unknown";
}

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function availabilityLabel(value: SourceCoverageDomain["availability"]) {
  return ({
    connected: "Connected source",
    native: "Native source",
    available_not_connected: "Available · not connected",
    unsupported: "Unsupported",
    unavailable: "Inventory unavailable",
  })[value];
}

function coverageLabel(value: SourceCoverageDomain["coverage"]["state"]) {
  return ({
    complete: "Complete",
    partial: "Partial",
    none: "No submitted items",
    not_applicable: "On selection",
    unknown: "Unknown",
  })[value];
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
