"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  ChartCandlestick,
  Check,
  CircleDashed,
  Database,
  Gauge,
  History,
  Layers3,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { createMarketRequestGate, startMarketJobPolling, marketJobActive, marketProgress, mergeMarketJob, parseMarketAnalysisReceipt, parseMarketBacktests, parseMarketBars, parseMarketBaselines, parseMarketCalendar, parseMarketEvents, parseMarketFeatures, parseMarketForecastReceipt, parseMarketJob, parseMarketJournal, parseMarketOverview, parseMarketReplays, parseMarketScoreReceipt, parseMarketVersions, type MarketAnalysisSubmission, type MarketJob } from "./market-research-workspace-state";

import {
  MARKET_INTERVALS,
  type MarketAnalysisVersion,
  type MarketBarsResult,
  type MarketBacktestsResult,
  type MarketAnalysisVersionsResult,
  type MarketEventBaselinesResult,
  type MarketEventsResult,
  type MarketEventReplaysResult,
  type MarketForecastHorizon,
  type MarketForecastJournalResult,
  type MarketInstrument,
  type MarketInstrumentId,
  type MarketInterval,
  type MarketLiveCalendarResult,
  type MarketResearchOverview,
  type MarketTechnicalFeaturesResult,
  type MarketTechnicalLayerId,
} from "@/lib/market-research/contracts";
import styles from "@/components/market-research/market-research-workspace.module.css";

const PriceChart = dynamic(
  () => import("@/components/market-research/price-chart").then(
    (module) => module.PriceChart,
  ),
  { ssr: false, loading: () => <ChartLoading /> },
);

type WorkspaceTab = "overview" | "events" | "technicals" | "backtests" | "journal";

type BacktestConfiguration = {
  direction: "both" | "long_only" | "short_only";
  session: "all" | "london" | "new_york_am";
  rewardRiskRatio: number;
  maxHoldingBars: number;
  spreadBps: number;
  slippageBps: number;
  commissionBps: number;
  riskPerTradeBps: number;
};

type MarketBackfillJob = MarketJob;

const tabs: Array<{ id: WorkspaceTab; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "Live context and readiness" },
  { id: "events", label: "Events", description: "High-impact release replay" },
  { id: "technicals", label: "Technicals", description: "Deterministic structure" },
  { id: "backtests", label: "Backtests", description: "Leakage-safe replay" },
  { id: "journal", label: "Journal", description: "Frozen predictions and scoring" },
];

type MarketReadState<T> = { key: string; data?: T; loading: boolean; stale?: boolean; error?: string };

function useMarketResource<T>(key: string, path: string, parser: (value: unknown) => T, enabled = true) {
  const [gate] = useState(createMarketRequestGate);
  const [state, setState] = useState<MarketReadState<T>>({ key: "", loading: false });
  const parserRef = useRef(parser);
  useLayoutEffect(() => { parserRef.current = parser; }, [parser]);
  useLayoutEffect(() => { gate.mount(); return () => gate.dispose(); }, [gate]);
  const refresh = useCallback(async () => {
    const request = gate.beginRead("source");
    const parse = parserRef.current;
    setState((current) => ({ ...(current.key === key ? current : { key }), loading: true }));
    try {
      const body = await marketJson(path, { signal: request.signal });
      if (!request.current()) return;
      const data = parse(body);
      setState({ key, data, loading: false });
    } catch (failure) {
      if (request.current()) setState((current) => ({ ...current, loading: false, error: marketError(failure) }));
    }
  }, [gate, key, path]);
  useLayoutEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => { window.clearTimeout(timer); gate.abort("source"); };
  }, [enabled, gate, refresh]);
  const markStale = useCallback(() => {
    gate.abort("source");
    setState((current) => current.key === key ? { ...current, loading: false, stale: true } : current);
  }, [gate, key]);
  const current = state.key === key ? state : { key, loading: enabled };
  return { ...current, refresh, markStale };
}

type TrackedMarketJob = { job: MarketJob; label: string; instrumentId?: string; request: unknown; error?: string };
type MarketEffectReceipt = { message: string; target: string; identities: unknown };

export function MarketResearchWorkspace() {
  const { session, status } = useWorkspaceSession();
  const readReason = permissionMessage(session, status, "read");
  if (readReason && (!session || (session.authEnabled && !session.authenticated))) return <section className={styles.shell}><h1>Markets</h1><p role="status">{readReason}</p></section>;
  return <ScopedMarketWorkspace key={JSON.stringify([session?.context?.tenantId, session?.context?.actorId, session?.membership?.role ?? session?.context?.role])} />;
}

function ScopedMarketWorkspace() {
  const { session, status } = useWorkspaceSession();
  const workflowReason = permissionMessage(session, status, "manage.workflow");
  const modelReason = permissionMessage(session, status, "run.agent");
  const [gate] = useState(createMarketRequestGate);
  const [selectedId, setSelectedId] = useState<MarketInstrumentId>("xauusd.spot");
  const [interval, setInterval] = useState<MarketInterval>("15min");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [overviewChartActive, setOverviewChartActive] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [receipt, setReceipt] = useState<MarketEffectReceipt>();
  const [jobs, setJobs] = useState<Record<string, TrackedMarketJob>>({});
  const jobsRef = useRef(jobs);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [layerSelection, setLayerSelection] = useState<{ snapshotId: string; ids: MarketTechnicalLayerId[] }>();
  const overviewRead = useMarketResource("overview", "/api/market-research", parseMarketOverview);
  const overview = overviewRead.data;
  const selected = overview?.instruments.find((item) => item.instrumentId === selectedId) ?? overview?.instruments[0];
  const instrumentId = selected?.instrumentId ?? selectedId;
  const contextKey = `${instrumentId}:${interval}`;
  const providerReady = Boolean(selected?.providerMapping.status === "verified" && overview?.providers.some((item) => item.provider === selected.providerMapping.provider && item.configured));
  const barsRequired = activeTab === "technicals" || activeTab === "backtests" || (activeTab === "overview" && overviewChartActive);
  const barsRead = useMarketResource(contextKey, `/api/market-research/bars?${new URLSearchParams({ instrumentId, interval, outputSize: "480" })}`, (value) => parseMarketBars(value, instrumentId, interval), Boolean(selected && providerReady && barsRequired));
  const bars = barsRead.data;
  const eventsRead = useMarketResource("events", "/api/market-research/events?limit=500", parseMarketEvents, activeTab === "events");
  const calendarRead = useMarketResource("calendar", "/api/market-research/calendar?days=14", parseMarketCalendar, activeTab === "events");
  const replaysRead = useMarketResource(instrumentId, `/api/market-research/replays?${new URLSearchParams({ instrumentId, limit: "100" })}`, (value) => parseMarketReplays(value, instrumentId), activeTab === "events");
  const goldBaselinesRead = useMarketResource("xauusd.spot", "/api/market-research/baselines?instrumentId=xauusd.spot&minimumSampleSize=20", (value) => parseMarketBaselines(value, "xauusd.spot"), activeTab === "events");
  const indexBaselinesRead = useMarketResource("ndx.cash", "/api/market-research/baselines?instrumentId=ndx.cash&minimumSampleSize=20", (value) => parseMarketBaselines(value, "ndx.cash"), activeTab === "events");
  const featuresRead = useMarketResource(bars?.snapshotId ?? contextKey, `/api/market-research/features?${new URLSearchParams({ snapshotId: bars?.snapshotId ?? "" })}`, (value) => { if (!bars) throw new Error("A price snapshot is required."); return parseMarketFeatures(value, bars); }, activeTab === "technicals" && Boolean(bars));
  const versionsRead = useMarketResource(contextKey, `/api/market-research/analysis?${new URLSearchParams({ instrumentId, interval, limit: "8" })}`, (value) => parseMarketVersions(value, instrumentId, interval), activeTab === "technicals" || (activeTab === "overview" && overviewChartActive));
  const backtestsRead = useMarketResource(instrumentId, `/api/market-research/backtests?${new URLSearchParams({ instrumentId, limit: "20" })}`, (value) => parseMarketBacktests(value, instrumentId), activeTab === "backtests");
  const journalRead = useMarketResource(instrumentId, `/api/market-research/journal?${new URLSearchParams({ instrumentId, limit: "40" })}`, (value) => parseMarketJournal(value, instrumentId), activeTab === "journal");
  const visibleTechnicalLayers = layerSelection && layerSelection.snapshotId === featuresRead.data?.snapshot.id ? layerSelection.ids : featuresRead.data?.layers.filter((layer) => layer.defaultVisible).map((layer) => layer.id) ?? [];
  const additionalBaselinesRead = useMarketResource(instrumentId, `/api/market-research/baselines?${new URLSearchParams({ instrumentId, minimumSampleSize: "20" })}`, (value) => parseMarketBaselines(value, instrumentId), activeTab === "events" && !["xauusd.spot", "ndx.cash"].includes(instrumentId));
  const baselinesByInstrument = { "xauusd.spot": goldBaselinesRead.data, "ndx.cash": indexBaselinesRead.data };
  const baselinesRead = instrumentId === "xauusd.spot" ? goldBaselinesRead : instrumentId === "ndx.cash" ? indexBaselinesRead : additionalBaselinesRead;
  const refreshAfterJob = useRef<(job: TrackedMarketJob) => void>(() => undefined);
  useLayoutEffect(() => {
    jobsRef.current = jobs;
    refreshAfterJob.current = ({ job, instrumentId: owner }) => {
      if (job.type === "market.events.backfill") { eventsRead.markStale(); void eventsRead.refresh(); }
      if (job.type === "market.replays.backfill") {
        if (owner === instrumentId) { replaysRead.markStale(); void replaysRead.refresh(); }
        const resource = owner === "xauusd.spot" ? goldBaselinesRead : owner === "ndx.cash" ? indexBaselinesRead : owner === instrumentId ? additionalBaselinesRead : undefined;
        if (resource) { resource.markStale(); void resource.refresh(); }
      }
      if (job.type === "market.backtest.run" && owner === instrumentId) { backtestsRead.markStale(); void backtestsRead.refresh(); }
    };
  });
  useLayoutEffect(() => { gate.mount(); return () => gate.dispose(); }, [gate]);
  const refreshCalendar = calendarRead.refresh;
  useEffect(() => {
    if (activeTab !== "events") return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshCalendar(); }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [activeTab, refreshCalendar]);

  const jobSignature = Object.entries(jobs).filter(([, item]) => marketJobActive(item.job)).map(([slot, item]) => `${slot}:${item.job.id}`).sort().join("|");
  useEffect(() => {
    if (!jobSignature) return;
    const cancel = () => { for (const slot of Object.keys(jobsRef.current)) gate.abort(`job:${slot}`); };
    return startMarketJobPolling({ invalidate: cancel, poll: async (currentPoll) => {
      await Promise.allSettled(Object.entries(jobsRef.current).filter(([, item]) => marketJobActive(item.job)).map(async ([slot, entry]) => {
        const read = gate.beginRead(`job:${slot}`);
        try {
          const value = await marketJson(`/api/operations/jobs/${encodeURIComponent(entry.job.id)}`, { signal: read.signal });
          if (!currentPoll() || !read.current()) return;
          const incoming = parseMarketJob(value, entry.job.type, entry.job.id);
          const current = jobsRef.current[slot];
          if (!current || current.job.id !== entry.job.id) return;
          const next = { ...current, job: mergeMarketJob(current.job, incoming), error: undefined };
          jobsRef.current = { ...jobsRef.current, [slot]: next };
          setJobs(jobsRef.current);
          if (marketJobActive(current.job) && !marketJobActive(next.job)) refreshAfterJob.current(next);
        } catch (failure) {
          if (currentPoll() && read.current()) {
            const current = jobsRef.current[slot];
            if (current?.job.id === entry.job.id) {
              jobsRef.current = { ...jobsRef.current, [slot]: { ...current, error: marketError(failure) } };
              setJobs(jobsRef.current);
            }
          }
        }
      }));
    } });
  }, [gate, jobSignature, pollGeneration]);

  const refreshActive = () => {
    void overviewRead.refresh();
    if (barsRequired && providerReady) void barsRead.refresh();
    if (activeTab === "technicals" && bars) { void featuresRead.refresh(); void versionsRead.refresh(); }
    if (activeTab === "events") { void eventsRead.refresh(); void calendarRead.refresh(); void replaysRead.refresh(); void goldBaselinesRead.refresh(); void indexBaselinesRead.refresh(); if (!["xauusd.spot", "ndx.cash"].includes(instrumentId)) void additionalBaselinesRead.refresh(); }
    if (activeTab === "backtests") void backtestsRead.refresh();
    if (activeTab === "journal") void journalRead.refresh();
  };
  const acceptJob = (slot: string, job: MarketJob, label: string, request: unknown, owner?: string) => {
    gate.abort(`job:${slot}`);
    jobsRef.current = { ...jobsRef.current, [slot]: { job, label, request, instrumentId: owner } };
    setJobs(jobsRef.current);
    setPollGeneration((current) => current + 1);
  };
  async function perform<T>(label: string, reason: string | undefined, request: (current: () => boolean) => Promise<T>, accept: (value: T) => MarketEffectReceipt, after?: () => void) {
    if (reason) return undefined;
    const action = gate.beginWrite();
    if (!action) return undefined;
    const returnFocus = document.activeElement instanceof HTMLButtonElement ? document.activeElement : undefined;
    setBusy(label); setActionError(undefined);
    let accepted = false;
    try {
      const value = await request(action.current);
      if (!action.current()) return undefined;
      setReceipt(accept(value)); accepted = true;
      return value;
    } catch (failure) {
      if (action.current()) setActionError(`${marketError(failure)} No new effect receipt was confirmed. Check the relevant history before retrying an uncertain request.`);
      return undefined;
    } finally {
      if (action.current()) {
        action.finish(); setBusy(undefined); if (accepted) after?.();
        // Disabling the initiating control may move focus to the document.
        // Restore it after rendering unless the user already chose another target.
        requestAnimationFrame(() => {
          if (returnFocus?.isConnected && !returnFocus.disabled && document.activeElement === document.body) {
            returnFocus.focus({ preventScroll: true });
          }
        });
      }
    }
  }
  const startEventBackfill = () => {
    if (!overview?.providers.some((item) => item.provider === "fred" && item.configured)) return;
    const imported = new Set(eventsRead.data?.events.map((item) => item.eventKey));
    const expand = calendarRead.data?.catalog.families.some((item) => item.historyCoverage === "fred_release_dates" && !imported.has(item.eventKey));
    const submitted = { startDate: eventsRead.data?.total && !expand ? utcDateDaysAgo(120) : "2000-01-01", endDate: new Date().toISOString().slice(0, 10) };
    void perform("Queue event history", workflowReason, async () => parseMarketJob(await marketPost("/api/market-research/events", submitted, `market-events-${Date.now()}`), "market.events.backfill"), (job) => {
      acceptJob("events", job, "Official event history", submitted);
      return { message: `Event history job ${job.id}: ${job.status}.`, target: `Submitted context: ${submitted.startDate} to ${submitted.endDate}`, identities: job };
    });
  };
  const startReplayBackfill = () => {
    const targets = overview?.instruments.filter((item) => item.providerMapping.status === "verified") ?? [];
    if (!eventsRead.data?.total || !targets.length) return;
    const endDate = new Date().toISOString().slice(0, 10);
    void perform("Queue event replays", workflowReason, (current) => Promise.allSettled(targets.map(async (target) => {
      const submitted = { instrumentId: target.instrumentId, interval: "5min", startDate: "2000-01-01", endDate, maxEvents: 24 };
      const job = parseMarketJob(await marketPost("/api/market-research/replays", submitted, `market-replays-${target.instrumentId}-${Date.now()}`), "market.replays.backfill");
      if (current()) acceptJob(`replay:${target.instrumentId}`, job, `Event replays · ${target.label}`, submitted, target.instrumentId);
      return { target, submitted, job };
    })), (results) => {
      const accepted: string[] = []; const failures: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") { accepted.push(result.value.job.id); }
        else failures.push(`${targets[index].label}: ${marketError(result.reason)}`);
      });
      if (failures.length) setActionError(`Unconfirmed replay requests: ${failures.join("; ")}`);
      return { message: `${accepted.length} of ${targets.length} replay job receipts confirmed.`, target: `Submitted context: 24 events per requested market · 2000-01-01 to ${endDate}`, identities: { acceptedJobIds: accepted, unconfirmed: failures } };
    });
  };
  const runBacktest = (configuration: BacktestConfiguration) => {
    if (!bars?.bars.length || bars.instrumentId !== instrumentId || bars.interval !== interval) return;
    const submitted = { snapshotId: bars.snapshotId, strategy: { strategyId: "foundation.liquidity_sweep_reversal.v1", direction: configuration.direction, session: configuration.session, rewardRiskRatio: configuration.rewardRiskRatio, maxHoldingBars: configuration.maxHoldingBars, stopBufferRangeMultiplier: 0.1 }, costs: { spreadBps: configuration.spreadBps, slippageBps: configuration.slippageBps, commissionBps: configuration.commissionBps }, initialEquity: 10_000, riskPerTradeBps: configuration.riskPerTradeBps };
    void perform("Queue backtest", workflowReason, async () => parseMarketJob(await marketPost("/api/market-research/backtests", submitted, `market-backtest-${bars.snapshotId}-${crypto.randomUUID()}`), "market.backtest.run"), (job) => {
      acceptJob(`backtest:${instrumentId}`, job, `Backtest · ${selected?.label ?? instrumentId}`, submitted, instrumentId);
      return { message: `Backtest job ${job.id}: ${job.status}.`, target: `Submitted context: ${instrumentId} · ${interval} · snapshot ${bars.snapshotId}`, identities: job };
    });
  };
  const generateForecast = (horizon: MarketForecastHorizon) => {
    if (overview?.engineTracks.find((track) => track.id === "scenario_forecast")?.state !== "foundation") return;
    const target = { instrumentId, horizon };
    void perform(`Generate ${horizon}`, modelReason, async () => parseMarketForecastReceipt(await marketPost("/api/market-research/journal/generate", target, `market-forecast-${instrumentId}-${horizon}-${crypto.randomUUID()}`), target.instrumentId, horizon), (data) => ({ message: `${data.reused ? "Existing" : "New"} sealed forecast ${data.forecast.id} confirmed. Journal freshness is checked separately.`, target: `${target.instrumentId} · ${horizon} · ${data.forecast.windowStart} to ${data.forecast.windowEnd}`, identities: data.forecast }), () => { journalRead.markStale(); void journalRead.refresh(); });
  };
  const scoreDueForecasts = () => {
    if (!journalRead.data?.scorecard.due) return;
    const target = { instrumentId, maxForecasts: 2 };
    void perform("Score forecasts", workflowReason, async () => parseMarketScoreReceipt(await marketPost("/api/market-research/journal/score", target, `market-forecast-score-${instrumentId}-${crypto.randomUUID()}`)), (data) => ({ message: `${data.outcomes.length} scoring outcome receipts returned. Journal freshness is checked separately.`, target: `Request: ${target.instrumentId} · at most 2 due forecasts`, identities: data.outcomes }), () => { journalRead.markStale(); void journalRead.refresh(); });
  };
  const saveAnalysis = async (snapshot: MarketBarsResult, submitted: MarketAnalysisSubmission) => {
    const frozen = structuredClone(submitted);
    const result = await perform("Save analysis", modelReason, async () => parseMarketAnalysisReceipt(await marketPost("/api/market-research/analysis", frozen, `market-analysis-${snapshot.snapshotId}-${crypto.randomUUID()}`), snapshot, frozen), (data) => ({ message: `Private analysis ${data.version.id} confirmed.`, target: `${snapshot.instrumentId} · ${snapshot.interval} · ${snapshot.snapshotId}`, identities: data.version }), () => { versionsRead.markStale(); void versionsRead.refresh(); });
    return result?.version;
  };
  const pendingReason = busy ? `${busy} is awaiting its receipt.` : undefined;
  const reads: Array<[string, ReturnType<typeof useMarketResource<unknown>>]> = [["Research readiness", overviewRead]];
  if (barsRequired) reads.push(["Price snapshot", barsRead]);
  if (activeTab === "technicals") reads.push(["Technical features", featuresRead], ["Private analyses", versionsRead]);
  if (activeTab === "events") reads.push(["Event history", eventsRead], ["Official calendar", calendarRead], ["Replay history", replaysRead], ["Gold baselines", goldBaselinesRead], ["Nasdaq baselines", indexBaselinesRead]);
  if (activeTab === "events" && !["xauusd.spot", "ndx.cash"].includes(instrumentId)) reads.push(["Selected market baselines", additionalBaselinesRead]);
  if (activeTab === "backtests") reads.push(["Backtest history", backtestsRead]);
  if (activeTab === "journal") reads.push(["Forecast journal", journalRead]);
  const replayJobs = Object.fromEntries(Object.entries(jobs).filter(([slot]) => slot.startsWith("replay:")).map(([, entry]) => [entry.instrumentId!, entry.job]));

  return <section className={styles.shell} aria-labelledby="markets-title" data-testid="markets-workspace">
    <header className={styles.hero}><div className={styles.heroCopy}><h1 id="markets-title">Markets</h1><p>Price evidence, event studies, technical structure and sealed research outcomes.</p></div><div className={styles.heroStatus}><span>{overview ? phaseLabel(overview.phase, false) : overviewRead.loading ? "Checking research systems" : "Research readiness unavailable"}</span><small>{overview ? `${overviewRead.error || overviewRead.loading ? "Last loaded · " : ""}${formatClock(overview.generatedAt)}` : "Availability is not yet confirmed"}</small><button type="button" onClick={refreshActive} disabled={overviewRead.loading || Boolean(busy)}>Refresh current view</button></div></header>
    <section className={styles.commandBar} aria-label="Market selection"><div className={styles.instruments}>{overview?.instruments.map((instrument) => <button key={instrument.instrumentId} type="button" className={instrument.instrumentId === instrumentId ? styles.instrumentActive : styles.instrument} onClick={() => setSelectedId(instrument.instrumentId)} disabled={Boolean(busy)} aria-pressed={instrument.instrumentId === instrumentId}><span>{instrument.shortLabel}</span><small>{instrumentTypeLabel(instrument)} · {instrument.providerMapping.status === "verified" ? "Exact feed mapped" : "Mapping required"}</small></button>)}{overviewRead.loading && !overview ? <InstrumentSkeleton /> : null}</div><div className={styles.quickState}><span>{instrumentId} · {interval}</span><span>{bars ? `${bars.bars[0]?.timestamp ?? "No first bar"} to ${bars.asOf} · ${bars.providerTimezone}` : "Price date range unavailable until chart data is loaded"}</span><span><ShieldCheck size={14} /> Research only · no trade execution</span></div></section>
    <div className={styles.tabs} role="group" aria-label="Market research views">{tabs.map((tab) => <button key={tab.id} type="button" className={activeTab === tab.id ? styles.tabActive : styles.tab} onClick={() => setActiveTab(tab.id)} disabled={Boolean(busy)} aria-pressed={activeTab === tab.id}><span>{tab.label}</span><small>{tab.description}</small></button>)}</div>
    <ExactEvidence label="Private workspace ownership" value={{ tenantId: session?.context?.tenantId, actorId: session?.context?.actorId }} />
    <div className={styles.readStates}>{reads.map(([label, read]) => <MarketReadStatus key={label} label={label} read={read} />)}</div>
    <p className={styles.liveStatus} role="status" aria-live="polite">{busy ? `${busy}. Already-sent work may continue if you leave this page.` : receipt?.message ?? ""}</p>
    {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
    {receipt ? <section className={styles.effectReceipt} aria-label="Confirmed market effect receipt"><strong>{receipt.message}</strong><p>{receipt.target}</p><details><summary>Exact returned receipt</summary><pre>{JSON.stringify(receipt.identities, null, 2)}</pre></details></section> : null}
    {Object.keys(jobs).length ? <section className={styles.jobLedger} aria-label="Market operation jobs"><header><h2>Operation jobs</h2><button type="button" disabled={!jobSignature} onClick={() => { for (const slot of Object.keys(jobsRef.current)) gate.abort(`job:${slot}`); setPollGeneration((current) => current + 1); }}>Refresh job statuses</button></header><p>Submitted inputs are retained locally. The returned job receipt confirms its identity and status but does not include those inputs.</p>{Object.entries(jobs).map(([slot, entry]) => <article key={slot}><strong>{entry.label}</strong><p><code>{entry.job.id}</code> · {entry.error ? "Last confirmed: " : ""}{entry.job.status}{entry.job.quarantined ? " · Operator review required" : ""}</p><p>Stage: {typeof entry.job.progress?.stage === "string" ? entry.job.progress.stage.replaceAll("_", " ") : "Unavailable"} · Updated {formatTime(entry.job.updatedAt)}</p>{entry.error ? <p role="status">Status is unconfirmed: {entry.error} Automatic visible-page checks continue.</p> : null}{entry.job.status === "failed" ? <p>{entry.job.lastError || "This operation did not complete."}</p> : null}<details><summary>Submitted request and returned progress</summary><pre>{JSON.stringify({ request: entry.request, progress: entry.job.progress ?? null, result: entry.job.result ?? null }, null, 2)}</pre></details></article>)}</section> : null}
    {selected ? <>
      <ResearchDesk hidden={activeTab !== "overview" && activeTab !== "technicals"} technicalMode={activeTab === "technicals"} instrument={selected} overview={overview} events={eventsRead.data} bars={bars} barsLoading={barsRead.loading} barsError={barsRead.error} interval={interval} onIntervalChange={setInterval} chartActive={activeTab === "technicals" || overviewChartActive} onActivateChart={() => setOverviewChartActive(true)} latestAnalysis={versionsRead.data?.versions[0]} features={featuresRead.data} visibleTechnicalLayers={visibleTechnicalLayers} onToggleTechnicalLayer={(layerId) => { if (featuresRead.data) setLayerSelection({ snapshotId: featuresRead.data.snapshot.id, ids: visibleTechnicalLayers.includes(layerId) ? visibleTechnicalLayers.filter((id) => id !== layerId) : [...visibleTechnicalLayers, layerId] }); }} saveDisabledReason={pendingReason ?? modelReason} onSaveAnalysis={saveAnalysis} controlsBusy={Boolean(busy)} />
      <div hidden={activeTab !== "events"}><NewsImpactLab instrument={selected} overview={overview} events={eventsRead.data} liveCalendar={calendarRead.data} liveCalendarLoading={calendarRead.loading} liveCalendarError={calendarRead.error} loading={eventsRead.loading} error={eventsRead.error} backfillJob={jobs.events?.job} replays={replaysRead.data} baselines={baselinesRead.data} baselinesByInstrument={baselinesByInstrument} replaysLoading={replaysRead.loading} baselinesLoading={baselinesRead.loading} replayError={replaysRead.error} baselinesError={baselinesRead.error} replayJobs={replayJobs} onBackfill={startEventBackfill} onReplayBackfill={startReplayBackfill} disabledReason={pendingReason ?? workflowReason} /></div>
      <div hidden={activeTab !== "technicals"}><TechnicalLab instrument={selected} overview={overview} bars={bars} features={featuresRead.data} loading={featuresRead.loading || barsRead.loading} error={featuresRead.error || barsRead.error} versions={versionsRead.data} versionsLoading={versionsRead.loading} versionsError={versionsRead.error} /></div>
      <div hidden={activeTab !== "backtests"}><BacktestLab instrument={selected} bars={bars} backtests={backtestsRead.data} loading={backtestsRead.loading} error={backtestsRead.error || barsRead.error} job={jobs[`backtest:${instrumentId}`]?.job} onRun={runBacktest} disabledReason={pendingReason ?? workflowReason} /></div>
      <div hidden={activeTab !== "journal"}><ForecastJournal instrument={selected} overview={overview} journal={journalRead.data} loading={journalRead.loading} error={journalRead.error} action={busy === "Generate daily" ? "daily" : busy === "Generate weekly" ? "weekly" : busy === "Score forecasts" ? "score" : undefined} onGenerate={generateForecast} onScore={scoreDueForecasts} generationDisabledReason={pendingReason ?? modelReason} scoreDisabledReason={pendingReason ?? workflowReason} /></div>
    </> : overviewRead.loading ? <WorkspaceSkeleton /> : <p className={styles.tableEmpty}>Research instruments are unavailable until the readiness source succeeds.</p>}
  </section>;
}

function MarketReadStatus({ label, read }: { label: string; read: { data?: unknown; loading: boolean; stale?: boolean; error?: string; refresh: () => Promise<void> } }) {
  return <div className={styles.readState} data-error={Boolean(read.error)}><span><strong>{label}</strong> · {read.loading ? read.data ? "Refreshing; last loaded result retained." : "Loading; availability unknown." : read.error ? read.data ? "Refresh failed; last loaded result retained." : "Unavailable." : read.stale ? "Last loaded; awaiting refresh." : read.data ? "Loaded." : "Not loaded."}{read.error ? <span>{read.error}</span> : null}</span>{read.error ? <button type="button" onClick={() => void read.refresh()} disabled={read.loading}>Retry {label.toLowerCase()}</button> : null}</div>;
}
async function marketJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) { const error = body && typeof body === "object" && "error" in body ? body.error : undefined; throw new Error(typeof error === "string" ? error : `The source returned ${response.status}.`); }
  return body;
}
function marketPost(path: string, body: unknown, key: string) { return marketJson(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) }); }
function marketError(error: unknown) { return error instanceof Error ? error.message : "The market request could not be confirmed."; }

function ResearchDesk({
  hidden,
  technicalMode,
  instrument,
  overview,
  events,
  bars,
  barsLoading,
  barsError,
  interval,
  onIntervalChange,
  chartActive,
  onActivateChart,
  latestAnalysis,
  features,
  visibleTechnicalLayers,
  onToggleTechnicalLayer,
  onSaveAnalysis,
  saveDisabledReason,
  controlsBusy,
}: {
  hidden: boolean;
  technicalMode: boolean;
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  events?: MarketEventsResult;
  bars?: MarketBarsResult;
  barsLoading: boolean;
  barsError?: string;
  interval: MarketInterval;
  onIntervalChange: (interval: MarketInterval) => void;
  chartActive: boolean;
  onActivateChart: () => void;
  latestAnalysis?: MarketAnalysisVersion;
  features?: MarketTechnicalFeaturesResult;
  visibleTechnicalLayers: MarketTechnicalLayerId[];
  onToggleTechnicalLayer: (layerId: MarketTechnicalLayerId) => void;
  onSaveAnalysis: (snapshot: MarketBarsResult, submitted: MarketAnalysisSubmission) => Promise<MarketAnalysisVersion | undefined>;
  saveDisabledReason?: string;
  controlsBusy: boolean;
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
    bars?.bars.length && bars.instrumentId === instrument.instrumentId && bars.interval === interval,
  );
  const matchingFeatures = features?.snapshot.id === bars?.snapshotId
    ? features
    : undefined;

  return (
    <section className={styles.workspace} hidden={hidden}>
      <div className={styles.primaryPlane}>
        <div className={styles.instrumentHeader}>
          <div>
            <p className={styles.eyebrow}>{technicalMode ? "Technical structure and private drawings" : "Canonical research instrument"}</p>
            <h2>{instrument.label}</h2>
            <p>{technicalMode ? "System overlays are locked, versioned detector output. Private drawings remain editable and may carry forward from an earlier snapshot for this instrument and interval." : instrument.identityWarning}</p>
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
          <Metric label="High-impact releases" value={events ? String(events.total) : "Unavailable"} detail="Bounded official history · open Events" />
          <Metric
            label="ICT structure"
            value={matchingFeatures ? `${matchingFeatures.counts.setupCandidates} setups` : "Unavailable"}
            detail={matchingFeatures ? `${matchingFeatures.annotations.length} typed overlays` : "Open Technicals"}
          />
        </div>

        <div className={styles.chartPanel}>
          <header>
            <div>
              <span><ChartCandlestick size={16} /> {technicalMode ? "ICT + Quarterly analysis canvas" : "Provider-labelled price context"}</span>
              <small>{bars ? `${bars.providerSymbol} · ${bars.providerTimezone} · ${bars.bars.length} bars · ${bars.snapshotSource === "cache" ? "reused" : "new"} snapshot ${bars.snapshotSha256.slice(0, 10)}` : "No proxy data is shown"}</small>
            </div>
            <div className={styles.intervalPicker} role="group" aria-label="Chart interval">
              {MARKET_INTERVALS.map((item) => (
                <button key={item} type="button" disabled={controlsBusy} aria-pressed={item === interval} onClick={() => onIntervalChange(item)}>{item}</button>
              ))}
            </div>
          </header>
          {technicalMode && matchingFeatures ? (
            <div className={styles.layerBar} role="group" aria-label="Analysis drawing layers">
              <div>
                <Layers3 size={15} />
                <span><strong>Drawing layers</strong><small>Locked system overlays · manual drawings stay editable</small></span>
              </div>
              <div className={styles.layerChips}>
                {matchingFeatures.layers.map((layer) => (
                  <button
                    key={layer.id}
                    type="button"
                    aria-pressed={visibleTechnicalLayers.includes(layer.id)}
                    disabled={controlsBusy}
                    onClick={() => onToggleTechnicalLayer(layer.id)}
                    title={layer.description}
                  >
                    <i data-layer={layer.id} /> {layer.label} <em>{layer.count}</em>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {bars ? <ExactEvidence label="Price snapshot provenance" value={{ instrumentId: bars.instrumentId, provider: bars.provider, providerSymbol: bars.providerSymbol, providerTimezone: bars.providerTimezone, interval: bars.interval, retrievedAt: bars.retrievedAt, asOf: bars.asOf, snapshotId: bars.snapshotId, snapshotSha256: bars.snapshotSha256, snapshotSource: bars.snapshotSource }} /> : null}
          <div className={styles.chartBody}>
            {!chartActive ? (
              <ChartDeferred onActivate={onActivateChart} />
            ) : hasMatchingBars && bars ? (
              <PriceChart
                key={`${instrument.instrumentId}:${bars.interval}`}
                instrument={instrument}
                bars={bars}
                latestAnalysis={latestAnalysis}
                features={technicalMode ? matchingFeatures : undefined}
                visibleLayerIds={technicalMode ? visibleTechnicalLayers : undefined}
                onSaveAnalysis={onSaveAnalysis}
                disabledReason={saveDisabledReason}
              />
            ) : barsLoading ? <ChartLoading /> : bars && !bars.bars.length ? <div className={styles.chartEmpty}><strong>No provider bars returned</strong><p>The exact instrument and interval returned an empty price snapshot.</p></div> : (
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
            <span>{technicalMode ? "Typed overlays never overwrite manual drawings · select layers above · drawing tools at left" : "Advanced Charts v32.2.0 · scroll to zoom · drag to pan · drawing tools at left"}</span>
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
            <strong>Scenarios are recorded in Journal</strong>
            <p>Sealed scenarios bind price snapshots, economic releases, deterministic features and model attribution. Calibrated directional probabilities remain withheld.</p>
          </div>
          <Link href="/app/settings" className={styles.textLink}>Configure model routing <ArrowRight size={14} /></Link>
        </section>

        <section className={styles.providerPanel}>
          <header><span><Database size={16} /> Research inputs</span><small>{overview ? `${overview.providers.filter((item) => item.configured).length}/${overview.providers.length} configured` : "Availability unknown"}</small></header>
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

function LiveEventBrief({
  calendar,
  loading,
  error,
  baselinesByInstrument,
}: {
  calendar?: MarketLiveCalendarResult;
  loading: boolean;
  error?: string;
  baselinesByInstrument: Partial<Record<MarketInstrumentId, MarketEventBaselinesResult>>;
}) {
  const today = calendar?.events.filter(({ dayState }) => dayState === "today") || [];
  const focus = today.find(({ eventKey }) => eventKey === "us.fomc") ||
    today[0] ||
    calendar?.events[0];
  const isFomc = focus?.eventKey === "us.fomc";
  const marketRows = [
    { id: "xauusd.spot", label: "Gold · XAU/USD" },
    { id: "ndx.cash", label: "NASDAQ-100 · NDX" },
  ] as const;

  return (
    <section className={styles.liveEventBoard}>
      <header>
        <div>
          <p className={styles.eyebrow}>{today.length ? "High-impact today" : "Next high-impact release"}</p>
          <h3>{focus?.name || "Official macro calendar"}</h3>
          <p>{focus ? focus.whyItMatters : calendar ? "No exact-time release is returned for this window." : loading ? "Loading the reviewed official U.S. release calendar." : "Official release availability is unconfirmed."}</p>
        </div>
        <span data-live={today.length > 0}>
          <i /> {today.length ? `${today.length} today` : calendar ? `${calendar.events.length} next ${calendar.windowDays} days` : "Count unavailable"}
        </span>
      </header>

      {error ? <div className={styles.tableNotice} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
      {loading ? <div className={styles.liveEventLoading}><RefreshCw className={styles.spin} size={18} /> Reading official release calendars…</div> : null}

      {focus ? (
        <div className={styles.liveEventGrid}>
          <article className={styles.releaseCard}>
            <div className={styles.releaseTime}>
              <CalendarClock size={19} />
              <span>
                <small>{focus.dayState === "today" ? "Today" : formatEventDate(focus.releaseDate)}</small>
                <strong>{formatEventTime(focus.occurredAt)}</strong>
              </span>
              <em data-released={focus.releaseState === "released"}>{focus.releaseState === "released" ? "Released" : "Scheduled"}</em>
            </div>
            {isFomc ? <p className={styles.releaseSequence}><strong>2:00 PM ET</strong> statement and decision <span>→</span> <strong>2:30 PM ET</strong> press conference. Projection meetings can create another repricing wave through the dot plot.</p> : null}
            <div className={styles.componentCloud}>
              {focus.components.map((component) => <span key={component}>{component}</span>)}
            </div>
            <a href={focus.sourceUrl} target="_blank" rel="noreferrer">Official source <ArrowRight size={13} /></a>
          </article>

          <article className={styles.crossMarketCard}>
            <div className={styles.cardHeading}><span><Activity size={16} /> Historical reaction</span><small>Exact family · immutable 5m bars</small></div>
            <div className={styles.crossMarketRows}>
              {marketRows.map(({ id, label }) => {
                const baseline = baselinesByInstrument[id]?.groups.find(
                  ({ eventKey }) => eventKey === focus.eventKey,
                );
                return (
                  <div key={id}>
                    <span><strong>{label}</strong><small>{baseline ? `${baseline.sampleSize} releases` : baselinesByInstrument[id] ? "No matching family returned" : "History unavailable"}</small></span>
                    <span><small>60m median</small><strong>{baseline?.post60m.medianBps == null ? "—" : formatSignedBps(baseline.post60m.medianBps)}</strong></span>
                    <span><small>Observed split</small><strong>{baseline ? `${Math.round(baseline.empiricalRates.up * 100)}% up · ${Math.round(baseline.empiricalRates.down * 100)}% down` : "Unavailable"}</strong></span>
                  </div>
                );
              })}
            </div>
            <p>Direction counts describe past outcomes. They are not the probability of the next release.</p>
          </article>

          <article className={styles.scenarioCard}>
            <div className={styles.cardHeading}><span><Waypoints size={16} /> Conditional map</span><small>Relative to expectations</small></div>
            {isFomc ? (
              <div className={styles.scenarioRows}>
                <div data-tone="cool"><strong>Dovish path</strong><p>Lower rate-path expectations or softer projections can pressure yields and the dollar, often supporting gold and rate-sensitive NASDAQ valuations.</p></div>
                <div data-tone="warm"><strong>Hawkish path</strong><p>Higher-for-longer guidance can lift yields and the dollar, often pressuring gold and long-duration technology shares.</p></div>
                <div><strong>Mixed / reversal path</strong><p>The statement, projections, and press conference can conflict. Treat the first move as provisional until price accepts outside the pre-release range.</p></div>
              </div>
            ) : (
              <div className={styles.scenarioRows}>
                <div data-tone="warm"><strong>Hotter / stronger</strong><p>A meaningful upside surprise can lift expected rates and the dollar; the effect on gold and NASDAQ depends on the growth-versus-inflation mix.</p></div>
                <div data-tone="cool"><strong>Softer / weaker</strong><p>A downside surprise can lower yields, but recession-sensitive weakness may separate gold from equity-index behavior.</p></div>
                <div><strong>Near consensus</strong><p>Revisions, subcomponents, positioning, and the pre-release liquidity structure may matter more than the headline.</p></div>
              </div>
            )}
          </article>
        </div>
      ) : !loading && calendar ? <div className={styles.liveEventEmpty}>No reviewed exact-time release was returned for the next {calendar.windowDays} days. {calendar.sourceHealth.some((source) => source.status === "unavailable") ? "Unavailable publishers may have missing releases." : "All listed publishers responded."}</div> : null}

      {calendar ? <section className={styles.calendarHealth} aria-label="Official calendar source coverage"><h3>Publisher coverage</h3><p>Generated {formatTime(calendar.generatedAt)} · market date {calendar.marketDate} · {calendar.timezone}.</p>{calendar.sourceHealth.map((source) => <p key={source.source}><strong>{scheduleSourceLabel(source.source)}</strong> · {source.status} · {source.status === "connected" ? `${source.eventCount} events returned` : "Event coverage unavailable"}. {source.note}</p>)}</section> : null}
      {calendar ? (
        <details className={styles.coverageCatalog}>
          <summary>
            <span><Database size={15} /> {calendar.catalog.reviewedFamilies} reviewed high-impact families</span>
            <small>{calendar.catalog.exactTimeFamilies} exact-time · {calendar.catalog.dateOnlyFamilies} date-only pending verification</small>
          </summary>
          <div>
            {calendar.catalog.families.map((family) => (
              <article key={family.eventKey}>
                <span><strong>{family.name}</strong><em>{family.historyCoverage === "publisher_schedule_only" ? "Publisher schedule" : family.scheduleCoverage === "official_exact" ? "Exact time" : "Date only"}</em></span>
                <p>{family.components.join(" · ")}</p>
                <small>{family.whyItMatters}</small>
              </article>
            ))}
          </div>
          <footer>{calendar.disclosures[0]} {calendar.disclosures[1]}</footer>
        </details>
      ) : null}
    </section>
  );
}

function NewsImpactLab({
  instrument,
  overview,
  events,
  liveCalendar,
  liveCalendarLoading,
  liveCalendarError,
  loading,
  error,
  backfillJob,
  replays,
  baselines,
  baselinesByInstrument,
  replaysLoading,
  baselinesLoading,
  replayError,
  baselinesError,
  replayJobs,
  onBackfill,
  onReplayBackfill,
  disabledReason,
}: {
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  events?: MarketEventsResult;
  liveCalendar?: MarketLiveCalendarResult;
  liveCalendarLoading: boolean;
  liveCalendarError?: string;
  loading: boolean;
  error?: string;
  backfillJob?: MarketBackfillJob;
  replays?: MarketEventReplaysResult;
  baselines?: MarketEventBaselinesResult;
  baselinesByInstrument: Partial<Record<MarketInstrumentId, MarketEventBaselinesResult>>;
  replaysLoading: boolean;
  baselinesLoading: boolean;
  replayError?: string;
  baselinesError?: string;
  replayJobs: Partial<Record<MarketInstrumentId, MarketBackfillJob>>;
  onBackfill: () => void;
  onReplayBackfill: () => void;
  disabledReason?: string;
}) {
  const calendar = overview?.providers.find((provider) => provider.provider === "bls");
  const vintage = overview?.providers.find((provider) => provider.provider === "fred");
  const importing = backfillJob && ["queued", "running"].includes(backfillJob.status);
  const importedEventKeys = new Set(events?.events.map(({ eventKey }) => eventKey));
  const catalogExpansionRequired = liveCalendar?.catalog.families.some(
    ({ eventKey, historyCoverage }) =>
      historyCoverage === "fred_release_dates" && !importedEventKeys.has(eventKey),
  ) === true;
  const completedSources = marketProgress(backfillJob?.progress?.completedSources);
  const totalSources = marketProgress(backfillJob?.progress?.totalSources);
  const activeReplayJobs = Object.values(replayJobs).filter((job) =>
    job && ["queued", "running"].includes(job.status)
  );
  const replaying = activeReplayJobs.length > 0;
  const completedEvents = combinedProgress(activeReplayJobs, "completedEvents");
  const totalEvents = combinedProgress(activeReplayJobs, "totalEvents");
  const replayByEventId = new Map((replays?.replays || []).map((replay) => [replay.eventId, replay]));
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Event study · {instrument.shortLabel}</p><h2>News impact lab</h2><p>Replay high-impact releases against immutable pre- and post-event windows, then compare the observed move with the surprise, revision, liquidity regime, and ICT context.</p></div>
        <div className={styles.labActions}>
          <div className={styles.labReadiness}><span data-ready={calendar?.configured}><i /> Official calendars</span><span data-ready={vintage?.configured}><i /> FRED history</span></div>
          <div className={styles.labButtons}>
            <button type="button" onClick={onBackfill} disabled={Boolean(disabledReason) || Boolean(importing) || vintage?.configured !== true}>
              <History size={15} />
              {importing
                ? `Importing ${completedSources}/${totalSources}`
                : catalogExpansionRequired
                  ? `Expand to ${liveCalendar?.catalog.reviewedFamilies} families`
                  : events?.total
                    ? "Refresh history"
                    : "Import history"}
            </button>
            <button type="button" onClick={onReplayBackfill} disabled={Boolean(disabledReason) || Boolean(replaying) || instrument.providerMapping.status !== "verified" || !events?.total}>
              <ChartCandlestick size={15} />
              {replaying ? `Replaying ${completedEvents}/${totalEvents}` : "Build next 24 per mapped market"}
            </button>
          </div>
        </div>
      </header>

      {disabledReason ? <p className={styles.permissionReason}>{disabledReason}</p> : null}
      <LiveEventBrief
        calendar={liveCalendar}
        loading={liveCalendarLoading}
        error={liveCalendarError}
        baselinesByInstrument={baselinesByInstrument}
      />

      <div className={styles.pipeline}>
        {[
          ["01", "Normalize", "Provider events → high impact"],
          ["02", "Freeze", "Initial-release FRED vintage"],
          ["03", "Measure", "Pre/post return + volatility"],
          ["04", "Explain", "Macro + ICT evidence"],
          ["05", "Calibrate", "Comparable-event outcomes"],
        ].map(([number, title, detail]) => <article key={number}><span>{number}</span><strong>{title}</strong><small>{detail}</small></article>)}
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
              <div className={styles.directionBar} role="img" aria-label={`${Math.round(baseline.empiricalRates.up * 100)} percent up, ${Math.round(baseline.empiricalRates.down * 100)} percent down`}>
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
        </div> : !baselinesLoading ? <div className={styles.baselineEmpty}>{baselines ? "No comparable release families were returned. Build immutable event windows to populate the baseline." : "Comparable-event counts and distributions are unavailable."}</div> : null}
        <footer>These are outcome distributions, not calibrated predictions. They do not condition on surprise, macro regime, session structure, or transcript-reviewed ICT context.</footer>
      </section>

      <section className={styles.eventTable} aria-label="Historical high-impact releases">
        <header><h3>Historical high-impact releases</h3><p>{events ? `${events.events.length} returned of ${events.total} available official dates · limit 500` : "Event count unavailable"}. {replays ? `${replays.replayedEvents}/${replays.eligibleEvents} eligible ${instrument.shortLabel} windows; ${replays.replays.length} returned, limit 100.` : "Replay coverage unavailable."}</p></header>
        {error ? <p className={styles.inlineError}>{error}{events ? " Last loaded event rows remain below." : ""}</p> : null}
        {replayError ? <p className={styles.inlineError}>{replayError}{replays ? " Last loaded replay measurements remain below." : ""}</p> : null}
        {replaysLoading ? <p className={styles.replayLoading}>Reading immutable price windows…</p> : null}
        {loading && !events ? <p className={styles.tableEmpty}>Loading event history; counts are unconfirmed.</p> : events?.events.length ? (
          <div className={styles.tableScroll} role="region" aria-label="Official event history table" tabIndex={0}>
            <table><caption>Official releases and the loaded {instrument.label} replay window.</caption><thead><tr><th scope="col">Release</th><th scope="col">Date</th><th scope="col">Precision</th><th scope="col">Values</th><th scope="col">Observed move</th><th scope="col">Source and evidence</th></tr></thead><tbody>
            {events.events.map((event) => {
              const replay = replayByEventId.get(event.id);
              return <tr key={event.id}>
                <th scope="row"><strong>{event.name}</strong><small>{event.eventKey}</small></th>
                <td><time dateTime={event.occurredAt || event.releaseDate}>{formatEventDate(event.releaseDate)}{event.occurredAt ? <small>{formatEventTime(event.occurredAt)}</small> : null}</time></td>
                <td>{event.timestampPrecision === "date" ? "Date only" : "Exact time"}</td>
                <td><strong>{event.observations[0] ? formatMacroObservation(event.observations[0]) : "Observation unavailable"}</strong><small>{event.observations[1] ? formatMacroObservation(event.observations[1]) : event.consensus === null ? "No free official consensus" : `Consensus ${event.consensus}`}</small></td>
                <td className={styles.replayMove} data-direction={replay?.direction}><strong>{replay?.post60m ? `${formatSignedBps(replay.post60m.returnBps)} · 60m` : !replays ? "Replay unavailable" : event.occurredAt ? "No window in returned replays" : "Needs exact time"}</strong><small>{replay?.post5m ? `${formatSignedBps(replay.post5m.returnBps)} at 5m · ${replay.post60mRangeBps?.toFixed(1) ?? "Unavailable"} bps range` : "No loaded price outcome"}</small></td>
                <td><a href={event.sourceUrl} target="_blank" rel="noreferrer">FRED source</a>{event.scheduleSourceUrl ? <a href={event.scheduleSourceUrl} target="_blank" rel="noreferrer">{scheduleSourceLabel(event.scheduleSource)} time source</a> : null}<ExactEvidence label="Exact release and loaded replay" value={{ event, replay: replay ?? null }} /></td>
              </tr>;
            })}
            </tbody></table>
          </div>
        ) : <div className={styles.tableEmpty}><strong>{events ? "No event history returned" : "Event history unavailable"}</strong><p>{events ? "Import official FRED release history to begin. Intraday impact requires an authoritative release timestamp and matching price window." : "Retry the event history source above. No zero count is inferred."}</p></div>}
        <footer className={styles.eventDisclosure}>Values are immutable initial-release FRED vintages, labeled in source units. A complete free official historical consensus archive is unavailable; missing consensus remains empty.</footer>
      </section>
    </section>
  );
}

function combinedProgress(jobs: Array<MarketJob | undefined>, field: string) {
  const values = jobs.map((job) => job?.progress?.[field]);
  return values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    ? values.reduce<number>((sum, value) => sum + (value as number), 0).toString()
    : "Unavailable";
}

function ExactEvidence({ label, value }: { label: string; value: unknown }) {
  return <details className={styles.exactEvidence}><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function utcDateDaysAgo(days: number) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
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
    "us.employment_cost_index": "Employment costs",
    "us.productivity_costs": "Productivity & costs",
    "us.import_export_prices": "Import/export prices",
    "us.trade_balance": "Trade balance",
    "us.durable_goods": "Durable goods",
    "us.housing_starts": "Housing starts",
    "us.new_home_sales": "New-home sales",
    "us.initial_jobless_claims": "Jobless claims",
    "us.industrial_production": "Industrial production",
    "us.ism_manufacturing": "ISM manufacturing",
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
  versions,
  versionsLoading,
  versionsError,
}: {
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  bars?: MarketBarsResult;
  features?: MarketTechnicalFeaturesResult;
  loading: boolean;
  error?: string;
  versions?: MarketAnalysisVersionsResult;
  versionsLoading: boolean;
  versionsError?: string;
}) {
  const detectorState = overview?.engineTracks.find((track) => track.id === "ict_detectors")?.state;
  const current = features?.snapshot.id === bars?.snapshotId ? features : undefined;
  const recentDetections = current?.detections.slice(0, 16) || [];
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Deterministic structure · {instrument.shortLabel}</p><h2>ICT + Quarterly engine</h2><p>Reproducible market-structure primitives run against one immutable price snapshot. Transcript-specific ICT rules stay separate until their exact definitions and source timecodes are reviewed.</p></div>
        <span className={styles.stateBadge} data-state={detectorState}>{current ? "Reproducible v2" : detectorState === "foundation" ? "Loading foundation" : "Waiting for bars"}</span>
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

          <ExactEvidence label="Exact technical evidence" value={{ snapshot: current.snapshot, detectorVersion: current.detectorVersion, resultSha256: current.resultSha256, annotations: current.annotations }} />
          <div className={styles.technicalSummary}>
            <article><small>Dealing range</small><strong>{current.range.zone}</strong><span>{current.range.positionPercent.toFixed(1)}% of last {current.range.lookbackBars} bars</span></article>
            <article><small>90-minute quarter</small><strong>Q{current.timeContext.ninetyMinuteQuarter}</strong><span>{sessionLabel(current.timeContext.session)} · {current.timeContext.localTime} ET</span></article>
            <article><small>Valid FVG / OB candidate</small><strong>{current.counts.activeFairValueGaps} / {current.counts.validOrderBlocks}</strong><span>Lifecycle-aware zones · OB review-gated</span></article>
            <article><small>Liquidity / setups</small><strong>{current.counts.liquidityLevels} / {current.counts.setupCandidates}</strong><span>Active levels · review-gated candidates</span></article>
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
              <header><div><strong>Latest detected structure</strong><span>Showing {recentDetections.length} of {current.detections.length} bounded observations</span></div><small>Newest first</small></header>
              {recentDetections.length ? <div className={styles.detectionRows}>
                {recentDetections.map((detection) => (
                  <article key={detection.id} data-direction={detection.direction}>
                    <i />
                    <span><strong>{detectionLabel(detection.kind)}</strong><small>{detection.direction} · {detection.state.replaceAll("_", " ")} · {detection.reviewState === "candidate_rule" ? "review candidate" : "foundation"}</small></span>
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

      <AnalysisVersionLedger versions={versions} loading={versionsLoading} error={versionsError} />
      <div className={styles.boundaryNote}><ShieldCheck size={18} /><div><strong>Review boundary</strong><p>Foundation drawings are reproducible geometry or time partitions. OB, MSS, Turtle Soup, Unicorn, and Judas Swing use visible candidate formulas until your transcript evidence and timecodes are reviewed; the app does not present them as validated signals.</p></div></div>
    </section>
  );
}

function AnalysisVersionLedger({
  versions,
  loading,
  error,
}: {
  versions?: MarketAnalysisVersionsResult;
  loading: boolean;
  error?: string;
}) {
  const latest = versions?.versions[0];
  const previous = versions?.versions[1];
  const annotationDelta = latest && previous
    ? latest.annotationCount - previous.annotationCount
    : undefined;
  return (
    <section className={styles.versionLedger}>
      <header>
        <div><strong>Private analysis ledger</strong><small>{versions ? `${versions.versions.length} shown · ${versions.total} available versions` : "Version count unavailable"} · manual drawings restore by instrument and interval; their saved snapshot may differ from the current chart</small></div>
        {latest ? <span>Δ overlays {annotationDelta === undefined ? "first" : `${annotationDelta >= 0 ? "+" : ""}${annotationDelta}`}</span> : null}
      </header>
      {error ? <p className={styles.inlineError}>{error}{versions ? " Last loaded versions remain below." : ""}</p> : null}
      {loading && !versions ? <div className={styles.versionLedgerEmpty}><RefreshCw className={styles.spin} size={14} /> Loading saved versions</div> : latest ? (
        <div className={styles.versionRows}>
          {versions.versions.map((version, index) => (
            <article key={version.id}>
              <i>{String(index + 1).padStart(2, "0")}</i>
              <span><strong>{index === 0 ? "Current saved version" : `Earlier version ${index}`}</strong><small>{formatFeatureTime(version.savedAt)} · snapshot {version.snapshotSha256.slice(0, 10)}</small></span>
              <span><strong>{version.annotationCount}</strong><small>overlays</small></span>
              <span><strong>{version.candidateCount}</strong><small>review candidates</small></span>
              <ExactEvidence label={`Exact analysis ${version.id}`} value={version} />
            </article>
          ))}
        </div>
      ) : versions ? <div className={styles.versionLedgerEmpty}>No saved analysis was returned. Draw on the chart, choose the analysis layers, then save an immutable version.</div> : <p className={styles.versionLedgerEmpty}>Saved analysis availability is unconfirmed.</p>}
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
    case "buy_side_liquidity": return "Buy-side liquidity";
    case "sell_side_liquidity": return "Sell-side liquidity";
    case "session_killzone": return "Session / kill zone";
    case "opening_gap": return "Opening gap";
    case "quarterly_open": return "Quarterly open";
    case "reference_open": return "Calendar open";
    case "order_block": return "Order block";
    case "market_structure_shift": return "Market structure shift";
    case "turtle_soup": return "Turtle Soup";
    case "unicorn": return "Unicorn";
    case "judas_swing": return "Judas Swing";
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

function BacktestLab({
  instrument,
  bars,
  backtests,
  loading,
  error,
  job,
  onRun,
  disabledReason,
}: {
  instrument: MarketInstrument;
  bars?: MarketBarsResult;
  backtests?: MarketBacktestsResult;
  loading: boolean;
  error?: string;
  job?: MarketBackfillJob;
  onRun: (configuration: BacktestConfiguration) => void;
  disabledReason?: string;
}) {
  const [configuration, setConfiguration] = useState<BacktestConfiguration>({
    direction: "both",
    session: "all",
    rewardRiskRatio: 2,
    maxHoldingBars: 24,
    spreadBps: 2,
    slippageBps: 1,
    commissionBps: 0,
    riskPerTradeBps: 100,
  });
  const running = job && ["queued", "running"].includes(job.status);
  const [resultId, setResultId] = useState<string>();
  const latest = backtests?.backtests.find((result) => result.id === resultId) ?? backtests?.backtests[0];
  const progressStage = typeof job?.progress?.stage === "string"
    ? job.progress.stage.replaceAll("_", " ")
    : "unavailable";
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div>
          <p className={styles.eyebrow}>Retrospective research · {instrument.shortLabel}</p>
          <h2>Backtest lab</h2>
          <p>Replay one frozen liquidity-sweep strategy against the exact chart snapshot. Entry happens on the next bar, costs are explicit, and the last 20% stays held out.</p>
        </div>
        <span className={styles.stateBadge} data-state="foundation">Foundation strategy · v1</span>
      </header>

      <div className={styles.backtestComposer}>
        <div className={styles.backtestProtocol}>
          <Rocket size={24} />
          <strong>Liquidity-sweep reversal</strong>
          <p>A bar must trade beyond the exact prior 20-bar boundary and close back inside. Advanced OB, Unicorn, Judas Swing, and transcript rules remain excluded until reviewed.</p>
          <small>{bars ? `${bars.bars.length} ${bars.interval} bars · ${bars.snapshotSha256.slice(0, 12)}` : "Waiting for a verified snapshot"}</small>
          {bars ? <ExactEvidence label="Current backtest snapshot" value={{ snapshotId: bars.snapshotId, snapshotSha256: bars.snapshotSha256, instrumentId: bars.instrumentId, interval: bars.interval, provider: bars.provider, providerSymbol: bars.providerSymbol, asOf: bars.asOf }} /> : null}
        </div>
        <form
          className={styles.backtestForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (disabledReason || running || !bars?.bars.length) return;
            onRun(configuration);
          }}
        >
          <label>
            <span>Direction</span>
            <select
              value={configuration.direction}
              onChange={(event) => setConfiguration((current) => ({
                ...current,
                direction: event.target.value as BacktestConfiguration["direction"],
              }))}
            >
              <option value="both">Long + short</option>
              <option value="long_only">Long only</option>
              <option value="short_only">Short only</option>
            </select>
          </label>
          <label>
            <span>Session</span>
            <select
              value={configuration.session}
              onChange={(event) => setConfiguration((current) => ({
                ...current,
                session: event.target.value as BacktestConfiguration["session"],
              }))}
            >
              <option value="all">All sessions</option>
              <option value="london">London 02:00–05:00 ET</option>
              <option value="new_york_am">New York 07:00–10:00 ET</option>
            </select>
          </label>
          <NumberField label="Reward / risk" value={configuration.rewardRiskRatio} min={0.5} max={5} step={0.25} onChange={(value) => setConfiguration((current) => ({ ...current, rewardRiskRatio: value }))} />
          <NumberField label="Max bars held" value={configuration.maxHoldingBars} min={1} max={96} step={1} onChange={(value) => setConfiguration((current) => ({ ...current, maxHoldingBars: value }))} />
          <NumberField label="Spread · bps" value={configuration.spreadBps} min={0} max={100} step={0.1} onChange={(value) => setConfiguration((current) => ({ ...current, spreadBps: value }))} />
          <NumberField label="Slippage · bps" value={configuration.slippageBps} min={0} max={100} step={0.1} onChange={(value) => setConfiguration((current) => ({ ...current, slippageBps: value }))} />
          <NumberField label="Commission · bps" value={configuration.commissionBps} min={0} max={100} step={0.1} onChange={(value) => setConfiguration((current) => ({ ...current, commissionBps: value }))} />
          <NumberField label="Risk / trade · bps" value={configuration.riskPerTradeBps} min={1} max={500} step={1} onChange={(value) => setConfiguration((current) => ({ ...current, riskPerTradeBps: value }))} />
          <button type="submit" disabled={!bars?.bars.length || Boolean(running) || Boolean(disabledReason)}>
            {running ? <RefreshCw className={styles.spin} size={15} /> : <Rocket size={15} />}
            {running ? `Running · ${progressStage}` : "Run immutable backtest"}
          </button>
        </form>
      </div>

      {disabledReason ? <p className={styles.permissionReason}>{disabledReason}</p> : null}
      {error ? <div className={styles.inlineError} role="alert"><AlertTriangle size={15} />{error}</div> : null}
      <div className={styles.backtestAssurance}>
        <span><ShieldCheck size={14} /> 60 / 20 / 20 chronological slices</span>
        <span>Next-bar entry</span>
        <span>Stop-first collision</span>
        <span>Single position</span>
        <span>No model call</span>
      </div>

      {backtests ? <section className={styles.backtestHistory} aria-label="Backtest history"><h3>Stored backtests</h3><p>{backtests.backtests.length} returned · at most 20 results for this instrument.</p>{backtests.backtests.map((result) => <button type="button" key={result.id} aria-pressed={latest?.id === result.id} onClick={() => setResultId(result.id)}>{formatTime(result.createdAt)} · {result.interval} · {result.id}</button>)}</section> : null}
      {latest ? (
        <section className={styles.backtestLatest}>
          <header>
            <div><strong>Selected sealed result</strong><small>{formatFeatureTime(latest.createdAt)} · {latest.interval} · {latest.metrics.overall.trades} trades</small></div>
            <code>{latest.resultSha256.slice(0, 12)}</code>
          </header>
          <ExactEvidence label="Exact backtest result and configuration" value={latest} />
          <div className={styles.backtestMetrics}>
            <BacktestMetric label="Net result" value={`${signed(latest.metrics.overall.netR)}R`} detail={`Ending ${formatMoney(latest.metrics.overall.endingEquity)}`} />
            <BacktestMetric label="Win rate" value={formatRatio(latest.metrics.overall.winRate)} detail={`${latest.metrics.overall.wins} win · ${latest.metrics.overall.losses} loss`} />
            <BacktestMetric label="Expectancy" value={latest.metrics.overall.expectancyR === null ? "—" : `${signed(latest.metrics.overall.expectancyR)}R`} detail={`PF ${latest.metrics.overall.profitFactor?.toFixed(2) || "—"}`} />
            <BacktestMetric label="Max drawdown" value={`${latest.metrics.overall.maxDrawdownPercent.toFixed(1)}%`} detail="Fixed fractional risk" />
            <BacktestMetric label="Held-out test" value={`${signed(latest.metrics.test.netR)}R`} detail={`${latest.metrics.test.trades} trades · ${formatRatio(latest.metrics.test.winRate)}`} />
          </div>
          <div className={styles.backtestTradeList}>
            <header><strong>Last {Math.min(6, latest.trades.length)} of {latest.trades.length} trades</strong><small>Net of configured spread, slippage, and commission</small></header>
            {latest.trades.slice(-6).reverse().map((trade) => (
              <article key={trade.id} data-direction={trade.direction}>
                <span><strong>{trade.direction}</strong><small>{trade.split} · {trade.exitReason}</small></span>
                <time dateTime={trade.enteredAt}>{formatFeatureTime(trade.enteredAt)}</time>
                <span><strong>{signed(trade.netR)}R</strong><small>{trade.holdingBars} bar{trade.holdingBars === 1 ? "" : "s"}</small></span>
              </article>
            ))}
            {!latest.trades.length ? <p>No qualifying foundation signal occurred in this snapshot.</p> : null}
          </div>
          <div className={styles.backtestWarnings}>
            {latest.warnings.map((warning) => <p key={warning}><AlertTriangle size={13} />{warning}</p>)}
          </div>
        </section>
      ) : loading ? (
        <div className={styles.journalEmpty}><RefreshCw className={styles.spin} size={24} /><strong>Reading backtest ledger</strong><p>Results load independently from the chart.</p></div>
      ) : (
        <div className={styles.journalEmpty}><History size={26} /><strong>{backtests ? "No backtests returned" : "Backtest history unavailable"}</strong><p>{backtests ? "Run the foundation strategy against the current immutable snapshot. Stored results are bounded to the latest 20 for this instrument." : "Readiness and result counts are unconfirmed. Retry the history source above."}</p></div>
      )}
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function BacktestMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
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
  generationDisabledReason,
  scoreDisabledReason,
}: {
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
  journal?: MarketForecastJournalResult;
  loading: boolean;
  error?: string;
  action?: MarketForecastHorizon | "score";
  onGenerate: (horizon: MarketForecastHorizon) => void;
  onScore: () => void;
  generationDisabledReason?: string;
  scoreDisabledReason?: string;
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
          <button type="button" disabled={!ready || Boolean(action) || Boolean(generationDisabledReason)} onClick={() => onGenerate("daily")}>
            {action === "daily" ? <RefreshCw className={styles.spin} size={14} /> : <Sparkles size={14} />} Daily scenario
          </button>
          <button type="button" disabled={!ready || Boolean(action) || Boolean(generationDisabledReason)} onClick={() => onGenerate("weekly")}>
            {action === "weekly" ? <RefreshCw className={styles.spin} size={14} /> : <CalendarClock size={14} />} Weekly scenario
          </button>
          <button type="button" disabled={!journal?.scorecard.due || Boolean(action) || Boolean(scoreDisabledReason)} onClick={onScore}>
            {action === "score" ? <RefreshCw className={styles.spin} size={14} /> : <Gauge size={14} />} Score due
          </button>
        </span>
      </div>
      {generationDisabledReason ? <p className={styles.permissionReason}>Generation: {generationDisabledReason}</p> : null}
      {scoreDisabledReason ? <p className={styles.permissionReason}>Scoring: {scoreDisabledReason}</p> : null}
      {error ? <div className={styles.inlineError} role="alert"><AlertTriangle size={15} />{error}</div> : null}
      <div className={styles.journalLayout}>
        <div className={styles.scoreFrame}>
          <header><span><Gauge size={17} /> Forward scorecard</span><small>{journal ? `${journal.scorecard.resolved} resolved · ${journal.scorecard.due} due` : "Counts unavailable"}</small></header>
          <div>
            <Metric label="Directional accuracy" value={formatRatio(journal?.scorecard.directionalAccuracy)} detail={journal ? `${journal.scorecard.directionalSampleSize} directional calls` : "Sample count unavailable"} />
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
        {!loading && journal && !journal.entries.length ? <div className={styles.journalEmpty}><History size={26} /><strong>No frozen forecasts yet</strong><p>Create the next daily or weekly research window. The first result is permanent and cannot be rewritten after seeing the outcome.</p></div> : null}
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
            <ExactEvidence label={`Exact forecast ${entry.forecast.id} and outcome`} value={entry} />
            <p className={styles.forecastSummary}>{entry.forecast.summary}</p>
            <div className={styles.scenarioGrid}>
              {entry.forecast.scenarios.map((scenario) => (
                <section key={scenario.direction} data-direction={scenario.direction}>
                  <span>#{scenario.rank} · {scenario.direction}</span>
                  <p>{scenario.thesis}</p>
                  <p>{scenario.targets.length ? `Targets: ${scenario.targets.map((target) => formatPrice(target, instrument.instrumentId)).join(", ")}` : "No justified target"}</p>
                  <p>{scenario.invalidation ? `Invalidation ${formatPrice(scenario.invalidation.price, instrument.instrumentId)} · ${scenario.invalidation.rationale}` : "No justified invalidation level"}</p>
                  <small>{scenario.observationZone ? `Observe ${formatPrice(scenario.observationZone.low, instrument.instrumentId)}–${formatPrice(scenario.observationZone.high, instrument.instrumentId)}` : "No justified observation zone"}</small>
                </section>
              ))}
            </div>
            <div className={styles.guardrailList}>{entry.forecast.warnings.map((warning) => <p key={warning}><AlertTriangle size={14} />{warning}</p>)}</div>
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
  return value === null || value === undefined ? "Unavailable" : `${Math.round(value * 1_000) / 10}%`;
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

function ChartDeferred({ onActivate }: { onActivate: () => void }) {
  return (
    <div className={styles.chartEmpty}>
      <Rocket size={25} />
      <strong>Live chart is ready on demand</strong>
      <p>Load the selected instrument and interval to inspect provider-labelled prices and draw on the chart.</p>
      <div className={styles.labButtons}>
        <button type="button" onClick={onActivate}>
          Load live chart <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

function ChartEmpty({ mappingRequired, providerReady, error }: { mappingRequired: boolean; providerReady: boolean; error?: string }) {
  return (
    <div className={styles.chartEmpty}>
      {error ? <AlertTriangle size={25} /> : mappingRequired ? <Waypoints size={25} /> : <Activity size={25} />}
      <strong>{error ? "Price feed unavailable" : mappingRequired ? "Exact feed mapping required" : providerReady ? "Waiting for provider bars" : "Connect the market-data feed"}</strong>
      <p>{error || (mappingRequired
        ? "Choose the exact broker CFD, cash index, or futures contract before this instrument can be charted or backtested."
        : providerReady
          ? "The provider is configured. Use Refresh current view to request this instrument again."
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
