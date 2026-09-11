"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  ChartCandlestick,
  Check,
  ChevronRight,
  CircleDashed,
  Clock3,
  Database,
  Gauge,
  History,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PriceChart } from "@/components/market-research/price-chart";
import {
  MARKET_INTERVALS,
  type MarketBarsResult,
  type MarketEventBaselinesResult,
  type MarketEventsResult,
  type MarketEventReplaysResult,
  type MarketForecastHorizon,
  type MarketForecastJournalResult,
  type MarketInstrument,
  type MarketInstrumentId,
  type MarketInterval,
  type MarketResearchOverview,
  type MarketTechnicalFeaturesResult,
} from "@/lib/market-research/contracts";
import styles from "@/components/market-research/market-research-workspace.module.css";

type WorkspaceTab = "overview" | "events" | "technicals" | "journal";

type MarketBackfillJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: Record<string, unknown>;
  lastError?: string;
};

const tabs: Array<{ id: WorkspaceTab; label: string; description: string }> = [
  { id: "overview", label: "Research desk", description: "Live context and readiness" },
  { id: "events", label: "News impact lab", description: "High-impact release replay" },
  { id: "technicals", label: "ICT + Quarterly", description: "Deterministic structure" },
  { id: "journal", label: "Forecast journal", description: "Frozen predictions and scoring" },
];

export function MarketResearchWorkspace() {
  const [overview, setOverview] = useState<MarketResearchOverview>();
  const [selectedId, setSelectedId] = useState<MarketInstrumentId>("xauusd.spot");
  const [interval, setInterval] = useState<MarketInterval>("15min");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [bars, setBars] = useState<MarketBarsResult>();
  const [events, setEvents] = useState<MarketEventsResult>();
  const [replays, setReplays] = useState<MarketEventReplaysResult>();
  const [baselines, setBaselines] = useState<MarketEventBaselinesResult>();
  const [backfillJob, setBackfillJob] = useState<MarketBackfillJob>();
  const [replayJob, setReplayJob] = useState<MarketBackfillJob>();
  const [features, setFeatures] = useState<MarketTechnicalFeaturesResult>();
  const [loading, setLoading] = useState(true);
  const [barsLoading, setBarsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [barsError, setBarsError] = useState<string>();
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string>();
  const [replaysLoading, setReplaysLoading] = useState(false);
  const [replayError, setReplayError] = useState<string>();
  const [baselinesLoading, setBaselinesLoading] = useState(false);
  const [baselinesError, setBaselinesError] = useState<string>();
  const [featuresLoading, setFeaturesLoading] = useState(false);
  const [featuresError, setFeaturesError] = useState<string>();
  const [journal, setJournal] = useState<MarketForecastJournalResult>();
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalError, setJournalError] = useState<string>();
  const [journalAction, setJournalAction] = useState<MarketForecastHorizon | "score">();

  const loadOverview = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/market-research", {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketResearchOverview & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market research could not load.");
      setOverview(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Market research could not load.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadOverview(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadOverview]);

  const selected = useMemo(() => overview?.instruments.find((instrument) =>
    instrument.instrumentId === selectedId
  ), [overview, selectedId]);
  const marketProviderReady = selected?.providerMapping.provider
    ? overview?.providers.find((provider) =>
        provider.provider === selected.providerMapping.provider
      )?.configured === true
    : false;

  const loadBars = useCallback(async (
    instrument: MarketInstrument,
    requestedInterval: MarketInterval,
    signal?: AbortSignal,
  ) => {
    if (!marketProviderReady || instrument.providerMapping.status !== "verified") {
      setBars(undefined);
      setBarsError(undefined);
      return;
    }
    setBarsLoading(true);
    setBarsError(undefined);
    try {
      const query = new URLSearchParams({
        instrumentId: instrument.instrumentId,
        interval: requestedInterval,
        outputSize: "480",
      });
      const response = await fetch(`/api/market-research/bars?${query}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketBarsResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market bars could not load.");
      setBars(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setBars(undefined);
      setBarsError(loadError instanceof Error ? loadError.message : "Market bars could not load.");
    } finally {
      if (!signal?.aborted) setBarsLoading(false);
    }
  }, [marketProviderReady]);

  const loadEvents = useCallback(async (signal?: AbortSignal) => {
    setEventsLoading(true);
    setEventsError(undefined);
    try {
      const response = await fetch("/api/market-research/events?limit=100", {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketEventsResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market event history could not load.");
      setEvents(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setEventsError(loadError instanceof Error ? loadError.message : "Market event history could not load.");
    } finally {
      if (!signal?.aborted) setEventsLoading(false);
    }
  }, []);

  const loadReplays = useCallback(async (
    instrumentId: MarketInstrumentId,
    signal?: AbortSignal,
  ) => {
    setReplaysLoading(true);
    setReplayError(undefined);
    try {
      const query = new URLSearchParams({ instrumentId, limit: "100" });
      const response = await fetch(`/api/market-research/replays?${query}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketEventReplaysResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market replays could not load.");
      setReplays(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setReplayError(loadError instanceof Error ? loadError.message : "Market replays could not load.");
    } finally {
      if (!signal?.aborted) setReplaysLoading(false);
    }
  }, []);

  const loadFeatures = useCallback(async (
    snapshotId: string,
    signal?: AbortSignal,
  ) => {
    setFeaturesLoading(true);
    setFeaturesError(undefined);
    try {
      const query = new URLSearchParams({ snapshotId });
      const response = await fetch(`/api/market-research/features?${query}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketTechnicalFeaturesResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Technical features could not load.");
      setFeatures(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setFeatures(undefined);
      setFeaturesError(loadError instanceof Error ? loadError.message : "Technical features could not load.");
    } finally {
      if (!signal?.aborted) setFeaturesLoading(false);
    }
  }, []);

  const loadBaselines = useCallback(async (
    instrumentId: MarketInstrumentId,
    signal?: AbortSignal,
  ) => {
    setBaselinesLoading(true);
    setBaselinesError(undefined);
    try {
      const query = new URLSearchParams({
        instrumentId,
        minimumSampleSize: "20",
      });
      const response = await fetch(`/api/market-research/baselines?${query}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketEventBaselinesResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Comparable-event baselines could not load.");
      setBaselines(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setBaselines(undefined);
      setBaselinesError(loadError instanceof Error ? loadError.message : "Comparable-event baselines could not load.");
    } finally {
      if (!signal?.aborted) setBaselinesLoading(false);
    }
  }, []);

  const loadJournal = useCallback(async (
    instrumentId: MarketInstrumentId,
    signal?: AbortSignal,
  ) => {
    setJournalLoading(true);
    setJournalError(undefined);
    try {
      const query = new URLSearchParams({ instrumentId, limit: "40" });
      const response = await fetch(`/api/market-research/journal?${query}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketForecastJournalResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Forecast journal could not load.");
      setJournal(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setJournal(undefined);
      setJournalError(loadError instanceof Error ? loadError.message : "Forecast journal could not load.");
    } finally {
      if (!signal?.aborted) setJournalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== "events" || events) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadEvents(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, events, loadEvents]);

  useEffect(() => {
    if (activeTab !== "events") return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void Promise.all([
        loadReplays(selectedId, controller.signal),
        loadBaselines(selectedId, controller.signal),
      ]),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, loadBaselines, loadReplays, selectedId]);

  const startEventBackfill = useCallback(async () => {
    setEventsError(undefined);
    try {
      const response = await fetch("/api/market-research/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `market-events-${Date.now()}`,
        },
        body: JSON.stringify({
          startDate: "2000-01-01",
          endDate: new Date().toISOString().slice(0, 10),
        }),
      });
      const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error || "Market event history could not be queued.");
      }
      setBackfillJob(payload.job);
    } catch (queueError) {
      setEventsError(queueError instanceof Error ? queueError.message : "Market event history could not be queued.");
    }
  }, []);

  const startReplayBackfill = useCallback(async () => {
    setReplayError(undefined);
    try {
      const response = await fetch("/api/market-research/replays", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `market-replays-${selectedId}-${Date.now()}`,
        },
        body: JSON.stringify({
          instrumentId: selectedId,
          interval: "5min",
          startDate: "2000-01-01",
          endDate: new Date().toISOString().slice(0, 10),
          maxEvents: 12,
        }),
      });
      const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error || "Market replay backfill could not be queued.");
      }
      setReplayJob(payload.job);
    } catch (queueError) {
      setReplayError(queueError instanceof Error ? queueError.message : "Market replay backfill could not be queued.");
    }
  }, [selectedId]);

  useEffect(() => {
    if (!backfillJob || !["queued", "running"].includes(backfillJob.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/operations/jobs/${backfillJob.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
        if (!response.ok || !payload.job) throw new Error(payload.error || "Import progress is unavailable.");
        setBackfillJob(payload.job);
        if (payload.job.status === "completed") {
          setEvents(undefined);
          await loadEvents(controller.signal);
        } else if (payload.job.status === "failed") {
          setEventsError(payload.job.lastError || "Historical event import did not complete.");
        }
      } catch (pollError) {
        if (pollError instanceof DOMException && pollError.name === "AbortError") return;
        setEventsError(pollError instanceof Error ? pollError.message : "Import progress is unavailable.");
      }
    }, 2_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [backfillJob, loadEvents]);

  useEffect(() => {
    if (!replayJob || !["queued", "running"].includes(replayJob.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/operations/jobs/${replayJob.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
        if (!response.ok || !payload.job) throw new Error(payload.error || "Replay progress is unavailable.");
        setReplayJob(payload.job);
        if (payload.job.status === "completed") {
          await Promise.all([
            loadReplays(selectedId, controller.signal),
            loadBaselines(selectedId, controller.signal),
          ]);
        } else if (payload.job.status === "failed") {
          setReplayError(payload.job.lastError || "Market replay backfill did not complete.");
        }
      } catch (pollError) {
        if (pollError instanceof DOMException && pollError.name === "AbortError") return;
        setReplayError(pollError instanceof Error ? pollError.message : "Replay progress is unavailable.");
      }
    }, 2_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadBaselines, loadReplays, replayJob, selectedId]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadBars(selected, interval, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [interval, loadBars, selected]);

  useEffect(() => {
    if (activeTab !== "technicals" || !bars?.snapshotId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadFeatures(bars.snapshotId, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, bars?.snapshotId, loadFeatures]);

  useEffect(() => {
    if (activeTab !== "journal") return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadJournal(selectedId, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, loadJournal, selectedId]);

  const generateForecast = useCallback(async (horizon: MarketForecastHorizon) => {
    setJournalAction(horizon);
    setJournalError(undefined);
    try {
      const response = await fetch("/api/market-research/journal/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `market-forecast-${selectedId}-${horizon}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ instrumentId: selectedId, horizon }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Market scenario could not be generated.");
      await loadJournal(selectedId);
    } catch (actionError) {
      setJournalError(actionError instanceof Error ? actionError.message : "Market scenario could not be generated.");
    } finally {
      setJournalAction(undefined);
    }
  }, [loadJournal, selectedId]);

  const scoreDueForecasts = useCallback(async () => {
    setJournalAction("score");
    setJournalError(undefined);
    try {
      const response = await fetch("/api/market-research/journal/score", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `market-forecast-score-${selectedId}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ instrumentId: selectedId, maxForecasts: 2 }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Due scenarios could not be scored.");
      await loadJournal(selectedId);
    } catch (actionError) {
      setJournalError(actionError instanceof Error ? actionError.message : "Due scenarios could not be scored.");
    } finally {
      setJournalAction(undefined);
    }
  }, [loadJournal, selectedId]);

  return (
    <main className={styles.shell}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Market intelligence · research only</p>
          <h1>Trading Market News</h1>
          <p>Macro event intelligence, evidence-bound price scenarios, and pure ICT + Quarterly Theory structure for intraday research.</p>
        </div>
        <div className={styles.heroStatus} data-ready={overview?.phase !== "configuration_required"}>
          <span><i /> {phaseLabel(overview?.phase, loading)}</span>
          <small>{formatClock(overview?.generatedAt)}</small>
        </div>
      </header>

      {error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" onClick={() => void loadOverview()}><RefreshCw size={14} /> Retry</button>
        </div>
      ) : null}

      <section className={styles.commandBar} aria-label="Market selection">
        <div className={styles.instruments}>
          {(overview?.instruments || []).map((instrument) => (
            <button
              key={instrument.instrumentId}
              type="button"
              className={instrument.instrumentId === selectedId ? styles.instrumentActive : styles.instrument}
              onClick={() => setSelectedId(instrument.instrumentId)}
              aria-pressed={instrument.instrumentId === selectedId}
            >
              <span>{instrument.shortLabel}</span>
              <small>{instrumentTypeLabel(instrument)}</small>
              <i data-state={instrument.providerMapping.status} />
            </button>
          ))}
          {loading ? <InstrumentSkeleton /> : null}
        </div>
        <div className={styles.quickState}>
          <span><Clock3 size={14} /> {bars?.asOf ? `Bars to ${formatTime(bars.asOf)}` : "No live snapshot"}</span>
          <span><ShieldCheck size={14} /> No trade execution</span>
        </div>
      </section>

      <nav className={styles.tabs} aria-label="Market research views">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab(tab.id)}
            aria-current={activeTab === tab.id ? "page" : undefined}
          >
            <span>{tab.label}</span>
            <small>{tab.description}</small>
          </button>
        ))}
      </nav>

      {selected ? (
        <>
          <ResearchDesk
            hidden={activeTab !== "overview"}
            instrument={selected}
            overview={overview}
            events={events}
            bars={bars}
            barsLoading={barsLoading}
            barsError={barsError}
            interval={interval}
            onIntervalChange={setInterval}
          />
          {activeTab === "events" ? (
            <NewsImpactLab
              instrument={selected}
              overview={overview}
              events={events}
              loading={eventsLoading}
              error={eventsError}
              backfillJob={backfillJob}
              replays={replays}
              baselines={baselines}
              replaysLoading={replaysLoading}
              baselinesLoading={baselinesLoading}
              replayError={replayError}
              baselinesError={baselinesError}
              replayJob={replayJob}
              onBackfill={startEventBackfill}
              onReplayBackfill={startReplayBackfill}
            />
          ) : null}
          {activeTab === "technicals" ? (
            <TechnicalLab
              instrument={selected}
              overview={overview}
              bars={bars}
              features={features}
              loading={featuresLoading || barsLoading}
              error={featuresError || barsError}
            />
          ) : null}
          {activeTab === "journal" ? (
            <ForecastJournal
              instrument={selected}
              overview={overview}
              journal={journal}
              loading={journalLoading}
              error={journalError}
              action={journalAction}
              onGenerate={generateForecast}
              onScore={scoreDueForecasts}
            />
          ) : null}
        </>
      ) : loading ? <WorkspaceSkeleton /> : null}
    </main>
  );
}

function ResearchDesk({
  hidden,
  instrument,
  overview,
  events,
  bars,
  barsLoading,
  barsError,
  interval,
  onIntervalChange,
}: {
  hidden: boolean;
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  events?: MarketEventsResult;
  bars?: MarketBarsResult;
  barsLoading: boolean;
  barsError?: string;
  interval: MarketInterval;
  onIntervalChange: (interval: MarketInterval) => void;
}) {
  const latest = bars?.bars.at(-1);
  const previous = bars?.bars.at(-2);
  const change = latest && previous ? latest.close - previous.close : undefined;
  const changePercent = change !== undefined && previous?.close
    ? change / previous.close * 100
    : undefined;
  const provider = overview?.providers.find((item) =>
    item.provider === instrument.providerMapping.provider
  );
  const hasMatchingBars = Boolean(
    bars?.bars.length && bars.instrumentId === instrument.instrumentId,
  );

  return (
    <section className={styles.workspace} hidden={hidden}>
      <div className={styles.primaryPlane}>
        <div className={styles.instrumentHeader}>
          <div>
            <p className={styles.eyebrow}>Canonical research instrument</p>
            <h2>{instrument.label}</h2>
            <p>{instrument.identityWarning}</p>
          </div>
          <div className={styles.priceReadout}>
            <strong>{latest ? formatPrice(latest.close, instrument.instrumentId) : "—"}</strong>
            <span data-direction={change === undefined ? "flat" : change >= 0 ? "up" : "down"}>
              {changePercent === undefined ? "Awaiting verified bars" : `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}% · last bar`}
            </span>
          </div>
        </div>

        <div className={styles.metricStrip}>
          <Metric label="Daily probability" value="Not scored" detail="Calibration required" />
          <Metric label="Weekly probability" value="Not scored" detail="Calibration required" />
          <Metric label="High-impact releases" value={events ? String(events.total) : "Open lab"} detail="Official history" />
          <Metric label="ICT confluence" value="Not run" detail="Detector foundation" />
        </div>

        <div className={styles.chartPanel}>
          <header>
            <div>
              <span><ChartCandlestick size={16} /> Provider-labelled price context</span>
              <small>{bars ? `${bars.providerSymbol} · ${bars.providerTimezone} · ${bars.bars.length} bars · ${bars.snapshotSource === "cache" ? "reused" : "new"} snapshot ${bars.snapshotSha256.slice(0, 10)}` : "No proxy data is shown"}</small>
            </div>
            <div className={styles.intervalPicker} aria-label="Chart interval">
              {MARKET_INTERVALS.map((item) => (
                <button key={item} type="button" aria-pressed={item === interval} onClick={() => onIntervalChange(item)}>{item}</button>
              ))}
            </div>
          </header>
          <div className={styles.chartBody}>
            {hasMatchingBars && bars ? (
              <PriceChart instrument={instrument} bars={bars} />
            ) : barsLoading ? <ChartLoading /> : (
              <ChartEmpty
                mappingRequired={instrument.providerMapping.status === "discovery_required"}
                providerReady={provider?.configured === true}
                error={barsError}
              />
            )}
            {barsLoading && hasMatchingBars ? (
              <div className={styles.chartUpdating} aria-live="polite">
                <RefreshCw className={styles.spin} size={13} /> Loading evidence-bound {interval} bars
              </div>
            ) : null}
          </div>
          <footer>
            <span>Advanced Charts v32.2.0 · scroll to zoom · drag to pan · drawing tools at left</span>
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
          </footer>
        </div>
      </div>

      <aside className={styles.analysisRail}>
        <section className={styles.agentBrief}>
          <header>
            <div className={styles.agentMark}><Bot size={22} /><i /></div>
            <div><p>Assigned analyst</p><h2>Meridian</h2></div>
            <span data-ready={overview?.agent.configured === true}>{overview?.agent.configured ? "Ready" : "Setup"}</span>
          </header>
          <div className={styles.agentModel}>
            <small>Model route</small>
            <strong>{overview?.agent.configured ? `${overview.agent.provider} / ${overview.agent.model}` : "Market research assignment required"}</strong>
            <p>{overview?.agent.note || "Checking the validated model route."}</p>
          </div>
          <div className={styles.thesisEmpty}>
            <Sparkles size={18} />
            <strong>No scenario generated</strong>
            <p>Meridian will only publish a directional probability after the price snapshot, economic releases, deterministic features, and calibration evidence are all bound to the same as-of time.</p>
          </div>
          <Link href="/app/settings" className={styles.textLink}>Configure model routing <ArrowRight size={14} /></Link>
        </section>

        <section className={styles.providerPanel}>
          <header><span><Database size={16} /> Research inputs</span><small>{overview?.providers.filter((item) => item.configured).length || 0}/{overview?.providers.length || 3} connected</small></header>
          <div>
            {(overview?.providers || []).map((item) => (
              <article key={item.provider}>
                <i data-ready={item.configured}>{item.configured ? <Check size={12} /> : <CircleDashed size={12} />}</i>
                <span><strong>{item.label}</strong><small>{item.purpose}</small></span>
                <em>{item.configured ? "Configured" : item.blocking ? "Required" : "Recommended"}</em>
              </article>
            ))}
          </div>
        </section>
      </aside>
    </section>
  );
}

function NewsImpactLab({
  instrument,
  overview,
  events,
  loading,
  error,
  backfillJob,
  replays,
  baselines,
  replaysLoading,
  baselinesLoading,
  replayError,
  baselinesError,
  replayJob,
  onBackfill,
  onReplayBackfill,
}: {
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  events?: MarketEventsResult;
  loading: boolean;
  error?: string;
  backfillJob?: MarketBackfillJob;
  replays?: MarketEventReplaysResult;
  baselines?: MarketEventBaselinesResult;
  replaysLoading: boolean;
  baselinesLoading: boolean;
  replayError?: string;
  baselinesError?: string;
  replayJob?: MarketBackfillJob;
  onBackfill: () => void;
  onReplayBackfill: () => void;
}) {
  const calendar = overview?.providers.find((provider) => provider.provider === "bls");
  const vintage = overview?.providers.find((provider) => provider.provider === "fred");
  const importing = backfillJob && ["queued", "running"].includes(backfillJob.status);
  const completedSources = numberProgress(backfillJob?.progress?.completedSources);
  const totalSources = numberProgress(backfillJob?.progress?.totalSources);
  const replaying = replayJob && ["queued", "running"].includes(replayJob.status);
  const completedEvents = numberProgress(replayJob?.progress?.completedEvents);
  const totalEvents = numberProgress(replayJob?.progress?.totalEvents);
  const replayByEventId = new Map((replays?.replays || []).map((replay) => [replay.eventId, replay]));
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Event study · {instrument.shortLabel}</p><h2>News impact lab</h2><p>Replay high-impact releases against immutable pre- and post-event windows, then compare the observed move with the surprise, revision, liquidity regime, and ICT context.</p></div>
        <div className={styles.labActions}>
          <div className={styles.labReadiness}><span data-ready={calendar?.configured}><i /> Official calendars</span><span data-ready={vintage?.configured}><i /> FRED history</span></div>
          <div className={styles.labButtons}>
            <button type="button" onClick={onBackfill} disabled={Boolean(importing) || vintage?.configured !== true}>
              <History size={15} />
              {importing ? `Importing ${completedSources}/${totalSources || 8}` : events?.total ? "Refresh history" : "Import history"}
            </button>
            <button type="button" onClick={onReplayBackfill} disabled={Boolean(replaying) || instrument.providerMapping.status !== "verified" || !events?.total}>
              <ChartCandlestick size={15} />
              {replaying ? `Replaying ${completedEvents}/${totalEvents || 12}` : replays?.remainingEvents ? "Build next 12 replays" : "Replays current"}
            </button>
          </div>
        </div>
      </header>
      <div className={styles.pipeline}>
        {[
          ["01", "Normalize", "Provider events → high impact"],
          ["02", "Freeze", "Initial-release FRED vintage"],
          ["03", "Measure", "Pre/post return + volatility"],
          ["04", "Explain", "Macro + ICT evidence"],
          ["05", "Calibrate", "Comparable-event outcomes"],
        ].map(([number, title, detail]) => <article key={number}><span>{number}</span><strong>{title}</strong><small>{detail}</small><ChevronRight size={15} /></article>)}
      </div>

      <section className={styles.baselinePanel}>
        <header>
          <div><strong>Comparable-event baseline</strong><span>Historical outcomes grouped by exact release family</span></div>
          <small>{baselines ? `${baselines.includedReplays} immutable windows · gate ${baselines.minimumSampleSize}/event` : "Descriptive only"}</small>
        </header>
        {baselinesError ? <div className={styles.tableNotice} role="alert"><AlertTriangle size={17} /><span>{baselinesError}</span></div> : null}
        {baselinesLoading ? <div className={styles.replayLoading}><RefreshCw className={styles.spin} size={13} /> Computing deterministic distributions…</div> : null}
        {baselines?.groups.length ? <div className={styles.baselineGrid}>
          {baselines.groups.map((baseline) => (
            <article key={baseline.eventKey} data-ready={baseline.state === "descriptive_baseline"}>
              <div className={styles.baselineTitle}>
                <span><strong>{eventKeyLabel(baseline.eventKey)}</strong><small>{baseline.eventKey}</small></span>
                <em>{baseline.sampleSize} events</em>
              </div>
              <div className={styles.directionBar} aria-label={`${Math.round(baseline.empiricalRates.up * 100)} percent up, ${Math.round(baseline.empiricalRates.down * 100)} percent down`}>
                <i style={{ width: `${baseline.empiricalRates.up * 100}%` }} />
                <b style={{ width: `${baseline.empiricalRates.down * 100}%` }} />
              </div>
              <div className={styles.baselineStats}>
                <span><small>60m median</small><strong>{baseline.post60m.medianBps === null ? "—" : formatSignedBps(baseline.post60m.medianBps)}</strong></span>
                <span><small>Middle 50%</small><strong>{formatBaselineRange(baseline.post60m.lowerQuartileBps, baseline.post60m.upperQuartileBps)}</strong></span>
                <span><small>Observed split</small><strong>{Math.round(baseline.empiricalRates.up * 100)}% up · {Math.round(baseline.empiricalRates.down * 100)}% down</strong></span>
              </div>
              <p>{baseline.state === "descriptive_baseline" ? "Descriptive sample gate reached; not a forecast probability." : `${baselines.minimumSampleSize - baseline.sampleSize} more windows needed for the descriptive gate.`}</p>
            </article>
          ))}
        </div> : !baselinesLoading ? <div className={styles.baselineEmpty}>Build immutable event windows to populate comparable release families.</div> : null}
        <footer>These are outcome distributions, not calibrated predictions. They do not condition on surprise, macro regime, session structure, or transcript-reviewed ICT context.</footer>
      </section>

      <div className={styles.eventTable}>
        <header><span>Historical high-impact releases</span><small>{events?.total ? `${events.total} official dates · ${replays?.replayedEvents || 0}/${replays?.eligibleEvents || 0} ${instrument.shortLabel} windows` : "FRED/ALFRED · owner-private · asynchronous"}</small></header>
        <div className={styles.tableHead}><span>Release</span><span>Date</span><span>Precision</span><span>Values</span><span>Observed move</span><span>Source</span></div>
        {error ? <div className={styles.tableNotice} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
        {replayError ? <div className={styles.tableNotice} role="alert"><AlertTriangle size={17} /><span>{replayError}</span></div> : null}
        {replaysLoading ? <div className={styles.replayLoading}><RefreshCw className={styles.spin} size={13} /> Loading immutable price windows…</div> : null}
        {loading ? <div className={styles.tableEmpty}><RefreshCw className={styles.spin} size={24} /><strong>Loading event history</strong></div> : events?.events.length ? (
          <div className={styles.eventRows}>
            {events.events.map((event) => {
              const replay = replayByEventId.get(event.id);
              return <article key={event.id}>
                <span><strong>{event.name}</strong><small>{event.eventKey}</small></span>
                <time dateTime={event.occurredAt || event.releaseDate}>
                  {formatEventDate(event.releaseDate)}
                  {event.occurredAt ? <small>{formatEventTime(event.occurredAt)}</small> : null}
                </time>
                <em data-warning={event.timestampPrecision === "date"}>{event.timestampPrecision === "date" ? "Date only" : "Exact time"}</em>
                <span>
                  <strong>{event.observations[0] ? formatMacroObservation(event.observations[0]) : "Pending"}</strong>
                  <small>{event.observations[1] ? formatMacroObservation(event.observations[1]) : event.consensus === null ? "No free official consensus" : `Consensus ${event.consensus}`}</small>
                </span>
                <span className={styles.replayMove} data-direction={replay?.direction}>
                  <strong>{replay?.post60m ? `${formatSignedBps(replay.post60m.returnBps)} · 60m` : event.occurredAt ? "Window pending" : "Needs exact time"}</strong>
                  <small>{replay?.post5m ? `${formatSignedBps(replay.post5m.returnBps)} at 5m · ${replay.post60mRangeBps?.toFixed(1) || "—"} bps range` : "No price outcome yet"}</small>
                </span>
                <span>
                  <a href={event.sourceUrl} target="_blank" rel="noreferrer">FRED <ArrowRight size={12} /></a>
                  {event.scheduleSourceUrl ? <a href={event.scheduleSourceUrl} target="_blank" rel="noreferrer">{scheduleSourceLabel(event.scheduleSource)} time <ArrowRight size={12} /></a> : null}
                </span>
              </article>;
            })}
          </div>
        ) : (
          <div className={styles.tableEmpty}><CalendarClock size={24} /><strong>No event history imported yet</strong><p>Import the free official FRED release history in the background. Exact intraday impact remains locked until an authoritative release timestamp and corresponding price window are available.</p></div>
        )}
        <footer className={styles.eventDisclosure}>Values are immutable initial-release FRED vintages, labeled in their source units. Official free sources do not provide a complete historical survey-consensus archive, so Asael keeps consensus empty instead of scraping an unlicensed value or inventing a surprise.</footer>
      </div>
    </section>
  );
}

function numberProgress(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatSignedBps(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} bps`;
}

function formatBaselineRange(lower: number | null, upper: number | null) {
  if (lower === null || upper === null) return "—";
  return `${formatSignedBps(lower)} to ${formatSignedBps(upper)}`;
}

function eventKeyLabel(eventKey: string) {
  const labels: Record<string, string> = {
    "us.cpi": "Consumer prices",
    "us.ppi": "Producer prices",
    "us.employment_situation": "Employment",
    "us.jolts": "JOLTS",
    "us.retail_sales": "Retail sales",
    "us.gdp": "GDP",
    "us.personal_income_outlays": "Income & outlays",
    "us.fomc": "FOMC decision",
  };
  return labels[eventKey] || eventKey;
}

function scheduleSourceLabel(source: MarketEventsResult["events"][number]["scheduleSource"]) {
  switch (source) {
    case "bls": return "BLS";
    case "census": return "Census";
    case "bea": return "BEA";
    case "federal_reserve": return "Federal Reserve";
    default: return "Official";
  }
}

function formatMacroObservation(
  observation: MarketEventsResult["events"][number]["observations"][number],
) {
  const value = new Intl.NumberFormat("en", {
    maximumFractionDigits: observation.unit === "percent" ? 2 : 3,
  }).format(observation.value);
  const suffix = observation.unit === "percent"
    ? "%"
    : observation.unit === "thousands"
      ? "k"
      : observation.unit === "millions"
        ? "m"
        : observation.unit === "billions"
          ? "bn"
          : "";
  return `${observation.label} ${value}${suffix}`;
}

function formatEventDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatEventTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function TechnicalLab({
  instrument,
  overview,
  bars,
  features,
  loading,
  error,
}: {
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  bars?: MarketBarsResult;
  features?: MarketTechnicalFeaturesResult;
  loading: boolean;
  error?: string;
}) {
  const detectorState = overview?.engineTracks.find((track) => track.id === "ict_detectors")?.state;
  const current = features?.snapshot.id === bars?.snapshotId ? features : undefined;
  const recentDetections = current?.detections.slice(0, 16) || [];
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Deterministic structure · {instrument.shortLabel}</p><h2>ICT + Quarterly engine</h2><p>Reproducible market-structure primitives run against one immutable price snapshot. Transcript-specific ICT rules stay separate until their exact definitions and source timecodes are reviewed.</p></div>
        <span className={styles.stateBadge} data-state={detectorState}>{current ? "Reproducible v1" : detectorState === "foundation" ? "Loading foundation" : "Waiting for bars"}</span>
      </header>

      {error ? <div className={styles.technicalNotice} role="alert"><AlertTriangle size={18} /><span>{error}</span></div> : null}
      {loading && !current ? <div className={styles.technicalLoading}><RefreshCw className={styles.spin} size={20} /><strong>Running deterministic features</strong><span>Reading the exact immutable snapshot; no model call is involved.</span></div> : null}
      {!loading && !current && !error ? <div className={styles.technicalLoading}><ChartCandlestick size={20} /><strong>No verified snapshot</strong><span>Load provider-labelled bars in the Research desk to run this engine.</span></div> : null}

      {current ? (
        <>
          <div className={styles.technicalReceipt}>
            <span><ShieldCheck size={15} /> Snapshot <strong>{current.snapshot.sha256.slice(0, 12)}</strong></span>
            <span>{current.detectorVersion}</span>
            <span>{current.snapshot.barCount} × {current.snapshot.interval} bars</span>
            <span>As of {formatTime(current.snapshot.asOf)}</span>
            <span>Result <strong>{current.resultSha256.slice(0, 12)}</strong></span>
          </div>

          <div className={styles.technicalSummary}>
            <article><small>Dealing range</small><strong>{current.range.zone}</strong><span>{current.range.positionPercent.toFixed(1)}% of last {current.range.lookbackBars} bars</span></article>
            <article><small>90-minute quarter</small><strong>Q{current.timeContext.ninetyMinuteQuarter}</strong><span>{sessionLabel(current.timeContext.session)} · {current.timeContext.localTime} ET</span></article>
            <article><small>Active price gaps</small><strong>{current.counts.activeFairValueGaps}</strong><span>Three-bar foundation definition</span></article>
            <article><small>Sweeps / displacement</small><strong>{current.counts.liquiditySweeps} / {current.counts.displacements}</strong><span>Within this exact snapshot</span></article>
          </div>

          <div className={styles.referenceStrip}>
            {current.timeContext.references.map((reference) => (
              <article key={reference.id} data-available={reference.status === "available"}>
                <small>{reference.label}</small>
                <strong>{reference.open === null ? "Outside snapshot" : formatPrice(reference.open, instrument.instrumentId)}</strong>
                <span>{reference.period}</span>
              </article>
            ))}
          </div>

          <div className={styles.technicalPanels}>
            <section className={styles.detectionPanel}>
              <header><div><strong>Latest detected structure</strong><span>{current.detections.length} bounded observations</span></div><small>Newest first</small></header>
              {recentDetections.length ? <div className={styles.detectionRows}>
                {recentDetections.map((detection) => (
                  <article key={detection.id} data-direction={detection.direction}>
                    <i />
                    <span><strong>{detectionLabel(detection.kind)}</strong><small>{detection.direction} · {detection.state}</small></span>
                    <time dateTime={detection.timestamp}>{formatFeatureTime(detection.timestamp)}</time>
                    <span><strong>{formatPrice(detection.price, instrument.instrumentId)}</strong><small>{detection.zoneLow !== null && detection.zoneHigh !== null ? `${formatPrice(detection.zoneLow, instrument.instrumentId)}–${formatPrice(detection.zoneHigh, instrument.instrumentId)}` : `strength ${detection.strength.toFixed(2)}`}</small></span>
                  </article>
                ))}
              </div> : <div className={styles.detectionEmpty}>No feature crossed its frozen threshold in this snapshot.</div>}
            </section>

            <section className={styles.definitionPanel}>
              <header><strong>Frozen definitions</strong><small>Deterministic foundation</small></header>
              <div>
                {current.definitions.map((definition, index) => (
                  <article key={definition.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{definition.label}</strong><p>{definition.formula}</p><small>{definition.id}</small></div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </>
      ) : null}

      <div className={styles.boundaryNote}><ShieldCheck size={18} /><div><strong>Transcript evidence boundary</strong><p>Each detected feature will cite the reviewed concept definition and transcript chunk that supports it. Transcript claims do not become executable rules until their definition is explicit and testable.</p></div></div>
    </section>
  );
}

function detectionLabel(kind: MarketTechnicalFeaturesResult["detections"][number]["kind"]) {
  switch (kind) {
    case "swing_high": return "Swing high";
    case "swing_low": return "Swing low";
    case "fair_value_gap": return "Price gap";
    case "displacement": return "Displacement";
    case "liquidity_sweep": return "Boundary sweep";
  }
}

function sessionLabel(session: MarketTechnicalFeaturesResult["timeContext"]["session"]) {
  switch (session) {
    case "asia_evening": return "Asia evening";
    case "london_open": return "London open";
    case "new_york_am": return "New York AM";
    case "new_york_pm": return "New York PM";
    case "off_hours": return "Off hours";
  }
}

function formatFeatureTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function ForecastJournal({
  instrument,
  overview,
  journal,
  loading,
  error,
  action,
  onGenerate,
  onScore,
}: {
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  journal?: MarketForecastJournalResult;
  loading: boolean;
  error?: string;
  action?: MarketForecastHorizon | "score";
  onGenerate: (horizon: MarketForecastHorizon) => void;
  onScore: () => void;
}) {
  const forecast = overview?.engineTracks.find((track) => track.id === "scenario_forecast");
  const ready = forecast?.state === "foundation";
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Forward shadow · {instrument.shortLabel}</p><h2>Forecast journal</h2><p>Daily and weekly scenarios are frozen before the trading window, then scored after expiry. Misses, invalidations, and abstentions remain visible.</p></div>
        <span className={styles.stateBadge} data-state={forecast?.state}>{ready ? "Active foundation" : "Blocked by setup"}</span>
      </header>
      <div className={styles.journalActions}>
        <div>
          <strong>Seal the next research window</strong>
          <p>Meridian uses the configured model and exact immutable evidence. Repeated requests for the same window reuse its first sealed result.</p>
        </div>
        <span>
          <button type="button" disabled={!ready || Boolean(action)} onClick={() => onGenerate("daily")}>
            {action === "daily" ? <RefreshCw className={styles.spin} size={14} /> : <Sparkles size={14} />} Daily scenario
          </button>
          <button type="button" disabled={!ready || Boolean(action)} onClick={() => onGenerate("weekly")}>
            {action === "weekly" ? <RefreshCw className={styles.spin} size={14} /> : <CalendarClock size={14} />} Weekly scenario
          </button>
          <button type="button" disabled={!journal?.scorecard.due || Boolean(action)} onClick={onScore}>
            {action === "score" ? <RefreshCw className={styles.spin} size={14} /> : <Gauge size={14} />} Score due
          </button>
        </span>
      </div>
      {error ? <div className={styles.inlineError} role="alert"><AlertTriangle size={15} />{error}</div> : null}
      <div className={styles.journalLayout}>
        <div className={styles.scoreFrame}>
          <header><span><Gauge size={17} /> Forward scorecard</span><small>{journal?.scorecard.resolved || 0} resolved · {journal?.scorecard.due || 0} due</small></header>
          <div>
            <Metric label="Directional accuracy" value={formatRatio(journal?.scorecard.directionalAccuracy)} detail={`${journal?.scorecard.directionalSampleSize || 0} directional calls`} />
            <Metric label="Brier score" value="Withheld" detail="No calibrated probabilities" />
            <Metric label="Coverage" value={formatRatio(journal?.scorecard.coverage)} detail="Resolved, excluding abstentions" />
          </div>
        </div>
        <div className={styles.journalProtocol}>
          <ShieldCheck size={22} />
          <strong>Hindsight-resistant by construction</strong>
          <p>The scenario body, evidence digests, Settings assignment revision, and model usage receipt are sealed together. Outcomes are appended separately.</p>
          <span>Uncalibrated · research only</span>
        </div>
      </div>
      <div className={styles.forecastList} aria-busy={loading}>
        {loading && !journal ? <div className={styles.journalEmpty}><RefreshCw className={styles.spin} size={24} /><strong>Reading sealed scenarios</strong><p>The journal remains usable while chart and news panels load independently.</p></div> : null}
        {!loading && !journal?.entries.length ? <div className={styles.journalEmpty}><History size={26} /><strong>No frozen forecasts yet</strong><p>Create the next daily or weekly research window. The first result is permanent and cannot be rewritten after seeing the outcome.</p></div> : null}
        {(journal?.entries || []).map((entry) => (
          <article className={styles.forecastCard} key={entry.forecast.id} data-stance={entry.forecast.stance}>
            <header>
              <div>
                <span>{entry.forecast.horizon} · {entry.resolutionState}</span>
                <strong>{entry.forecast.stance === "abstain" ? "Abstain" : `${entry.forecast.stance} lead`}</strong>
                <small>{formatForecastWindow(entry.forecast.windowStart, entry.forecast.windowEnd)}</small>
              </div>
              <em>{entry.forecast.evidenceStrength} evidence</em>
            </header>
            <p className={styles.forecastSummary}>{entry.forecast.summary}</p>
            <div className={styles.scenarioGrid}>
              {entry.forecast.scenarios.map((scenario) => (
                <section key={scenario.direction} data-direction={scenario.direction}>
                  <span>#{scenario.rank} · {scenario.direction}</span>
                  <p>{scenario.thesis}</p>
                  <small>{scenario.observationZone ? `Observe ${formatPrice(scenario.observationZone.low, instrument.instrumentId)}–${formatPrice(scenario.observationZone.high, instrument.instrumentId)}` : "No justified observation zone"}</small>
                </section>
              ))}
            </div>
            <footer>
              <span><ShieldCheck size={13} /> Sealed {formatFeatureTime(entry.forecast.sealedAt)}</span>
              <span>{entry.outcome ? `${entry.outcome.actualDirection} · ${formatSignedBps(entry.outcome.returnBps)}` : entry.resolutionState === "due" ? "Outcome ready to score" : "Window has not closed"}</span>
              <span>{entry.forecast.evidence.baselineReplayCount} event windows · {entry.forecast.evidence.baselineQualifiedGroups} qualified groups</span>
            </footer>
          </article>
        ))}
      </div>
      <div className={styles.guardrailList}>
        {(overview?.guardrails || []).map((guardrail) => <p key={guardrail}><Check size={14} />{guardrail}</p>)}
      </div>
    </section>
  );
}

function formatRatio(value?: number | null) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 1_000) / 10}%`;
}

function formatForecastWindow(start: string, end: string) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${formatter.format(new Date(start))} → ${formatter.format(new Date(end))}`;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className={styles.metric}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

function ChartEmpty({ mappingRequired, providerReady, error }: { mappingRequired: boolean; providerReady: boolean; error?: string }) {
  return (
    <div className={styles.chartEmpty}>
      {error ? <AlertTriangle size={25} /> : mappingRequired ? <Waypoints size={25} /> : <Activity size={25} />}
      <strong>{error ? "Price feed unavailable" : mappingRequired ? "Exact feed mapping required" : providerReady ? "Waiting for provider bars" : "Connect the market-data feed"}</strong>
      <p>{error || (mappingRequired
        ? "Choose the exact broker CFD, cash index, or futures contract before this instrument can be charted or backtested."
        : providerReady
          ? "The provider is configured; refresh the page if the feed remains empty."
          : "Connect the instrument's named market-data feed. No sample prices or proxy instruments are substituted.")}</p>
    </div>
  );
}

function ChartLoading() {
  return <div className={styles.chartLoading}><RefreshCw size={18} className={styles.spin} /><span>Loading the provider snapshot…</span></div>;
}

function InstrumentSkeleton() {
  return <div className={styles.instrumentSkeleton}><i /><span /></div>;
}

function WorkspaceSkeleton() {
  return <section className={styles.workspaceSkeleton}><div /><div /></section>;
}

function phaseLabel(phase: MarketResearchOverview["phase"] | undefined, loading: boolean) {
  if (loading) return "Checking research systems";
  if (phase === "ready_for_historical_replay") return "Historical replay ready";
  if (phase === "ready_for_live_research") return "Live research ready";
  return "Configuration required";
}

function formatClock(value?: string) {
  if (!value) return "Provider and model readiness";
  return `Checked ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value))}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}

function formatPrice(value: number, instrumentId: MarketInstrumentId) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: instrumentId === "xauusd.spot" ? 2 : 1,
    maximumFractionDigits: instrumentId === "xauusd.spot" ? 2 : 1,
  }).format(value);
}

function instrumentTypeLabel(instrument: MarketInstrument) {
  return ({
    commodity_spot: "Spot reference",
    equity_index: "Cash benchmark",
    equity: "Listed stock",
    etf: "Exchange-traded fund",
    future: "Futures contract",
    cfd: "Research CFD",
  } as const)[instrument.assetClass];
}
