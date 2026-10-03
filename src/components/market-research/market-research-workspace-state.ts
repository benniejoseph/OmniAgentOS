import { browserRefreshEnvironment, type VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";
import { z } from "zod";
import {
  marketAnalysisSaveResultSchema, marketAnalysisVersionsResultSchema, marketBacktestsResultSchema,
  marketBarsResultSchema, marketEventBaselinesResultSchema, marketEventReplaysResultSchema, marketEventsResultSchema,
  marketForecastJournalResultSchema, marketForecastOutcomeSchema, marketForwardForecastSchema,
  marketLiveCalendarResultSchema, marketResearchOverviewSchema, marketTechnicalFeaturesResultSchema,
  type MarketBarsResult, type MarketForecastHorizon, type MarketInterval, type MarketSerializedChartState,
  type MarketTechnicalLayerId,
} from "@/lib/market-research/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Routes add this one transport receipt to otherwise strict domain contracts. */
function domain(value: unknown) {
  const data = record(value);
  if (!data) return value;
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== "serviceReceipt"));
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(domain(value));
  if (!result.success) throw new Error(`${label} returned an incomplete response. Its result is unconfirmed.`);
  return result.data;
}
function requireMatch(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(`${label} does not match the requested market evidence.`);
}
function unique(values: readonly string[], label: string) {
  requireMatch(new Set(values).size === values.length, label);
}

export function parseMarketOverview(value: unknown) {
  const result = parse(marketResearchOverviewSchema, value, "Research readiness");
  unique(result.instruments.map((item) => item.instrumentId), "Instrument identities");
  unique(result.providers.map((item) => item.provider), "Provider identities");
  return result;
}
export function parseMarketBars(value: unknown, instrumentId: string, interval: MarketInterval) {
  const result = parse(marketBarsResultSchema, value, "Price snapshot");
  requireMatch(result.instrumentId === instrumentId && result.interval === interval && result.bars.length <= 480, "Price snapshot");
  requireMatch(result.bars.every((bar, index) => index === 0 || bar.time > result.bars[index - 1].time), "Price-bar order");
  return result;
}
export function parseMarketFeatures(value: unknown, bars: MarketBarsResult) {
  const result = parse(marketTechnicalFeaturesResultSchema, value, "Technical features");
  requireMatch(result.snapshot.id === bars.snapshotId && result.snapshot.sha256 === bars.snapshotSha256 &&
    result.snapshot.instrumentId === bars.instrumentId && result.snapshot.interval === bars.interval, "Technical snapshot");
  unique(result.layers.map((item) => item.id), "Technical layers");
  unique(result.annotations.map((item) => item.id), "Technical annotations");
  return result;
}
export function parseMarketEvents(value: unknown) {
  const result = parse(marketEventsResultSchema, value, "Event history");
  requireMatch(result.events.length <= 500, "Event history bound");
  unique(result.events.map((item) => item.id), "Event identities");
  return result;
}
export function parseMarketCalendar(value: unknown) {
  const result = parse(marketLiveCalendarResultSchema, value, "Official calendar");
  requireMatch(result.windowDays === 14, "Calendar window");
  unique(result.sourceHealth.map((item) => item.source), "Calendar sources");
  unique(result.catalog.families.map((item) => item.eventKey), "Calendar families");
  return result;
}
export function parseMarketReplays(value: unknown, instrumentId: string) {
  const result = parse(marketEventReplaysResultSchema, value, "Replay history");
  requireMatch(result.instrumentId === instrumentId && result.replays.length <= 100 && result.replays.every((item) => item.instrumentId === instrumentId), "Replay history");
  unique(result.replays.map((item) => item.id), "Replay identities");
  return result;
}
export function parseMarketBaselines(value: unknown, instrumentId: string) {
  const result = parse(marketEventBaselinesResultSchema, value, "Comparable-event baselines");
  requireMatch(result.instrumentId === instrumentId && result.minimumSampleSize === 20, "Baseline context");
  unique(result.groups.map((item) => item.eventKey), "Baseline groups");
  return result;
}
export function parseMarketVersions(value: unknown, instrumentId: string, interval: MarketInterval) {
  const result = parse(marketAnalysisVersionsResultSchema, value, "Private analyses");
  requireMatch(result.instrumentId === instrumentId && result.interval === interval && result.versions.length <= 8 &&
    result.versions.every((item) => item.instrumentId === instrumentId && item.interval === interval), "Analysis context");
  unique(result.versions.map((item) => item.id), "Analysis identities");
  return result;
}
export function parseMarketBacktests(value: unknown, instrumentId: string) {
  const result = parse(marketBacktestsResultSchema, value, "Backtest history");
  requireMatch(result.instrumentId === instrumentId && result.backtests.length <= 20 && result.backtests.every((item) => item.instrumentId === instrumentId), "Backtest context");
  unique(result.backtests.map((item) => item.id), "Backtest identities");
  return result;
}
export function parseMarketJournal(value: unknown, instrumentId: string) {
  const result = parse(marketForecastJournalResultSchema, value, "Forecast journal");
  requireMatch(result.instrumentId === instrumentId && result.entries.length <= 40 && result.entries.every((entry) =>
    entry.forecast.instrumentId === instrumentId && (!entry.outcome || entry.outcome.forecastId === entry.forecast.id) &&
    (entry.resolutionState === "resolved") === Boolean(entry.outcome)), "Forecast journal context");
  unique(result.entries.map((item) => item.forecast.id), "Forecast identities");
  return result;
}

export const MARKET_JOB_TYPES = ["market.events.backfill", "market.replays.backfill", "market.backtest.run"] as const;
const jobSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), type: z.enum(MARKET_JOB_TYPES),
  status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
  progress: z.record(z.string(), z.unknown()).optional(), result: z.record(z.string(), z.unknown()).optional(),
  updatedAt: z.string().datetime({ offset: true }), createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable().optional(),
  lastError: z.string().nullable().optional(), quarantined: z.boolean().optional(),
}).passthrough();
export type MarketJob = z.infer<typeof jobSchema>;
export function parseMarketJob(value: unknown, type: MarketJob["type"], id?: string) {
  const data = parse(z.object({ job: jobSchema }).passthrough(), value, "Operation job").job;
  requireMatch(data.type === type && (!id || data.id === id), "Operation job identity");
  return data;
}
export function marketJobActive(job: MarketJob) { return job.status === "queued" || job.status === "running"; }
/** Fresh explicit enqueues may reuse an old terminal ID; only polls are monotonic. */
export function mergeMarketJob(previous: MarketJob, incoming: MarketJob) {
  requireMatch(previous.id === incoming.id && previous.type === incoming.type, "Operation job identity");
  if (!marketJobActive(previous) || Date.parse(incoming.updatedAt) < Date.parse(previous.updatedAt)) return previous;
  return incoming;
}
export function marketProgress(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "Unavailable";
}

export function parseMarketForecastReceipt(value: unknown, instrumentId: string, horizon: MarketForecastHorizon) {
  const data = parse(z.object({ forecast: marketForwardForecastSchema, reused: z.boolean() }).strict(), value, "Forecast generation");
  requireMatch(data.forecast.instrumentId === instrumentId && data.forecast.horizon === horizon, "Generated forecast");
  return data;
}
export function parseMarketScoreReceipt(value: unknown) {
  // The endpoint selects the current due set. Outcomes carry forecast IDs, not
  // instrument IDs; do not pretend a bounded earlier journal supplied that set.
  const data = parse(z.object({ outcomes: z.array(marketForecastOutcomeSchema).max(2) }).strict(), value, "Forecast scoring");
  unique(data.outcomes.map((item) => item.forecastId), "Scored forecast identities");
  unique(data.outcomes.map((item) => item.id), "Outcome identities");
  return data;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const data = record(value);
  if (data) return `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${stable(data[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export type MarketAnalysisSubmission = { snapshotId: string; visibleLayerIds: readonly MarketTechnicalLayerId[]; chartState: MarketSerializedChartState };
export function parseMarketAnalysisReceipt(value: unknown, bars: MarketBarsResult, submitted: MarketAnalysisSubmission) {
  const data = parse(marketAnalysisSaveResultSchema, value, "Private analysis save");
  const version = data.version;
  requireMatch(version.snapshotId === submitted.snapshotId && version.snapshotId === bars.snapshotId &&
    version.snapshotSha256 === bars.snapshotSha256 && version.instrumentId === bars.instrumentId && version.interval === bars.interval &&
    stable([...version.visibleLayerIds].sort()) === stable([...submitted.visibleLayerIds].sort()) &&
    stable(version.chartState) === stable(submitted.chartState), "Saved analysis");
  return data;
}

/** Instance and channel guards remain valid even if transport ignores abort. */
export function createMarketRequestGate() {
  let mounted = false;
  let epoch = 0;
  let action: object | undefined;
  const reads = new Map<string, AbortController>();
  return {
    mount() { mounted = true; epoch += 1; },
    dispose() { mounted = false; epoch += 1; action = undefined; for (const item of reads.values()) item.abort(); reads.clear(); },
    beginRead(key: string) {
      reads.get(key)?.abort();
      const controller = new AbortController();
      const generation = epoch;
      reads.set(key, controller);
      return { signal: controller.signal, abort: () => controller.abort(), current: () => mounted && epoch === generation && reads.get(key) === controller && !controller.signal.aborted };
    },
    abort(key: string) { reads.get(key)?.abort(); reads.delete(key); },
    beginWrite() {
      if (!mounted || action) return undefined;
      const token = {};
      const generation = epoch;
      action = token;
      return { current: () => mounted && epoch === generation && action === token, finish: () => { if (action === token) action = undefined; } };
    },
  };
}

/** Keep checking pending jobs after unchanged/failed reads; hidden work cannot win later. */
export function startMarketJobPolling({ poll, invalidate, environment = browserRefreshEnvironment }: {
  poll: (current: () => boolean) => Promise<void>;
  invalidate: () => void;
  environment?: VisibleRefreshEnvironment;
}) {
  let disposed = false;
  let generation = 0;
  let running = false;
  let timer: number | undefined;
  const clear = () => { if (timer !== undefined) environment.clearTimer(timer); timer = undefined; };
  const schedule = () => {
    if (!disposed && !running && timer === undefined && environment.isVisible()) timer = environment.setTimer(() => { timer = undefined; void read(); }, 2000);
  };
  const read = async () => {
    if (disposed || running || !environment.isVisible()) return;
    running = true;
    const identity = ++generation;
    const current = () => !disposed && generation === identity;
    try { await poll(current); } catch { /* Per-source feedback belongs to the caller. Continue pending reads. */ }
    finally { if (current()) { running = false; schedule(); } }
  };
  const wake = () => { clear(); if (environment.isVisible()) void read(); };
  const visibility = () => {
    if (environment.isVisible()) wake();
    else { clear(); generation += 1; running = false; invalidate(); }
  };
  environment.addFocusListener(wake);
  environment.addVisibilityListener(visibility);
  schedule();
  return () => { disposed = true; generation += 1; clear(); invalidate(); environment.removeFocusListener(wake); environment.removeVisibilityListener(visibility); };
}
