"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "@/components/market-research/market-research-workspace.module.css";
import type {
  MarketBarsResult,
  MarketInstrument,
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
  activeChart: () => { resetData: () => void };
  setSymbol: (
    symbol: string,
    resolution: string,
    callback: () => void,
  ) => void;
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

let chartLibraryPromise: Promise<TradingViewWidgetConstructor> | undefined;

export function PriceChart({
  instrument,
  bars,
}: {
  instrument: MarketInstrument;
  bars: MarketBarsResult;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TradingViewWidget | undefined>(undefined);
  const readyRef = useRef(false);
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
      widget.setSymbol(instrument.instrumentId, resolution, () => undefined);
      return;
    }
    widget.activeChart().resetData();
  }, [bars, instrument]);

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
