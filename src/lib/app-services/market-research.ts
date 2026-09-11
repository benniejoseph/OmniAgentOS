import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketBarsQuerySchema,
  marketEventBackfillRequestSchema,
  marketEventBaselinesQuerySchema,
  marketEventReplayRequestSchema,
  marketEventReplaysQuerySchema,
  marketEventsQuerySchema,
  marketForecastGenerateRequestSchema,
  marketForecastJournalQuerySchema,
  marketForecastScoreRequestSchema,
  marketResearchOverviewSchema,
  marketTechnicalFeaturesQuerySchema,
} from "@/lib/market-research/contracts";
import { buildMarketEventBaselines } from "@/lib/market-research/event-baselines";
import { listMarketEvents } from "@/lib/market-research/event-store";
import { listMarketEventReplays } from "@/lib/market-research/event-replay-store";
import { generateMarketForwardForecast } from "@/lib/market-research/forward-shadow-agent";
import {
  buildMarketForecastWindow,
  forecastWindowInterval,
  scoreMarketForwardForecast,
} from "@/lib/market-research/forward-shadow";
import {
  findMarketForecastForWindow,
  listDueMarketForecasts,
  listMarketForecastJournal,
  saveMarketForecastOutcome,
  saveMarketForwardForecast,
} from "@/lib/market-research/forward-shadow-store";
import { enqueueMarketEventBackfillJob } from "@/lib/market-research/event-jobs";
import { enqueueMarketEventReplayBackfillJob } from "@/lib/market-research/replay-jobs";
import { marketInstruments } from "@/lib/market-research/instruments";
import { fetchMarketBarSnapshot } from "@/lib/market-research/market-data";
import {
  findFreshMarketPriceSnapshot,
  readMarketPriceSnapshot,
  saveMarketPriceSnapshot,
} from "@/lib/market-research/price-snapshot-store";
import { buildMarketTechnicalFeatures } from "@/lib/market-research/technical-features";
import { fetchTwelveDataBarRangeSnapshot } from "@/lib/market-research/twelve-data";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { resolveRuntimeModelAssignment } from "@/lib/settings/runtime-models";

export async function showMarketResearchOverviewService(
  caller: AppServiceCaller,
) {
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.overview.show"),
  );
  const model = await resolveRuntimeModelAssignment({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    scope: "market_research",
    tier: "reasoning",
    requiredFeature: "text",
  });
  const modelAssigned = model.source === "tenant_assignment" && model.configured;
  const providers = [
    providerReadiness({
      provider: "twelve_data",
      label: "Twelve Data",
      purpose: "Indicative price history and live chart context",
      setupVariable: "TWELVE_DATA_API_KEY",
      configured: hasEnvironmentValue("TWELVE_DATA_API_KEY"),
      blocking: true,
    }),
    providerReadiness({
      provider: "fred",
      label: "FRED / ALFRED",
      purpose: "Release-vintage macro series for leakage-safe historical replay",
      setupVariable: "FRED_API_KEY",
      configured: hasEnvironmentValue("FRED_API_KEY"),
      blocking: true,
    }),
    providerReadiness({
      provider: "bls",
      label: "BLS official calendar",
      purpose: "CPI, PPI, employment, and JOLTS release times",
      setupVariable: "PUBLIC_OFFICIAL_SOURCE",
      configured: true,
      blocking: false,
    }),
    providerReadiness({
      provider: "census",
      label: "U.S. Census calendar",
      purpose: "Retail sales release times",
      setupVariable: "PUBLIC_OFFICIAL_SOURCE",
      configured: true,
      blocking: false,
    }),
    providerReadiness({
      provider: "bea",
      label: "BEA release schedule",
      purpose: "GDP and personal income/outlays release times",
      setupVariable: "PUBLIC_OFFICIAL_SOURCE",
      configured: true,
      blocking: false,
    }),
    providerReadiness({
      provider: "federal_reserve",
      label: "Federal Reserve calendar",
      purpose: "FOMC decision dates and statement times",
      setupVariable: "PUBLIC_OFFICIAL_SOURCE",
      configured: true,
      blocking: false,
    }),
  ] as const;
  const blockingProvidersReady = providers
    .filter((provider) => provider.blocking)
    .every((provider) => provider.configured);
  const historicalReplayReady = blockingProvidersReady;
  const phase = !modelAssigned || !blockingProvidersReady
    ? "configuration_required"
    : historicalReplayReady
      ? "ready_for_historical_replay"
      : "ready_for_live_research";

  const overview = marketResearchOverviewSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    phase,
    instruments: marketInstruments,
    providers,
    agent: {
      agentId: "meridian",
      name: "Meridian",
      role: "Market research",
      modelScope: "market_research",
      assignmentState: modelAssigned ? "assigned" : "assignment_required",
      configured: modelAssigned,
      provider: modelAssigned ? model.provider || null : null,
      model: modelAssigned ? model.model || null : null,
      source: model.source,
      note: modelAssigned
        ? "The analyst is bound to the validated Market research assignment in Settings."
        : "Assign a validated Market research model in Settings before the analyst can produce scenarios. Deployment fallback is intentionally not treated as an assignment.",
    },
    engineTracks: [
      {
        id: "event_replay",
        label: "High-impact event replay",
        state: historicalReplayReady ? "foundation" : "blocked",
        note: historicalReplayReady
          ? "Official FRED release history is available for immutable event backfill."
          : "Needs both target price feeds and the FRED/ALFRED history feed.",
      },
      {
        id: "ict_detectors",
        label: "ICT + Quarterly detectors",
        state: blockingProvidersReady ? "foundation" : "blocked",
        note: blockingProvidersReady
          ? "Versioned deterministic primitives are available against immutable bars; transcript-authoritative ICT rules remain review-gated."
          : "Needs verified market bars before deterministic features can be evaluated.",
      },
      {
        id: "scenario_forecast",
        label: "Daily + weekly scenarios",
        state: phase === "configuration_required" ? "blocked" : "foundation",
        note: phase === "configuration_required"
          ? "A validated market model and both research feeds are required."
          : "Meridian can seal daily and weekly ordinal scenarios. Numeric probabilities remain unavailable until calibration passes.",
      },
      {
        id: "forward_shadow",
        label: "Forward-shadow journal",
        state: phase === "configuration_required" ? "blocked" : "foundation",
        note: phase === "configuration_required"
          ? "The append-only journal activates with the market research foundation."
          : "Every pre-market scenario is immutable and outcome scoring is stored as a separate append-only receipt.",
      },
    ],
    guardrails: [
      "Research only: Meridian cannot place, modify, or manage trades.",
      "No missing price bar, event value, or probability may be invented or silently filled.",
      "Every result must bind its instrument, provider, snapshot, as-of time, and evidence lineage.",
      "Twelve Data NDX, NQ/MNQ, QQQ, and broker NAS100/US100 CFDs are never treated as interchangeable.",
    ],
  });
  return completeAppServiceCall(authorized, overview, {
    resourceCount: overview.instruments.length,
    occurredAt: overview.generatedAt,
  });
}

export async function listMarketResearchBarsService(
  caller: AppServiceCaller,
  input: z.input<typeof marketBarsQuerySchema>,
) {
  const value = marketBarsQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.bars.list"),
  );
  const cached = await findFreshMarketPriceSnapshot({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    ...value,
  });
  const result = cached || await fetchAndPersistMarketBars({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    ...value,
  });
  return completeAppServiceCall(authorized, result, {
    resourceCount: result.bars.length,
    occurredAt: result.retrievedAt,
  });
}

export async function showMarketResearchFeaturesService(
  caller: AppServiceCaller,
  input: z.input<typeof marketTechnicalFeaturesQuerySchema>,
) {
  const value = marketTechnicalFeaturesQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.features.show"),
  );
  const snapshot = await readMarketPriceSnapshot({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    snapshotId: value.snapshotId,
  });
  const result = buildMarketTechnicalFeatures(snapshot);
  return completeAppServiceCall(authorized, result, {
    resourceCount: result.detections.length,
    occurredAt: result.snapshot.asOf,
  });
}

async function fetchAndPersistMarketBars(input: {
  tenantId: string;
  actorId: string;
  instrumentId: Parameters<typeof fetchMarketBarSnapshot>[0]["instrumentId"];
  interval: Parameters<typeof fetchMarketBarSnapshot>[0]["interval"];
  outputSize: number;
}) {
  const fetched = await fetchMarketBarSnapshot(input);
  return saveMarketPriceSnapshot({
    tenantId: input.tenantId,
    actorId: input.actorId,
    outputSize: input.outputSize,
    result: fetched.result,
    sourcePayload: fetched.sourcePayload,
  });
}

export async function listMarketResearchEventsService(
  caller: AppServiceCaller,
  input: z.input<typeof marketEventsQuerySchema>,
) {
  const value = marketEventsQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.events.list"),
  );
  const result = await listMarketEvents({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    limit: value.limit,
  });
  return completeAppServiceCall(authorized, result, {
    resourceCount: result.events.length,
    occurredAt: result.lastImportedAt || new Date().toISOString(),
  });
}

export async function backfillMarketResearchEventsService(
  caller: AppServiceCaller,
  input: z.input<typeof marketEventBackfillRequestSchema>,
) {
  const value = marketEventBackfillRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.events.backfill"),
  );
  const job = await enqueueMarketEventBackfillJob({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    executionScope: caller.executionScope!,
    idempotencyKey: caller.idempotencyKey!,
    request: value,
  });
  return completeAppServiceCall(authorized, {
    job: projectOperationJobStatus(job),
  });
}

export async function listMarketResearchReplaysService(
  caller: AppServiceCaller,
  input: z.input<typeof marketEventReplaysQuerySchema>,
) {
  const value = marketEventReplaysQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.replays.list"),
  );
  const result = await listMarketEventReplays({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    ...value,
  });
  return completeAppServiceCall(authorized, result, {
    resourceCount: result.replays.length,
    occurredAt: result.lastReplayedAt || new Date().toISOString(),
  });
}

export async function showMarketResearchBaselinesService(
  caller: AppServiceCaller,
  input: z.input<typeof marketEventBaselinesQuerySchema>,
) {
  const value = marketEventBaselinesQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.baselines.show"),
  );
  const replayResult = await listMarketEventReplays({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    instrumentId: value.instrumentId,
    limit: 500,
  });
  const result = buildMarketEventBaselines({
    ...value,
    replays: replayResult.replays,
  });
  return completeAppServiceCall(authorized, result, {
    resourceCount: result.groups.length,
    occurredAt: replayResult.lastReplayedAt || new Date().toISOString(),
  });
}

export async function backfillMarketResearchReplaysService(
  caller: AppServiceCaller,
  input: z.input<typeof marketEventReplayRequestSchema>,
) {
  const value = marketEventReplayRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.replays.backfill"),
  );
  const job = await enqueueMarketEventReplayBackfillJob({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    executionScope: caller.executionScope!,
    idempotencyKey: caller.idempotencyKey!,
    request: value,
  });
  return completeAppServiceCall(authorized, { job: projectOperationJobStatus(job) });
}

export async function listMarketForecastJournalService(
  caller: AppServiceCaller,
  input: z.input<typeof marketForecastJournalQuerySchema>,
) {
  const value = marketForecastJournalQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.journal.list"),
  );
  const result = await listMarketForecastJournal({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    ...value,
  });
  return completeAppServiceCall(authorized, result, {
    resourceCount: result.entries.length,
  });
}

export async function generateMarketForecastService(
  caller: AppServiceCaller,
  input: z.input<typeof marketForecastGenerateRequestSchema>,
) {
  const value = marketForecastGenerateRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.journal.generate"),
  );
  const requestedAt = new Date().toISOString();
  const window = buildMarketForecastWindow({ horizon: value.horizon });
  const existing = await findMarketForecastForWindow({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    ...value,
    windowStart: window.start,
  });
  if (existing) {
    return completeAppServiceCall(authorized, { forecast: existing, reused: true }, {
      resourceCount: 1,
      occurredAt: existing.sealedAt,
    });
  }
  const interval = forecastWindowInterval(value.horizon);
  const snapshot = await findFreshMarketPriceSnapshot({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    instrumentId: value.instrumentId,
    interval,
    outputSize: 480,
  }) || await fetchAndPersistMarketBars({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    instrumentId: value.instrumentId,
    interval,
    outputSize: 480,
  });
  const features = buildMarketTechnicalFeatures(snapshot);
  const replayResult = await listMarketEventReplays({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    instrumentId: value.instrumentId,
    limit: 500,
  });
  const baselines = buildMarketEventBaselines({
    instrumentId: value.instrumentId,
    minimumSampleSize: 20,
    replays: replayResult.replays,
  });
  const eventResult = await listMarketEvents({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    limit: 500,
  });
  const startDate = newYorkDate(window.start);
  const endDate = newYorkDate(window.end);
  const macroEvents = eventResult.events.filter((event) =>
    event.releaseDate >= startDate && event.releaseDate <= endDate
  ).slice(0, 24);
  const forecast = await generateMarketForwardForecast({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    executionScope: caller.executionScope!,
    ...value,
    window,
    requestedAt,
    features,
    baselines,
    macroEvents,
  });
  const saved = await saveMarketForwardForecast({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    executionScope: caller.executionScope!,
    idempotencyKey: caller.idempotencyKey!,
    forecast,
  });
  return completeAppServiceCall(authorized, {
    forecast: saved.forecast,
    reused: !saved.inserted,
  }, {
    resourceCount: 1,
    occurredAt: saved.forecast.sealedAt,
  });
}

export async function scoreDueMarketForecastsService(
  caller: AppServiceCaller,
  input: z.input<typeof marketForecastScoreRequestSchema>,
) {
  const value = marketForecastScoreRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.market_research.journal.score"),
  );
  const due = await listDueMarketForecasts({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    instrumentId: value.instrumentId,
    limit: value.maxForecasts,
  });
  const outcomes = [];
  for (const forecast of due) {
    const snapshot = await fetchTwelveDataBarRangeSnapshot({
      instrumentId: forecast.instrumentId,
      interval: forecastWindowInterval(forecast.horizon),
      startAt: forecast.windowStart,
      endAt: forecast.windowEnd,
    });
    const outcome = scoreMarketForwardForecast({
      forecast,
      result: snapshot.result,
      sourcePayload: snapshot.sourcePayload,
    });
    const saved = await saveMarketForecastOutcome({
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      executionScope: caller.executionScope!,
      idempotencyKey: `${caller.idempotencyKey!}:${forecast.id}`,
      outcome,
    });
    outcomes.push(saved.outcome);
  }
  return completeAppServiceCall(authorized, { outcomes }, {
    resourceCount: outcomes.length,
  });
}

function providerReadiness(input: {
  provider: "twelve_data" | "fred" | "bls" | "census" | "bea" | "federal_reserve";
  label: string;
  purpose: string;
  configured: boolean;
  blocking: boolean;
  setupVariable: string;
}) {
  return {
    ...input,
    status: input.configured ? "connected" as const : "credential_required" as const,
  };
}

function hasEnvironmentValue(name: string) {
  return Boolean(process.env[name]?.trim());
}

function newYorkDate(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
