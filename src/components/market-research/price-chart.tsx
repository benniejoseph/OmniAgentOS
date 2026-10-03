"use client";

import { AlertTriangle, Check, RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MarketAnalysisSubmission } from "./market-research-workspace-state";

import styles from "@/components/market-research/market-research-workspace.module.css";
import type {
  MarketAnalysisVersion,
  MarketBarsResult,
  MarketInstrument,
  MarketSerializedChartState,
  MarketTechnicalFeaturesResult,
  MarketTechnicalLayerId,
} from "@/lib/market-research/contracts";
import {
  createAsaelTradingViewDatafeed,
  marketIntervalToTradingViewResolution,
  TRADINGVIEW_LIBRARY_PATH,
  TRADINGVIEW_LIBRARY_SCRIPT,
  TRADINGVIEW_LIBRARY_VERSION,
  type AsaelTradingViewDatafeed,
  type TradingViewMarketSnapshot,
} from "@/lib/market-research/tradingview-datafeed";

type TradingViewWidget = {
  changeTheme: (theme: "light" | "dark") => Promise<void>;
  applyOverrides: (overrides: Record<string, boolean | string | number>) => void;
  chartReady: () => Promise<void>;
  activeChart: () => {
    resetData: () => void;
    setSymbol: (symbol: string) => Promise<boolean>;
    setResolution: (resolution: string) => Promise<boolean>;
    createShape: (
      point: ChartPoint,
      options: ChartShapeOptions,
    ) => Promise<string | number>;
    createMultipointShape: (
      points: ChartPoint[],
      options: ChartShapeOptions,
    ) => Promise<string | number>;
    removeEntity: (id: string | number) => void;
    getLineToolsState: () => TradingViewLineToolsState;
    applyLineToolsState: (state: TradingViewLineToolsState) => Promise<void>;
  };
  remove: () => void;
};

type TradingViewWidgetConstructor = new (options: {
  container: HTMLElement;
  datafeed: AsaelTradingViewDatafeed;
  library_path: string;
  symbol: string;
  interval: string;
  locale: "en";
  timezone: string;
  autosize: true;
  fullscreen: false;
  theme: "light" | "dark";
  disabled_features: string[];
  enabled_features: string[];
  loading_screen: { backgroundColor: string; foregroundColor: string };
  overrides: Record<string, boolean | string | number>;
}) => TradingViewWidget;

type TradingViewWindow = Window & {
  TradingView?: { widget: TradingViewWidgetConstructor };
};

type ChartPoint = { time: number; price: number };
type ChartShapeOptions = {
  shape: string;
  text?: string;
  lock: boolean;
  disableSelection: boolean;
  disableSave: boolean;
  disableUndo: boolean;
  showInObjectsTree: boolean;
  zOrder?: "top" | "bottom";
  overrides?: Record<string, boolean | string | number>;
};
type TradingViewLineToolsState = {
  sources: Map<string | number, unknown | null> | null;
  groups: Map<string, unknown | null>;
  symbol?: string;
};

let chartLibraryPromise: Promise<TradingViewWidgetConstructor> | undefined;

export function PriceChart({
  instrument,
  bars,
  latestAnalysis,
  features,
  visibleLayerIds,
  onSaveAnalysis,
  disabledReason,
}: {
  instrument: MarketInstrument;
  bars: MarketBarsResult;
  latestAnalysis?: MarketAnalysisVersion;
  features?: MarketTechnicalFeaturesResult;
  visibleLayerIds?: readonly MarketTechnicalLayerId[];
  onSaveAnalysis: (snapshot: MarketBarsResult, submitted: MarketAnalysisSubmission) => Promise<MarketAnalysisVersion | undefined>;
  disabledReason?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TradingViewWidget | undefined>(undefined);
  const readyRef = useRef(false);
  const systemShapeIdsRef = useRef<Array<string | number>>([]);
  const overlayRevisionRef = useRef(0);
  const activeSnapshotRef = useRef<TradingViewMarketSnapshot>({ instrument, bars });
  const latestAnalysisRef = useRef(latestAnalysis);
  const restoredAnalysisIdRef = useRef<string | undefined>(undefined);
  const appliedSnapshotRef = useRef({
    instrumentId: instrument.instrumentId,
    snapshotId: bars.snapshotId,
    interval: bars.interval,
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [overlayState, setOverlayState] = useState<"idle" | "rendering" | "ready" | "partial">("idle");
  const [overlayFailureCount, setOverlayFailureCount] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedLabel, setSavedLabel] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [themeRevision, setThemeRevision] = useState(0);
  const [forcedColors, setForcedColors] = useState(false);
  const [tablePage, setTablePage] = useState(0);
  const [themeError, setThemeError] = useState(false);
  const [restoreError, setRestoreError] = useState(false);
  const saveAttemptRef = useRef<object | undefined>(undefined);
  const themeQueueRef = useRef(Promise.resolve());
  useEffect(() => {
    const update = () => { setThemeRevision((value) => value + 1); setForcedColors(window.matchMedia("(forced-colors: active)").matches); };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const contrast = window.matchMedia("(forced-colors: active)");
    contrast.addEventListener("change", update);
    update();
    return () => { observer.disconnect(); contrast.removeEventListener("change", update); saveAttemptRef.current = undefined; };
  }, []);
  useEffect(() => {
    latestAnalysisRef.current = latestAnalysis;
  }, [latestAnalysis]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    readyRef.current = false;
    setStatus("loading");

    void loadTradingViewLibrary().then((Widget) => {
      if (disposed) return;
      const snapshot = activeSnapshotRef.current;
      const palette = chartPalette();
      appliedSnapshotRef.current = {
        instrumentId: snapshot.instrument.instrumentId,
        snapshotId: snapshot.bars.snapshotId,
        interval: snapshot.bars.interval,
      };
      const widget = new Widget({
        container,
        datafeed: createAsaelTradingViewDatafeed(() => activeSnapshotRef.current),
        library_path: TRADINGVIEW_LIBRARY_PATH,
        symbol: snapshot.instrument.instrumentId,
        interval: marketIntervalToTradingViewResolution(snapshot.bars.interval),
        locale: "en",
        timezone: snapshot.instrument.assetClass === "equity_index"
          ? "America/New_York"
          : "Etc/UTC",
        autosize: true,
        fullscreen: false,
        theme: palette.theme,
        disabled_features: [
          "header_symbol_search",
          "symbol_search_hot_key",
          "header_resolutions",
          "show_interval_dialog_on_key_press",
          "header_compare",
          "header_saveload",
          "header_undo_redo",
          "timeframes_toolbar",
        ],
        enabled_features: [
          "chart_scroll",
          "chart_zoom",
          "handle_scale",
          "handle_scroll",
          "iframe_loading_same_origin",
          "saveload_separate_drawings_storage",
        ],
        loading_screen: {
          backgroundColor: palette.background,
          foregroundColor: palette.foreground,
        },
        overrides: chartOverrides(palette),
      });
      widgetRef.current = widget;
      return widget.chartReady().then(async () => {
        if (disposed) return;
        try {
          const restored = await restoreChartState(
            widget.activeChart(),
            snapshot,
            latestAnalysisRef.current,
          );
          if (!disposed && restored) {
            restoredAnalysisIdRef.current = restored.id;
            setSavedLabel(`Restored ${formatSavedTime(restored.savedAt)} · saved source ${restored.snapshotId}`);
          }
        } catch {
          if (!disposed) setRestoreError(true);
        }
        if (disposed) return;
        readyRef.current = true;
        setStatus("ready");
      });
    }).catch(() => {
      if (!disposed) setStatus("error");
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      saveAttemptRef.current = undefined;
      systemShapeIdsRef.current = [];
      overlayRevisionRef.current += 1;
      widgetRef.current?.remove();
      widgetRef.current = undefined;
      container.replaceChildren();
    };
  }, [attempt]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || status !== "ready") return;
    let disposed = false;
    const palette = chartPalette();
    // TradingView's theme promise must settle before its explicit overrides.
    // Serialize rapid theme changes so an older completion cannot win.
    themeQueueRef.current = themeQueueRef.current.catch(() => undefined).then(async () => {
      if (disposed || widgetRef.current !== widget) return;
      await widget.changeTheme(palette.theme);
      if (!disposed && widgetRef.current === widget) { widget.applyOverrides(chartOverrides(palette)); setThemeError(false); }
    }).catch(() => { if (!disposed && widgetRef.current === widget) setThemeError(true); });
    return () => { disposed = true; };
  }, [status, themeRevision]);

  useEffect(() => {
    activeSnapshotRef.current = { instrument, bars };
    const widget = widgetRef.current;
    if (!widget || !readyRef.current) return;
    const applied = appliedSnapshotRef.current;
    if (
      bars.snapshotId === applied.snapshotId &&
      bars.interval === applied.interval &&
      instrument.instrumentId === applied.instrumentId
    ) return;
    const resolution = marketIntervalToTradingViewResolution(bars.interval);
    appliedSnapshotRef.current = {
      instrumentId: instrument.instrumentId,
      snapshotId: bars.snapshotId,
      interval: bars.interval,
    };
    if (
      applied.interval !== bars.interval ||
      applied.instrumentId !== instrument.instrumentId
    ) {
      const chart = widget.activeChart();
      void (async () => {
        if (applied.instrumentId !== instrument.instrumentId) {
          await chart.setSymbol(instrument.instrumentId);
        }
        if (applied.interval !== bars.interval) {
          await chart.setResolution(resolution);
        }
        const snapshot = activeSnapshotRef.current;
        const restored = await restoreChartState(
          chart,
          snapshot,
          latestAnalysisRef.current,
        );
        if (
          widgetRef.current === widget &&
          activeSnapshotRef.current.instrument.instrumentId === snapshot.instrument.instrumentId &&
          activeSnapshotRef.current.bars.interval === snapshot.bars.interval
        ) {
          restoredAnalysisIdRef.current = restored?.id;
          setSavedLabel(restored ? `Restored ${formatSavedTime(restored.savedAt)} · saved source ${restored.snapshotId}` : undefined);
          setSaveState("idle");
        }
      })().catch(() => {
        if (widgetRef.current === widget) setSaveState("error");
      });
      return;
    }
    widget.activeChart().resetData();
  }, [bars, instrument]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !readyRef.current || status !== "ready" || !latestAnalysis) return;
    const snapshot = activeSnapshotRef.current;
    if (!analysisMatchesSnapshot(latestAnalysis, snapshot)) return;
    if (restoredAnalysisIdRef.current === latestAnalysis.id) return;
    let disposed = false;
    void widget.activeChart().applyLineToolsState(
      deserializeChartState(latestAnalysis.chartState),
    ).then(() => {
      if (
        disposed ||
        widgetRef.current !== widget ||
        latestAnalysisRef.current?.id !== latestAnalysis.id
      ) return;
      restoredAnalysisIdRef.current = latestAnalysis.id;
      setRestoreError(false);
      setSavedLabel(`Restored ${formatSavedTime(latestAnalysis.savedAt)} · saved source ${latestAnalysis.snapshotId}`);
      setSaveState("idle");
    }).catch(() => {
      if (!disposed && widgetRef.current === widget) setRestoreError(true);
    });
    return () => { disposed = true; };
  }, [bars.interval, instrument.instrumentId, latestAnalysis, status]);

  const visibleLayersKey = [...(visibleLayerIds || [])].sort().join(",");
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !readyRef.current) return;
    const revision = overlayRevisionRef.current + 1;
    overlayRevisionRef.current = revision;
    const chart = widget.activeChart();
    const previous = systemShapeIdsRef.current;
    systemShapeIdsRef.current = [];
    for (const id of previous) chart.removeEntity(id);
    if (!features || features.snapshot.id !== bars.snapshotId) {
      queueMicrotask(() => {
        if (overlayRevisionRef.current !== revision || widgetRef.current !== widget) return;
        setOverlayState("idle");
        setOverlayFailureCount(0);
      });
      return;
    }
    const visible = new Set(visibleLayersKey.split(",").filter(Boolean));
    const annotations = features.annotations.filter((item) => visible.has(item.layerId));
    queueMicrotask(() => {
      if (overlayRevisionRef.current !== revision || widgetRef.current !== widget) return;
      setOverlayState(annotations.length ? "rendering" : "ready");
      setOverlayFailureCount(0);
    });
    const current = () => overlayRevisionRef.current === revision && widgetRef.current === widget;
    void renderAnnotations(chart, annotations, current).then(({ ids, failedCount }) => {
      if (overlayRevisionRef.current !== revision || widgetRef.current !== widget) {
        if (widgetRef.current === widget) for (const id of ids) chart.removeEntity(id);
        return;
      }
      systemShapeIdsRef.current = ids;
      setOverlayFailureCount(failedCount);
      setOverlayState(failedCount ? "partial" : "ready");
    }).catch(() => {
      if (current()) {
        setOverlayFailureCount(annotations.length);
        setOverlayState("partial");
      }
    });
  }, [bars.snapshotId, features, status, themeRevision, visibleLayersKey]);

  const currentTablePage = Math.min(tablePage, Math.max(0, Math.ceil(bars.bars.length / 40) - 1));
  const saveAnalysis = async () => {
    const widget = widgetRef.current;
    if (!widget || !readyRef.current || !features || disabledReason || saveAttemptRef.current) return;
    const attempt = {};
    saveAttemptRef.current = attempt;
    const snapshot = activeSnapshotRef.current;
    // A same-instrument price refresh may advance while this frozen save runs.
    // Keep its accepted receipt labelled with its submitted snapshot; the keyed
    // widget and attempt still fence a different instrument, interval or owner.
    const current = () => saveAttemptRef.current === attempt && widgetRef.current === widget;
    setSaveState("saving");
    try {
      const chartState = serializeChartState(widget.activeChart().getLineToolsState());
      const version = await onSaveAnalysis(snapshot.bars, { snapshotId: snapshot.bars.snapshotId, visibleLayerIds: [...(visibleLayerIds ?? [])], chartState });
      if (!current()) return;
      if (!version) throw new Error("Private save was not confirmed.");
      restoredAnalysisIdRef.current = version.id;
      setSavedLabel(`Saved ${formatSavedTime(version.savedAt)} · ${version.id} · source ${version.snapshotId}`);
      setSaveState("saved");
    } catch {
      if (current()) setSaveState("error");
    } finally {
      if (saveAttemptRef.current === attempt) saveAttemptRef.current = undefined;
    }
  };

  return (
    <div className={styles.advancedChart} data-state={status}>
      <div
        ref={containerRef}
        className={styles.chartCanvas}
        role="region"
        aria-label={`TradingView Advanced Chart for ${instrument.label} with ${bars.bars.length} evidence-bound provider bars`}
        aria-busy={status === "loading"}
        hidden={forcedColors}
      />
      {status === "loading" ? (
        <div className={styles.chartLibraryState} aria-live="polite">
          <RefreshCw className={styles.spin} size={14} />
          Loading TradingView Advanced Charts
        </div>
      ) : null}
      {status === "error" ? (
        <div className={styles.chartLibraryError} role="alert">
          <AlertTriangle size={19} />
          <strong>Advanced Chart could not load</strong>
          <p>The licensed TradingView v{TRADINGVIEW_LIBRARY_VERSION} assets are unavailable in this release.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : null}
      {features && status === "ready" && overlayState === "rendering" ? (
        <div className={styles.chartOverlayState} aria-live="polite">
          <RefreshCw className={styles.spin} size={13} /> Drawing selected concepts
        </div>
      ) : null}
      {features && status === "ready" && overlayState === "partial" ? (
        <div className={styles.chartOverlayState} data-state="warning" role="status">
          <AlertTriangle size={13} /> {overlayFailureCount} overlays unavailable; chart controls remain active
        </div>
      ) : null}
      {features && status === "ready" ? (
        <div className={styles.chartPersistence} data-state={saveState} aria-live="polite">
          <span>
            {saveState === "saved" ? <Check size={13} /> : <Save size={13} />}
            {saveState === "error" ? "Private save unavailable" : savedLabel || "Drawings are private to you"}
          </span>
          <button type="button" disabled={saveState === "saving" || Boolean(disabledReason)} onClick={() => void saveAnalysis()}>
            {saveState === "saving" ? <RefreshCw className={styles.spin} size={13} /> : <Save size={13} />}
            {saveState === "saving" ? "Saving" : "Save version"}
          </button>
        </div>
      ) : null}
      {disabledReason && features ? <p className={styles.permissionReason}>{disabledReason}</p> : null}
      {themeError ? <p className={styles.permissionReason} role="status">Chart theme could not refresh. Exact price data remains available below.</p> : null}
      {restoreError ? <p className={styles.permissionReason} role="status">Stored drawings could not be restored. The saved version remains in the analysis ledger.</p> : null}
      <details className={styles.chartData} open={forcedColors || undefined}><summary>Exact price data · {bars.bars.length} bars</summary><p>{bars.instrumentId} · {bars.interval} · {bars.providerSymbol} · {bars.providerTimezone}</p><p>Snapshot <code>{bars.snapshotId}</code><br />Digest <code>{bars.snapshotSha256}</code></p><div className={styles.tableScroll} role="region" aria-label="Exact provider price bars" tabIndex={0}><table><caption>Immutable provider bars; timestamps are UTC.</caption><thead><tr><th scope="col">Time</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Close</th><th scope="col">Volume</th></tr></thead><tbody>{bars.bars.slice(currentTablePage * 40, (currentTablePage + 1) * 40).map((bar) => <tr key={bar.time}><th scope="row"><time dateTime={bar.timestamp}>{bar.timestamp}</time></th><td>{bar.open}</td><td>{bar.high}</td><td>{bar.low}</td><td>{bar.close}</td><td>{bar.volume ?? "Unavailable"}</td></tr>)}</tbody></table></div><div className={styles.dataPager}><button type="button" disabled={currentTablePage === 0} onClick={() => setTablePage(Math.max(0, currentTablePage - 1))}>Previous price rows</button><span>Page {currentTablePage + 1} of {Math.max(1, Math.ceil(bars.bars.length / 40))} · 40 rows per page</span><button type="button" disabled={(currentTablePage + 1) * 40 >= bars.bars.length} onClick={() => setTablePage(currentTablePage + 1)}>Next price rows</button></div></details>
    </div>
  );
}

async function restoreChartState(
  chart: ReturnType<TradingViewWidget["activeChart"]>,
  snapshot: TradingViewMarketSnapshot,
  latestAnalysis?: MarketAnalysisVersion,
) {
  if (!latestAnalysis || !analysisMatchesSnapshot(latestAnalysis, snapshot)) {
    return undefined;
  }
  await chart.applyLineToolsState(deserializeChartState(latestAnalysis.chartState));
  return latestAnalysis;
}

function analysisMatchesSnapshot(
  analysis: MarketAnalysisVersion,
  snapshot: TradingViewMarketSnapshot,
) {
  return analysis.instrumentId === snapshot.instrument.instrumentId &&
    analysis.interval === snapshot.bars.interval;
}

function serializeChartState(state: TradingViewLineToolsState): MarketSerializedChartState {
  const serialized = {
    sources: state.sources ? [...state.sources.entries()] : null,
    groups: [...state.groups.entries()],
    ...(state.symbol ? { symbol: state.symbol } : {}),
  };
  return JSON.parse(JSON.stringify(serialized)) as MarketSerializedChartState;
}

function deserializeChartState(state: MarketSerializedChartState): TradingViewLineToolsState {
  return {
    sources: state.sources ? new Map(state.sources) : null,
    groups: new Map(state.groups),
    ...(state.symbol ? { symbol: state.symbol } : {}),
  };
}

function formatSavedTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

async function renderAnnotations(
  chart: ReturnType<TradingViewWidget["activeChart"]>,
  annotations: MarketTechnicalFeaturesResult["annotations"],
  current: () => boolean,
) {
  const ids: Array<string | number> = [];
  let failedCount = 0;
  const batchSize = 12;
  for (let index = 0; index < annotations.length; index += batchSize) {
    if (!current()) break;
    const settled = await Promise.allSettled(
      annotations.slice(index, index + batchSize).map((item) =>
        createAnnotation(chart, item)
      ),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") ids.push(result.value);
      else failedCount += 1;
    }
  }
  return { ids, failedCount };
}

function createAnnotation(
  chart: ReturnType<TradingViewWidget["activeChart"]>,
  item: MarketTechnicalFeaturesResult["annotations"][number],
) {
  const style = annotationStyle(item.layerId, item.direction, item.reviewState);
  const shared = {
    text: item.label,
    lock: true,
    disableSelection: false,
    disableSave: true,
    disableUndo: true,
    showInObjectsTree: true,
    overrides: style,
  } satisfies Omit<ChartShapeOptions, "shape">;
  const primitive = item.primitive;
  if (primitive.type === "horizontal_line") {
    return chart.createMultipointShape([
      primitive.point,
      { time: primitive.endTime, price: primitive.point.price },
    ], { ...shared, shape: "trend_line" });
  }
  if (primitive.type === "vertical_line") {
    return chart.createShape(primitive.point, {
      ...shared,
      shape: "vertical_line",
      zOrder: "bottom",
    });
  }
  if (primitive.type === "price_zone" || primitive.type === "time_window") {
    return chart.createMultipointShape([
      primitive.from,
      primitive.to,
    ], {
      ...shared,
      shape: "rectangle",
      zOrder: primitive.type === "time_window" ? "bottom" : "top",
    });
  }
  return chart.createShape(primitive.point, {
    ...shared,
    shape: primitive.marker === "up"
      ? "arrow_up"
      : primitive.marker === "down"
        ? "arrow_down"
        : "text",
    zOrder: "top",
  });
}

function annotationStyle(
  layerId: MarketTechnicalLayerId,
  direction: MarketTechnicalFeaturesResult["annotations"][number]["direction"],
  reviewState: MarketTechnicalFeaturesResult["annotations"][number]["reviewState"],
) {
  const palette = chartPalette();
  const layers: Record<MarketTechnicalLayerId, string> = {
    liquidity: palette.accent, imbalances: palette.success, blocks: palette.info, setups: palette.warning,
    sessions: palette.muted, quarterly: palette.strong, structure: palette.foreground, gaps: palette.danger,
  };
  const color = direction === "bullish"
    ? palette.success
    : direction === "bearish"
      ? palette.danger
      : layers[layerId];
  return {
    linecolor: color,
    color,
    textcolor: color,
    textColor: color,
    backgroundColor: annotationFill(layers[layerId]),
    fillBackground: true,
    linewidth: layerId === "setups" ? 2 : 1,
    linestyle: reviewState === "candidate_rule" ? 2 : 0,
    extendLeft: false,
    extendRight: false,
    showPriceLabels: false,
    showTime: false,
  };
}

function chartPalette() {
  const tokens = getComputedStyle(document.documentElement);
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" as const : "light" as const;
  const value = (name: string) => tokens.getPropertyValue(`--${name}`).trim();
  return { theme, background: value("surface"), foreground: value("foreground"), muted: value("muted"),
    line: value("line"), strong: value("line-strong"), accent: value("accent"), success: value("success"),
    danger: value("danger"), info: value("info"), warning: value("warning") };
}
function chartOverrides(palette: ReturnType<typeof chartPalette>) {
  return {
    "paneProperties.background": palette.background, "paneProperties.backgroundType": "solid",
    "paneProperties.vertGridProperties.color": palette.line, "paneProperties.horzGridProperties.color": palette.line,
    "scalesProperties.textColor": palette.muted, "scalesProperties.lineColor": palette.strong, "scalesProperties.fontSize": 13,
    "mainSeriesProperties.candleStyle.upColor": palette.success, "mainSeriesProperties.candleStyle.downColor": palette.danger,
    "mainSeriesProperties.candleStyle.borderUpColor": palette.success, "mainSeriesProperties.candleStyle.borderDownColor": palette.danger,
    "mainSeriesProperties.candleStyle.wickUpColor": palette.success, "mainSeriesProperties.candleStyle.wickDownColor": palette.danger,
  };
}
function annotationFill(color: string) {
  const hex = /^#([a-f\d]{6})$/i.exec(color)?.[1];
  return hex ? `rgba(${Number.parseInt(hex.slice(0, 2), 16)}, ${Number.parseInt(hex.slice(2, 4), 16)}, ${Number.parseInt(hex.slice(4, 6), 16)}, 0.12)` : "transparent";
}

function loadTradingViewLibrary() {
  const tradingViewWindow = window as unknown as TradingViewWindow;
  const existingConstructor = tradingViewWindow.TradingView?.widget;
  if (existingConstructor) return Promise.resolve(existingConstructor);
  if (chartLibraryPromise) return chartLibraryPromise;

  chartLibraryPromise = new Promise<TradingViewWidgetConstructor>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${TRADINGVIEW_LIBRARY_SCRIPT}"]`,
    );
    const script = existingScript || document.createElement("script");
    const settle = () => {
      const constructor = (window as unknown as TradingViewWindow).TradingView?.widget;
      if (constructor) resolve(constructor);
      else {
        chartLibraryPromise = undefined;
        script.remove();
        reject(new Error("TradingView Advanced Charts did not initialize."));
      }
    };
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", () => {
      chartLibraryPromise = undefined;
      script.remove();
      reject(new Error("TradingView Advanced Charts assets could not load."));
    }, { once: true });
    if (!existingScript) {
      script.src = TRADINGVIEW_LIBRARY_SCRIPT;
      script.async = true;
      script.dataset.asaelVendor = `tradingview-${TRADINGVIEW_LIBRARY_VERSION}`;
      document.head.append(script);
    }
  });
  return chartLibraryPromise;
}
