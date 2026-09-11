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
  type MarketInstrument,
  type MarketInstrumentId,
  type MarketInterval,
  type MarketResearchOverview,
} from "@/lib/market-research/contracts";
import styles from "@/components/market-research/market-research-workspace.module.css";

type WorkspaceTab = "overview" | "events" | "technicals" | "journal";

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
  const [loading, setLoading] = useState(true);
  const [barsLoading, setBarsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [barsError, setBarsError] = useState<string>();

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
  const marketProviderReady = overview?.providers.find((provider) =>
    provider.provider === "twelve_data"
  )?.configured === true;

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
              bars={bars}
              barsLoading={barsLoading}
              barsError={barsError}
              interval={interval}
              onIntervalChange={setInterval}
            />
          ) : null}
          {activeTab === "events" ? <NewsImpactLab instrument={selected} overview={overview} /> : null}
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
  bars,
  barsLoading,
  barsError,
  interval,
  onIntervalChange,
}: {
  instrument: MarketInstrument;
  overview?: MarketResearchOverview;
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
  const provider = overview?.providers.find((item) => item.provider === "twelve_data");

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
          <Metric label="High-impact events" value="Unavailable" detail="Calendar not connected" />
          <Metric label="ICT confluence" value="Not run" detail="Detector foundation" />
        </div>

        <div className={styles.chartPanel}>
          <header>
            <div>
              <span><ChartCandlestick size={16} /> Provider-labelled price context</span>
              <small>{bars ? `${bars.providerSymbol} · ${bars.providerTimezone} · ${bars.bars.length} bars` : "No proxy data is shown"}</small>
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
          <header><span><Database size={16} /> Research inputs</span><small>{overview?.providers.filter((item) => item.configured).length || 0}/3 connected</small></header>
          <div>
            {(overview?.providers || []).map((item) => (
              <article key={item.provider}>
                <i data-ready={item.configured}>{item.configured ? <Check size={12} /> : <CircleDashed size={12} />}</i>
                <span><strong>{item.label}</strong><small>{item.purpose}</small></span>
                <em>{item.configured ? "Connected" : item.blocking ? "Required" : "Recommended"}</em>
              </article>
            ))}
          </div>
        </section>
      </aside>
    </section>
  );
}

function NewsImpactLab({ instrument, overview }: { instrument: MarketInstrument; overview?: MarketResearchOverview }) {
  const calendar = overview?.providers.find((provider) => provider.provider === "trading_economics");
  const vintage = overview?.providers.find((provider) => provider.provider === "fred");
  return (
    <section className={styles.lab}>
      <header className={styles.labHeader}>
        <div><p className={styles.eyebrow}>Event study · {instrument.shortLabel}</p><h2>News impact lab</h2><p>Replay high-impact releases against immutable pre- and post-event windows, then compare the observed move with the surprise, revision, liquidity regime, and ICT context.</p></div>
        <div className={styles.labReadiness}><span data-ready={calendar?.configured}><i /> Calendar</span><span data-ready={vintage?.configured}><i /> Vintages</span></div>
      </header>
      <div className={styles.pipeline}>
        {[
          ["01", "Normalize", "Provider events → high impact"],
          ["02", "Freeze", "Consensus and prior vintage"],
          ["03", "Measure", "Pre/post return + volatility"],
          ["04", "Explain", "Macro + ICT evidence"],
          ["05", "Calibrate", "Comparable-event outcomes"],
        ].map(([number, title, detail]) => <article key={number}><span>{number}</span><strong>{title}</strong><small>{detail}</small><ChevronRight size={15} /></article>)}
      </div>
      <div className={styles.eventTable}>
        <header><span>Historical high-impact releases</span><small>Actual, previous, consensus, revision, and market windows</small></header>
        <div className={styles.tableHead}><span>Release</span><span>Surprise</span><span>Pre-event</span><span>Post-event</span><span>Attribution</span></div>
        <div className={styles.tableEmpty}><CalendarClock size={24} /><strong>No event history imported yet</strong><p>Connect Trading Economics and FRED/ALFRED, then the backfill worker can build the event study without blocking this page.</p></div>
      </div>
    </section>
  );
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
          : "Add the Twelve Data credential to load indicative XAU/USD bars. No sample prices are substituted.")}</p>
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
    cfd: "Broker CFD",
  } as const)[instrument.assetClass];
}
