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
  type MarketEventsResult,
  type MarketEventReplaysResult,
  type MarketInstrument,
  type MarketInstrumentId,
  type MarketInterval,
  type MarketResearchOverview,
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
  const [backfillJob, setBackfillJob] = useState<MarketBackfillJob>();
  const [replayJob, setReplayJob] = useState<MarketBackfillJob>();
  const [loading, setLoading] = useState(true);
  const [barsLoading, setBarsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [barsError, setBarsError] = useState<string>();
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string>();
  const [replaysLoading, setReplaysLoading] = useState(false);
  const [replayError, setReplayError] = useState<string>();

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
      () => void loadReplays(selectedId, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, loadReplays, selectedId]);

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
          await loadReplays(selectedId, controller.signal);
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
  }, [loadReplays, replayJob, selectedId]);

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
          {activeTab === "overview" ? (
            <ResearchDesk
              instrument={selected}
              overview={overview}
              events={events}
              bars={bars}
              barsLoading={barsLoading}
              barsError={barsError}
              interval={interval}
              onIntervalChange={setInterval}
            />
          ) : null}
          {activeTab === "events" ? (
            <NewsImpactLab
              instrument={selected}
              overview={overview}
              events={events}
              loading={eventsLoading}
              error={eventsError}
              backfillJob={backfillJob}
              replays={replays}
              replaysLoading={replaysLoading}
              replayError={replayError}
              replayJob={replayJob}
              onBackfill={startEventBackfill}
              onReplayBackfill={startReplayBackfill}
            />
          ) : null}
          {activeTab === "technicals" ? <TechnicalLab instrument={selected} overview={overview} /> : null}
          {activeTab === "journal" ? <ForecastJournal instrument={selected} overview={overview} /> : null}
        </>
      ) : loading ? <WorkspaceSkeleton /> : null}
    </main>
  );
}

function ResearchDesk({
  instrument,
  overview,
  events,
  bars,
  barsLoading,
  barsError,
  interval,
  onIntervalChange,
}: {
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

  return (
    <section className={styles.workspace}>
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
            {barsLoading ? <ChartLoading /> : bars?.bars.length ? <PriceChart bars={bars.bars} /> : (
              <ChartEmpty
                mappingRequired={instrument.providerMapping.status === "discovery_required"}
                providerReady={provider?.configured === true}
                error={barsError}
              />
            )}
          </div>
          <footer>
            <span>Scroll to zoom · drag to pan · pinch on touch</span>
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
  replaysLoading,
  replayError,
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
  replaysLoading: boolean;
  replayError?: string;
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

function TechnicalLab({ instrument, overview }: { instrument: MarketInstrument; overview?: MarketResearchOverview }) {
  const detectorState = overview?.engineTracks.find((track) => track.id === "ict_detectors")?.state;
  const detectors = [
    ["Quarterly opens", "Yearly, monthly, weekly, daily, 90-minute and session partitions"],
    ["Dealing range", "External/internal liquidity and premium/discount arrays"],
    ["Displacement", "Versioned impulse and market-structure shift conditions"],
    ["FVG / IFVG", "Three-candle imbalance, inversion, mitigation, and invalidation"],
    ["Order blocks", "Strict displacement-linked candidate and mitigation rules"],
    ["Time + session", "Asia, London, New York and macro-release proximity"],
  ];
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Deterministic structure · {instrument.shortLabel}</p><h2>ICT + Quarterly engine</h2><p>Technical evidence is deliberately limited to reviewed Quarterly Theory and core ICT definitions. Generic indicators are not mixed into the signal vocabulary.</p></div>
        <span className={styles.stateBadge} data-state={detectorState}>{detectorState === "foundation" ? "Ready to implement" : "Waiting for bars"}</span>
      </header>
      <div className={styles.detectorGrid}>
        {detectors.map(([title, detail], index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{title}</strong><p>{detail}</p></div><em>Definition pending review</em></article>)}
      </div>
      <div className={styles.boundaryNote}><ShieldCheck size={18} /><div><strong>Transcript evidence boundary</strong><p>Each detected feature will cite the reviewed concept definition and transcript chunk that supports it. Transcript claims do not become executable rules until their definition is explicit and testable.</p></div></div>
    </section>
  );
}

function ForecastJournal({ instrument, overview }: { instrument: MarketInstrument; overview?: MarketResearchOverview }) {
  const forecast = overview?.engineTracks.find((track) => track.id === "scenario_forecast");
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Forward shadow · {instrument.shortLabel}</p><h2>Forecast journal</h2><p>Daily and weekly scenarios are frozen before the trading window, then scored after expiry. Misses, invalidations, and abstentions remain visible.</p></div>
        <span className={styles.stateBadge} data-state={forecast?.state}>{forecast?.state === "planned" ? "Planned" : "Blocked by setup"}</span>
      </header>
      <div className={styles.journalLayout}>
        <div className={styles.scoreFrame}>
          <header><span><Gauge size={17} /> Calibration scorecard</span><small>Minimum evidence gate</small></header>
          <div><Metric label="Directional accuracy" value="—" detail="No resolved forecasts" /><Metric label="Brier score" value="—" detail="Probability calibration" /><Metric label="Coverage" value="—" detail="Abstention-aware" /></div>
        </div>
        <div className={styles.journalEmpty}><History size={26} /><strong>No frozen forecasts</strong><p>The journal starts only after feeds, detector versions, and the Meridian model assignment are active. Past scenarios cannot be rewritten after their cutoff.</p></div>
      </div>
      <div className={styles.guardrailList}>
        {(overview?.guardrails || []).map((guardrail) => <p key={guardrail}><Check size={14} />{guardrail}</p>)}
      </div>
    </section>
  );
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
