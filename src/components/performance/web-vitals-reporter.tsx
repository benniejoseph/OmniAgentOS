"use client";

import { useEffect } from "react";
import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  type MetricType,
} from "web-vitals";

const sampleRate = normalizeSampleRate(
  process.env.NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE,
);

export function WebVitalsReporter() {
  useEffect(() => {
    const target = window as typeof window & {
      __asaelWebVitalsRegistered?: boolean;
      __asaelWebVitalsSampleRate?: number;
    };
    if (target.__asaelWebVitalsRegistered) {
      return;
    }
    target.__asaelWebVitalsRegistered = true;
    const effectiveSampleRate = normalizeSampleRate(
      target.__asaelWebVitalsSampleRate ?? sampleRate,
    );
    if (
      effectiveSampleRate <= 0 ||
      Math.random() >= effectiveSampleRate
    ) {
      return;
    }
    const report = (metric: MetricType) => {
      if (metric.name === "TTFB") {
        return;
      }
      const body = JSON.stringify({
        path: metric.navigationURL
          ? new URL(metric.navigationURL, window.location.href).pathname
          : window.location.pathname,
        metrics: [
          {
            id: metric.id,
            name: metric.name,
            value:
              metric.name === "CLS"
                ? Math.round(metric.value * 1_000) / 1_000
                : Math.round(metric.value),
            rating: metric.rating,
          },
        ],
      });
      if (!navigator.sendBeacon("/api/observability/web-vitals", body)) {
        void fetch("/api/observability/web-vitals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        });
      }
    };
    onCLS(report);
    onFCP(report);
    onINP(report);
    onLCP(report);
  }, []);

  return null;
}

function normalizeSampleRate(value: string | number | undefined) {
  const parsed = Number(value ?? "0.1");
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.1;
}
