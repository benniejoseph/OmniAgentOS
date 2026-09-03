import "server-only";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { listRecentEvents, type DomainEvent } from "@/lib/events/store";
import { listFileAiUsageRecords } from "@/lib/usage/ledger";
import type { AiUsageRecord } from "@/lib/usage/types";

export type UsagePeriodKey = "day" | "week" | "month";

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  /** Distinct agent-run streams; retained for compatibility. */
  runs: number;
  /** Persisted agent-run model events; retained for compatibility. */
  modelCalls: number;
  /** Distinct metered sources across agent, workflow, retrieval, media, and browser paths. */
  sourceStreams: number;
  /** Logical provider calls across every metered AI operation. */
  providerCalls: number;
  attempts: number;
  failedAttempts: number;
  failedCalls: number;
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
  isAgentModelCall: boolean;
  status: "completed" | "failed";
  provider: string;
  model: string;
  providerCallCount: number;
  attemptCount: number;
  failedAttemptCount: number;
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

type MutableTotals = Omit<UsageTotals, "runs" | "sourceStreams" | "costCoveragePercent"> & {
  runIds: Set<string>;
  sourceIds: Set<string>;
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
  const events = loaded.events;
  const periods = Object.fromEntries(
    PERIODS.map((period) => [period.key, summarizePeriod(events, period, nowMs)]),
  ) as Record<UsagePeriodKey, UsagePeriodSummary>;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    scopeLabel: "Unified AI consumption ledger",
    disclosure:
      "Includes recorded agent turns, council and workflow calls, embeddings, web search, OCR, image generation, transcription, speech, and browser automation. Historical agent-run events remain visible without double-counting dual-written receipts. Costs are estimates when a configured price is known; input tokens are volume, not context-window percentage.",
    sourceEventLimitReached: loaded.limitReached,
    periods,
  };
}

async function loadTrackedModelEvents(tenantId: string, earliestAt: number) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const cutoff = new Date(earliestAt).toISOString();
    const rows = await getSql()`
      WITH combined AS (
        SELECT
          usage.recorded_at AS at,
          jsonb_build_object(
            'kind', 'usage',
            'source_stream_id', usage.source_stream_id,
            'source_event_id', usage.source_event_id,
            'purpose', usage.purpose,
            'status', usage.status,
            'provider', usage.provider,
            'model', usage.model,
            'usage', usage.usage,
            'call_receipts', usage.call_receipts,
            'provider_call_count', usage.provider_call_count,
            'attempt_count', usage.attempt_count,
            'failed_attempt_count', usage.failed_attempt_count,
            'estimated_cost_microusd', usage.estimated_cost_microusd
          ) AS data
        FROM omni_ai_usage usage
        WHERE usage.tenant_id = ${tenantId}
          AND usage.recorded_at >= ${cutoff}::timestamptz

        UNION ALL

        SELECT
          event.at,
          jsonb_build_object(
            'kind', 'legacy',
            'stream_id', event.stream_id,
            'payload', event.payload
          ) AS data
        FROM omni_events event
        WHERE event.tenant_id = ${tenantId}
          AND event.type = 'run.model'
          AND event.at >= ${cutoff}::timestamptz
          AND COALESCE(event.payload->>'usageLedgerVersion', '') <> '1'
          AND NOT EXISTS (
            SELECT 1
            FROM omni_ai_usage usage
            WHERE usage.tenant_id = event.tenant_id
              AND usage.source_event_id = event.id
          )
      )
      SELECT at, data
      FROM combined
      ORDER BY at DESC
      LIMIT ${MAX_DATABASE_EVENTS + 1}
    `;
    const limitReached = rows.length > MAX_DATABASE_EVENTS;
    return {
      events: rows.slice(0, MAX_DATABASE_EVENTS)
        .flatMap(toCombinedTrackedEvents),
      limitReached,
    };
  }

  const [usageRecords, legacyEvents] = await Promise.all([
    listFileAiUsageRecords({ tenantId, limit: MAX_FILE_EVENTS + 1 }),
    listRecentEvents({ tenantId, type: "run.model", limit: MAX_FILE_EVENTS }),
  ]);
  const meteredSourceEvents = new Set(
    usageRecords.map((record) => record.sourceEventId || "").filter(Boolean),
  );
  const events = [
      ...usageRecords
        .filter((record) => Date.parse(record.recordedAt) >= earliestAt)
        .flatMap(toTrackedUsageRecord),
      ...legacyEvents
        .filter((event) =>
          Date.parse(event.at) >= earliestAt &&
          event.payload.usageLedgerVersion !== 1 &&
          !meteredSourceEvents.has(event.id)
        )
        .map(toLegacyTrackedModelEvent)
        .filter((event): event is TrackedModelEvent => Boolean(event)),
    ].sort((left, right) => right.at - left.at);
  return {
    events: events.slice(0, MAX_FILE_EVENTS),
    limitReached:
      events.length > MAX_FILE_EVENTS ||
      usageRecords.length > MAX_FILE_EVENTS ||
      legacyEvents.length >= MAX_FILE_EVENTS,
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
    providerCalls: 0,
    attempts: 0,
    failedAttempts: 0,
    failedCalls: 0,
    knownEstimatedCostUsd: 0,
    knownCostCalls: 0,
    unknownCostCalls: 0,
    runIds: new Set<string>(),
    sourceIds: new Set<string>(),
  };
}

function addToTotals(totals: MutableTotals, event: TrackedModelEvent) {
  totals.inputTokens += event.inputTokens;
  totals.outputTokens += event.outputTokens;
  totals.cachedInputTokens += event.cachedInputTokens;
  totals.totalTokens += event.totalTokens;
  totals.sourceIds.add(event.streamId);
  totals.providerCalls += event.providerCallCount;
  totals.attempts += event.attemptCount;
  totals.failedAttempts += event.failedAttemptCount;
  if (event.isAgentModelCall) {
    totals.modelCalls += 1;
    totals.runIds.add(event.streamId);
  }
  if (event.status === "failed") totals.failedCalls += event.providerCallCount;
  if (event.estimatedCostUsd === undefined) {
    totals.unknownCostCalls += event.providerCallCount;
  } else {
    totals.knownEstimatedCostUsd += event.estimatedCostUsd;
    totals.knownCostCalls += event.providerCallCount;
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
    sourceStreams: totals.sourceIds.size,
    providerCalls: totals.providerCalls,
    attempts: totals.attempts,
    failedAttempts: totals.failedAttempts,
    failedCalls: totals.failedCalls,
    knownEstimatedCostUsd: roundUsd(totals.knownEstimatedCostUsd),
    knownCostCalls: totals.knownCostCalls,
    unknownCostCalls: totals.unknownCostCalls,
    costCoveragePercent: pricedCalls
      ? Math.round((totals.knownCostCalls / pricedCalls) * 100)
      : 0,
  };
}

function toCombinedTrackedEvents(row: Record<string, unknown>): TrackedModelEvent[] {
  const data = objectRecord(row.data);
  const at = row.at instanceof Date ? row.at.toISOString() : String(row.at || "");
  if (data.kind === "legacy") {
    const event = toLegacyTrackedModelEvent({
      streamId: normalizedLabel(data.stream_id, "unknown-run"),
      at,
      payload: objectRecord(data.payload),
    });
    return event ? [event] : [];
  }
  if (data.kind !== "usage") return [];
  return toTrackedUsageRows({ ...data, recorded_at: at });
}

function toLegacyTrackedModelEvent(event: Pick<DomainEvent, "streamId" | "at" | "payload">): TrackedModelEvent | undefined {
  if (event.payload.usageExpiredAt) return undefined;
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
    isAgentModelCall: true,
    status: "completed",
    provider: normalizedLabel(event.payload.provider, "unknown"),
    model: normalizedLabel(event.payload.model, "Unknown model"),
    providerCallCount: positiveInteger(event.payload.iterationCount, 1),
    attemptCount: positiveInteger(
      event.payload.attemptCount,
      event.payload.fallbackUsed === true ? 2 : 1,
    ),
    failedAttemptCount: nonNegative(
      event.payload.failedAttemptCount ?? (event.payload.fallbackUsed === true ? 1 : 0),
    ),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: recordedTotal ?? inputTokens + outputTokens,
    ...(costKnown ? { estimatedCostUsd: cost } : {}),
  };
}

function toTrackedUsageRows(row: Record<string, unknown>): TrackedModelEvent[] {
  const callReceipts = Array.isArray(row.call_receipts)
    ? row.call_receipts.map(objectRecord)
    : [];
  if (!callReceipts.length) return [toAggregateTrackedUsageRow(row)];

  const recordedAt = row.recorded_at instanceof Date
    ? row.recorded_at.getTime()
    : Date.parse(String(row.recorded_at || ""));
  const streamId = normalizedLabel(row.source_stream_id, "unknown-source");
  const logicalAgentModelCall = Boolean(
    row.status !== "failed" &&
    normalizedLabel(row.purpose, "") === "agent.turn" &&
    streamId.startsWith("run:"),
  );
  return callReceipts.map((receipt, index) => {
    const usage = objectRecord(receipt.usage);
    const inputTokens = nonNegative(usage.inputTokens);
    const outputTokens = nonNegative(usage.outputTokens);
    const costMicrousd = optionalNonNegative(receipt.estimatedCostMicrousd);
    const failed = receipt.status === "failed";
    return {
      streamId,
      at: Number.isFinite(recordedAt) ? recordedAt : 0,
      isAgentModelCall:
        logicalAgentModelCall && index === callReceipts.length - 1 && !failed,
      status: failed ? "failed" : "completed",
      provider: normalizedLabel(receipt.provider, "unknown"),
      model: normalizedLabel(receipt.model, "Unknown model"),
      providerCallCount: 1,
      attemptCount: 1,
      failedAttemptCount: failed ? 1 : 0,
      inputTokens,
      outputTokens,
      cachedInputTokens: nonNegative(usage.cachedInputTokens),
      totalTokens:
        optionalNonNegative(usage.totalTokens) ?? inputTokens + outputTokens,
      ...(costMicrousd === undefined
        ? {}
        : { estimatedCostUsd: costMicrousd / 1_000_000 }),
    };
  });
}

function toAggregateTrackedUsageRow(row: Record<string, unknown>): TrackedModelEvent {
  const usage = objectRecord(row.usage);
  const recordedAt = row.recorded_at instanceof Date
    ? row.recorded_at.getTime()
    : Date.parse(String(row.recorded_at || ""));
  const inputTokens = nonNegative(usage.inputTokens);
  const outputTokens = nonNegative(usage.outputTokens);
  const costMicrousd = optionalNonNegative(row.estimated_cost_microusd);
  return {
    streamId: normalizedLabel(row.source_stream_id, "unknown-source"),
    at: Number.isFinite(recordedAt) ? recordedAt : 0,
    isAgentModelCall: Boolean(
      row.status !== "failed" &&
      normalizedLabel(row.purpose, "") === "agent.turn" &&
      normalizedLabel(row.source_stream_id, "").startsWith("run:"),
    ),
    status: row.status === "failed" ? "failed" : "completed",
    provider: normalizedLabel(row.provider, "unknown"),
    model: normalizedLabel(row.model, "Unknown model"),
    providerCallCount: nonNegativeInteger(row.provider_call_count, 0),
    attemptCount: nonNegativeInteger(row.attempt_count, 0),
    failedAttemptCount: nonNegativeInteger(row.failed_attempt_count, 0),
    inputTokens,
    outputTokens,
    cachedInputTokens: nonNegative(usage.cachedInputTokens),
    totalTokens: optionalNonNegative(usage.totalTokens) ?? inputTokens + outputTokens,
    ...(costMicrousd === undefined ? {} : { estimatedCostUsd: costMicrousd / 1_000_000 }),
  };
}

function toTrackedUsageRecord(record: AiUsageRecord): TrackedModelEvent[] {
  return toTrackedUsageRows({
    source_stream_id: record.sourceStreamId,
    source_event_id: record.sourceEventId,
    purpose: record.purpose,
    status: record.status,
    provider: record.provider,
    model: record.model,
    usage: record.usage,
    call_receipts: record.callReceipts,
    provider_call_count: record.providerCallCount,
    attempt_count: record.attemptCount,
    failed_attempt_count: record.failedAttemptCount,
    estimated_cost_microusd: record.estimatedCostMicrousd,
    recorded_at: record.recordedAt,
  });
}

function bucketIndex(at: number, start: number, bucketMs: number, count: number) {
  return Math.min(Math.max(Math.floor((at - start) / bucketMs), 0), count - 1);
}

function nonNegative(value: unknown) {
  return optionalNonNegative(value) ?? 0;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function optionalNonNegative(value: unknown) {
  if (value === null || value === undefined) return undefined;
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
