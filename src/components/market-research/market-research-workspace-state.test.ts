import { describe, expect, it, vi } from "vitest";
import { createMarketRequestGate, marketProgress, mergeMarketJob, parseMarketAnalysisReceipt, parseMarketBars, parseMarketCalendar, parseMarketEvents, parseMarketFeatures, parseMarketForecastReceipt, parseMarketJob, parseMarketJournal, parseMarketScoreReceipt, parseMarketVersions, startMarketJobPolling, type MarketJob } from "./market-research-workspace-state";
import { MARKET_EVENT_BASELINE_VERSION, MARKET_FORWARD_SHADOW_VERSION, MARKET_LIVE_CALENDAR_VERSION, MARKET_RESEARCH_CONTRACT_VERSION, type MarketAnalysisVersion, type MarketBarsResult, type MarketForecastOutcome, type MarketForwardForecast } from "@/lib/market-research/contracts";
import { buildMarketTechnicalFeatures } from "@/lib/market-research/technical-features";
import type { VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";

const stamp = "2026-10-03T12:00:00.000Z";
const sha = "a".repeat(64);
function bars(): MarketBarsResult {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const time = Date.parse(stamp) / 1000 + index * 900;
    return { time, timestamp: new Date(time * 1000).toISOString(), open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index, volume: null };
  });
  return { contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, instrumentId: "xauusd.spot", provider: "twelve_data", providerSymbol: "XAU/USD", providerTimezone: "UTC", interval: "15min", retrievedAt: stamp, asOf: rows.at(-1)!.timestamp, snapshotId: `market_snapshot_${"a".repeat(48)}`, snapshotSha256: sha, snapshotSource: "provider", bars: rows };
}
function version(): MarketAnalysisVersion {
  return { id: `market_analysis_${"b".repeat(48)}`, contractVersion: "market-analysis-version:1", instrumentId: "xauusd.spot", interval: "15min", snapshotId: bars().snapshotId, snapshotSha256: sha, detectorVersion: "market-ict-quarterly-candidates:2", technicalResultSha256: "b".repeat(64), visibleLayerIds: ["liquidity", "structure"], chartStateSha256: "c".repeat(64), chartState: { sources: [["manual-1", { type: "trend_line", color: "gold" }]], groups: [] }, annotationCount: 2, detectionCount: 3, candidateCount: 1, savedAt: stamp, versionSha256: "d".repeat(64) };
}
function job(status: MarketJob["status"] = "queued", updatedAt = stamp): MarketJob {
  return { id: "job_exact_1", type: "market.backtest.run", status, progress: { stage: "queued", completedBars: 0, totalBars: 0 }, createdAt: stamp, updatedAt };
}
function forecast(): MarketForwardForecast {
  return { id: `market_forecast_${"b".repeat(48)}`, contractVersion: MARKET_FORWARD_SHADOW_VERSION, instrumentId: "xauusd.spot", horizon: "daily", sealedAt: stamp, windowStart: "2026-10-05T13:30:00.000Z", windowEnd: "2026-10-05T20:00:00.000Z", researchMode: true, probabilityState: "uncalibrated", stance: "abstain", evidenceStrength: "limited", summary: "Evidence does not justify a directional call.", scenarios: (["bullish", "bearish", "neutral"] as const).map((direction, index) => ({ direction, rank: index + 1, thesis: `${direction} path`, observationZone: null, targets: [], invalidation: null, supportingFeatureIds: [] })), warnings: ["No calibrated probability."], evidence: { snapshotId: bars().snapshotId, snapshotSha256: sha, snapshotAsOf: stamp, detectorVersion: "market-ict-quarterly-candidates:2", technicalResultSha256: sha, baselineVersion: MARKET_EVENT_BASELINE_VERSION, baselineResultSha256: sha, baselineReplayCount: 0, baselineQualifiedGroups: 0, macroEventIds: [], macroEventsSha256: sha }, modelAttribution: { provider: "test", model: "fixture", assignmentScope: "market_research", assignmentId: "assignment:one", assignmentRevision: 1, assignmentConfigurationSha256: sha, usageReceiptId: "123e4567-e89b-42d3-a456-426614174000", usageReceiptRecorded: true }, forecastSha256: sha };
}
function outcome(): MarketForecastOutcome {
  return { id: `market_forecast_outcome_${"c".repeat(48)}`, forecastId: forecast().id, resolvedAt: "2026-10-05T20:15:00.000Z", provider: "twelve_data", providerSymbol: "XAU/USD", interval: "15min", sourcePayloadSha256: sha, snapshotSha256: sha, firstPrice: 100, lastPrice: 101, returnBps: 100, actualDirection: "bullish", stanceHit: null, scenarioRankHit: 1, maxFavorableBps: null, maxAdverseBps: null, brierScore: null, outcomeSha256: sha };
}

describe("Market read contracts", () => {
  it("accepts the route receipt without relaxing the strict domain schema", () => {
    expect(parseMarketBars({ ...bars(), serviceReceipt: { requestId: "read" } }, "xauusd.spot", "15min").bars).toHaveLength(30);
    expect(() => parseMarketBars({ ...bars(), unexpected: true }, "xauusd.spot", "15min")).toThrow("incomplete");
    expect(() => parseMarketBars({}, "xauusd.spot", "15min")).toThrow("incomplete");
  });
  it("rejects stale instrument/interval data and unordered or excessive price rows", () => {
    expect(() => parseMarketBars(bars(), "ndx.cash", "15min")).toThrow("match");
    expect(() => parseMarketBars(bars(), "xauusd.spot", "1h")).toThrow("match");
    expect(() => parseMarketBars({ ...bars(), bars: [...bars().bars].reverse() }, "xauusd.spot", "15min")).toThrow("order");
    expect(() => parseMarketBars({ ...bars(), bars: Array.from({ length: 481 }, () => bars().bars[0]) }, "xauusd.spot", "15min")).toThrow("match");
  });
  it("binds technical features to both immutable snapshot ID and digest", () => {
    const data = buildMarketTechnicalFeatures(bars());
    expect(parseMarketFeatures(data, bars()).snapshot.id).toBe(bars().snapshotId);
    expect(() => parseMarketFeatures(data, { ...bars(), snapshotSha256: "e".repeat(64) })).toThrow("match");
    expect(() => parseMarketFeatures({ ...data, layers: [...data.layers, data.layers[0]] }, bars())).toThrow();
  });
  it("does not turn missing events into an empty result", () => {
    expect(() => parseMarketEvents({ events: [] })).toThrow("incomplete");
  });
  it("validates partial publisher health rather than inventing complete calendar coverage", () => {
    const data = { contractVersion: MARKET_LIVE_CALENDAR_VERSION, generatedAt: stamp, marketDate: "2026-10-03", timezone: "America/New_York", windowDays: 14, catalog: { reviewedFamilies: 0, exactTimeFamilies: 0, dateOnlyFamilies: 0, families: [] }, events: [], sourceHealth: ["bls", "census", "bea", "federal_reserve"].map((source) => ({ source, status: source === "bls" ? "unavailable" : "connected", eventCount: 0, note: "Bounded provider read." })), disclosures: ["Unavailable publishers may have missing events."] };
    expect(parseMarketCalendar(data).sourceHealth[0].status).toBe("unavailable");
    expect(() => parseMarketCalendar({ ...data, windowDays: 30 })).toThrow("window");
    expect(() => parseMarketCalendar({ ...data, sourceHealth: data.sourceHealth.map(() => data.sourceHealth[0]) })).toThrow("sources");
  });
  it("rejects duplicate versions and a version for the wrong selected interval", () => {
    const data = { contractVersion: "market-analysis-version:1", instrumentId: "xauusd.spot", interval: "15min", versions: [version()], total: 1 };
    expect(parseMarketVersions(data, "xauusd.spot", "15min").total).toBe(1);
    expect(() => parseMarketVersions({ ...data, versions: [version(), version()] }, "xauusd.spot", "15min")).toThrow("identities");
    expect(() => parseMarketVersions(data, "xauusd.spot", "1h")).toThrow("context");
  });
  it("requires a resolved journal outcome to name its exact sealed forecast", () => {
    const data = { contractVersion: MARKET_FORWARD_SHADOW_VERSION, instrumentId: "xauusd.spot", entries: [{ forecast: forecast(), outcome: outcome(), resolutionState: "resolved" }], scorecard: { total: 1, resolved: 1, due: 0, abstentions: 1, directionalAccuracy: null, directionalSampleSize: 0, coverage: 0, brierScore: null, probabilityState: "uncalibrated" } };
    expect(parseMarketJournal(data, "xauusd.spot").entries).toHaveLength(1);
    expect(() => parseMarketJournal({ ...data, entries: [{ ...data.entries[0], outcome: { ...outcome(), forecastId: `market_forecast_${"e".repeat(48)}` } }] }, "xauusd.spot")).toThrow("context");
    expect(() => parseMarketJournal({ ...data, entries: [{ ...data.entries[0], outcome: null }] }, "xauusd.spot")).toThrow("context");
  });
});

describe("Market immutable effect receipts", () => {
  it("requires job identity/type/status and keeps unknown progress distinct from zero", () => {
    expect(parseMarketJob({ job: job() }, "market.backtest.run", "job_exact_1").status).toBe("queued");
    expect(() => parseMarketJob({ job: job() }, "market.replays.backfill")).toThrow("identity");
    expect(() => parseMarketJob({ job: job() }, "market.backtest.run", "other")).toThrow("identity");
    expect(() => parseMarketJob({ job: { ...job(), status: "done" } }, "market.backtest.run")).toThrow("incomplete");
    expect(marketProgress(undefined)).toBe("Unavailable");
    expect(marketProgress(0)).toBe("0");
    expect(marketProgress(-1)).toBe("Unavailable");
  });
  it("retains terminal receipts and ignores older poll revisions", () => {
    expect(mergeMarketJob(job("completed"), job("running", "2026-10-03T13:00:00.000Z")).status).toBe("completed");
    const current = job("running", "2026-10-03T13:00:00.000Z");
    expect(mergeMarketJob(current, job())).toBe(current);
    expect(mergeMarketJob(job(), job("failed")).status).toBe("failed");
  });
  it("binds saved manual state, selected layers, instrument and snapshot digest", () => {
    const saved = version();
    const submitted = { snapshotId: saved.snapshotId, visibleLayerIds: saved.visibleLayerIds, chartState: saved.chartState };
    expect(parseMarketAnalysisReceipt({ version: saved, reused: false }, bars(), submitted).version.id).toBe(saved.id);
    expect(() => parseMarketAnalysisReceipt({ version: { ...saved, chartState: { sources: null, groups: [] } }, reused: false }, bars(), submitted)).toThrow("match");
    expect(() => parseMarketAnalysisReceipt({ version: { ...saved, visibleLayerIds: [] }, reused: false }, bars(), submitted)).toThrow("match");
    expect(() => parseMarketAnalysisReceipt({ version: saved, reused: false }, { ...bars(), snapshotSha256: "e".repeat(64) }, submitted)).toThrow("match");
    expect(parseMarketAnalysisReceipt({ version: { ...saved, visibleLayerIds: [...saved.visibleLayerIds].reverse() }, reused: true }, bars(), submitted).reused).toBe(true);
  });
  it("checks forecast market and horizon even for reused sealed results", () => {
    const data = { forecast: forecast(), reused: true };
    expect(parseMarketForecastReceipt(data, "xauusd.spot", "daily").reused).toBe(true);
    expect(() => parseMarketForecastReceipt(data, "ndx.cash", "daily")).toThrow("match");
    expect(() => parseMarketForecastReceipt(data, "xauusd.spot", "weekly")).toThrow("match");
    expect(() => parseMarketForecastReceipt({ forecast: forecast() }, "xauusd.spot", "daily")).toThrow("incomplete");
  });
  it("bounds scoring receipts without claiming an absent instrument echo", () => {
    expect(parseMarketScoreReceipt({ outcomes: [] }).outcomes).toEqual([]);
    expect(parseMarketScoreReceipt({ outcomes: [outcome()] }).outcomes[0].forecastId).toBe(forecast().id);
    expect(() => parseMarketScoreReceipt({ outcomes: [outcome(), outcome()] })).toThrow("identities");
    expect(() => parseMarketScoreReceipt({ outcomes: [outcome(), outcome(), outcome()] })).toThrow("incomplete");
    expect(() => parseMarketScoreReceipt({})).toThrow("incomplete");
  });
});

describe("Market scope and exclusive request lifetime", () => {
  it("rejects late A→B→A reads even when transport ignores abort", () => {
    const gate = createMarketRequestGate(); gate.mount();
    const firstA = gate.beginRead("source"); const b = gate.beginRead("source"); const secondA = gate.beginRead("source");
    expect(firstA.signal.aborted).toBe(true); expect(firstA.current()).toBe(false); expect(b.current()).toBe(false); expect(secondA.current()).toBe(true);
    gate.dispose(); expect(secondA.current()).toBe(false);
  });
  it("claims a write synchronously across different action buttons", () => {
    const gate = createMarketRequestGate(); gate.mount();
    const save = gate.beginWrite()!; expect(gate.beginWrite()).toBeUndefined();
    save.finish(); const generate = gate.beginWrite()!;
    save.finish(); expect(generate.current()).toBe(true); expect(gate.beginWrite()).toBeUndefined();
    generate.finish(); expect(gate.beginWrite()).toBeDefined();
  });
  it("invalidates disposed owner work without letting an old finally clear a new action", () => {
    const gate = createMarketRequestGate(); gate.mount(); const old = gate.beginWrite()!;
    gate.dispose(); gate.mount(); const current = gate.beginWrite()!;
    expect(old.current()).toBe(false); old.finish(); expect(current.current()).toBe(true);
  });
  it("fences old job polls before accepting a fresh enqueue of the same ID", () => {
    const gate = createMarketRequestGate(); gate.mount(); const old = gate.beginRead("job:one");
    gate.abort("job:one"); const receipt = parseMarketJob({ job: job() }, "market.backtest.run");
    expect(receipt.status).toBe("queued"); expect(old.current()).toBe(false);
    expect(gate.beginRead("job:one").current()).toBe(true);
  });
});

function environment() {
  let visible = true; let next = 0;
  const timers = new Map<number, () => void>(); const focus = new Set<() => void>(); const visibility = new Set<() => void>();
  const api: VisibleRefreshEnvironment = { isVisible: () => visible, setTimer: (callback) => { timers.set(++next, callback); return next; }, clearTimer: (id) => { timers.delete(id); }, addFocusListener: (fn) => { focus.add(fn); }, removeFocusListener: (fn) => { focus.delete(fn); }, addVisibilityListener: (fn) => { visibility.add(fn); }, removeVisibilityListener: (fn) => { visibility.delete(fn); } };
  return { api, timers, tick: async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); await Promise.resolve(); await Promise.resolve(); }, visibility: (value: boolean) => { visible = value; visibility.forEach((fn) => fn()); }, focus: () => focus.forEach((fn) => fn()), listeners: () => focus.size + visibility.size };
}
describe("Market continuing pending-job reads", () => {
  it("schedules after an unchanged result and a failed read instead of silently stopping", async () => {
    const env = environment(); const poll = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("temporary read failure")).mockResolvedValue(undefined);
    const stop = startMarketJobPolling({ poll, invalidate: vi.fn(), environment: env.api });
    await env.tick(); expect(poll).toHaveBeenCalledTimes(1); expect(env.timers.size).toBe(1);
    await env.tick(); expect(poll).toHaveBeenCalledTimes(2); expect(env.timers.size).toBe(1);
    await env.tick(); expect(poll).toHaveBeenCalledTimes(3); stop(); expect(env.timers.size).toBe(0); expect(env.listeners()).toBe(0);
  });
  it("invalidates held hidden-page reads and permits a fresh visible poll", async () => {
    const env = environment(); const current: Array<() => boolean> = []; const release: Array<() => void> = [];
    const invalidate = vi.fn();
    const stop = startMarketJobPolling({ poll: (valid) => { current.push(valid); return new Promise<void>((resolve) => { release.push(resolve); }); }, invalidate, environment: env.api });
    await env.tick(); env.focus(); expect(current).toHaveLength(1);
    env.visibility(false); expect(current[0]()).toBe(false); expect(invalidate).toHaveBeenCalledOnce();
    env.visibility(true); expect(current).toHaveLength(2); expect(current[1]()).toBe(true);
    release[0](); await Promise.resolve(); expect(env.timers.size).toBe(0);
    stop(); expect(current[1]()).toBe(false); release[1](); await Promise.resolve(); expect(env.timers.size).toBe(0);
  });
});
