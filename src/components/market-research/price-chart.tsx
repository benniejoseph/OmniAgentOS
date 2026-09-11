"use client";

import { useEffect, useRef } from "react";
import type { UTCTimestamp } from "lightweight-charts";

import type { MarketBar } from "@/lib/market-research/contracts";
import styles from "@/components/market-research/market-research-workspace.module.css";

export function PriceChart({ bars }: { bars: readonly MarketBar[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || bars.length === 0) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let cleanupChart = () => {};

    void import("lightweight-charts").then((charts) => {
      if (disposed) return;
      const root = getComputedStyle(document.documentElement);
      const chart = charts.createChart(container, {
        autoSize: true,
        layout: {
          background: { type: charts.ColorType.Solid, color: "transparent" },
          textColor: root.getPropertyValue("--muted").trim() || "#8aa29f",
          attributionLogo: true,
          fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui",
        },
        grid: {
          vertLines: { color: "rgba(126, 180, 170, 0.10)" },
          horzLines: { color: "rgba(126, 180, 170, 0.10)" },
        },
        crosshair: { mode: charts.CrosshairMode.Normal },
        rightPriceScale: {
          borderColor: "rgba(126, 180, 170, 0.22)",
          scaleMargins: { top: 0.12, bottom: 0.1 },
        },
        timeScale: {
          borderColor: "rgba(126, 180, 170, 0.22)",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        handleScale: {
          axisPressedMouseMove: true,
          mouseWheel: true,
          pinch: true,
        },
      });
      const series = chart.addSeries(charts.CandlestickSeries, {
        upColor: "#72d7bd",
        downColor: "#ef8d86",
        borderUpColor: "#72d7bd",
        borderDownColor: "#ef8d86",
        wickUpColor: "#72d7bd",
        wickDownColor: "#ef8d86",
      });
      series.setData(bars.map((bar) => ({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })));
      chart.timeScale().fitContent();
      resizeObserver = new ResizeObserver(() => chart.resize(
        container.clientWidth,
        container.clientHeight,
      ));
      resizeObserver.observe(container);
      cleanupChart = () => chart.remove();
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      cleanupChart();
    };
  }, [bars]);

  return (
    <div
      ref={containerRef}
      className={styles.chartCanvas}
      role="img"
      aria-label={`Interactive candlestick chart with ${bars.length} provider bars`}
    />
  );
}
