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
  Layers3,
  RefreshCw,
  Rocket,
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
  { id: "backtests", label: "Backtest lab", description: "Leakage-safe replay" },
  { id: "journal", label: "Forecast journal", description: "Frozen predictions and scoring" },
];

export function MarketResearchWorkspace() {
  const [overview, setOverview] = useState<MarketResearchOverview>();
  const [selectedId, setSelectedId] = useState<MarketInstrumentId>("xauusd.spot");
  const [interval, setInterval] = useState<MarketInterval>("15min");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [bars, setBars] = useState<MarketBarsResult>();
  const [events, setEvents] = useState<MarketEventsResult>();
  const [liveCalendar, setLiveCalendar] = useState<MarketLiveCalendarResult>();
  const [replays, setReplays] = useState<MarketEventReplaysResult>();
  const [baselinesByInstrument, setBaselinesByInstrument] = useState<
    Partial<Record<MarketInstrumentId, MarketEventBaselinesResult>>
  >({});
  const [backfillJob, setBackfillJob] = useState<MarketBackfillJob>();
  const [replayJobs, setReplayJobs] = useState<
    Partial<Record<MarketInstrumentId, MarketBackfillJob>>
  >({});
  const [features, setFeatures] = useState<MarketTechnicalFeaturesResult>();
  const [loading, setLoading] = useState(true);
  const [barsLoading, setBarsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [barsError, setBarsError] = useState<string>();
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string>();
  const [liveCalendarLoading, setLiveCalendarLoading] = useState(false);
  const [liveCalendarError, setLiveCalendarError] = useState<string>();
  const [replaysLoading, setReplaysLoading] = useState(false);
  const [replayError, setReplayError] = useState<string>();
  const [baselinesLoading, setBaselinesLoading] = useState(false);
  const [baselinesError, setBaselinesError] = useState<string>();
  const [featuresLoading, setFeaturesLoading] = useState(false);
  const [featuresError, setFeaturesError] = useState<string>();
  const [visibleTechnicalLayers, setVisibleTechnicalLayers] = useState<MarketTechnicalLayerId[]>([]);
  const [analysisVersions, setAnalysisVersions] = useState<MarketAnalysisVersionsResult>();
  const [analysisVersionsLoading, setAnalysisVersionsLoading] = useState(false);
  const [analysisVersionsError, setAnalysisVersionsError] = useState<string>();
  const [journal, setJournal] = useState<MarketForecastJournalResult>();
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalError, setJournalError] = useState<string>();
  const [journalAction, setJournalAction] = useState<MarketForecastHorizon | "score">();
  const [backtests, setBacktests] = useState<MarketBacktestsResult>();
  const [backtestsLoading, setBacktestsLoading] = useState(false);
  const [backtestsError, setBacktestsError] = useState<string>();
  const [backtestJob, setBacktestJob] = useState<MarketBackfillJob>();
  const [backtestJobInstrumentId, setBacktestJobInstrumentId] = useState<MarketInstrumentId>();

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
  const baselines = baselinesByInstrument[selectedId];
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
      const response = await fetch("/api/market-research/events?limit=500", {
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

  const loadLiveCalendar = useCallback(async (signal?: AbortSignal) => {
    setLiveCalendarLoading(true);
    setLiveCalendarError(undefined);
    try {
      const response = await fetch("/api/market-research/calendar?days=14", {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketLiveCalendarResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Official market calendar could not load.");
      setLiveCalendar(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setLiveCalendarError(loadError instanceof Error ? loadError.message : "Official market calendar could not load.");
    } finally {
      if (!signal?.aborted) setLiveCalendarLoading(false);
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
      setVisibleTechnicalLayers(
        payload.layers.filter((layer) => layer.defaultVisible).map((layer) => layer.id),
      );
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setFeatures(undefined);
      setFeaturesError(loadError instanceof Error ? loadError.message : "Technical features could not load.");
    } finally {
      if (!signal?.aborted) setFeaturesLoading(false);
    }
  }, []);

  const loadAnalysisVersions = useCallback(async (
    instrumentId: MarketInstrumentId,
    requestedInterval: MarketInterval,
    signal?: AbortSignal,
  ) => {
    setAnalysisVersionsLoading(true);
    setAnalysisVersionsError(undefined);
    try {
      const query = new URLSearchParams({
        instrumentId,
        interval: requestedInterval,
        limit: "8",
      });
      const response = await fetch(`/api/market-research/analysis?${query}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketAnalysisVersionsResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Saved analyses could not load.");
      setAnalysisVersions(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setAnalysisVersionsError(loadError instanceof Error ? loadError.message : "Saved analyses could not load.");
    } finally {
      if (!signal?.aborted) setAnalysisVersionsLoading(false);
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
      setBaselinesByInstrument((current) => ({
        ...current,
        [instrumentId]: payload,
      }));
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
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

  const loadBacktests = useCallback(async (
    instrumentId: MarketInstrumentId,
    signal?: AbortSignal,
  ) => {
    setBacktestsLoading(true);
    setBacktestsError(undefined);
    try {
      const query = new URLSearchParams({ instrumentId, limit: "20" });
      const response = await fetch(`/api/market-research/backtests?${query}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json() as MarketBacktestsResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Backtest history could not load.");
      setBacktests(payload);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setBacktests(undefined);
      setBacktestsError(loadError instanceof Error ? loadError.message : "Backtest history could not load.");
    } finally {
      if (!signal?.aborted) setBacktestsLoading(false);
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
    if (activeTab !== "events" || liveCalendar) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadLiveCalendar(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, liveCalendar, loadLiveCalendar]);

  useEffect(() => {
    if (activeTab !== "events") return;
    const timer = window.setInterval(() => void loadLiveCalendar(), 5 * 60 * 1_000);
    return () => window.clearInterval(timer);
  }, [activeTab, loadLiveCalendar]);

  useEffect(() => {
    if (activeTab !== "events") return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void Promise.all([
        loadReplays(selectedId, controller.signal),
        loadBaselines("xauusd.spot", controller.signal),
        loadBaselines("ndx.cash", controller.signal),
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
      const importedEventKeys = new Set(events?.events.map(({ eventKey }) => eventKey));
      const catalogExpansionRequired = liveCalendar?.catalog.families.some(
        ({ eventKey, historyCoverage }) =>
          historyCoverage === "fred_release_dates" && !importedEventKeys.has(eventKey),
      ) === true;
      const response = await fetch("/api/market-research/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `market-events-${Date.now()}`,
        },
        body: JSON.stringify({
          startDate: events?.total && !catalogExpansionRequired
            ? utcDateDaysAgo(120)
            : "2000-01-01",
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
  }, [events, liveCalendar]);

  const startReplayBackfill = useCallback(async () => {
    setReplayError(undefined);
    const targets = (overview?.instruments || []).filter(
      ({ providerMapping }) => providerMapping.status === "verified",
    );
    const queued = await Promise.allSettled(targets.map(async ({ instrumentId }) => {
      const response = await fetch("/api/market-research/replays", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `market-replays-${instrumentId}-${Date.now()}`,
        },
        body: JSON.stringify({
          instrumentId,
          interval: "5min",
          startDate: "2000-01-01",
          endDate: new Date().toISOString().slice(0, 10),
          maxEvents: 24,
        }),
      });
      const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error || `${instrumentId} replay backfill could not be queued.`);
      }
      return { instrumentId, job: payload.job };
    }));
    const successful = queued.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    if (successful.length) {
      setReplayJobs((current) => ({
        ...current,
        ...Object.fromEntries(successful.map(({ instrumentId, job }) => [instrumentId, job])),
      }));
    }
    const failed = queued.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      setReplayError(failed.reason instanceof Error ? failed.reason.message : "A market replay backfill could not be queued.");
    }
  }, [overview?.instruments]);

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
    const activeJobs = Object.entries(replayJobs).filter(([, job]) =>
      job && ["queued", "running"].includes(job.status)
    ) as Array<[MarketInstrumentId, MarketBackfillJob]>;
    if (!activeJobs.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const updates = await Promise.all(activeJobs.map(async ([instrumentId, job]) => {
          const response = await fetch(`/api/operations/jobs/${job.id}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
          if (!response.ok || !payload.job) throw new Error(payload.error || "Replay progress is unavailable.");
          return [instrumentId, payload.job] as const;
        }));
        setReplayJobs((current) => ({ ...current, ...Object.fromEntries(updates) }));
        if (updates.some(([, job]) => job.status === "completed")) {
          await Promise.all([
            loadReplays(selectedId, controller.signal),
            loadBaselines("xauusd.spot", controller.signal),
            loadBaselines("ndx.cash", controller.signal),
          ]);
        }
        const failed = updates.find(([, job]) => job.status === "failed")?.[1];
        if (failed) {
          setReplayError(failed.lastError || "Market replay backfill did not complete.");
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
  }, [loadBaselines, loadReplays, replayJobs, selectedId]);

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
    if (activeTab !== "technicals") return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadAnalysisVersions(selectedId, interval, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, interval, loadAnalysisVersions, selectedId]);

  const toggleTechnicalLayer = useCallback((layerId: MarketTechnicalLayerId) => {
    setVisibleTechnicalLayers((current) => current.includes(layerId)
      ? current.filter((item) => item !== layerId)
      : [...current, layerId]);
  }, []);

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

  useEffect(() => {
    if (activeTab !== "backtests") return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadBacktests(selectedId, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, loadBacktests, selectedId]);

  const runBacktest = useCallback(async (configuration: BacktestConfiguration) => {
    if (!bars?.snapshotId || bars.instrumentId !== selectedId) {
      setBacktestsError("Load a verified immutable price snapshot first.");
      return;
    }
    setBacktestsError(undefined);
    try {
      const response = await fetch("/api/market-research/backtests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `market-backtest-${bars.snapshotId}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          snapshotId: bars.snapshotId,
          strategy: {
            strategyId: "foundation.liquidity_sweep_reversal.v1",
            direction: configuration.direction,
            session: configuration.session,
            rewardRiskRatio: configuration.rewardRiskRatio,
            maxHoldingBars: configuration.maxHoldingBars,
            stopBufferRangeMultiplier: 0.1,
          },
          costs: {
            spreadBps: configuration.spreadBps,
            slippageBps: configuration.slippageBps,
            commissionBps: configuration.commissionBps,
          },
          initialEquity: 10_000,
          riskPerTradeBps: configuration.riskPerTradeBps,
        }),
      });
      const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
      if (!response.ok || !payload.job) {
        throw new Error(payload.error || "Backtest could not be queued.");
      }
      setBacktestJob(payload.job);
      setBacktestJobInstrumentId(selectedId);
    } catch (queueError) {
      setBacktestsError(queueError instanceof Error ? queueError.message : "Backtest could not be queued.");
    }
  }, [bars, selectedId]);

  useEffect(() => {
    if (!backtestJob || !["queued", "running"].includes(backtestJob.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/operations/jobs/${backtestJob.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { job?: MarketBackfillJob; error?: string };
        if (!response.ok || !payload.job) {
          throw new Error(payload.error || "Backtest progress is unavailable.");
        }
        setBacktestJob(payload.job);
        if (payload.job.status === "completed") {
          if (backtestJobInstrumentId === selectedId) {
            await loadBacktests(selectedId, controller.signal);
          }
        } else if (payload.job.status === "failed") {
          setBacktestsError(payload.job.lastError || "Backtest did not complete.");
        }
      } catch (pollError) {
        if (pollError instanceof DOMException && pollError.name === "AbortError") return;
        setBacktestsError(pollError instanceof Error ? pollError.message : "Backtest progress is unavailable.");
      }
    }, 2_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [backtestJob, backtestJobInstrumentId, loadBacktests, selectedId]);

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
            hidden={activeTab !== "overview" && activeTab !== "technicals"}
            technicalMode={activeTab === "technicals"}
            instrument={selected}
            overview={overview}
            events={events}
            bars={bars}
            barsLoading={barsLoading}
            barsError={barsError}
            interval={interval}
            onIntervalChange={setInterval}
            features={features}
            visibleTechnicalLayers={visibleTechnicalLayers}
            onToggleTechnicalLayer={toggleTechnicalLayer}
            onAnalysisSaved={() => void loadAnalysisVersions(selectedId, interval)}
          />
          {activeTab === "events" ? (
            <NewsImpactLab
              instrument={selected}
              overview={overview}
              events={events}
              liveCalendar={liveCalendar}
              liveCalendarLoading={liveCalendarLoading}
              liveCalendarError={liveCalendarError}
              loading={eventsLoading}
              error={eventsError}
              backfillJob={backfillJob}
              replays={replays}
              baselines={baselines}
              baselinesByInstrument={baselinesByInstrument}
              replaysLoading={replaysLoading}
              baselinesLoading={baselinesLoading}
              replayError={replayError}
              baselinesError={baselinesError}
              replayJobs={replayJobs}
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
              versions={analysisVersions}
              versionsLoading={analysisVersionsLoading}
              versionsError={analysisVersionsError}
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
          {activeTab === "backtests" ? (
            <BacktestLab
              instrument={selected}
              bars={bars?.instrumentId === selectedId ? bars : undefined}
              backtests={backtests?.instrumentId === selectedId ? backtests : undefined}
              loading={backtestsLoading}
              error={backtestsError || barsError}
              job={backtestJobInstrumentId === selectedId ? backtestJob : undefined}
              onRun={runBacktest}
            />
          ) : null}
        </>
      ) : loading ? <WorkspaceSkeleton /> : null}
    </main>
  );
}

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
  features,
  visibleTechnicalLayers,
  onToggleTechnicalLayer,
  onAnalysisSaved,
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
  features?: MarketTechnicalFeaturesResult;
  visibleTechnicalLayers: MarketTechnicalLayerId[];
  onToggleTechnicalLayer: (layerId: MarketTechnicalLayerId) => void;
  onAnalysisSaved: () => void;
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
  const matchingFeatures = features?.snapshot.id === bars?.snapshotId
    ? features
    : undefined;

  return (
    <section className={styles.workspace} hidden={hidden}>
      <div className={styles.primaryPlane}>
        <div className={styles.instrumentHeader}>
          <div>
            <p className={styles.eyebrow}>{technicalMode ? "Evidence-bound drawing canvas" : "Canonical research instrument"}</p>
            <h2>{instrument.label}</h2>
            <p>{technicalMode ? "System overlays are locked, versioned detector output. Your own TradingView drawings remain separate and editable." : instrument.identityWarning}</p>
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
          <Metric
            label="ICT structure"
            value={matchingFeatures ? `${matchingFeatures.counts.setupCandidates} setups` : "Not run"}
            detail={matchingFeatures ? `${matchingFeatures.annotations.length} typed overlays` : "Open ICT + Quarterly"}
          />
        </div>

        <div className={styles.chartPanel}>
          <header>
            <div>
              <span><ChartCandlestick size={16} /> {technicalMode ? "ICT + Quarterly analysis canvas" : "Provider-labelled price context"}</span>
              <small>{bars ? `${bars.providerSymbol} · ${bars.providerTimezone} · ${bars.bars.length} bars · ${bars.snapshotSource === "cache" ? "reused" : "new"} snapshot ${bars.snapshotSha256.slice(0, 10)}` : "No proxy data is shown"}</small>
            </div>
            <div className={styles.intervalPicker} aria-label="Chart interval">
              {MARKET_INTERVALS.map((item) => (
                <button key={item} type="button" aria-pressed={item === interval} onClick={() => onIntervalChange(item)}>{item}</button>
              ))}
            </div>
          </header>
          {technicalMode && matchingFeatures ? (
            <div className={styles.layerBar} aria-label="Analysis drawing layers">
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
                    onClick={() => onToggleTechnicalLayer(layer.id)}
                    title={layer.description}
                  >
                    <i data-layer={layer.id} /> {layer.label} <em>{layer.count}</em>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className={styles.chartBody}>
            {hasMatchingBars && bars ? (
              <PriceChart
                instrument={instrument}
                bars={bars}
                features={technicalMode ? matchingFeatures : undefined}
                visibleLayerIds={technicalMode ? visibleTechnicalLayers : undefined}
                onAnalysisSaved={onAnalysisSaved}
              />
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
          <p>{focus ? focus.whyItMatters : "Loading the reviewed official U.S. release calendar."}</p>
        </div>
        <span data-live={today.length > 0}>
          <i /> {today.length ? `${today.length} today` : `${calendar?.events.length || 0} next 14 days`}
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
                    <span><strong>{label}</strong><small>{baseline ? `${baseline.sampleSize} releases` : "History not built"}</small></span>
                    <span><small>60m median</small><strong>{baseline?.post60m.medianBps == null ? "—" : formatSignedBps(baseline.post60m.medianBps)}</strong></span>
                    <span><small>Observed split</small><strong>{baseline ? `${Math.round(baseline.empiricalRates.up * 100)}% up · ${Math.round(baseline.empiricalRates.down * 100)}% down` : "Build replays"}</strong></span>
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
      ) : !loading ? <div className={styles.liveEventEmpty}>No reviewed exact-time release is scheduled in the next {calendar?.windowDays || 14} days.</div> : null}

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
}) {
  const calendar = overview?.providers.find((provider) => provider.provider === "bls");
  const vintage = overview?.providers.find((provider) => provider.provider === "fred");
  const importing = backfillJob && ["queued", "running"].includes(backfillJob.status);
  const importedEventKeys = new Set(events?.events.map(({ eventKey }) => eventKey));
  const catalogExpansionRequired = liveCalendar?.catalog.families.some(
    ({ eventKey, historyCoverage }) =>
      historyCoverage === "fred_release_dates" && !importedEventKeys.has(eventKey),
  ) === true;
  const completedSources = numberProgress(backfillJob?.progress?.completedSources);
  const totalSources = numberProgress(backfillJob?.progress?.totalSources);
  const activeReplayJobs = Object.values(replayJobs).filter((job) =>
    job && ["queued", "running"].includes(job.status)
  );
  const replaying = activeReplayJobs.length > 0;
  const completedEvents = activeReplayJobs.reduce(
    (sum, job) => sum + numberProgress(job?.progress?.completedEvents),
    0,
  );
  const totalEvents = activeReplayJobs.reduce(
    (sum, job) => sum + numberProgress(job?.progress?.totalEvents),
    0,
  );
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
              {importing
                ? `Importing ${completedSources}/${totalSources || "…"}`
                : catalogExpansionRequired
                  ? `Expand to ${liveCalendar?.catalog.reviewedFamilies || 18} families`
                  : events?.total
                    ? "Refresh history"
                    : "Import history"}
            </button>
            <button type="button" onClick={onReplayBackfill} disabled={Boolean(replaying) || instrument.providerMapping.status !== "verified" || !events?.total}>
              <ChartCandlestick size={15} />
              {replaying ? `Replaying ${completedEvents}/${totalEvents || "…"}` : "Build next 24 × both markets"}
            </button>
          </div>
        </div>
      </header>

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

          <AnalysisVersionLedger
            versions={versions}
            loading={versionsLoading}
            error={versionsError}
          />

          <div className={styles.technicalPanels}>
            <section className={styles.detectionPanel}>
              <header><div><strong>Latest detected structure</strong><span>{current.detections.length} bounded observations</span></div><small>Newest first</small></header>
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
        <div><strong>Private analysis ledger</strong><small>{versions?.total || 0} immutable versions · latest drawings restore automatically</small></div>
        {latest ? <span>Δ overlays {annotationDelta === undefined ? "first" : `${annotationDelta >= 0 ? "+" : ""}${annotationDelta}`}</span> : null}
      </header>
      {error ? <div className={styles.versionLedgerEmpty}>{error}</div> : loading && !versions ? <div className={styles.versionLedgerEmpty}><RefreshCw className={styles.spin} size={14} /> Loading saved versions</div> : latest ? (
        <div className={styles.versionRows}>
          {versions.versions.map((version, index) => (
            <article key={version.id}>
              <i>{String(index + 1).padStart(2, "0")}</i>
              <span><strong>{index === 0 ? "Current saved version" : `Earlier version ${index}`}</strong><small>{formatFeatureTime(version.savedAt)} · snapshot {version.snapshotSha256.slice(0, 10)}</small></span>
              <span><strong>{version.annotationCount}</strong><small>overlays</small></span>
              <span><strong>{version.candidateCount}</strong><small>review candidates</small></span>
              <code>{version.versionSha256.slice(0, 12)}</code>
            </article>
          ))}
        </div>
      ) : <div className={styles.versionLedgerEmpty}>Draw on the chart, choose the analysis layers, then save the first immutable version.</div>}
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
}: {
  instrument: MarketInstrument;
  bars?: MarketBarsResult;
  backtests?: MarketBacktestsResult;
  loading: boolean;
  error?: string;
  job?: MarketBackfillJob;
  onRun: (configuration: BacktestConfiguration) => void;
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
  const latest = backtests?.backtests[0];
  const progressStage = typeof job?.progress?.stage === "string"
    ? job.progress.stage.replaceAll("_", " ")
    : "queued";
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
        </div>
        <form
          className={styles.backtestForm}
          onSubmit={(event) => {
            event.preventDefault();
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
          <button type="submit" disabled={!bars || Boolean(running)}>
            {running ? <RefreshCw className={styles.spin} size={15} /> : <Rocket size={15} />}
            {running ? `Running · ${progressStage}` : "Run immutable backtest"}
          </button>
        </form>
      </div>

      {error ? <div className={styles.inlineError} role="alert"><AlertTriangle size={15} />{error}</div> : null}
      <div className={styles.backtestAssurance}>
        <span><ShieldCheck size={14} /> 60 / 20 / 20 chronological slices</span>
        <span>Next-bar entry</span>
        <span>Stop-first collision</span>
        <span>Single position</span>
        <span>No model call</span>
      </div>

      {latest ? (
        <section className={styles.backtestLatest}>
          <header>
            <div><strong>Latest sealed result</strong><small>{formatFeatureTime(latest.createdAt)} · {latest.interval} · {latest.metrics.overall.trades} trades</small></div>
            <code>{latest.resultSha256.slice(0, 12)}</code>
          </header>
          <div className={styles.backtestMetrics}>
            <BacktestMetric label="Net result" value={`${signed(latest.metrics.overall.netR)}R`} detail={`Ending ${formatMoney(latest.metrics.overall.endingEquity)}`} />
            <BacktestMetric label="Win rate" value={formatRatio(latest.metrics.overall.winRate)} detail={`${latest.metrics.overall.wins} win · ${latest.metrics.overall.losses} loss`} />
            <BacktestMetric label="Expectancy" value={latest.metrics.overall.expectancyR === null ? "—" : `${signed(latest.metrics.overall.expectancyR)}R`} detail={`PF ${latest.metrics.overall.profitFactor?.toFixed(2) || "—"}`} />
            <BacktestMetric label="Max drawdown" value={`${latest.metrics.overall.maxDrawdownPercent.toFixed(1)}%`} detail="Fixed fractional risk" />
            <BacktestMetric label="Held-out test" value={`${signed(latest.metrics.test.netR)}R`} detail={`${latest.metrics.test.trades} trades · ${formatRatio(latest.metrics.test.winRate)}`} />
          </div>
          <div className={styles.backtestTradeList}>
            <header><strong>Last trades</strong><small>Net of configured spread, slippage, and commission</small></header>
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
        <div className={styles.journalEmpty}><History size={26} /><strong>No backtests yet</strong><p>Run the foundation strategy against the current immutable snapshot. Every result remains visible for comparison.</p></div>
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
