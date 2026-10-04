import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { APP_SERVICE_BOUNDARY_VERSION } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildDeterministicMarketBacktest } from "@/lib/market-research/backtest-engine";
import { MARKET_RESEARCH_CONTRACT_VERSION, marketBacktestRequestSchema, marketBarsResultSchema, type MarketEventReplay } from "@/lib/market-research/contracts";
import { buildMarketEventBaselines } from "@/lib/market-research/event-baselines";
import { buildMarketForwardForecast, scoreMarketForwardForecast } from "@/lib/market-research/forward-shadow";
import { marketInstruments } from "@/lib/market-research/instruments";
import { buildMarketTechnicalFeatures } from "@/lib/market-research/technical-features";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  nativeMarketBacktestsQuerySchema, nativeMarketBacktestsResponseForScopeSchema, nativeMarketBacktestsResponseSchema,
  nativeMarketBarsQuerySchema, nativeMarketBarsResponseForScopeSchema, nativeMarketBarsResponseSchema,
  nativeMarketBaselinesQuerySchema, nativeMarketBaselinesResponseForScopeSchema, nativeMarketBaselinesResponseSchema,
  nativeMarketCalendarQuerySchema, nativeMarketCalendarResponseForScopeSchema, nativeMarketDateSchema,
  nativeMarketEventsQuerySchema, nativeMarketEventsResponseForScopeSchema, nativeMarketEventsResponseSchema,
  nativeMarketFeaturesResponseForScopeSchema, nativeMarketFeaturesResponseSchema,
  nativeMarketJobResponseForTargetSchema, nativeMarketJobResponseSchema,
  nativeMarketJournalQuerySchema, nativeMarketJournalResponseForScopeSchema, nativeMarketJournalResponseSchema,
  nativeMarketOverviewResponseForScopeSchema, nativeMarketOverviewResponseSchema, nativeMarketReadContractSchemas,
  nativeMarketReplaysQuerySchema, nativeMarketReplaysResponseForScopeSchema, nativeMarketReplaysResponseSchema,
  nativeMarketSnapshotsResponseForScopeSchema, nativeMarketStoredSnapshotResponseForScopeSchema,
  nativeMarketAnalysisMetadataResponseForScopeSchema,
} from "./market-contracts";

const now = "2026-10-04T10:00:00.000Z", instrumentId = "xauusd.spot";
const scope = { tenantId: "tenant-a", requestActorId: "reader@example.test", role: "viewer" };
const hash48 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 48);
type Operation = Parameters<typeof getAppServiceOperationContract>[0];
function response<T extends object>(body: T, operation: Operation, resourceCount: number, owner = scope) {
  const contract = getAppServiceOperationContract(operation);
  const receipt = { schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, operation, action: contract.action, resourceType: contract.resourceType, eventContract: contract.eventContract, accessMode: "read", authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: owner.tenantId, actorId: owner.requestActorId, role: owner.role, executionScope: null }), idempotencyKeySha256: null, outcomeSha256: canonicalJsonSha256(body), resourceCount, occurredAt: now };
  return { ...body, serviceReceipt: { ...receipt, receiptSha256: canonicalJsonSha256(receipt) } };
}
function withDigest<T extends object>(body: T, field: string) { return { ...body, [field]: canonicalJsonSha256(body) }; }
function snapshot(length = 30, owner = scope) {
  const start = Date.parse("2026-10-02T08:00:00.000Z");
  const bars = Array.from({ length }, (_, index) => ({ time: (start + index * 900_000) / 1000, timestamp: new Date(start + index * 900_000).toISOString(), open: 100, high: 101 + index / 100, low: 99, close: 100 + index / 100, volume: null }));
  const body = { contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, instrumentId, provider: "twelve_data", providerSymbol: "XAU/USD", providerTimezone: "UTC", interval: "15min", asOf: bars.at(-1)?.timestamp ?? now, bars };
  const snapshotSha256 = canonicalJsonSha256(body);
  return marketBarsResultSchema.parse({ ...body, retrievedAt: now, snapshotSha256, snapshotId: `market_snapshot_${hash48(`${owner.tenantId}:${owner.requestActorId}:${snapshotSha256}`)}`, snapshotSource: "cache" });
}
function overview() {
  return { contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, generatedAt: now, phase: "configuration_required", instruments: [...marketInstruments],
    providers: ["twelve_data", "fred", "bls"].map((provider) => ({ provider, label: provider, purpose: "Research data", configured: false, blocking: true, status: "credential_required", setupVariable: "UNCONFIGURED" })),
    agent: { agentId: "meridian", name: "Meridian", role: "Market research", modelScope: "market_research", assignmentState: "assignment_required", configured: false, provider: null, model: null, source: "deployment_environment", note: "A deployment fallback is not an assignment." },
    engineTracks: ["event_replay", "ict_detectors", "scenario_forecast", "forward_shadow"].map((id) => ({ id, label: id, state: "blocked", note: "Configuration required" })), guardrails: ["Research only"] };
}
function event(releaseDate = "2026-10-02") {
  return { id: `market_event_${hash48(`fred:10:${releaseDate}`)}`, eventKey: "us.cpi", name: "Release <script>inert</script>", currency: "USD", impact: "high", source: "fred", sourceReleaseId: 10, sourceUrl: "https://fred.stlouisfed.org/release?rid=10", releaseDate, occurredAt: null, timestampPrecision: "date", scheduleSource: null, scheduleSourceUrl: null, actual: null, consensus: null, previous: null, revised: null, valueStatus: "release_date_only", observations: [], importedAt: now };
}
function events() { return { contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, events: [event()], total: 900, lastImportedAt: now }; }
function replay(index = 1): MarketEventReplay {
  const eventId = `market_event_${hash48(String(index))}`, snapshotSha256 = "a".repeat(64);
  const id = `market_replay_${hash48(`${scope.tenantId}:${scope.requestActorId}:${eventId}:${instrumentId}:5min:${snapshotSha256}`)}`;
  return { id, eventId, eventKey: "us.cpi", instrumentId, provider: "twelve_data", providerSymbol: "XAU/USD", interval: "5min", occurredAt: now, windowStart: now, windowEnd: "2026-10-04T14:00:00.000Z", retrievedAt: now, barCount: 1, snapshotSha256, baseline: { timestamp: now, close: 100 }, post5m: null, post15m: null, post60m: null, post240m: null, pre60mRangeBps: null, post60mRangeBps: null, maxFavorableBps: null, maxAdverseBps: null, direction: "insufficient_data" };
}
function replays() { return { contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, instrumentId, replays: [replay()], eligibleEvents: 1000, replayedEvents: 900, remainingEvents: 100, lastReplayedAt: now }; }
function baselines(replays: MarketEventReplay[] = []) { return buildMarketEventBaselines({ instrumentId, minimumSampleSize: 20, replays }); }
function forecast() {
  return buildMarketForwardForecast({ tenantId: scope.tenantId, actorId: scope.requestActorId, instrumentId, horizon: "daily", window: { start: "2026-10-05T13:30:00.000Z", end: "2026-10-05T20:00:00.000Z" }, sealedAt: now, features: buildMarketTechnicalFeatures(snapshot()), baselines: baselines(), macroEvents: [],
    modelOutput: { stance: "abstain", evidenceStrength: "insufficient", summary: "The bounded evidence does not support a direction.", scenarios: (["bullish", "bearish", "neutral"] as const).map((direction, index) => ({ direction, rank: index + 1, thesis: `${direction} research scenario`, observationZone: null, targets: [], invalidation: null, supportingFeatureIds: [] })), warnings: ["Consensus is unavailable."] },
    modelAttribution: { provider: "openai", model: "research-model", assignmentScope: "market_research", assignmentId: "assignment:one", assignmentRevision: 1, assignmentConfigurationSha256: "a".repeat(64), usageReceiptId: "11111111-1111-4111-8111-111111111111", usageReceiptRecorded: true } });
}
function journal(resolved = false) {
  const value = forecast();
  const bars = [value.windowStart, value.windowEnd].map((timestamp) => ({ time: Date.parse(timestamp) / 1000, timestamp, open: 100, high: 102, low: 99, close: 101, volume: null }));
  const { snapshotId: _snapshotId, snapshotSha256: _snapshotSha256, snapshotSource: _snapshotSource, ...provider } = snapshot();
  const outcome = resolved ? scoreMarketForwardForecast({ forecast: value, result: { ...provider, bars, asOf: value.windowEnd, retrievedAt: "2026-10-05T20:01:00.000Z" }, sourcePayload: { fixture: true }, resolvedAt: "2026-10-05T20:01:00.000Z" }) : null;
  return { contractVersion: "market-forward-shadow:1", instrumentId, entries: [{ forecast: value, resolutionState: resolved ? "resolved" : "due", outcome }], scorecard: { total: 1, resolved: resolved ? 1 : 0, due: resolved ? 0 : 1, abstentions: 1, directionalAccuracy: null, directionalSampleSize: 0, coverage: resolved ? 0 : null, brierScore: null, probabilityState: "uncalibrated" } };
}
function backtests() {
  const source = snapshot();
  const backtest = buildDeterministicMarketBacktest({ tenantId: scope.tenantId, actorId: scope.requestActorId, snapshot: source, request: marketBacktestRequestSchema.parse({ snapshotId: source.snapshotId }), createdAt: now });
  return { contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, instrumentId, backtests: [backtest], total: 120 };
}
function calendar() {
  return { contractVersion: "market-live-calendar:1", generatedAt: now, marketDate: "2026-10-04", timezone: "America/New_York", windowDays: 14, catalog: { reviewedFamilies: 0, exactTimeFamilies: 0, dateOnlyFamilies: 0, families: [] }, events: [], sourceHealth: ["bls", "census", "bea", "federal_reserve"].map((source) => ({ source, status: source === "bls" ? "unavailable" : "connected", eventCount: 0, note: "Only observed source state is reported." })), disclosures: ["Missing sources are not empty calendars."] };
}
function job() {
  return { id: "22222222-2222-4222-8222-222222222222", type: "market.backtest.run", status: "queued", progress: { stage: "queued", completedBars: 0, totalBars: 0 }, priority: 1, attempt: 0, maxAttempts: 3, runAt: now, createdAt: now, updatedAt: now };
}

describe("standalone native Markets read candidates", () => {
  it("has no mutation request, arbitrary chart state, or capability enrollment", () => {
    expect(Object.keys(nativeMarketReadContractSchemas)).toHaveLength(23);
    expect(Object.keys(nativeMarketReadContractSchemas).some((name) => /Mutation|Generate|RunRequest|Backfill/.test(name))).toBe(false);
  });
  it("accepts an exact stored snapshot without claiming a provider refresh", () => {
    const source = snapshot();
    const schema = nativeMarketStoredSnapshotResponseForScopeSchema(scope, { snapshotId: source.snapshotId, instrumentId, interval: "15min" });
    expect(schema.parse(response(source, "app.market_research.snapshots.show", source.bars.length)).snapshotSource).toBe("cache");
    expect(schema.safeParse(response({ ...source, snapshotSource: "provider" }, "app.market_research.snapshots.show", source.bars.length)).success).toBe(false);
    expect(schema.safeParse(response(snapshot(31), "app.market_research.snapshots.show", 31)).success).toBe(false);
  });
  it("binds bounded stored metadata to the exact owner and snapshot", () => {
    const source = snapshot(), { bars, snapshotSource: _source, contractVersion: _version, ...metadata } = source;
    const body = { contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, instrumentId, interval: "15min", snapshots: [{ ...metadata, barCount: bars.length }], hasMore: true };
    const schema = nativeMarketSnapshotsResponseForScopeSchema(scope, { instrumentId, interval: "15min", limit: 1 });
    expect(schema.parse(response(body, "app.market_research.snapshots.list", 1)).hasMore).toBe(true);
    expect(nativeMarketSnapshotsResponseForScopeSchema({ ...scope, requestActorId: "other@example.test" }, { instrumentId, interval: "15min" }).safeParse(response(body, "app.market_research.snapshots.list", 1)).success).toBe(false);
    expect(schema.safeParse(response({ ...body, snapshots: [body.snapshots[0], body.snapshots[0]] }, "app.market_research.snapshots.list", 2)).success).toBe(false);
  });
  it("accepts a truly empty metadata page and rejects opaque plugin state", () => {
    const body = { contractVersion: "market-analysis-version:1", view: "metadata", instrumentId, interval: "15min", versions: [], total: 0 };
    const schema = nativeMarketAnalysisMetadataResponseForScopeSchema(scope, { instrumentId, interval: "15min", view: "metadata" });
    expect(schema.parse(response(body, "app.market_research.analysis.list", 0)).versions).toEqual([]);
    expect(schema.safeParse(response({ ...body, chartState: { plugin: {} } }, "app.market_research.analysis.list", 0)).success).toBe(false);
  });
  it.each([
    [nativeMarketBarsQuerySchema, "outputSize", 100, 1000, { instrumentId }],
    [nativeMarketEventsQuerySchema, "limit", 1, 500, {}],
    [nativeMarketReplaysQuerySchema, "limit", 1, 500, { instrumentId }],
    [nativeMarketBaselinesQuerySchema, "minimumSampleSize", 5, 100, { instrumentId }],
    [nativeMarketBacktestsQuerySchema, "limit", 1, 100, { instrumentId }],
    [nativeMarketJournalQuerySchema, "limit", 1, 100, { instrumentId }],
    [nativeMarketCalendarQuerySchema, "days", 1, 31, {}],
  ] as const)("matches existing GET bounds %#", (schema, field, minimum, maximum, rest) => {
    expect(schema.safeParse({ ...rest, [field]: minimum }).success).toBe(true);
    expect(schema.safeParse({ ...rest, [field]: maximum }).success).toBe(true);
    for (const value of [minimum - 1, maximum + 1, 1.5, "20", Infinity]) expect(schema.safeParse({ ...rest, [field]: value }).success).toBe(false);
    expect(schema.safeParse({ ...rest, actorId: "forged-owner" }).success).toBe(false);
  });
  it.each(["2024-02-29", "2000-02-29", "2026-10-04"])("accepts real calendar date %s", (value) => expect(nativeMarketDateSchema.safeParse(value).success).toBe(true));
  it.each(["2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-1-02"])("rejects invalid date %s", (value) => expect(nativeMarketDateSchema.safeParse(value).success).toBe(false));
  it("retains configuration-required overview without implying a live price or model assignment", () => {
    const value = nativeMarketOverviewResponseForScopeSchema(scope).parse(response(overview(), "app.market_research.overview.show", 2));
    expect(value.phase).toBe("configuration_required"); expect(value.agent.configured).toBe(false);
    expect(value.instruments[1].identityWarning).toContain("not NQ/MNQ");
  });
  it("rejects duplicate registry identities and bounded registry overflow", () => {
    const body = overview();
    expect(nativeMarketOverviewResponseSchema.safeParse(response({ ...body, instruments: [body.instruments[0], body.instruments[0]] }, "app.market_research.overview.show", 2)).success).toBe(false);
    const instruments = Array.from({ length: 21 }, (_, index) => ({ ...body.instruments[0], instrumentId: `instrument.${index}` }));
    expect(nativeMarketOverviewResponseSchema.safeParse(response({ ...body, instruments }, "app.market_research.overview.show", 21)).success).toBe(false);
  });
  it.each(["tenantId", "requestActorId", "role"] as const)("rejects a rehashed foreign %s receipt", (field) => {
    expect(nativeMarketOverviewResponseForScopeSchema(scope).safeParse(response(overview(), "app.market_research.overview.show", 2, { ...scope, [field]: "foreign" })).success).toBe(false);
  });
  it("rejects missing, wrong-operation, altered-body, and wrong-count receipts", () => {
    const body = events();
    expect(nativeMarketEventsResponseSchema.safeParse(body).success).toBe(false);
    expect(nativeMarketEventsResponseSchema.safeParse(response(body, "app.market_research.overview.show", 1)).success).toBe(false);
    expect(nativeMarketEventsResponseSchema.safeParse({ ...response(body, "app.market_research.events.list", 1), total: 901 }).success).toBe(false);
    expect(nativeMarketEventsResponseSchema.safeParse(response(body, "app.market_research.events.list", 0)).success).toBe(false);
  });
  it("preserves immutable cache evidence and its true retrieval/as-of times", () => {
    const body = snapshot();
    const result = nativeMarketBarsResponseForScopeSchema(scope, { instrumentId }).parse(response(body, "app.market_research.bars.list", 30));
    expect(result.snapshotSource).toBe("cache"); expect(result.asOf).toBe(body.asOf); expect(result.retrievedAt).toBe(now);
    expect(result.bars[0].volume).toBeNull();
  });
  it("rejects a same-content snapshot ID owned by another actor", () => {
    const body = snapshot(30, { ...scope, requestActorId: "other@example.test" });
    expect(nativeMarketBarsResponseForScopeSchema(scope, { instrumentId }).safeParse(response(body, "app.market_research.bars.list", 30)).success).toBe(false);
  });
  it("rejects instrument/interval/request-size mismatches even with fresh receipts", () => {
    const body = snapshot(101), wire = response(body, "app.market_research.bars.list", 101);
    for (const query of [{ instrumentId: "ndx.cash" }, { instrumentId, interval: "5min" as const }, { instrumentId, outputSize: 100 }]) expect(nativeMarketBarsResponseForScopeSchema(scope, query).safeParse(wire).success).toBe(false);
  });
  it("rejects corrupt price evidence and duplicate/reversed timestamps", () => {
    const body = snapshot();
    expect(nativeMarketBarsResponseSchema.safeParse(response({ ...body, bars: [{ ...body.bars[0], close: 100.5 }, ...body.bars.slice(1)] }, "app.market_research.bars.list", 30)).success).toBe(false);
    for (const bars of [[body.bars[0], body.bars[0]], [...body.bars].reverse(), [{ ...body.bars[0], time: body.bars[0].time + 1 }]]) {
      const normalized = { contractVersion: body.contractVersion, instrumentId: body.instrumentId, provider: body.provider, providerSymbol: body.providerSymbol, providerTimezone: body.providerTimezone, interval: body.interval, asOf: body.asOf, bars };
      expect(nativeMarketBarsResponseSchema.safeParse(response({ ...body, bars, snapshotSha256: canonicalJsonSha256(normalized) }, "app.market_research.bars.list", bars.length)).success).toBe(false);
    }
  });
  it("accepts real deterministic technical evidence with exact selected snapshot", () => {
    const source = snapshot(), features = buildMarketTechnicalFeatures(source);
    const result = nativeMarketFeaturesResponseForScopeSchema(scope, { snapshotId: source.snapshotId, snapshotSha256: source.snapshotSha256, instrumentId, interval: source.interval }).parse(response(features, "app.market_research.features.show", features.detections.length));
    expect(result.detectorVersion).toBe("market-ict-quarterly-candidates:2");
    expect(result.definitions.some((row) => row.transcriptAuthority === "awaiting_review")).toBe(true);
  });
  it("rejects technical digest tampering, wrong snapshot, and invented annotation source", () => {
    const source = snapshot(), features = buildMarketTechnicalFeatures(source), wire = response(features, "app.market_research.features.show", features.detections.length);
    expect(nativeMarketFeaturesResponseForScopeSchema(scope, { snapshotId: `market_snapshot_${"f".repeat(48)}` }).safeParse(wire).success).toBe(false);
    expect(nativeMarketFeaturesResponseSchema.safeParse(response({ ...features, resultSha256: "0".repeat(64) }, "app.market_research.features.show", features.detections.length)).success).toBe(false);
    expect(features.annotations.length).toBeGreaterThan(0);
    const { resultSha256: _sha, ...body } = features;
    const changed = withDigest({ ...body, annotations: [{ ...features.annotations[0], detectionId: `market_feature_${"f".repeat(48)}` }, ...features.annotations.slice(1)] }, "resultSha256");
    expect(nativeMarketFeaturesResponseSchema.safeParse(response(changed, "app.market_research.features.show", features.detections.length)).success).toBe(false);
  });
  it("keeps date-only events, absent consensus, inert source strings and partial history", () => {
    const value = nativeMarketEventsResponseForScopeSchema(scope, { limit: 1 }).parse(response(events(), "app.market_research.events.list", 1));
    expect(value.total).toBe(900); expect(value.events[0].consensus).toBeNull(); expect(value.events[0].occurredAt).toBeNull(); expect(value.events[0].name).toContain("<script>");
  });
  it("rejects foreign source-release identities, impossible dates and invented exact timestamps", () => {
    for (const changed of [{ ...event(), id: `market_event_${"f".repeat(48)}` }, event("2026-02-30"), { ...event(), occurredAt: now }]) expect(nativeMarketEventsResponseSchema.safeParse(response({ ...events(), events: [changed] }, "app.market_research.events.list", 1)).success).toBe(false);
  });
  it("keeps bounded empty store shape without inventing availability", () => {
    const value = nativeMarketEventsResponseSchema.parse(response({ contractVersion: MARKET_RESEARCH_CONTRACT_VERSION, events: [], total: 0, lastImportedAt: null }, "app.market_research.events.list", 0));
    expect(value).not.toHaveProperty("available"); expect(value.lastImportedAt).toBeNull();
  });
  it("accepts incomplete replay evidence without fabricating missing price windows", () => {
    const value = nativeMarketReplaysResponseForScopeSchema(scope, { instrumentId, limit: 1 }).parse(response(replays(), "app.market_research.replays.list", 1));
    expect(value.replays[0].direction).toBe("insufficient_data"); expect(value.replays[0].post60m).toBeNull(); expect(value.replayedEvents).toBe(900);
  });
  it("rejects mixed instruments, duplicate exact replays, and false coverage", () => {
    const body = replays();
    for (const changed of [{ ...body, replays: [{ ...replay(), instrumentId: "ndx.cash" }] }, { ...body, replays: [replay(), replay()] }, { ...body, remainingEvents: 0 }]) expect(nativeMarketReplaysResponseSchema.safeParse(response(changed, "app.market_research.replays.list", changed.replays.length)).success).toBe(false);
  });
  it("accepts descriptive capped baselines and preserves their low sample warning", () => {
    const body = baselines([replay()]);
    const value = nativeMarketBaselinesResponseForScopeSchema(scope, { instrumentId }).parse(response(body, "app.market_research.baselines.show", 1));
    expect(value.interpretation).toBe("descriptive_not_predictive"); expect(value.groups[0].state).toBe("low_sample");
  });
  it("rejects overstated baseline samples or relabeled probabilities", () => {
    const { resultSha256: _sha, ...body } = baselines([replay()]);
    for (const changed of [{ ...body, includedReplays: 501 }, { ...body, interpretation: "predictive" }, { ...body, groups: [{ ...body.groups[0], state: "descriptive_baseline" }] }]) expect(nativeMarketBaselinesResponseSchema.safeParse(response(withDigest(changed, "resultSha256"), "app.market_research.baselines.show", 1)).success).toBe(false);
  });
  it("accepts existing retrospective engine output without changing analytical meaning", () => {
    const body = backtests();
    const value = nativeMarketBacktestsResponseForScopeSchema(scope, { instrumentId, limit: 1 }).parse(response(body, "app.market_research.backtests.list", 1));
    expect(value.backtests[0].manifest.evaluationLabel).toBe("retrospective_rule_evaluation"); expect(value.total).toBe(120);
  });
  it("rejects backtest evidence corruption and a foreign selected instrument", () => {
    const body = backtests();
    expect(nativeMarketBacktestsResponseSchema.safeParse(response({ ...body, backtests: [{ ...body.backtests[0], resultSha256: "0".repeat(64) }] }, "app.market_research.backtests.list", 1)).success).toBe(false);
    expect(nativeMarketBacktestsResponseForScopeSchema(scope, { instrumentId: "ndx.cash" }).safeParse(response(body, "app.market_research.backtests.list", 1)).success).toBe(false);
  });
  it.each([false, true])("accepts real forecast/outcome digests with uncalibrated scorecard (resolved=%s)", (resolved) => {
    const value = nativeMarketJournalResponseForScopeSchema(scope, { instrumentId }).parse(response(journal(resolved), "app.market_research.journal.list", 1));
    expect(value.scorecard.probabilityState).toBe("uncalibrated"); expect(value.scorecard.brierScore).toBeNull(); expect(value.entries[0].outcome?.stanceHit ?? null).toBeNull();
  });
  it("rejects false journal completeness, fabricated probability, and missing outcome", () => {
    const body = journal();
    for (const changed of [{ ...body, scorecard: { ...body.scorecard, total: 4000 } }, { ...body, scorecard: { ...body.scorecard, brierScore: 0.2 } }, { ...body, entries: [{ ...body.entries[0], resolutionState: "resolved" }] }]) expect(nativeMarketJournalResponseSchema.safeParse(response(changed, "app.market_research.journal.list", 1)).success).toBe(false);
  });
  it("rejects a validly rehashed outcome assigned to another forecast", () => {
    const body = journal(true), outcome = body.entries[0].outcome!;
    const { outcomeSha256: _sha, id, ...old } = outcome;
    const changed = { ...withDigest({ ...old, forecastId: `market_forecast_${"f".repeat(48)}` }, "outcomeSha256"), id };
    expect(nativeMarketJournalResponseSchema.safeParse(response({ ...body, entries: [{ ...body.entries[0], outcome: changed }] }, "app.market_research.journal.list", 1)).success).toBe(false);
  });
  it("rejects owner-private immutable IDs relabeled under a different valid read receipt", () => {
    const other = { ...scope, requestActorId: "other@example.test" }, source = snapshot(), features = buildMarketTechnicalFeatures(source);
    expect(nativeMarketFeaturesResponseForScopeSchema(other, { snapshotId: source.snapshotId }).safeParse(response(features, "app.market_research.features.show", features.detections.length, other)).success).toBe(false);
    expect(nativeMarketReplaysResponseForScopeSchema(other, { instrumentId }).safeParse(response(replays(), "app.market_research.replays.list", 1, other)).success).toBe(false);
    expect(nativeMarketBacktestsResponseForScopeSchema(other, { instrumentId }).safeParse(response(backtests(), "app.market_research.backtests.list", 1, other)).success).toBe(false);
    expect(nativeMarketJournalResponseForScopeSchema(other, { instrumentId }).safeParse(response(journal(), "app.market_research.journal.list", 1, other)).success).toBe(false);
  });
  it("keeps independent calendar source failures and the actual events receipt operation", () => {
    const value = nativeMarketCalendarResponseForScopeSchema(scope).parse(response(calendar(), "app.market_research.events.list", 0));
    expect(value.events).toEqual([]); expect(value.sourceHealth[0].status).toBe("unavailable");
    expect(nativeMarketCalendarResponseForScopeSchema(scope, { days: 7 }).safeParse(response(calendar(), "app.market_research.events.list", 0)).success).toBe(false);
  });
  it("rejects extra fields at root, nested evidence, and receipt boundaries", () => {
    expect(nativeMarketEventsResponseSchema.safeParse(response({ ...events(), execute: true }, "app.market_research.events.list", 1)).success).toBe(false);
    expect(nativeMarketEventsResponseSchema.safeParse(response({ ...events(), events: [{ ...event(), providerSecret: "inert" }] }, "app.market_research.events.list", 1)).success).toBe(false);
    const wire = response(events(), "app.market_research.events.list", 1);
    expect(nativeMarketEventsResponseSchema.safeParse({ ...wire, serviceReceipt: { ...wire.serviceReceipt, ownerActorId: "forged" } }).success).toBe(false);
  });
});

describe("bounded exact Market job observations", () => {
  it("accepts exact queued and processing projections without inventing request authority", () => {
    const value = job();
    const schema = nativeMarketJobResponseForTargetSchema({ jobId: value.id, type: "market.backtest.run" });
    expect(schema.parse({ job: value }).job.status).toBe("queued");
    expect(schema.parse({ job: { ...value, status: "running", progress: { stage: "processing", startedAt: now } } }).job.status).toBe("running");
    expect(schema.parse({ job: value }).job).not.toHaveProperty("requestHash");
  });
  it("allows completed progress while status remains running before the terminal commit", () => {
    const value = { ...job(), status: "running", progress: { stage: "completed", completedAt: now }, result: { resourceId: `market_backtest_${"a".repeat(48)}`, backtestId: `market_backtest_${"a".repeat(48)}`, reused: true, instrumentId, snapshotId: snapshot().snapshotId, resultSha256: "b".repeat(64), tradeCount: 0 } };
    expect(nativeMarketJobResponseForTargetSchema({ jobId: value.id, type: "market.backtest.run", instrumentId, snapshotId: snapshot().snapshotId }).parse({ job: value }).job.status).toBe("running");
  });
  it("retains failed/quarantined evidence, with no retry or enqueue projection", () => {
    const value = nativeMarketJobResponseSchema.parse({ job: { ...job(), status: "failed", quarantined: true, lastError: "Delivery stopped before an outcome.", completedAt: now } }).job;
    expect(value.quarantined).toBe(true); expect(value.status).toBe("failed");
    expect(nativeMarketJobResponseSchema.safeParse({ job: { ...job(), quarantined: true } }).success).toBe(false);
  });
  it("rejects foreign exact job, type, submitted snapshot, and unknown progress fields", () => {
    const value = job();
    expect(nativeMarketJobResponseForTargetSchema({ jobId: "33333333-3333-4333-8333-333333333333", type: "market.backtest.run" }).safeParse({ job: value }).success).toBe(false);
    expect(nativeMarketJobResponseForTargetSchema({ jobId: value.id, type: "market.events.backfill" }).safeParse({ job: value }).success).toBe(false);
    const result = { resourceId: `market_backtest_${"a".repeat(48)}`, backtestId: `market_backtest_${"a".repeat(48)}`, reused: false, instrumentId, snapshotId: snapshot().snapshotId, resultSha256: "b".repeat(64), tradeCount: 0 };
    expect(nativeMarketJobResponseForTargetSchema({ jobId: value.id, type: "market.backtest.run", snapshotId: `market_snapshot_${"f".repeat(48)}` }).safeParse({ job: { ...value, result } }).success).toBe(false);
    expect(nativeMarketJobResponseSchema.safeParse({ job: { ...value, progress: { ...value.progress, request: { token: "not allowed" } } } }).success).toBe(false);
  });
  it("bounds error/count payloads and rejects mismatched child receipt identities", () => {
    expect(nativeMarketJobResponseSchema.safeParse({ job: { ...job(), lastError: "x".repeat(4001) } }).success).toBe(false);
    expect(nativeMarketJobResponseSchema.safeParse({ job: { ...job(), attempt: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
    const result = { resourceId: `market_backtest_${"a".repeat(48)}`, backtestId: `market_backtest_${"b".repeat(48)}`, reused: false, instrumentId, snapshotId: snapshot().snapshotId, resultSha256: "b".repeat(64), tradeCount: 0 };
    expect(nativeMarketJobResponseSchema.safeParse({ job: { ...job(), result } }).success).toBe(false);
  });
  it("accepts source-specific event stages and bounded replay results", () => {
    const base = job();
    const eventJob = { ...base, type: "market.events.backfill", status: "running", progress: { stage: "fetching_official_schedule", currentScheduleSource: "bea", completedSources: 2, totalSources: 20, importedEvents: 4, importedSchedules: 0, importedObservations: 0, discoveredDates: 4, discoveredObservations: 0 } };
    expect(nativeMarketJobResponseSchema.safeParse({ job: eventJob }).success).toBe(true);
    const replayJob = { ...base, type: "market.replays.backfill", status: "completed", progress: { stage: "completed", completedAt: now }, result: { resourceId: "market_event_replays", instrumentId, interval: "5min", consideredEvents: 24, importedReplays: 20, skippedEvents: 4, startDate: "2000-01-01", endDate: "2026-10-04" } };
    expect(nativeMarketJobResponseSchema.safeParse({ job: replayJob }).success).toBe(true);
    expect(nativeMarketJobResponseSchema.safeParse({ job: { ...replayJob, result: { ...replayJob.result, consideredEvents: 25 } } }).success).toBe(false);
  });
});
