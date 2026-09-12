"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "@/components/market-research/market-research-workspace.module.css";
import type {
  MarketBarsResult,
  MarketInstrument,
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
  theme: "dark";
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

let chartLibraryPromise: Promise<TradingViewWidgetConstructor> | undefined;

export function PriceChart({
  instrument,
  bars,
  features,
  visibleLayerIds,
}: {
  instrument: MarketInstrument;
  bars: MarketBarsResult;
  features?: MarketTechnicalFeaturesResult;
  visibleLayerIds?: readonly MarketTechnicalLayerId[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TradingViewWidget | undefined>(undefined);
  const readyRef = useRef(false);
  const systemShapeIdsRef = useRef<Array<string | number>>([]);
  const overlayRevisionRef = useRef(0);
  const activeSnapshotRef = useRef<TradingViewMarketSnapshot>({ instrument, bars });
  const appliedSnapshotRef = useRef({
    instrumentId: instrument.instrumentId,
    snapshotId: bars.snapshotId,
    interval: bars.interval,
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    readyRef.current = false;
    setStatus("loading");

    void loadTradingViewLibrary().then((Widget) => {
      if (disposed) return;
      const snapshot = activeSnapshotRef.current;
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
        theme: "dark",
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
        ],
        loading_screen: {
          backgroundColor: "#101d21",
          foregroundColor: "#72d7bd",
        },
        overrides: {
          "paneProperties.background": "#101d21",
          "paneProperties.backgroundType": "solid",
          "paneProperties.vertGridProperties.color": "rgba(126, 180, 170, 0.08)",
          "paneProperties.horzGridProperties.color": "rgba(126, 180, 170, 0.08)",
          "scalesProperties.textColor": "#9ab0ad",
          "scalesProperties.lineColor": "rgba(126, 180, 170, 0.20)",
          "mainSeriesProperties.candleStyle.upColor": "#72d7bd",
          "mainSeriesProperties.candleStyle.downColor": "#ef8d86",
          "mainSeriesProperties.candleStyle.borderUpColor": "#72d7bd",
          "mainSeriesProperties.candleStyle.borderDownColor": "#ef8d86",
          "mainSeriesProperties.candleStyle.wickUpColor": "#72d7bd",
          "mainSeriesProperties.candleStyle.wickDownColor": "#ef8d86",
        },
      });
      widgetRef.current = widget;
      return widget.chartReady().then(() => {
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
      systemShapeIdsRef.current = [];
      overlayRevisionRef.current += 1;
      widgetRef.current?.remove();
      widgetRef.current = undefined;
      container.replaceChildren();
    };
  }, [attempt]);

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
      })().catch(() => {
        if (widgetRef.current === widget) setStatus("error");
      });
      return;
    }
    widget.activeChart().resetData();
  }, [bars, instrument]);

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
    if (!features || features.snapshot.id !== bars.snapshotId) return;
    const visible = new Set(visibleLayersKey.split(",").filter(Boolean));
    const annotations = features.annotations.filter((item) => visible.has(item.layerId));
    void renderAnnotations(chart, annotations).then((ids) => {
      if (overlayRevisionRef.current !== revision || widgetRef.current !== widget) {
        for (const id of ids) chart.removeEntity(id);
        return;
      }
      systemShapeIdsRef.current = ids;
    }).catch(() => {
      if (widgetRef.current === widget) setStatus("error");
    });
  }, [bars.snapshotId, features, status, visibleLayersKey]);

  return (
    <div className={styles.advancedChart} data-state={status}>
      <div
        ref={containerRef}
        className={styles.chartCanvas}
        role="region"
        aria-label={`TradingView Advanced Chart for ${instrument.label} with ${bars.bars.length} evidence-bound provider bars`}
        aria-busy={status === "loading"}
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
    </div>
  );
}

async function renderAnnotations(
  chart: ReturnType<TradingViewWidget["activeChart"]>,
  annotations: MarketTechnicalFeaturesResult["annotations"],
) {
  const ids: Array<string | number> = [];
  for (const item of annotations) {
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
      ids.push(await chart.createMultipointShape([
        primitive.point,
        { time: primitive.endTime, price: primitive.point.price },
      ], { ...shared, shape: "trend_line" }));
    } else if (primitive.type === "vertical_line") {
      ids.push(await chart.createShape(primitive.point, {
        ...shared,
        shape: "vertical_line",
        zOrder: "bottom",
      }));
    } else if (primitive.type === "price_zone" || primitive.type === "time_window") {
      ids.push(await chart.createMultipointShape([
        primitive.from,
        primitive.to,
      ], {
        ...shared,
        shape: "rectangle",
        zOrder: primitive.type === "time_window" ? "bottom" : "top",
      }));
    } else {
      ids.push(await chart.createShape(primitive.point, {
        ...shared,
        shape: primitive.marker === "up"
          ? "arrow_up"
          : primitive.marker === "down"
            ? "arrow_down"
            : "text",
        zOrder: "top",
      }));
    }
  }
  return ids;
}

function annotationStyle(
  layerId: MarketTechnicalLayerId,
  direction: MarketTechnicalFeaturesResult["annotations"][number]["direction"],
  reviewState: MarketTechnicalFeaturesResult["annotations"][number]["reviewState"],
) {
  const palette: Record<MarketTechnicalLayerId, { line: string; fill: string }> = {
    liquidity: { line: "#f2c078", fill: "rgba(242, 192, 120, 0.12)" },
    imbalances: { line: "#72d7bd", fill: "rgba(114, 215, 189, 0.14)" },
    blocks: { line: "#88aef1", fill: "rgba(136, 174, 241, 0.14)" },
    setups: { line: "#d7a6ff", fill: "rgba(215, 166, 255, 0.16)" },
    sessions: { line: "#67868b", fill: "rgba(103, 134, 139, 0.07)" },
    quarterly: { line: "#9fb4af", fill: "rgba(159, 180, 175, 0.08)" },
    structure: { line: "#d5e4e1", fill: "rgba(213, 228, 225, 0.10)" },
    gaps: { line: "#ef8d86", fill: "rgba(239, 141, 134, 0.13)" },
  };
  const color = direction === "bullish"
    ? "#72d7bd"
    : direction === "bearish"
      ? "#ef8d86"
      : palette[layerId].line;
  return {
    linecolor: color,
    color,
    textcolor: color,
    textColor: color,
    backgroundColor: palette[layerId].fill,
    fillBackground: true,
    linewidth: layerId === "setups" ? 2 : 1,
    linestyle: reviewState === "candidate_rule" ? 2 : 0,
    extendLeft: false,
    extendRight: false,
    showPriceLabels: false,
    showTime: false,
  };
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
