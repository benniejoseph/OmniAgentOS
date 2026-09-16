import { z } from "zod";

export const MARKET_RESEARCH_CONTRACT_VERSION =
  "market-research-foundation:6" as const;

export const MARKET_INSTRUMENT_IDS = [
  "xauusd.spot",
  "ndx.cash",
] as const;
export const marketInstrumentIdSchema = z.string().trim().min(3).max(120).regex(
  /^[a-z0-9][a-z0-9._-]+$/,
);
export type MarketInstrumentId = z.infer<typeof marketInstrumentIdSchema>;

export const MARKET_INTERVALS = ["5min", "15min", "1h"] as const;
export type MarketInterval = (typeof MARKET_INTERVALS)[number];

export const MARKET_PRICE_PROVIDERS = ["twelve_data"] as const;
export type MarketPriceProvider = (typeof MARKET_PRICE_PROVIDERS)[number];

export const MARKET_RESEARCH_PROVIDERS = [
  ...MARKET_PRICE_PROVIDERS,
  "fred",
  "bls",
  "census",
  "bea",
  "federal_reserve",
] as const;
export type MarketResearchProvider = (typeof MARKET_RESEARCH_PROVIDERS)[number];

export const marketInstrumentSchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  label: z.string().min(1).max(120),
  shortLabel: z.string().min(1).max(40),
  canonicalSymbol: z.string().min(1).max(40),
  assetClass: z.enum([
    "commodity_spot",
    "equity_index",
    "equity",
    "etf",
    "future",
    "cfd",
  ]),
  aliases: z.array(z.string().min(1).max(40)).max(20),
  description: z.string().min(1).max(700),
  identityWarning: z.string().min(1).max(700),
  providerMapping: z.object({
    provider: z.enum(MARKET_PRICE_PROVIDERS),
    symbol: z.string().min(1).max(80).nullable(),
    status: z.enum(["verified", "discovery_required"]),
    note: z.string().min(1).max(500),
  }).strict(),
}).strict();

export type MarketInstrument = z.infer<typeof marketInstrumentSchema>;

export const marketProviderReadinessSchema = z.object({
  provider: z.enum(MARKET_RESEARCH_PROVIDERS),
  label: z.string().min(1).max(120),
  purpose: z.string().min(1).max(300),
  configured: z.boolean(),
  blocking: z.boolean(),
  status: z.enum(["connected", "credential_required"]),
  setupVariable: z.string().min(1).max(120),
}).strict();

export const marketResearchOverviewSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  generatedAt: z.string().datetime({ offset: true }),
  phase: z.enum([
    "configuration_required",
    "ready_for_live_research",
    "ready_for_historical_replay",
  ]),
  instruments: z.array(marketInstrumentSchema).min(1),
  providers: z.array(marketProviderReadinessSchema).min(3).max(8),
  agent: z.object({
    agentId: z.literal("meridian"),
    name: z.literal("Meridian"),
    role: z.literal("Market research"),
    modelScope: z.literal("market_research"),
    assignmentState: z.enum(["assigned", "assignment_required"]),
    configured: z.boolean(),
    provider: z.string().max(80).nullable(),
    model: z.string().max(240).nullable(),
    source: z.enum(["tenant_assignment", "deployment_environment"]),
    note: z.string().min(1).max(1_000),
  }).strict(),
  engineTracks: z.array(z.object({
    id: z.enum([
      "event_replay",
      "ict_detectors",
      "scenario_forecast",
      "forward_shadow",
    ]),
    label: z.string().min(1).max(100),
    state: z.enum(["blocked", "foundation", "planned"]),
    note: z.string().min(1).max(500),
  }).strict()).length(4),
  guardrails: z.array(z.string().min(1).max(400)).min(1).max(12),
}).strict();

export type MarketResearchOverview = z.infer<
  typeof marketResearchOverviewSchema
>;

export const marketBarsQuerySchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  interval: z.enum(MARKET_INTERVALS).default("15min"),
  outputSize: z.number().int().min(100).max(1_000).default(480),
}).strict();

export const marketBarSchema = z.object({
  time: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative().nullable(),
}).strict().superRefine((bar, context) => {
  if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) {
    context.addIssue({
      code: "custom",
      message: "Market bar OHLC bounds are invalid.",
    });
  }
});

export type MarketBar = z.infer<typeof marketBarSchema>;

export const marketBarsProviderResultSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  instrumentId: marketInstrumentIdSchema,
  provider: z.enum(MARKET_PRICE_PROVIDERS),
  providerSymbol: z.string().min(1).max(80),
  providerTimezone: z.string().min(1).max(120),
  interval: z.enum(MARKET_INTERVALS),
  retrievedAt: z.string().datetime({ offset: true }),
  asOf: z.string().datetime({ offset: true }),
  bars: z.array(marketBarSchema).max(1_000),
}).strict();

export type MarketBarsProviderResult = z.infer<
  typeof marketBarsProviderResultSchema
>;

export const marketBarsResultSchema = marketBarsProviderResultSchema.extend({
  snapshotId: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotSource: z.enum(["provider", "cache"]),
}).strict();

export type MarketBarsResult = z.infer<typeof marketBarsResultSchema>;

const marketDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const MARKET_TECHNICAL_DETECTOR_VERSIONS = [
  "market-technical-primitives:1",
  "market-ict-quarterly-candidates:2",
] as const;
export const MARKET_TECHNICAL_DETECTOR_VERSION =
  "market-ict-quarterly-candidates:2" as const;

export const marketTechnicalFeaturesQuerySchema = z.object({
  snapshotId: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
}).strict();

export const marketTechnicalReferenceSchema = z.object({
  id: z.enum(["ninety_minute", "day", "week", "month"]),
  label: z.string().min(1).max(80),
  period: z.string().min(1).max(120),
  open: z.number().finite().nullable(),
  timestamp: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(["available", "outside_snapshot"]),
}).strict();

export const marketTechnicalDetectionSchema = z.object({
  id: z.string().regex(/^market_feature_[a-f0-9]{48}$/),
  definitionId: z.enum([
    "foundation.swing.v2",
    "foundation.fvg.v2",
    "foundation.displacement.v1",
    "foundation.liquidity_sweep.v1",
    "foundation.liquidity_pool.v1",
    "foundation.session_window.v1",
    "foundation.calendar_gap.v1",
    "foundation.quarterly_time.v1",
    "foundation.reference_open.v1",
    "candidate.order_block.v1",
    "candidate.market_structure_shift.v1",
    "candidate.turtle_soup.v1",
    "candidate.unicorn.v1",
    "candidate.judas_swing.v1",
  ]),
  kind: z.enum([
    "swing_high",
    "swing_low",
    "fair_value_gap",
    "displacement",
    "liquidity_sweep",
    "buy_side_liquidity",
    "sell_side_liquidity",
    "session_killzone",
    "opening_gap",
    "quarterly_open",
    "reference_open",
    "order_block",
    "market_structure_shift",
    "turtle_soup",
    "unicorn",
    "judas_swing",
  ]),
  direction: z.enum(["bullish", "bearish", "neutral"]),
  timestamp: z.string().datetime({ offset: true }),
  endTimestamp: z.string().datetime({ offset: true }).nullable(),
  price: z.number().finite(),
  zoneLow: z.number().finite().nullable(),
  zoneHigh: z.number().finite().nullable(),
  strength: z.number().finite().nonnegative(),
  state: z.enum([
    "observed",
    "active",
    "partially_mitigated",
    "mitigated",
    "invalidated",
  ]),
  reviewState: z.enum(["deterministic_foundation", "candidate_rule"]),
  reason: z.string().min(1).max(700),
  evidenceTimestamps: z.array(
    z.string().datetime({ offset: true }),
  ).min(1).max(12),
}).strict().superRefine((value, context) => {
  if (
    value.zoneLow !== null &&
    value.zoneHigh !== null &&
    value.zoneLow > value.zoneHigh
  ) {
    context.addIssue({
      code: "custom",
      message: "Technical feature price-zone bounds are invalid.",
    });
  }
});

export const marketTechnicalDefinitionSchema = z.object({
  id: marketTechnicalDetectionSchema.shape.definitionId,
  label: z.string().min(1).max(100),
  formula: z.string().min(1).max(600),
  reviewState: z.enum(["deterministic_foundation", "candidate_rule"]),
  transcriptAuthority: z.enum(["not_claimed", "awaiting_review"]),
}).strict();

export const marketTechnicalLayerIdSchema = z.enum([
  "liquidity",
  "imbalances",
  "blocks",
  "setups",
  "sessions",
  "quarterly",
  "structure",
  "gaps",
]);
export type MarketTechnicalLayerId = z.infer<
  typeof marketTechnicalLayerIdSchema
>;

export const marketTechnicalLayerSchema = z.object({
  id: marketTechnicalLayerIdSchema,
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  defaultVisible: z.boolean(),
  count: z.number().int().nonnegative().max(500),
}).strict();

const annotationPointSchema = z.object({
  time: z.number().int().nonnegative(),
  price: z.number().finite(),
}).strict();

export const marketTechnicalAnnotationPrimitiveSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("horizontal_line"),
      point: annotationPointSchema,
      endTime: z.number().int().nonnegative(),
    }).strict(),
    z.object({
      type: z.literal("vertical_line"),
      point: annotationPointSchema,
    }).strict(),
    z.object({
      type: z.literal("price_zone"),
      from: annotationPointSchema,
      to: annotationPointSchema,
    }).strict(),
    z.object({
      type: z.literal("time_window"),
      from: annotationPointSchema,
      to: annotationPointSchema,
    }).strict(),
    z.object({
      type: z.literal("marker"),
      point: annotationPointSchema,
      marker: z.enum(["up", "down", "dot"]),
    }).strict(),
  ],
);

export const marketTechnicalAnnotationSchema = z.object({
  id: z.string().regex(/^market_annotation_[a-f0-9]{48}$/),
  detectionId: z.string().regex(/^market_feature_[a-f0-9]{48}$/),
  layerId: marketTechnicalLayerIdSchema,
  concept: marketTechnicalDetectionSchema.shape.kind,
  label: z.string().min(1).max(100),
  detail: z.string().min(1).max(700),
  direction: marketTechnicalDetectionSchema.shape.direction,
  state: marketTechnicalDetectionSchema.shape.state,
  reviewState: marketTechnicalDetectionSchema.shape.reviewState,
  renderPriority: z.number().int().min(1).max(100),
  primitive: marketTechnicalAnnotationPrimitiveSchema,
}).strict();

export const marketTechnicalFeaturesResultSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  detectorVersion: z.literal(MARKET_TECHNICAL_DETECTOR_VERSION),
  snapshot: z.object({
    id: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    instrumentId: marketInstrumentIdSchema,
    provider: z.enum(MARKET_PRICE_PROVIDERS),
    providerSymbol: z.string().min(1).max(80),
    interval: z.enum(MARKET_INTERVALS),
    firstBarAt: z.string().datetime({ offset: true }),
    asOf: z.string().datetime({ offset: true }),
    barCount: z.number().int().min(1).max(1_000),
  }).strict(),
  timeContext: z.object({
    timezone: z.literal("America/New_York"),
    localDate: marketDateSchema,
    localTime: z.string().regex(/^\d{2}:\d{2}$/),
    ninetyMinuteQuarter: z.number().int().min(1).max(16),
    session: z.enum([
      "asia_evening",
      "london_open",
      "new_york_am",
      "new_york_pm",
      "off_hours",
    ]),
    references: z.array(marketTechnicalReferenceSchema).length(4),
  }).strict(),
  range: z.object({
    lookbackBars: z.number().int().min(1).max(96),
    low: z.number().finite(),
    high: z.number().finite(),
    equilibrium: z.number().finite(),
    latestClose: z.number().finite(),
    positionPercent: z.number().finite().min(0).max(100),
    zone: z.enum(["premium", "equilibrium", "discount"]),
  }).strict(),
  definitions: z.array(marketTechnicalDefinitionSchema).min(10).max(20),
  detections: z.array(marketTechnicalDetectionSchema).max(240),
  layers: z.array(marketTechnicalLayerSchema).length(8),
  annotations: z.array(marketTechnicalAnnotationSchema).max(120),
  counts: z.object({
    activeFairValueGaps: z.number().int().nonnegative(),
    validOrderBlocks: z.number().int().nonnegative(),
    liquidityLevels: z.number().int().nonnegative(),
    sessionWindows: z.number().int().nonnegative(),
    setupCandidates: z.number().int().nonnegative(),
    displacements: z.number().int().nonnegative(),
    liquiditySweeps: z.number().int().nonnegative(),
    swingPoints: z.number().int().nonnegative(),
  }).strict(),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type MarketTechnicalFeaturesResult = z.infer<
  typeof marketTechnicalFeaturesResultSchema
>;

export const MARKET_BACKTEST_VERSION =
  "market-deterministic-backtest:1" as const;

export const marketBacktestStrategySchema = z.object({
  strategyId: z.literal("foundation.liquidity_sweep_reversal.v1"),
  direction: z.enum(["both", "long_only", "short_only"]).default("both"),
  session: z.enum(["all", "london", "new_york_am"]).default("all"),
  rewardRiskRatio: z.number().finite().min(0.5).max(5).default(2),
  maxHoldingBars: z.number().int().min(1).max(96).default(24),
  stopBufferRangeMultiplier: z.number().finite().min(0).max(1).default(0.1),
}).strict();

export const marketBacktestCostModelSchema = z.object({
  spreadBps: z.number().finite().nonnegative().max(100).default(2),
  slippageBps: z.number().finite().nonnegative().max(100).default(1),
  commissionBps: z.number().finite().nonnegative().max(100).default(0),
}).strict();

export const marketBacktestRequestSchema = z.object({
  snapshotId: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
  strategy: marketBacktestStrategySchema.default({
    strategyId: "foundation.liquidity_sweep_reversal.v1",
    direction: "both",
    session: "all",
    rewardRiskRatio: 2,
    maxHoldingBars: 24,
    stopBufferRangeMultiplier: 0.1,
  }),
  costs: marketBacktestCostModelSchema.default({
    spreadBps: 2,
    slippageBps: 1,
    commissionBps: 0,
  }),
  initialEquity: z.number().finite().min(100).max(100_000_000).default(10_000),
  riskPerTradeBps: z.number().int().min(1).max(500).default(100),
}).strict();

export const marketBacktestsQuerySchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

const marketBacktestSplitSchema = z.enum(["train", "validation", "test"]);
const marketBacktestTradeSchema = z.object({
  id: z.string().regex(/^market_backtest_trade_[a-f0-9]{48}$/),
  split: marketBacktestSplitSchema,
  direction: z.enum(["long", "short"]),
  signalAt: z.string().datetime({ offset: true }),
  enteredAt: z.string().datetime({ offset: true }),
  exitedAt: z.string().datetime({ offset: true }),
  entryPrice: z.number().finite().positive(),
  exitPrice: z.number().finite().positive(),
  stopPrice: z.number().finite().positive(),
  targetPrice: z.number().finite().positive(),
  exitReason: z.enum(["stop", "target", "timeout", "snapshot_end"]),
  holdingBars: z.number().int().min(1).max(96),
  grossR: z.number().finite(),
  netR: z.number().finite(),
  equityAfter: z.number().finite().nonnegative(),
}).strict();

const marketBacktestMetricsSchema = z.object({
  trades: z.number().int().nonnegative().max(1_000),
  wins: z.number().int().nonnegative().max(1_000),
  losses: z.number().int().nonnegative().max(1_000),
  breakEven: z.number().int().nonnegative().max(1_000),
  winRate: z.number().finite().min(0).max(1).nullable(),
  netR: z.number().finite(),
  expectancyR: z.number().finite().nullable(),
  profitFactor: z.number().finite().nonnegative().nullable(),
  maxDrawdownPercent: z.number().finite().min(0).max(100),
  endingEquity: z.number().finite().nonnegative(),
}).strict();

export const marketBacktestSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  backtestVersion: z.literal(MARKET_BACKTEST_VERSION),
  id: z.string().regex(/^market_backtest_[a-f0-9]{48}$/),
  instrumentId: marketInstrumentIdSchema,
  provider: z.enum(MARKET_PRICE_PROVIDERS),
  providerSymbol: z.string().min(1).max(80),
  interval: z.enum(MARKET_INTERVALS),
  snapshotId: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotAsOf: z.string().datetime({ offset: true }),
  firstBarAt: z.string().datetime({ offset: true }),
  lastBarAt: z.string().datetime({ offset: true }),
  barCount: z.number().int().min(21).max(1_000),
  manifest: z.object({
    strategy: marketBacktestStrategySchema,
    costs: marketBacktestCostModelSchema,
    initialEquity: z.number().finite().min(100).max(100_000_000),
    riskPerTradeBps: z.number().int().min(1).max(500),
    engineRulesSha256: z.string().regex(/^[a-f0-9]{64}$/),
    entryTiming: z.literal("next_bar_open"),
    collisionPolicy: z.literal("stop_first"),
    overlapPolicy: z.literal("single_position"),
    evaluationLabel: z.literal("retrospective_rule_evaluation"),
    splitRatios: z.tuple([z.literal(0.6), z.literal(0.2), z.literal(0.2)]),
  }).strict(),
  splitBoundaries: z.object({
    validationStartsAt: z.string().datetime({ offset: true }),
    testStartsAt: z.string().datetime({ offset: true }),
  }).strict(),
  leakageChecks: z.object({
    strictChronology: z.literal(true),
    immutableSnapshotBound: z.literal(true),
    signalUsesPastAndPresentOnly: z.literal(true),
    entryAfterSignal: z.literal(true),
    costsApplied: z.literal(true),
  }).strict(),
  metrics: z.object({
    overall: marketBacktestMetricsSchema,
    train: marketBacktestMetricsSchema,
    validation: marketBacktestMetricsSchema,
    test: marketBacktestMetricsSchema,
  }).strict(),
  trades: z.array(marketBacktestTradeSchema).max(1_000),
  warnings: z.array(z.string().min(1).max(300)).max(8),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const marketBacktestsResultSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  instrumentId: marketInstrumentIdSchema,
  backtests: z.array(marketBacktestSchema).max(100),
  total: z.number().int().nonnegative(),
}).strict();

export type MarketBacktestRequest = z.infer<typeof marketBacktestRequestSchema>;
export type MarketBacktest = z.infer<typeof marketBacktestSchema>;
export type MarketBacktestsResult = z.infer<typeof marketBacktestsResultSchema>;

export const MARKET_ANALYSIS_VERSION = "market-analysis-version:1" as const;

const chartEntityIdSchema = z.union([
  z.string().min(1).max(240),
  z.number().int().nonnegative(),
]);

export const marketSerializedChartStateSchema = z.object({
  sources: z.array(z.tuple([
    chartEntityIdSchema,
    z.unknown().nullable(),
  ])).max(1_000).nullable(),
  groups: z.array(z.tuple([
    z.string().min(1).max(240),
    z.unknown().nullable(),
  ])).max(250),
  symbol: z.string().min(1).max(240).optional(),
}).strict();

export type MarketSerializedChartState = z.infer<
  typeof marketSerializedChartStateSchema
>;

export const marketAnalysisGenerateRequestSchema = z.object({
  snapshotId: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
  visibleLayerIds: z.array(marketTechnicalLayerIdSchema).max(8).optional(),
  chartState: marketSerializedChartStateSchema.optional(),
}).strict();

export const marketAnalysisVersionsQuerySchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  interval: z.enum(MARKET_INTERVALS),
  limit: z.number().int().min(1).max(40).default(10),
}).strict();

export const marketAnalysisVersionSchema = z.object({
  id: z.string().regex(/^market_analysis_[a-f0-9]{48}$/),
  contractVersion: z.literal(MARKET_ANALYSIS_VERSION),
  instrumentId: marketInstrumentIdSchema,
  interval: z.enum(MARKET_INTERVALS),
  snapshotId: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  detectorVersion: z.enum(MARKET_TECHNICAL_DETECTOR_VERSIONS),
  technicalResultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  visibleLayerIds: z.array(marketTechnicalLayerIdSchema).max(8),
  chartStateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  chartState: marketSerializedChartStateSchema,
  annotationCount: z.number().int().nonnegative().max(120),
  detectionCount: z.number().int().nonnegative().max(240),
  candidateCount: z.number().int().nonnegative().max(240),
  savedAt: z.string().datetime({ offset: true }),
  versionSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  if (value.candidateCount > value.detectionCount) {
    context.addIssue({
      code: "custom",
      path: ["candidateCount"],
      message: "Review-candidate count cannot exceed the detection count.",
    });
  }
});

export type MarketAnalysisVersion = z.infer<
  typeof marketAnalysisVersionSchema
>;

export const marketAnalysisSaveResultSchema = z.object({
  version: marketAnalysisVersionSchema,
  reused: z.boolean(),
}).strict();

export const marketAnalysisVersionsResultSchema = z.object({
  contractVersion: z.literal(MARKET_ANALYSIS_VERSION),
  instrumentId: marketInstrumentIdSchema,
  interval: z.enum(MARKET_INTERVALS),
  versions: z.array(marketAnalysisVersionSchema).max(40),
  total: z.number().int().nonnegative(),
}).strict();

export type MarketAnalysisVersionsResult = z.infer<
  typeof marketAnalysisVersionsResultSchema
>;

export const marketEventReplayRequestSchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  interval: z.enum(MARKET_INTERVALS).default("5min"),
  startDate: marketDateSchema.default("2000-01-01"),
  endDate: marketDateSchema,
  maxEvents: z.number().int().min(1).max(24).default(12),
}).strict().refine(
  (value) => value.startDate <= value.endDate,
  { message: "Market replay start date must not follow the end date." },
);

export type MarketEventReplayRequest = z.infer<
  typeof marketEventReplayRequestSchema
>;

const replayPointSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  close: z.number().finite(),
  returnBps: z.number().finite(),
}).strict();

export const marketEventReplaySchema = z.object({
  id: z.string().regex(/^market_replay_[a-f0-9]{48}$/),
  eventId: z.string().regex(/^market_event_[a-f0-9]{48}$/),
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  instrumentId: marketInstrumentIdSchema,
  provider: z.enum(MARKET_PRICE_PROVIDERS),
  providerSymbol: z.string().min(1).max(80),
  interval: z.enum(MARKET_INTERVALS),
  occurredAt: z.string().datetime({ offset: true }),
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
  retrievedAt: z.string().datetime({ offset: true }),
  barCount: z.number().int().min(1).max(1_000),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  baseline: z.object({
    timestamp: z.string().datetime({ offset: true }),
    close: z.number().finite(),
  }).strict(),
  post5m: replayPointSchema.nullable(),
  post15m: replayPointSchema.nullable(),
  post60m: replayPointSchema.nullable(),
  post240m: replayPointSchema.nullable(),
  pre60mRangeBps: z.number().finite().nonnegative().nullable(),
  post60mRangeBps: z.number().finite().nonnegative().nullable(),
  maxFavorableBps: z.number().finite().nonnegative().nullable(),
  maxAdverseBps: z.number().finite().nonnegative().nullable(),
  direction: z.enum(["up", "down", "flat", "insufficient_data"]),
}).strict();

export type MarketEventReplay = z.infer<typeof marketEventReplaySchema>;

export const marketEventReplaysQuerySchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  limit: z.number().int().min(1).max(500).default(100),
}).strict();

export const marketEventReplaysResultSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  instrumentId: marketInstrumentIdSchema,
  replays: z.array(marketEventReplaySchema).max(500),
  eligibleEvents: z.number().int().nonnegative(),
  replayedEvents: z.number().int().nonnegative(),
  remainingEvents: z.number().int().nonnegative(),
  lastReplayedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type MarketEventReplaysResult = z.infer<
  typeof marketEventReplaysResultSchema
>;

export const MARKET_EVENT_BASELINE_VERSION =
  "market-event-baseline:1" as const;

export const marketEventBaselinesQuerySchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  minimumSampleSize: z.number().int().min(5).max(100).default(20),
}).strict();

const marketReturnDistributionSchema = z.object({
  sampleSize: z.number().int().nonnegative(),
  meanBps: z.number().finite().nullable(),
  medianBps: z.number().finite().nullable(),
  lowerQuartileBps: z.number().finite().nullable(),
  upperQuartileBps: z.number().finite().nullable(),
}).strict();

export const marketEventBaselineSchema = z.object({
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  sampleSize: z.number().int().positive(),
  state: z.enum(["low_sample", "descriptive_baseline"]),
  firstOccurredAt: z.string().datetime({ offset: true }),
  lastOccurredAt: z.string().datetime({ offset: true }),
  directions: z.object({
    up: z.number().int().nonnegative(),
    down: z.number().int().nonnegative(),
    flat: z.number().int().nonnegative(),
  }).strict(),
  empiricalRates: z.object({
    up: z.number().finite().min(0).max(1),
    down: z.number().finite().min(0).max(1),
    flat: z.number().finite().min(0).max(1),
  }).strict(),
  post5m: marketReturnDistributionSchema,
  post15m: marketReturnDistributionSchema,
  post60m: marketReturnDistributionSchema,
  post240m: marketReturnDistributionSchema,
  excursions: z.object({
    sampleSize: z.number().int().nonnegative(),
    medianFavorableBps: z.number().finite().nonnegative().nullable(),
    medianAdverseBps: z.number().finite().nonnegative().nullable(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const directionTotal = value.directions.up + value.directions.down + value.directions.flat;
  if (directionTotal !== value.sampleSize) {
    context.addIssue({
      code: "custom",
      message: "Market event baseline direction counts must equal its sample size.",
    });
  }
});

export type MarketEventBaseline = z.infer<typeof marketEventBaselineSchema>;

export const marketEventBaselinesResultSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  baselineVersion: z.literal(MARKET_EVENT_BASELINE_VERSION),
  instrumentId: marketInstrumentIdSchema,
  minimumSampleSize: z.number().int().min(5).max(100),
  includedReplays: z.number().int().nonnegative(),
  groups: z.array(marketEventBaselineSchema).max(50),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  interpretation: z.literal("descriptive_not_predictive"),
}).strict();

export type MarketEventBaselinesResult = z.infer<
  typeof marketEventBaselinesResultSchema
>;

export const MARKET_FORWARD_SHADOW_VERSION =
  "market-forward-shadow:1" as const;

export const marketForecastHorizonSchema = z.enum(["daily", "weekly"]);
export type MarketForecastHorizon = z.infer<
  typeof marketForecastHorizonSchema
>;

export const marketForecastDirectionSchema = z.enum([
  "bullish",
  "bearish",
  "neutral",
]);
export type MarketForecastDirection = z.infer<
  typeof marketForecastDirectionSchema
>;

const marketForecastPriceZoneSchema = z.object({
  low: z.number().finite(),
  high: z.number().finite(),
}).strict().refine((value) => value.low <= value.high, {
  message: "Market forecast price-zone bounds are invalid.",
});

export const marketForecastScenarioSchema = z.object({
  direction: marketForecastDirectionSchema,
  rank: z.number().int().min(1).max(3),
  thesis: z.string().trim().min(1).max(1_200),
  observationZone: marketForecastPriceZoneSchema.nullable(),
  targets: z.array(z.number().finite()).max(3),
  invalidation: z.object({
    price: z.number().finite(),
    rationale: z.string().trim().min(1).max(500),
  }).strict().nullable(),
  supportingFeatureIds: z.array(
    z.string().regex(/^market_feature_[a-f0-9]{48}$/),
  ).max(12),
}).strict();

export const marketForecastModelAttributionSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(240),
  assignmentScope: z.literal("market_research"),
  assignmentId: z.string().trim().min(1).max(240),
  assignmentRevision: z.number().int().positive(),
  assignmentConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  usageReceiptId: z.string().uuid(),
  usageReceiptRecorded: z.literal(true),
}).strict();

export const marketForwardForecastSchema = z.object({
  id: z.string().regex(/^market_forecast_[a-f0-9]{48}$/),
  contractVersion: z.literal(MARKET_FORWARD_SHADOW_VERSION),
  instrumentId: marketInstrumentIdSchema,
  horizon: marketForecastHorizonSchema,
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
  sealedAt: z.string().datetime({ offset: true }),
  researchMode: z.literal(true),
  probabilityState: z.literal("uncalibrated"),
  stance: z.enum(["bullish", "bearish", "neutral", "abstain"]),
  evidenceStrength: z.enum(["insufficient", "limited", "developing"]),
  summary: z.string().trim().min(1).max(1_600),
  scenarios: z.array(marketForecastScenarioSchema).length(3),
  warnings: z.array(z.string().trim().min(1).max(600)).min(1).max(10),
  evidence: z.object({
    snapshotId: z.string().regex(/^market_snapshot_[a-f0-9]{48}$/),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotAsOf: z.string().datetime({ offset: true }),
    detectorVersion: z.enum(MARKET_TECHNICAL_DETECTOR_VERSIONS),
    technicalResultSha256: z.string().regex(/^[a-f0-9]{64}$/),
    baselineVersion: z.literal(MARKET_EVENT_BASELINE_VERSION),
    baselineResultSha256: z.string().regex(/^[a-f0-9]{64}$/),
    baselineReplayCount: z.number().int().nonnegative(),
    baselineQualifiedGroups: z.number().int().nonnegative(),
    macroEventIds: z.array(
      z.string().regex(/^market_event_[a-f0-9]{48}$/),
    ).max(24),
    macroEventsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  modelAttribution: marketForecastModelAttributionSchema,
  forecastSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  if (value.windowStart >= value.windowEnd || value.sealedAt >= value.windowStart) {
    context.addIssue({
      code: "custom",
      message: "A market forecast must be sealed before its ordered window.",
    });
  }
  const directions = value.scenarios.map((scenario) => scenario.direction);
  const ranks = value.scenarios.map((scenario) => scenario.rank);
  if (new Set(directions).size !== 3 || new Set(ranks).size !== 3) {
    context.addIssue({
      code: "custom",
      message: "A market forecast requires one uniquely ranked scenario per direction.",
    });
  }
});

export type MarketForwardForecast = z.infer<typeof marketForwardForecastSchema>;

export const marketForecastOutcomeSchema = z.object({
  id: z.string().regex(/^market_forecast_outcome_[a-f0-9]{48}$/),
  forecastId: z.string().regex(/^market_forecast_[a-f0-9]{48}$/),
  resolvedAt: z.string().datetime({ offset: true }),
  provider: z.enum(MARKET_PRICE_PROVIDERS),
  providerSymbol: z.string().trim().min(1).max(80),
  interval: z.enum(MARKET_INTERVALS),
  sourcePayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  firstPrice: z.number().finite(),
  lastPrice: z.number().finite(),
  returnBps: z.number().finite(),
  actualDirection: marketForecastDirectionSchema,
  stanceHit: z.boolean().nullable(),
  scenarioRankHit: z.number().int().min(1).max(3),
  maxFavorableBps: z.number().finite().nonnegative().nullable(),
  maxAdverseBps: z.number().finite().nonnegative().nullable(),
  brierScore: z.null(),
  outcomeSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type MarketForecastOutcome = z.infer<
  typeof marketForecastOutcomeSchema
>;

export const marketForecastJournalEntrySchema = z.object({
  forecast: marketForwardForecastSchema,
  resolutionState: z.enum(["open", "due", "resolved"]),
  outcome: marketForecastOutcomeSchema.nullable(),
}).strict();

export const marketForecastJournalQuerySchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  limit: z.number().int().min(1).max(100).default(40),
}).strict();

export const marketForecastJournalResultSchema = z.object({
  contractVersion: z.literal(MARKET_FORWARD_SHADOW_VERSION),
  instrumentId: marketInstrumentIdSchema,
  entries: z.array(marketForecastJournalEntrySchema).max(100),
  scorecard: z.object({
    total: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    due: z.number().int().nonnegative(),
    abstentions: z.number().int().nonnegative(),
    directionalAccuracy: z.number().finite().min(0).max(1).nullable(),
    directionalSampleSize: z.number().int().nonnegative(),
    coverage: z.number().finite().min(0).max(1).nullable(),
    brierScore: z.null(),
    probabilityState: z.literal("uncalibrated"),
  }).strict(),
}).strict();

export type MarketForecastJournalResult = z.infer<
  typeof marketForecastJournalResultSchema
>;

export const marketForecastGenerateRequestSchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  horizon: marketForecastHorizonSchema,
}).strict();

export const marketForecastScoreRequestSchema = z.object({
  instrumentId: marketInstrumentIdSchema,
  maxForecasts: z.number().int().min(1).max(4).default(2),
}).strict();

export const marketMacroObservationSchema = z.object({
  id: z.string().regex(/^market_observation_[a-f0-9]{48}$/),
  metricKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  seriesId: z.string().regex(/^[A-Z0-9]+$/),
  label: z.string().min(1).max(160),
  unit: z.enum(["index", "percent", "thousands", "millions", "billions"]),
  observationDate: marketDateSchema,
  releaseDate: marketDateSchema,
  vintageEnd: marketDateSchema,
  value: z.number().finite(),
  sourceUrl: z.string().url().max(1_000),
  initialRelease: z.literal(true),
}).strict();

export type MarketMacroObservation = z.infer<
  typeof marketMacroObservationSchema
>;

export const marketEventSchema = z.object({
  id: z.string().regex(/^market_event_[a-f0-9]{48}$/),
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  name: z.string().min(1).max(160),
  currency: z.literal("USD"),
  impact: z.literal("high"),
  source: z.literal("fred"),
  sourceReleaseId: z.number().int().positive(),
  sourceUrl: z.string().url().max(1_000),
  releaseDate: marketDateSchema,
  occurredAt: z.string().datetime({ offset: true }).nullable(),
  timestampPrecision: z.enum(["date", "instant"]),
  scheduleSource: z.enum([
    "bls",
    "census",
    "bea",
    "federal_reserve",
  ]).nullable(),
  scheduleSourceUrl: z.string().url().max(1_000).nullable(),
  actual: z.number().finite().nullable(),
  consensus: z.number().finite().nullable(),
  previous: z.number().finite().nullable(),
  revised: z.number().finite().nullable(),
  valueStatus: z.enum(["release_date_only", "observed_values"]),
  observations: z.array(marketMacroObservationSchema).max(12),
  importedAt: z.string().datetime({ offset: true }),
}).strict();

export type MarketEvent = z.infer<typeof marketEventSchema>;

export const marketEventsResultSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  events: z.array(marketEventSchema).max(500),
  total: z.number().int().nonnegative(),
  lastImportedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type MarketEventsResult = z.infer<typeof marketEventsResultSchema>;

export const marketEventsQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
}).strict();

export const marketEventBackfillRequestSchema = z.object({
  startDate: marketDateSchema.default("2000-01-01"),
  endDate: marketDateSchema,
  eventKeys: z.array(
    z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  ).min(1).max(20).optional(),
}).strict().refine(
  (value) => value.startDate <= value.endDate,
  { message: "Market event history start date must not follow the end date." },
);

export type MarketEventBackfillRequest = z.infer<
  typeof marketEventBackfillRequestSchema
>;
