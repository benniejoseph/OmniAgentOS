import { createHash } from "node:crypto";
import { z } from "zod";

import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  marketBacktestsQuerySchema, marketBacktestsResultSchema, marketBarsQuerySchema, marketBarsResultSchema,
  marketEventBaselinesQuerySchema, marketEventBaselinesResultSchema, marketEventReplaysQuerySchema,
  marketEventReplaysResultSchema, marketEventsQuerySchema, marketEventsResultSchema, marketForecastJournalQuerySchema,
  marketForecastJournalResultSchema, marketInstrumentIdSchema, marketLiveCalendarQuerySchema,
  marketLiveCalendarResultSchema, marketResearchOverviewSchema, marketTechnicalFeaturesQuerySchema,
  marketTechnicalFeaturesResultSchema,
  marketStoredSnapshotsQuerySchema, marketStoredSnapshotsResultSchema,
  marketAnalysisMetadataQuerySchema, marketAnalysisMetadataResultSchema,
} from "@/lib/market-research/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Standalone publication candidates. Nothing here enrolls a capability or runs a
// provider. Bars GET can fetch/persist on cache miss; calendar GET fetches live
// sources. The separate snapshots and analysis metadata projections read only
// stored evidence; metadata deliberately excludes arbitrary chart plugin state.
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotId = z.string().regex(/^market_snapshot_[a-f0-9]{48}$/);
const backtestId = z.string().regex(/^market_backtest_[a-f0-9]{48}$/);
const eventKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/);
const interval = z.enum(["5min", "15min", "1h"]);
export const nativeMarketDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Market date must be a real calendar date.");

export const nativeMarketBarsQuerySchema = marketBarsQuerySchema;
export const nativeMarketFeaturesQuerySchema = marketTechnicalFeaturesQuerySchema;
export const nativeMarketEventsQuerySchema = marketEventsQuerySchema;
export const nativeMarketReplaysQuerySchema = marketEventReplaysQuerySchema;
export const nativeMarketBaselinesQuerySchema = marketEventBaselinesQuerySchema;
export const nativeMarketBacktestsQuerySchema = marketBacktestsQuerySchema;
export const nativeMarketJournalQuerySchema = marketForecastJournalQuerySchema;
export const nativeMarketCalendarQuerySchema = marketLiveCalendarQuerySchema;
export const nativeMarketSnapshotsQuerySchema = marketStoredSnapshotsQuerySchema;
export const nativeMarketAnalysisMetadataQuerySchema = marketAnalysisMetadataQuerySchema;

function receipt(operation: Parameters<typeof getAppServiceOperationContract>[0]) {
  const expected = getAppServiceOperationContract(operation);
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.action !== expected.action || value.resourceType !== expected.resourceType || value.eventContract !== expected.eventContract || value.accessMode !== "read" || value.idempotencyKeySha256 !== null) issue(context, "Receipt does not describe this exact read operation.");
  });
}
type ReadReceipt = z.infer<typeof appServiceReceiptSchema>;
function read(value: { serviceReceipt: ReadReceipt }, context: z.RefinementCtx, resourceCount: number) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== resourceCount) issue(context, "Read receipt differs from its returned body or count.");
}
function unique(values: readonly string[], context: z.RefinementCtx) {
  if (new Set(values).size !== values.length) issue(context, "Duplicate exact identities are invalid.");
}
function realDate(value: string, context: z.RefinementCtx) {
  if (!nativeMarketDateSchema.safeParse(value).success) issue(context, "Invalid calendar date.");
}
function safeCounts(values: readonly number[], context: z.RefinementCtx) {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) issue(context, "Counts must be nonnegative safe integers.");
}
function digestBody(value: object, field: string, excluded: readonly string[], context: z.RefinementCtx) {
  const data = value as Record<string, unknown>;
  const body = Object.fromEntries(Object.entries(data).filter(([key]) => key !== field && !excluded.includes(key)));
  if (data[field] !== canonicalJsonSha256(body)) issue(context, "Immutable evidence digest differs from its body.");
}
function hash48(value: string) { return createHash("sha256").update(value).digest("hex").slice(0, 48); }

export type NativeMarketReadScope = { tenantId: string; requestActorId: string; role: string };
function authority(value: { serviceReceipt: ReadReceipt }, scope: NativeMarketReadScope, context: z.RefinementCtx) {
  if (!scope.tenantId.trim() || !scope.requestActorId.trim() || !scope.role.trim() || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: scope.tenantId, actorId: scope.requestActorId, role: scope.role, executionScope: null })) issue(context, "Read receipt belongs to another tenant, request actor, or role.");
}

export const nativeMarketOverviewResponseSchema = marketResearchOverviewSchema.extend({
  instruments: marketResearchOverviewSchema.shape.instruments.max(20),
  serviceReceipt: receipt("app.market_research.overview.show"),
}).strict().superRefine((value, context) => {
  read(value, context, value.instruments.length);
  unique(value.instruments.map((item) => item.instrumentId), context);
  unique(value.providers.map((item) => item.provider), context);
  unique(value.engineTracks.map((item) => item.id), context);
});
export function nativeMarketOverviewResponseForScopeSchema(scope: NativeMarketReadScope) {
  return nativeMarketOverviewResponseSchema.superRefine((value, context) => authority(value, scope, context));
}

export const nativeMarketBarsResponseSchema = marketBarsResultSchema.extend({ serviceReceipt: receipt("app.market_research.bars.list") }).strict().superRefine((value, context) => {
  read(value, context, value.bars.length);
  const body = { contractVersion: value.contractVersion, instrumentId: value.instrumentId, provider: value.provider, providerSymbol: value.providerSymbol, providerTimezone: value.providerTimezone, interval: value.interval, asOf: value.asOf, bars: value.bars };
  if (value.snapshotSha256 !== canonicalJsonSha256(body)) issue(context, "Snapshot digest differs from the normalized price evidence.");
  value.bars.forEach((bar, index) => {
    if (!Number.isSafeInteger(bar.time) || Date.parse(bar.timestamp) !== bar.time * 1000 || (index > 0 && bar.time <= value.bars[index - 1].time)) issue(context, "Price bars require unique ordered timestamp identities.");
  });
  // No invented bars, gap filling, live-price claim, or freshness timeout.
});
export function nativeMarketBarsResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketBarsQuerySchema>) {
  const expected = marketBarsQuerySchema.parse(query);
  return nativeMarketBarsResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.instrumentId !== expected.instrumentId || value.interval !== expected.interval || value.bars.length > expected.outputSize || value.snapshotId !== `market_snapshot_${hash48(`${scope.tenantId}:${scope.requestActorId}:${value.snapshotSha256}`)}`) issue(context, "Snapshot differs from the exact owner, instrument, interval, or requested bound.");
  });
}

export const nativeMarketSnapshotsResponseSchema = marketStoredSnapshotsResultSchema.extend({ serviceReceipt: receipt("app.market_research.snapshots.list") }).strict().superRefine((value, context) => {
  read(value, context, value.snapshots.length);
  unique(value.snapshots.map((row) => row.snapshotId), context);
  for (const row of value.snapshots) if (row.instrumentId !== value.instrumentId || row.interval !== value.interval) issue(context, "Stored snapshot metadata differs from the selected instrument or interval.");
});
export function nativeMarketSnapshotsResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketStoredSnapshotsQuerySchema>) {
  const expected = marketStoredSnapshotsQuerySchema.parse(query);
  return nativeMarketSnapshotsResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.instrumentId !== expected.instrumentId || value.interval !== expected.interval || value.snapshots.length > expected.limit) issue(context, "Stored snapshot page differs from the exact request.");
    for (const row of value.snapshots) if (row.snapshotId !== `market_snapshot_${hash48(`${scope.tenantId}:${scope.requestActorId}:${row.snapshotSha256}`)}`) issue(context, "Stored snapshot belongs to another owner.");
  });
}
export const nativeMarketStoredSnapshotResponseSchema = marketBarsResultSchema.extend({ snapshotSource: z.literal("cache"), serviceReceipt: receipt("app.market_research.snapshots.show") }).strict().superRefine((value, context) => {
  read(value, context, value.bars.length);
  const body = { contractVersion: value.contractVersion, instrumentId: value.instrumentId, provider: value.provider, providerSymbol: value.providerSymbol, providerTimezone: value.providerTimezone, interval: value.interval, asOf: value.asOf, bars: value.bars };
  if (value.snapshotSha256 !== canonicalJsonSha256(body)) issue(context, "Stored snapshot digest differs from its evidence.");
  value.bars.forEach((bar, index) => { if (!Number.isSafeInteger(bar.time) || Date.parse(bar.timestamp) !== bar.time * 1000 || (index > 0 && bar.time <= value.bars[index - 1].time)) issue(context, "Stored bars require unique ordered timestamp identities."); });
});
export function nativeMarketStoredSnapshotResponseForScopeSchema(scope: NativeMarketReadScope, expected: { snapshotId: string; instrumentId?: string; interval?: string }) {
  return nativeMarketStoredSnapshotResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.snapshotId !== expected.snapshotId || value.snapshotId !== `market_snapshot_${hash48(`${scope.tenantId}:${scope.requestActorId}:${value.snapshotSha256}`)}` || (expected.instrumentId !== undefined && value.instrumentId !== expected.instrumentId) || (expected.interval !== undefined && value.interval !== expected.interval)) issue(context, "Stored snapshot differs from its exact owner and selection.");
  });
}
export const nativeMarketAnalysisMetadataResponseSchema = marketAnalysisMetadataResultSchema.extend({ serviceReceipt: receipt("app.market_research.analysis.list") }).strict().superRefine((value, context) => {
  read(value, context, value.versions.length);
  unique(value.versions.map((row) => row.id), context);
  for (const row of value.versions) if (row.instrumentId !== value.instrumentId || row.interval !== value.interval) issue(context, "Saved analysis metadata differs from the selected market.");
});
export function nativeMarketAnalysisMetadataResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketAnalysisMetadataQuerySchema>) {
  const expected = marketAnalysisMetadataQuerySchema.parse(query);
  return nativeMarketAnalysisMetadataResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.instrumentId !== expected.instrumentId || value.interval !== expected.interval || value.versions.length > expected.limit) issue(context, "Saved analysis metadata differs from the requested bounded page.");
    for (const row of value.versions) if (row.snapshotId !== `market_snapshot_${hash48(`${scope.tenantId}:${scope.requestActorId}:${row.snapshotSha256}`)}`) issue(context, "Saved analysis snapshot belongs to another owner.");
  });
}

export const nativeMarketFeaturesResponseSchema = marketTechnicalFeaturesResultSchema.extend({ serviceReceipt: receipt("app.market_research.features.show") }).strict().superRefine((value, context) => {
  read(value, context, value.detections.length);
  digestBody(value, "resultSha256", ["serviceReceipt"], context);
  unique(value.detections.map((row) => row.id), context);
  unique(value.annotations.map((row) => row.id), context);
  unique(value.layers.map((row) => row.id), context);
  unique(value.definitions.map((row) => row.id), context);
  unique(value.timeContext.references.map((row) => row.id), context);
  realDate(value.timeContext.localDate, context);
  safeCounts(Object.values(value.counts), context);
  for (const annotation of value.annotations) {
    const detection = value.detections.find((row) => row.id === annotation.detectionId);
    if (!detection || !value.layers.some((row) => row.id === annotation.layerId) || annotation.concept !== detection.kind || annotation.direction !== detection.direction || annotation.reviewState !== detection.reviewState || annotation.state !== detection.state) issue(context, "Annotation differs from its exact detection or layer.");
  }
});
export function nativeMarketFeaturesResponseForScopeSchema(scope: NativeMarketReadScope, expected: { snapshotId: string; snapshotSha256?: string; instrumentId?: string; interval?: string }) {
  snapshotId.parse(expected.snapshotId);
  return nativeMarketFeaturesResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.snapshot.id !== expected.snapshotId || (expected.snapshotSha256 !== undefined && value.snapshot.sha256 !== expected.snapshotSha256) || (expected.instrumentId !== undefined && value.snapshot.instrumentId !== expected.instrumentId) || (expected.interval !== undefined && value.snapshot.interval !== expected.interval)) issue(context, "Technical evidence differs from the selected immutable snapshot.");
    if (value.snapshot.id !== `market_snapshot_${hash48(`${scope.tenantId}:${scope.requestActorId}:${value.snapshot.sha256}`)}`) issue(context, "Technical snapshot belongs to another owner.");
  });
}

export const nativeMarketEventsResponseSchema = marketEventsResultSchema.extend({ serviceReceipt: receipt("app.market_research.events.list") }).strict().superRefine((value, context) => {
  read(value, context, value.events.length);
  safeCounts([value.total], context);
  unique(value.events.map((row) => row.id), context);
  for (const event of value.events) {
    realDate(event.releaseDate, context);
    safeCounts([event.sourceReleaseId], context);
    if (event.id !== `market_event_${hash48(`fred:${event.sourceReleaseId}:${event.releaseDate}`)}`) issue(context, "Event identity differs from its source release and date.");
    if ((event.timestampPrecision === "instant") !== (event.occurredAt !== null)) issue(context, "Date-only evidence cannot claim an exact release time.");
    unique(event.observations.map((row) => row.id), context);
    for (const observation of event.observations) {
      realDate(observation.observationDate, context); realDate(observation.releaseDate, context); realDate(observation.vintageEnd, context);
      if (observation.releaseDate !== event.releaseDate || observation.seriesId.length > 120) issue(context, "Observation differs from the bounded source release.");
    }
  }
  // Rows and totals are live separate queries. No fabricated hasMore or empty
  // availability signal: an unconfigured store currently returns this shape.
});
export function nativeMarketEventsResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketEventsQuerySchema> = {}) {
  const expected = marketEventsQuerySchema.parse(query);
  return nativeMarketEventsResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.events.length > expected.limit) issue(context, "Event page exceeds the requested bound.");
  });
}

export const nativeMarketReplaysResponseSchema = marketEventReplaysResultSchema.extend({ serviceReceipt: receipt("app.market_research.replays.list") }).strict().superRefine((value, context) => {
  read(value, context, value.replays.length);
  unique(value.replays.map((row) => row.id), context);
  unique(value.replays.map((row) => row.eventId), context);
  safeCounts([value.eligibleEvents, value.replayedEvents, value.remainingEvents], context);
  if (value.remainingEvents !== Math.max(0, value.eligibleEvents - value.replayedEvents)) issue(context, "Replay coverage counts disagree.");
  for (const replay of value.replays) if (replay.instrumentId !== value.instrumentId) issue(context, "Replay belongs to another instrument.");
});
export function nativeMarketReplaysResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketEventReplaysQuerySchema>) {
  const expected = marketEventReplaysQuerySchema.parse(query);
  return nativeMarketReplaysResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.instrumentId !== expected.instrumentId || value.replays.length > expected.limit) issue(context, "Replay page differs from the selected instrument or bound.");
    for (const replay of value.replays) if (replay.id !== `market_replay_${hash48(`${scope.tenantId}:${scope.requestActorId}:${replay.eventId}:${replay.instrumentId}:${replay.interval}:${replay.snapshotSha256}`)}`) issue(context, "Replay identity belongs to another owner or source snapshot.");
  });
}

export const nativeMarketBaselinesResponseSchema = marketEventBaselinesResultSchema.extend({ serviceReceipt: receipt("app.market_research.baselines.show") }).strict().superRefine((value, context) => {
  read(value, context, value.groups.length);
  digestBody(value, "resultSha256", ["serviceReceipt"], context);
  unique(value.groups.map((row) => row.eventKey), context);
  if (value.includedReplays > 500 || value.groups.reduce((total, row) => total + row.sampleSize, 0) !== value.includedReplays) issue(context, "Baseline samples differ from the bounded replay cohort.");
  for (const group of value.groups) {
    if (group.state !== (group.sampleSize >= value.minimumSampleSize ? "descriptive_baseline" : "low_sample")) issue(context, "Baseline state differs from the reported sample threshold.");
  }
  // Included samples are a capped cohort, never an all-history probability.
});
export function nativeMarketBaselinesResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketEventBaselinesQuerySchema>) {
  const expected = marketEventBaselinesQuerySchema.parse(query);
  return nativeMarketBaselinesResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.instrumentId !== expected.instrumentId || value.minimumSampleSize !== expected.minimumSampleSize) issue(context, "Baseline differs from the selected cohort request.");
  });
}

export const nativeMarketBacktestsResponseSchema = marketBacktestsResultSchema.extend({ serviceReceipt: receipt("app.market_research.backtests.list") }).strict().superRefine((value, context) => {
  read(value, context, value.backtests.length);
  unique(value.backtests.map((row) => row.id), context);
  safeCounts([value.total], context);
  for (const backtest of value.backtests) {
    if (backtest.instrumentId !== value.instrumentId) issue(context, "Backtest belongs to another instrument.");
    digestBody(backtest, "resultSha256", ["createdAt"], context);
    unique(backtest.trades.map((trade) => trade.id), context);
    if (backtest.metrics.overall.trades !== backtest.trades.length) issue(context, "Backtest trade count differs from its immutable result.");
  }
});
export function nativeMarketBacktestsResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketBacktestsQuerySchema>) {
  const expected = marketBacktestsQuerySchema.parse(query);
  return nativeMarketBacktestsResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.instrumentId !== expected.instrumentId || value.backtests.length > expected.limit) issue(context, "Backtest page differs from the selected instrument or bound.");
    for (const backtest of value.backtests) {
      const identity = canonicalJsonSha256({ tenantId: scope.tenantId, actorId: scope.requestActorId, snapshotId: backtest.snapshotId, snapshotSha256: backtest.snapshotSha256, manifest: backtest.manifest });
      if (backtest.id !== `market_backtest_${hash48(identity)}`) issue(context, "Backtest identity belongs to another owner, snapshot, or manifest.");
    }
  });
}

export const nativeMarketJournalResponseSchema = marketForecastJournalResultSchema.extend({ serviceReceipt: receipt("app.market_research.journal.list") }).strict().superRefine((value, context) => {
  read(value, context, value.entries.length);
  unique(value.entries.map((row) => row.forecast.id), context);
  const resolved = value.entries.filter((row) => row.outcome !== null);
  const directional = resolved.filter((row) => row.forecast.stance !== "abstain");
  const hits = directional.filter((row) => row.outcome?.stanceHit === true);
  const expected = { total: value.entries.length, resolved: resolved.length, due: value.entries.filter((row) => row.resolutionState === "due").length, abstentions: value.entries.filter((row) => row.forecast.stance === "abstain").length, directionalAccuracy: directional.length ? hits.length / directional.length : null, directionalSampleSize: directional.length, coverage: resolved.length ? directional.length / resolved.length : null, brierScore: null, probabilityState: "uncalibrated" };
  if (canonicalJsonSha256(value.scorecard) !== canonicalJsonSha256(expected)) issue(context, "Scorecard must describe only the returned bounded journal.");
  for (const entry of value.entries) {
    const forecast = entry.forecast;
    if (forecast.instrumentId !== value.instrumentId || (entry.resolutionState === "resolved") !== Boolean(entry.outcome)) issue(context, "Journal evidence or resolution state differs from its exact forecast.");
    digestBody(forecast, "forecastSha256", ["id"], context);
    safeCounts([forecast.modelAttribution.assignmentRevision, forecast.evidence.baselineReplayCount, forecast.evidence.baselineQualifiedGroups], context);
    unique(forecast.evidence.macroEventIds, context);
    if (entry.outcome) {
      if (entry.outcome.forecastId !== forecast.id) issue(context, "Outcome belongs to another forecast.");
      digestBody(entry.outcome, "outcomeSha256", ["id"], context);
      if (entry.outcome.id !== `market_forecast_outcome_${hash48(JSON.stringify({ forecastId: forecast.id, outcomeSha256: entry.outcome.outcomeSha256 }))}`) issue(context, "Outcome identity differs from its exact forecast and digest.");
    }
  }
});
export function nativeMarketJournalResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketForecastJournalQuerySchema>) {
  const expected = marketForecastJournalQuerySchema.parse(query);
  return nativeMarketJournalResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.instrumentId !== expected.instrumentId || value.entries.length > expected.limit) issue(context, "Journal differs from the selected instrument or bound.");
    for (const entry of value.entries) if (entry.forecast.id !== `market_forecast_${hash48(JSON.stringify({ tenantId: scope.tenantId, actorId: scope.requestActorId, forecastSha256: entry.forecast.forecastSha256 }))}`) issue(context, "Forecast identity belongs to another owner or evidence body.");
  });
}

// Existing calendar reuses events.list. This schema preserves that actual wire
// contract; it does not claim a separately published native calendar operation.
export const nativeMarketCalendarResponseSchema = marketLiveCalendarResultSchema.extend({ serviceReceipt: receipt("app.market_research.events.list") }).strict().superRefine((value, context) => {
  read(value, context, value.events.length);
  realDate(value.marketDate, context);
  unique(value.sourceHealth.map((row) => row.source), context);
  unique(value.catalog.families.map((row) => row.eventKey), context);
  for (const event of value.events) realDate(event.releaseDate, context);
  safeCounts([value.catalog.reviewedFamilies, value.catalog.exactTimeFamilies, value.catalog.dateOnlyFamilies, ...value.sourceHealth.map((row) => row.eventCount)], context);
});
export function nativeMarketCalendarResponseForScopeSchema(scope: NativeMarketReadScope, query: z.input<typeof marketLiveCalendarQuerySchema> = {}) {
  const expected = marketLiveCalendarQuerySchema.parse(query);
  return nativeMarketCalendarResponseSchema.superRefine((value, context) => {
    authority(value, scope, context);
    if (value.windowDays !== expected.days) issue(context, "Calendar differs from the requested date window.");
  });
}

const commonProgress = [
  z.object({ stage: z.literal("processing"), startedAt: timestamp }).strict(),
  z.object({ stage: z.literal("completed"), completedAt: timestamp }).strict(),
] as const;
const importCounts = { completedSources: count, totalSources: count, importedEvents: count, importedSchedules: count, importedObservations: count };
const discoveredCounts = { discoveredDates: count, discoveredObservations: count };
const source = z.enum(["bls", "census", "bea", "federal_reserve"]);
const eventProgress = z.union([
  ...commonProgress,
  z.object({ stage: z.literal("queued"), ...importCounts }).strict(),
  z.object({ stage: z.enum(["fetching_release_history", "saving_release_history"]), ...importCounts, ...discoveredCounts, currentEventKey: eventKey }).strict(),
  z.object({ stage: z.enum(["fetching_official_schedule", "saving_official_schedule"]), ...importCounts, ...discoveredCounts, currentScheduleSource: source }).strict(),
  z.object({ stage: z.enum(["fetching_initial_release_values", "saving_initial_release_values"]), ...importCounts, ...discoveredCounts, currentEventKey: eventKey, currentSeriesId: z.string().regex(/^[A-Z0-9]+$/).max(120) }).strict(),
]);
const replayCounts = { completedEvents: count.max(24), totalEvents: count.max(24), importedReplays: count.max(24), skippedEvents: count.max(24) };
const replayProgress = z.union([
  ...commonProgress,
  z.object({ stage: z.literal("queued"), ...replayCounts }).strict(),
  z.object({ stage: z.enum(["fetching_price_window", "saving_price_window"]), ...replayCounts, currentEventKey: eventKey, currentOccurredAt: timestamp }).strict(),
]);
const backtestProgress = z.union([
  ...commonProgress,
  z.object({ stage: z.enum(["queued", "reading_snapshot", "running_strategy"]), completedBars: count.max(1000), totalBars: count.max(1000) }).strict(),
  z.object({ stage: z.literal("saving_result"), completedBars: count.max(1000), totalBars: count.max(1000), tradeCount: count.max(1000) }).strict(),
]);
const eventResult = z.object({ resourceId: z.literal("market_event_history"), importedEvents: count, importedSchedules: count, importedObservations: count, discoveredDates: count, discoveredObservations: count, sourcesProcessed: count, startDate: nativeMarketDateSchema, endDate: nativeMarketDateSchema, timestampPrecision: z.literal("date") }).strict();
const replayResult = z.object({ resourceId: z.literal("market_event_replays"), instrumentId: marketInstrumentIdSchema, interval, consideredEvents: count.max(24), importedReplays: count.max(24), skippedEvents: count.max(24), startDate: nativeMarketDateSchema, endDate: nativeMarketDateSchema }).strict();
const backtestResult = z.object({ resourceId: backtestId, backtestId, reused: z.boolean(), instrumentId: marketInstrumentIdSchema, snapshotId, resultSha256: sha, tradeCount: count.max(1000) }).strict();
const jobBase = z.object({
  id: z.string().uuid(), status: z.enum(["queued", "running", "completed", "failed", "canceled"]), quarantined: z.literal(true).optional(),
  priority: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), attempt: count, maxAttempts: count.min(1),
  runAt: timestamp, createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp.optional(), lastError: z.string().max(4000).optional(),
}).strict();
export const nativeMarketJobSchema = z.discriminatedUnion("type", [
  jobBase.extend({ type: z.literal("market.events.backfill"), progress: eventProgress.optional(), result: eventResult.optional() }).strict(),
  jobBase.extend({ type: z.literal("market.replays.backfill"), progress: replayProgress.optional(), result: replayResult.optional() }).strict(),
  jobBase.extend({ type: z.literal("market.backtest.run"), progress: backtestProgress.optional(), result: backtestResult.optional() }).strict(),
]).superRefine((value, context) => {
  if (value.quarantined && value.status !== "failed") issue(context, "Quarantine must retain the server's failed status projection.");
  if (value.type === "market.backtest.run" && value.result && value.result.resourceId !== value.result.backtestId) issue(context, "Backtest job result identities disagree.");
  if (value.type !== "market.backtest.run" && value.result && value.result.startDate > value.result.endDate) issue(context, "Job date window is reversed.");
  // Result/progress are committed before terminal status: running + completed
  // progress is a valid observation, not proof that another enqueue is safe.
});
export const nativeMarketJobResponseSchema = z.object({ job: nativeMarketJobSchema }).strict();
export function nativeMarketJobResponseForTargetSchema(target: { jobId: string; type: z.infer<typeof nativeMarketJobSchema>["type"]; instrumentId?: string; snapshotId?: string }) {
  z.string().uuid().parse(target.jobId);
  return nativeMarketJobResponseSchema.superRefine((value, context) => {
    if (value.job.id !== target.jobId || value.job.type !== target.type) issue(context, "Job differs from the exact requested identity.");
    if (value.job.type !== "market.events.backfill" && value.job.result && target.instrumentId !== undefined && value.job.result.instrumentId !== target.instrumentId) issue(context, "Job result belongs to another submitted instrument.");
    if (value.job.type === "market.backtest.run" && value.job.result && target.snapshotId !== undefined && value.job.result.snapshotId !== target.snapshotId) issue(context, "Job result belongs to another submitted snapshot.");
    // GET jobs has no owner/request receipt. Bootstrap, exact URL and request
    // generation fences remain necessary; these fields cannot grant authority.
  });
}

export const nativeMarketReadContractSchemas = {
  NativeMarketSnapshotsQuery: nativeMarketSnapshotsQuerySchema, NativeMarketSnapshotsResponse: nativeMarketSnapshotsResponseSchema,
  NativeMarketStoredSnapshotResponse: nativeMarketStoredSnapshotResponseSchema,
  NativeMarketAnalysisMetadataQuery: nativeMarketAnalysisMetadataQuerySchema, NativeMarketAnalysisMetadataResponse: nativeMarketAnalysisMetadataResponseSchema,
  NativeMarketBarsQuery: nativeMarketBarsQuerySchema, NativeMarketFeaturesQuery: nativeMarketFeaturesQuerySchema,
  NativeMarketEventsQuery: nativeMarketEventsQuerySchema, NativeMarketReplaysQuery: nativeMarketReplaysQuerySchema,
  NativeMarketBaselinesQuery: nativeMarketBaselinesQuerySchema, NativeMarketBacktestsQuery: nativeMarketBacktestsQuerySchema,
  NativeMarketJournalQuery: nativeMarketJournalQuerySchema, NativeMarketCalendarQuery: nativeMarketCalendarQuerySchema,
  NativeMarketOverviewResponse: nativeMarketOverviewResponseSchema, NativeMarketBarsResponse: nativeMarketBarsResponseSchema,
  NativeMarketFeaturesResponse: nativeMarketFeaturesResponseSchema, NativeMarketEventsResponse: nativeMarketEventsResponseSchema,
  NativeMarketReplaysResponse: nativeMarketReplaysResponseSchema, NativeMarketBaselinesResponse: nativeMarketBaselinesResponseSchema,
  NativeMarketBacktestsResponse: nativeMarketBacktestsResponseSchema, NativeMarketJournalResponse: nativeMarketJournalResponseSchema,
  NativeMarketCalendarResponse: nativeMarketCalendarResponseSchema, NativeMarketJobResponse: nativeMarketJobResponseSchema,
} as const;
