import { z } from "zod";

export const MARKET_RESEARCH_CONTRACT_VERSION =
  "market-research-foundation:1" as const;

export const MARKET_INSTRUMENT_IDS = [
  "xauusd.spot",
  "nasdaq100.reference",
] as const;
export const marketInstrumentIdSchema = z.string().trim().min(3).max(120).regex(
  /^[a-z0-9][a-z0-9._-]+$/,
);
export type MarketInstrumentId = z.infer<typeof marketInstrumentIdSchema>;

export const MARKET_INTERVALS = ["5min", "15min", "1h"] as const;
export type MarketInterval = (typeof MARKET_INTERVALS)[number];

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
    provider: z.literal("twelve_data"),
    symbol: z.string().min(1).max(80).nullable(),
    status: z.enum(["verified", "discovery_required"]),
    note: z.string().min(1).max(500),
  }).strict(),
}).strict();

export type MarketInstrument = z.infer<typeof marketInstrumentSchema>;

export const marketProviderReadinessSchema = z.object({
  provider: z.enum(["twelve_data", "trading_economics", "fred"]),
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
  providers: z.array(marketProviderReadinessSchema).length(3),
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

export const marketBarsResultSchema = z.object({
  contractVersion: z.literal(MARKET_RESEARCH_CONTRACT_VERSION),
  instrumentId: marketInstrumentIdSchema,
  provider: z.literal("twelve_data"),
  providerSymbol: z.string().min(1).max(80),
  providerTimezone: z.string().min(1).max(120),
  interval: z.enum(MARKET_INTERVALS),
  retrievedAt: z.string().datetime({ offset: true }),
  asOf: z.string().datetime({ offset: true }),
  bars: z.array(marketBarSchema).max(1_000),
}).strict();

export type MarketBarsResult = z.infer<typeof marketBarsResultSchema>;
