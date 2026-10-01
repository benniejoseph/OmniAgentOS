import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vitals = vi.hoisted(() => ({
  listeners: new Map<string, Array<(metric: Record<string, unknown>) => void>>(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // The reporter is called as a plain function below, so its effect runs as
  // it is called.
  useEffect: (effect: () => void) => {
    effect();
  },
}));

vi.mock("web-vitals", () => {
  const listen = (name: string) => (listener: (metric: Record<string, unknown>) => void) => {
    vitals.listeners.set(name, [...(vitals.listeners.get(name) ?? []), listener]);
  };
  return {
    onCLS: listen("CLS"),
    onFCP: listen("FCP"),
    onINP: listen("INP"),
    onLCP: listen("LCP"),
  };
});

const { WebVitalsReporter } = await import("@/components/performance/web-vitals-reporter");

const sendBeacon = vi.fn((_url: string, _body: string) => true);
const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));

function openPage(sampleRate?: number) {
  vi.stubGlobal("window", {
    location: { href: "https://asael.test/app/agents?tab=runs", pathname: "/app/agents" },
    ...(sampleRate === undefined ? {} : { __asaelWebVitalsSampleRate: sampleRate }),
  });
}

function emit(name: string, metric: Record<string, unknown>) {
  for (const listener of vitals.listeners.get(name) ?? []) listener({ name, ...metric });
}

function sent() {
  return sendBeacon.mock.calls.map(([url, body]) => ({ url, body: JSON.parse(body) }));
}

beforeEach(() => {
  vitals.listeners.clear();
  sendBeacon.mockReset().mockReturnValue(true);
  fetchStub.mockClear();
  vi.stubGlobal("navigator", { sendBeacon });
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reporting Web Vitals from the browser", () => {
  it("sends each finalized metric for the page it measured, once per page", () => {
    openPage(1);
    WebVitalsReporter();
    WebVitalsReporter();
    expect([...vitals.listeners].map(([name, listeners]) => [name, listeners.length]))
      .toEqual([["CLS", 1], ["FCP", 1], ["INP", 1], ["LCP", 1]]);

    emit("LCP", {
      id: "v6-lcp",
      value: 2_412.6,
      rating: "good",
      navigationURL: "https://asael.test/app/projects?open=1",
    });
    emit("CLS", { id: "v6-cls", value: 0.123_45, rating: "needs-improvement" });
    emit("INP", { id: "v6-inp", value: 199.5, rating: "good" });

    expect(sent()).toEqual([
      {
        url: "/api/observability/web-vitals",
        body: {
          path: "/app/projects",
          metrics: [{ id: "v6-lcp", name: "LCP", value: 2_413, rating: "good" }],
        },
      },
      {
        url: "/api/observability/web-vitals",
        body: {
          path: "/app/agents",
          metrics: [{ id: "v6-cls", name: "CLS", value: 0.123, rating: "needs-improvement" }],
        },
      },
      {
        url: "/api/observability/web-vitals",
        body: {
          path: "/app/agents",
          metrics: [{ id: "v6-inp", name: "INP", value: 200, rating: "good" }],
        },
      },
    ]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("posts the metric with keepalive when the browser refuses the beacon", () => {
    openPage(1);
    sendBeacon.mockReturnValue(false);
    WebVitalsReporter();

    emit("FCP", { id: "v6-fcp", value: 812.2, rating: "good" });

    const [body] = sendBeacon.mock.calls.map(([, sentBody]) => sentBody);
    expect(fetchStub.mock.calls).toEqual([[
      "/api/observability/web-vitals",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      },
    ]]);
    expect(JSON.parse(body!)).toEqual({
      path: "/app/agents",
      metrics: [{ id: "v6-fcp", name: "FCP", value: 812, rating: "good" }],
    });
  });

  it("measures only the sampled share of page views", () => {
    const random = vi.spyOn(Math, "random");
    for (const [sampleRate, draw, measured] of [
      [undefined, 0.099, true],
      [undefined, 0.1, false],
      [0.5, 0.49, true],
      [0.5, 0.5, false],
      [0, 0, false],
      [-1, 0, false],
      [2, 0.999, true],
      [Number.NaN, 0.099, true],
      [Number.NaN, 0.1, false],
    ] as const) {
      vitals.listeners.clear();
      random.mockReturnValue(draw);
      openPage(sampleRate);
      WebVitalsReporter();
      expect([sampleRate, draw, vitals.listeners.size]).toEqual([sampleRate, draw, measured ? 4 : 0]);
    }
  });
});
