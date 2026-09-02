import "server-only";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { listRecentEvents, type DomainEvent } from "@/lib/events/store";

export type UsagePeriodKey = "day" | "week" | "month";

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  runs: number;
  modelCalls: number;
  knownEstimatedCostUsd: number;
  knownCostCalls: number;
  unknownCostCalls: number;
  costCoveragePercent: number;
};

export type UsageSeriesPoint = {
  currentAt: string;
  previousAt: string;
  currentTotalTokens: number;
  previousTotalTokens: number;
};

export type UsageBreakdownItem = {
  id: string;
  label: string;
  provider?: string;
  totals: UsageTotals;
};

export type UsagePeriodSummary = {
  key: UsagePeriodKey;
  label: string;
  currentLabel: string;
  previousLabel: string;
  currentStartAt: string;
  currentEndAt: string;
  previousStartAt: string;
  previousEndAt: string;
  bucketUnit: "hour" | "day";
  current: UsageTotals;
  previous: UsageTotals;
  series: UsageSeriesPoint[];
  providers: UsageBreakdownItem[];
  models: UsageBreakdownItem[];
};

export type UsageSummary = {
  generatedAt: string;
  scopeLabel: string;
  disclosure: string;
  sourceEventLimitReached: boolean;
  periods: Record<UsagePeriodKey, UsagePeriodSummary>;
};

type TrackedModelEvent = {
  streamId: string;
  at: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
};

type PeriodDefinition = {
  key: UsagePeriodKey;
  label: string;
  currentLabel: string;
  previousLabel: string;
  durationMs: number;
  bucketMs: number;
  bucketUnit: "hour" | "day";
};

type MutableTotals = Omit<UsageTotals, "runs" | "costCoveragePercent"> & {
  runIds: Set<string>;
};

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_DATABASE_EVENTS = 100_000;
const MAX_FILE_EVENTS = 500;

const PERIODS: PeriodDefinition[] = [
  {
    key: "day",
    label: "24 hours",
    currentLabel: "Current 24 hours",
    previousLabel: "Previous 24 hours",
    durationMs: DAY_MS,
    bucketMs: HOUR_MS,
    bucketUnit: "hour",
  },
  {
    key: "week",
    label: "7 days",
    currentLabel: "Current 7 days",
    previousLabel: "Previous 7 days",
    durationMs: 7 * DAY_MS,
    bucketMs: DAY_MS,
    bucketUnit: "day",
  },
  {
    key: "month",
    label: "30 days",
    currentLabel: "Current 30 days",
    previousLabel: "Previous 30 days",
    durationMs: 30 * DAY_MS,
    bucketMs: DAY_MS,
    bucketUnit: "day",
  },
];

export async function loadUsageSummary({
  tenantId,
  now = new Date(),
}: {
  tenantId: string;
  now?: Date;
}): Promise<UsageSummary> {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) throw new Error("A tenant is required to load usage.");

  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const earliestAt = nowMs - 60 * DAY_MS;
  const loaded = await loadTrackedModelEvents(normalizedTenantId, earliestAt);
  const events = loaded.events
    .map(toTrackedModelEvent)
    .filter((event): event is TrackedModelEvent => Boolean(event));
  const periods = Object.fromEntries(
    PERIODS.map((period) => [period.key, summarizePeriod(events, period, nowMs)]),
  ) as Record<UsagePeriodKey, UsagePeriodSummary>;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    scopeLabel: "Tracked agent consumption",
    disclosure:
      "Based on recorded agent-run model calls. Other model paths are not yet included. Input tokens are shown as context consumed; this is token volume, not a context-window percentage.",
    sourceEventLimitReached: loaded.limitReached,
    periods,
  };
}

async function loadTrackedModelEvents(tenantId: string, earliestAt: number) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT stream_id, payload, at
      FROM omni_events
      WHERE tenant_id = ${tenantId}
        AND type = 'run.model'
        AND at >= ${new Date(earliestAt).toISOString()}::timestamptz
      ORDER BY at DESC
      LIMIT ${MAX_DATABASE_EVENTS + 1}
    `;
    return {
      events: rows.slice(0, MAX_DATABASE_EVENTS).map((row) => ({
        streamId: String(row.stream_id || ""),
        at: row.at instanceof Date ? row.at.toISOString() : String(row.at || ""),
        payload: objectRecord(row.payload),
      })),
      limitReached: rows.length > MAX_DATABASE_EVENTS,
    };
  }

  const events = await listRecentEvents({
    tenantId,
    type: "run.model",
    limit: MAX_FILE_EVENTS,
  });
  return {
    events: events
      .filter((event) => Date.parse(event.at) >= earliestAt)
      .map((event) => ({
        streamId: event.streamId,
        at: event.at,
        payload: event.payload,
      })),
    limitReached: events.length >= MAX_FILE_EVENTS,
  };
}

function summarizePeriod(
  events: TrackedModelEvent[],
  period: PeriodDefinition,
  nowMs: number,
): UsagePeriodSummary {
  const currentStart = nowMs - period.durationMs;
  const previousStart = currentStart - period.durationMs;
  const bucketCount = Math.round(period.durationMs / period.bucketMs);
  const currentEvents: TrackedModelEvent[] = [];
  const previousEvents: TrackedModelEvent[] = [];
  const currentBuckets = Array.from({ length: bucketCount }, () => 0);
  const previousBuckets = Array.from({ length: bucketCount }, () => 0);

  for (const event of events) {
    if (event.at >= currentStart && event.at <= nowMs) {
      currentEvents.push(event);
      currentBuckets[bucketIndex(event.at, currentStart, period.bucketMs, bucketCount)] += event.totalTokens;
    } else if (event.at >= previousStart && event.at < currentStart) {
      previousEvents.push(event);
      previousBuckets[bucketIndex(event.at, previousStart, period.bucketMs, bucketCount)] += event.totalTokens;
    }
  }

  return {
    key: period.key,
    label: period.label,
    currentLabel: period.currentLabel,
    previousLabel: period.previousLabel,
    currentStartAt: new Date(currentStart).toISOString(),
    currentEndAt: new Date(nowMs).toISOString(),
    previousStartAt: new Date(previousStart).toISOString(),
    previousEndAt: new Date(currentStart).toISOString(),
    bucketUnit: period.bucketUnit,
    current: sumEvents(currentEvents),
    previous: sumEvents(previousEvents),
    series: currentBuckets.map((currentTotalTokens, index) => ({
      currentAt: new Date(currentStart + index * period.bucketMs).toISOString(),
      previousAt: new Date(previousStart + index * period.bucketMs).toISOString(),
      currentTotalTokens,
      previousTotalTokens: previousBuckets[index],
    })),
    providers: breakdown(currentEvents, (event) => ({
      id: event.provider,
      label: providerLabel(event.provider),
    })),
    models: breakdown(currentEvents, (event) => ({
      id: `${event.provider}:${event.model}`,
      label: event.model,
      provider: providerLabel(event.provider),
    })),
  };
}

function breakdown(
  events: TrackedModelEvent[],
  identify: (event: TrackedModelEvent) => { id: string; label: string; provider?: string },
) {
  const groups = new Map<string, {
    id: string;
    label: string;
    provider?: string;
    events: TrackedModelEvent[];
  }>();
  for (const event of events) {
    const identity = identify(event);
    const group = groups.get(identity.id) || { ...identity, events: [] };
    group.events.push(event);
    groups.set(identity.id, group);
  }
  return [...groups.values()]
    .map((group) => ({
      id: group.id,
      label: group.label,
      ...(group.provider ? { provider: group.provider } : {}),
      totals: sumEvents(group.events),
    }))
    .sort((left, right) =>
      right.totals.totalTokens - left.totals.totalTokens || left.label.localeCompare(right.label),
    )
    .slice(0, 50);
}

function sumEvents(events: TrackedModelEvent[]): UsageTotals {
  const totals = mutableTotals();
  for (const event of events) addToTotals(totals, event);
  return finishTotals(totals);
}

function mutableTotals(): MutableTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    knownEstimatedCostUsd: 0,
    knownCostCalls: 0,
    unknownCostCalls: 0,
    runIds: new Set<string>(),
  };
}

function addToTotals(totals: MutableTotals, event: TrackedModelEvent) {
  totals.inputTokens += event.inputTokens;
  totals.outputTokens += event.outputTokens;
  totals.cachedInputTokens += event.cachedInputTokens;
  totals.totalTokens += event.totalTokens;
  totals.modelCalls += 1;
  totals.runIds.add(event.streamId);
  if (event.estimatedCostUsd === undefined) {
    totals.unknownCostCalls += 1;
  } else {
    totals.knownEstimatedCostUsd += event.estimatedCostUsd;
    totals.knownCostCalls += 1;
  }
}

function finishTotals(totals: MutableTotals): UsageTotals {
  const pricedCalls = totals.knownCostCalls + totals.unknownCostCalls;
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    totalTokens: totals.totalTokens,
    runs: totals.runIds.size,
    modelCalls: totals.modelCalls,
    knownEstimatedCostUsd: roundUsd(totals.knownEstimatedCostUsd),
    knownCostCalls: totals.knownCostCalls,
    unknownCostCalls: totals.unknownCostCalls,
    costCoveragePercent: pricedCalls
      ? Math.round((totals.knownCostCalls / pricedCalls) * 100)
      : 0,
  };
}

function toTrackedModelEvent(event: Pick<DomainEvent, "streamId" | "at" | "payload">): TrackedModelEvent | undefined {
  const at = Date.parse(event.at);
  if (!Number.isFinite(at)) return undefined;
  const inputTokens = nonNegative(event.payload.inputTokens);
  const outputTokens = nonNegative(event.payload.outputTokens);
  const cachedInputTokens = nonNegative(event.payload.cachedInputTokens);
  const recordedTotal = optionalNonNegative(event.payload.totalTokens);
  const cost = optionalNonNegative(event.payload.estimatedCostUsd);
  const costKnown = event.payload.costKnown !== false && cost !== undefined;
  return {
    streamId: event.streamId || "unknown-run",
    at,
    provider: normalizedLabel(event.payload.provider, "unknown"),
    model: normalizedLabel(event.payload.model, "Unknown model"),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: recordedTotal ?? inputTokens + outputTokens,
    ...(costKnown ? { estimatedCostUsd: cost } : {}),
  };
}

function bucketIndex(at: number, start: number, bucketMs: number, count: number) {
  return Math.min(Math.max(Math.floor((at - start) / bucketMs), 0), count - 1);
}

function nonNegative(value: unknown) {
  return optionalNonNegative(value) ?? 0;
}

function optionalNonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizedLabel(value: unknown, fallback: string) {
  const label = typeof value === "string" ? value.trim() : "";
  return (label || fallback).slice(0, 160);
}

function providerLabel(provider: string) {
  if (provider === "unknown") return "Unknown provider";
  if (provider === "aws_bedrock") return "AWS Bedrock";
  return provider
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function roundUsd(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
