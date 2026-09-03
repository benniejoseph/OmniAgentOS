import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendDomainEvent } from "@/lib/events/store";
import { assertExecutionScopeTenant } from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type {
  AiUsageCallInput,
  AiUsageCallReceipt,
  AiUsageRecord,
  AiUsageScope,
  AiUsageStatus,
  AiUsageUnits,
} from "@/lib/usage/types";

type UsageSqlClient = ReturnType<typeof getSql>;

type UsageFileLedger = {
  records: Array<{
    record: AiUsageRecord;
    eventAppended: boolean;
    eventId?: string;
  }>;
};

const FILE_USAGE_RECORD_CAP = 10_000;

export type RecordAiUsageInput = AiUsageScope & {
  id?: string;
  sourceEventId?: string;
  status: AiUsageStatus;
  provider: string;
  model: string;
  usage?: AiUsageUnits;
  providerCallCount?: number;
  attemptCount?: number;
  failedAttemptCount?: number;
  callReceipts?: readonly AiUsageCallInput[];
  latencyMs?: number;
  estimatedCostUsd?: number;
  providerRequestId?: string;
  failureKind?: string;
  retryable?: boolean;
};

export async function recordAiUsage(
  input: RecordAiUsageInput,
  options: { sql?: UsageSqlClient } = {},
): Promise<AiUsageRecord> {
  const record = normalizeUsageRecord(input);
  if (hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    if (options.sql) return persistPostgresUsage(record, options.sql);
    let saved: AiUsageRecord | undefined;
    await getSql().transaction(async (sql: UsageSqlClient) => {
      saved = await persistPostgresUsage(record, sql);
    });
    if (!saved) throw new Error("AI usage receipt was not persisted.");
    return saved;
  }

  return persistFileUsage(record);
}

export async function listFileAiUsageRecords({
  tenantId,
  limit = 500,
}: {
  tenantId: string;
  limit?: number;
}) {
  const normalizedTenantId = requiredText(tenantId, "tenantId", 120);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), FILE_USAGE_RECORD_CAP);
  const ledger = await readJsonFile<UsageFileLedger>(
    getUsageFile(),
    { records: [] },
  );
  return ledger.records
    .map((entry) => ({
      ...entry.record,
      callReceipts: Array.isArray(entry.record.callReceipts)
        ? entry.record.callReceipts
        : [],
    }))
    .filter((record) => record.tenantId === normalizedTenantId)
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
    .slice(0, boundedLimit);
}

export async function recordAiUsageSafely(
  input: Parameters<typeof recordAiUsage>[0],
) {
  try {
    return await recordAiUsage(input);
  } catch (error) {
    console.warn(
      "AI usage receipt persistence failed.",
      error instanceof Error ? error.message : "Unknown usage persistence error.",
    );
    return undefined;
  }
}

async function persistPostgresUsage(
  record: AiUsageRecord,
  sql: UsageSqlClient,
): Promise<AiUsageRecord> {
  const inserted = await sql`
    INSERT INTO omni_ai_usage (
      id, tenant_id, actor_id, source_stream_id, source_event_id,
      correlation_id, causation_id, execution_scope, operation, purpose,
      status, provider, model, usage, call_receipts, provider_call_count, attempt_count,
      failed_attempt_count, latency_ms, estimated_cost_microusd,
      pricing_source, pricing_version, provider_request_id, assignment_id,
      credential_source, failure_kind, retryable, recorded_at
    ) VALUES (
      ${record.id}, ${record.tenantId}, ${record.actorId},
      ${record.sourceStreamId}, ${record.sourceEventId || null},
      ${record.correlationId || null}, ${record.causationId || null},
      ${record.executionScope || null}::jsonb,
      ${record.operation}, ${record.purpose}, ${record.status}, ${record.provider}, ${record.model},
      ${record.usage}::jsonb, ${record.callReceipts}::jsonb, ${record.providerCallCount},
      ${record.attemptCount}, ${record.failedAttemptCount}, ${record.latencyMs},
      ${record.estimatedCostMicrousd ?? null}, ${record.pricingSource || null},
      ${record.pricingVersion || null}, ${record.providerRequestId || null},
      ${record.assignmentId || null}, ${record.credentialSource || null},
      ${record.failureKind || null}, ${record.retryable ?? null},
      ${record.recordedAt}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  if (inserted[0]) {
    await appendDomainEvent(
      usageDomainEvent(record, usageEventId(record.id)),
      { sql },
    );
    return usageRecordFromRow(inserted[0]);
  }

  const existing = await sql`
    SELECT * FROM omni_ai_usage
    WHERE tenant_id = ${record.tenantId}
      AND (
        id = ${record.id}
        OR (
          ${record.sourceEventId || null}::text IS NOT NULL
          AND source_event_id = ${record.sourceEventId || null}
        )
      )
    ORDER BY (id = ${record.id}) DESC
    LIMIT 1
  `;
  if (!existing[0]) {
    throw new Error("AI usage receipt id collided outside the active tenant.");
  }
  let saved = usageRecordFromRow(existing[0]);
  const promoteSourceEvent = Boolean(
    record.sourceEventId &&
    saved.id === record.id &&
    !saved.sourceEventId,
  );
  const comparableSaved = promoteSourceEvent
    ? { ...saved, sourceEventId: record.sourceEventId }
    : saved;
  const sameSourceEvent = Boolean(
    record.sourceEventId && comparableSaved.sourceEventId === record.sourceEventId,
  );
  if (
    canonicalUsageRecord(comparableSaved, sameSourceEvent) !==
    canonicalUsageRecord(record, sameSourceEvent)
  ) {
    throw new Error("AI usage receipt id is already bound to different metrics.");
  }
  if (promoteSourceEvent) {
    const promoted = await sql`
      UPDATE omni_ai_usage
      SET source_event_id = ${record.sourceEventId || null}
      WHERE tenant_id = ${record.tenantId}
        AND id = ${record.id}
        AND source_event_id IS NULL
      RETURNING *
    `;
    if (!promoted[0]) {
      throw new Error("AI usage receipt source event could not be reconciled.");
    }
    saved = usageRecordFromRow(promoted[0]);
  }
  return saved;
}

async function persistFileUsage(record: AiUsageRecord): Promise<AiUsageRecord> {
  let saved: AiUsageRecord | undefined;
  let appendEvent = false;
  let collisionError: Error | undefined;
  await updateJsonFile<UsageFileLedger>(
    getUsageFile(),
    { records: [] },
    (ledger) => {
      const existing = ledger.records.find((entry) =>
        entry.record.id === record.id ||
        Boolean(
          record.sourceEventId &&
          entry.record.tenantId === record.tenantId &&
          entry.record.sourceEventId === record.sourceEventId,
        )
      );
      if (existing) {
        if (!Array.isArray(existing.record.callReceipts)) {
          existing.record = { ...existing.record, callReceipts: [] };
        }
        const promoteSourceEvent = Boolean(
          record.sourceEventId &&
          existing.record.id === record.id &&
          !existing.record.sourceEventId,
        );
        const comparableExisting = promoteSourceEvent
          ? { ...existing.record, sourceEventId: record.sourceEventId }
          : existing.record;
        const sameSourceEvent = Boolean(
          record.sourceEventId &&
          comparableExisting.sourceEventId === record.sourceEventId,
        );
        if (
          canonicalUsageRecord(comparableExisting, sameSourceEvent) !==
          canonicalUsageRecord(record, sameSourceEvent)
        ) {
          collisionError = new Error(
            "AI usage receipt id is already bound to different metrics.",
          );
        }
        if (promoteSourceEvent && !collisionError) {
          existing.record = comparableExisting;
        }
        existing.eventId ||= usageEventId(existing.record.id);
        saved = existing.record;
        appendEvent = !existing.eventAppended;
        return ledger;
      }
      ledger.records.push({
        record,
        eventAppended: false,
        eventId: usageEventId(record.id),
      });
      if (ledger.records.length > FILE_USAGE_RECORD_CAP) {
        ledger.records = ledger.records.slice(-FILE_USAGE_RECORD_CAP);
      }
      saved = record;
      appendEvent = true;
      return ledger;
    },
  );
  if (!saved) throw new Error("AI usage receipt was not persisted.");
  if (appendEvent) {
    await appendDomainEvent(usageDomainEvent(saved, usageEventId(saved.id)));
    const savedId = saved.id;
    await updateJsonFile<UsageFileLedger>(
      getUsageFile(),
      { records: [] },
      (ledger) => {
        const entry = ledger.records.find((item) => item.record.id === savedId);
        if (entry) entry.eventAppended = true;
        return ledger;
      },
    );
  }
  if (collisionError) throw collisionError;
  return saved;
}

function usageDomainEvent(record: AiUsageRecord, id?: string) {
  return {
    ...(id ? { id } : {}),
    streamId: `ai-usage:${record.id}`,
    type: "ai.usage.recorded",
    tenantId: record.tenantId,
    actorId: record.actorId,
    correlationId: record.correlationId,
    causationId: record.causationId,
    executionScope: record.executionScope,
    payload: {
      schemaVersion: 2,
      usageId: record.id,
      sourceStreamId: record.sourceStreamId,
      sourceEventId: record.sourceEventId,
      operation: record.operation,
      purpose: record.purpose,
      status: record.status,
      provider: record.provider,
      model: record.model,
      usage: record.usage,
      callReceipts: record.callReceipts,
      providerCallCount: record.providerCallCount,
      attemptCount: record.attemptCount,
      failedAttemptCount: record.failedAttemptCount,
      latencyMs: record.latencyMs,
      estimatedCostMicrousd: record.estimatedCostMicrousd,
      pricingSource: record.pricingSource,
      pricingVersion: record.pricingVersion,
      providerRequestId: record.providerRequestId,
      assignmentId: record.assignmentId,
      credentialSource: record.credentialSource,
      failureKind: record.failureKind,
      retryable: record.retryable,
    },
  };
}

function normalizeUsageRecord(input: RecordAiUsageInput): AiUsageRecord {
  const tenantId = requiredText(input.tenantId, "tenantId", 120);
  const actorId = requiredText(input.actorId, "actorId", 256);
  if (input.executionScope) {
    assertExecutionScopeTenant(input.executionScope, tenantId);
    if (
      input.executionScope.initiatingActorId &&
      input.executionScope.initiatingActorId !== actorId
    ) {
      throw new Error("AI usage actor does not match its execution scope.");
    }
  }
  const callReceipts = normalizeCallReceipts(input.callReceipts);
  const explicitCost = optionalNonNegativeNumber(input.estimatedCostUsd);
  const allCallCostsKnown = callReceipts.length > 0 &&
    callReceipts.every((receipt) => receipt.estimatedCostMicrousd !== undefined);
  const estimatedCostMicrousd = callReceipts.length
    ? allCallCostsKnown
      ? callReceipts.reduce(
          (total, receipt) => total + (receipt.estimatedCostMicrousd || 0),
          0,
        )
      : undefined
    : explicitCost === undefined
      ? undefined
      : Math.round(explicitCost * 1_000_000);
  const pricing = callReceipts.length
    ? callReceiptPricingProvenance(callReceipts)
    : pricingProvenance(input.provider, input.model, estimatedCostMicrousd !== undefined);
  const providerCallCount = callReceipts.length ||
    nonNegativeInteger(input.providerCallCount, 1);
  const attemptCount = nonNegativeInteger(input.attemptCount, providerCallCount);
  const failedAttemptCount = callReceipts.length
    ? callReceipts.filter((receipt) => receipt.status === "failed").length
    : nonNegativeInteger(input.failedAttemptCount, 0);
  if (providerCallCount > attemptCount) {
    throw new Error("AI usage provider-call count cannot exceed attempt count.");
  }
  if (failedAttemptCount > attemptCount) {
    throw new Error("AI usage failed-attempt count cannot exceed attempt count.");
  }
  return {
    id: requiredText(input.id || randomUUID(), "id", 200),
    tenantId,
    actorId,
    sourceStreamId: requiredText(input.sourceStreamId, "sourceStreamId", 240),
    ...(input.sourceEventId
      ? { sourceEventId: requiredText(input.sourceEventId, "sourceEventId", 200) }
      : {}),
    operation: input.operation,
    purpose: requiredText(input.purpose, "purpose", 160),
    status: input.status,
    provider: requiredText(input.provider, "provider", 80),
    model: requiredText(input.model, "model", 200),
    usage: callReceipts.length
      ? sumUsageUnits(callReceipts.map((receipt) => receipt.usage))
      : normalizeUsageUnits(input.usage),
    providerCallCount,
    attemptCount,
    failedAttemptCount,
    callReceipts,
    latencyMs: nonNegativeInteger(input.latencyMs, 0),
    ...(estimatedCostMicrousd === undefined ? {} : { estimatedCostMicrousd }),
    ...pricing,
    ...(input.providerRequestId
      ? { providerRequestId: requiredText(input.providerRequestId, "providerRequestId", 240) }
      : {}),
    ...(input.assignmentId
      ? { assignmentId: requiredText(input.assignmentId, "assignmentId", 200) }
      : {}),
    ...(input.credentialSource ? { credentialSource: input.credentialSource } : {}),
    ...(input.correlationId
      ? { correlationId: requiredText(input.correlationId, "correlationId", 240) }
      : {}),
    ...(input.causationId
      ? { causationId: requiredText(input.causationId, "causationId", 240) }
      : {}),
    ...(input.executionScope ? { executionScope: input.executionScope } : {}),
    ...(input.failureKind
      ? { failureKind: requiredText(input.failureKind, "failureKind", 80) }
      : {}),
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    recordedAt: new Date().toISOString(),
  };
}

function normalizeUsageUnits(input: AiUsageUnits | undefined): AiUsageUnits {
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const normalized = optionalNonNegativeNumber(value);
      return normalized === undefined ? [] : [[key, Math.round(normalized)]];
    }),
  ) as AiUsageUnits;
}

function normalizeCallReceipts(
  input: readonly AiUsageCallInput[] | undefined,
): AiUsageCallReceipt[] {
  if (!input?.length) return [];
  if (input.length > 64) {
    throw new Error("AI usage call receipts exceed the 64-call limit.");
  }
  return input.map((receipt, index) => {
    if (receipt.status !== "completed" && receipt.status !== "failed") {
      throw new Error("AI usage call receipt status is invalid.");
    }
    const provider = requiredText(receipt.provider, "call provider", 80);
    const model = requiredText(receipt.model, "call model", 200);
    const cost = optionalNonNegativeNumber(receipt.estimatedCostUsd);
    return {
      sequence: index + 1,
      provider,
      model,
      status: receipt.status,
      usage: normalizeUsageUnits(receipt.usage),
      latencyMs: nonNegativeInteger(receipt.latencyMs, 0),
      ...(cost === undefined
        ? {}
        : { estimatedCostMicrousd: Math.round(cost * 1_000_000) }),
      ...pricingProvenance(provider, model, cost !== undefined),
      ...(receipt.providerRequestId
        ? {
            providerRequestId: requiredText(
              receipt.providerRequestId,
              "call providerRequestId",
              240,
            ),
          }
        : {}),
      ...(receipt.failureKind
        ? {
            failureKind: requiredText(
              receipt.failureKind,
              "call failureKind",
              80,
            ),
          }
        : {}),
      ...(receipt.retryable === undefined
        ? {}
        : { retryable: receipt.retryable }),
    };
  });
}

function sumUsageUnits(usages: readonly AiUsageUnits[]): AiUsageUnits {
  const totals: Record<string, number> = {};
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage)) {
      totals[key] = (totals[key] || 0) + (optionalNonNegativeNumber(value) || 0);
    }
  }
  return totals as AiUsageUnits;
}

function callReceiptPricingProvenance(
  receipts: readonly AiUsageCallReceipt[],
) {
  const priced = receipts.filter(
    (receipt) => receipt.estimatedCostMicrousd !== undefined,
  );
  if (!priced.length) return {};
  return {
    pricingSource: "provider_call_receipts",
    pricingVersion: createHash("sha256")
      .update(
        priced.map((receipt) =>
          `${receipt.provider}/${receipt.model}/${receipt.pricingVersion || "unknown"}`
        ).join("\n"),
      )
      .digest("hex")
      .slice(0, 16),
  };
}

function pricingProvenance(provider: string, model: string, costKnown: boolean) {
  if (!costKnown) return {};
  const raw = provider === "openai"
    ? process.env.OPENAI_MODEL_PRICING_JSON
    : provider === "google"
      ? process.env.GEMINI_MODEL_PRICING_JSON
      : provider === "anthropic"
        ? process.env.ANTHROPIC_MODEL_PRICING_JSON
        : provider === "aws_bedrock"
          ? process.env.BEDROCK_MODEL_PRICING_JSON
          : process.env.LOCAL_MODEL_PRICING_JSON;
  let selected = "configured-rate";
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    selected = JSON.stringify(parsed[model] || selected);
  } catch {
    selected = "configured-rate";
  }
  return {
    pricingSource: "environment",
    pricingVersion: createHash("sha256")
      .update(`${provider}\n${model}\n${selected}`)
      .digest("hex")
      .slice(0, 16),
  };
}

function usageRecordFromRow(row: Record<string, unknown>): AiUsageRecord {
  const usage = row.usage && typeof row.usage === "object" && !Array.isArray(row.usage)
    ? row.usage as AiUsageUnits
    : {};
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    sourceStreamId: String(row.source_stream_id),
    ...(row.source_event_id ? { sourceEventId: String(row.source_event_id) } : {}),
    ...(row.correlation_id ? { correlationId: String(row.correlation_id) } : {}),
    ...(row.causation_id ? { causationId: String(row.causation_id) } : {}),
    ...(row.execution_scope && typeof row.execution_scope === "object" && !Array.isArray(row.execution_scope)
      ? { executionScope: row.execution_scope as AiUsageRecord["executionScope"] }
      : {}),
    operation: String(row.operation) as AiUsageRecord["operation"],
    purpose: String(row.purpose),
    status: String(row.status) as AiUsageStatus,
    provider: String(row.provider),
    model: String(row.model),
    usage,
    callReceipts: Array.isArray(row.call_receipts)
      ? row.call_receipts as AiUsageCallReceipt[]
      : [],
    providerCallCount: Number(row.provider_call_count),
    attemptCount: Number(row.attempt_count),
    failedAttemptCount: Number(row.failed_attempt_count),
    latencyMs: Number(row.latency_ms),
    ...(row.estimated_cost_microusd === null || row.estimated_cost_microusd === undefined
      ? {}
      : { estimatedCostMicrousd: Number(row.estimated_cost_microusd) }),
    ...(row.pricing_source ? { pricingSource: String(row.pricing_source) } : {}),
    ...(row.pricing_version ? { pricingVersion: String(row.pricing_version) } : {}),
    ...(row.provider_request_id ? { providerRequestId: String(row.provider_request_id) } : {}),
    ...(row.assignment_id ? { assignmentId: String(row.assignment_id) } : {}),
    ...(row.credential_source
      ? { credentialSource: String(row.credential_source) as AiUsageRecord["credentialSource"] }
      : {}),
    ...(row.failure_kind ? { failureKind: String(row.failure_kind) } : {}),
    ...(row.retryable === null || row.retryable === undefined
      ? {}
      : { retryable: Boolean(row.retryable) }),
    recordedAt: row.recorded_at instanceof Date
      ? row.recorded_at.toISOString()
      : String(row.recorded_at),
  };
}

function canonicalUsageRecord(record: AiUsageRecord, ignoreId = false) {
  return stableStringify({
    ...record,
    id: ignoreId ? undefined : record.id,
    recordedAt: undefined,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function getUsageFile() {
  return getDataPath("ai-usage.json");
}

function usageEventId(recordId: string) {
  return `ai-usage:${recordId}`;
}

function requiredText(value: string, field: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`AI usage ${field} is required.`);
  if (normalized.length > maxLength) {
    throw new Error(`AI usage ${field} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function optionalNonNegativeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
