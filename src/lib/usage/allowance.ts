import "server-only";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { listFileAiUsageRecords } from "@/lib/usage/ledger";
import type { AiUsageRecord } from "@/lib/usage/types";

export type TenantAiUsageTotals = {
  tokens: number;
  costMicrousd: number;
};

const FILE_USAGE_RECORD_LIMIT = 10_000;
const USAGE_COUNTER_MAX = 1_000_000_000_000;

/**
 * Sum the AI usage the ledger recorded for a tenant since a time, or only the
 * usage of one source stream. A record's tokens are the larger of its
 * reported total and its input plus output, and a record without a price
 * adds no cost.
 */
export async function loadTenantAiUsageSince(input: {
  tenantId: string;
  since: Date;
  sourceStreamId?: string;
}): Promise<TenantAiUsageTotals> {
  const sourceStreamId = input.sourceStreamId ?? null;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        COALESCE(SUM(GREATEST(
          CASE WHEN jsonb_typeof(ledger.usage->'totalTokens') = 'number'
            THEN (ledger.usage->>'totalTokens')::numeric ELSE 0 END,
          CASE WHEN jsonb_typeof(ledger.usage->'inputTokens') = 'number'
            THEN (ledger.usage->>'inputTokens')::numeric ELSE 0 END
          + CASE WHEN jsonb_typeof(ledger.usage->'outputTokens') = 'number'
            THEN (ledger.usage->>'outputTokens')::numeric ELSE 0 END
        )), 0)::text AS tokens,
        COALESCE(SUM(ledger.estimated_cost_microusd), 0)::text AS cost_microusd
      FROM omni_ai_usage ledger
      WHERE ledger.tenant_id = ${input.tenantId}
        AND ledger.recorded_at >= ${input.since.toISOString()}::timestamptz
        AND (${sourceStreamId}::text IS NULL OR ledger.source_stream_id = ${sourceStreamId})
    `;
    const row = rows[0] as
      | { tokens?: unknown; cost_microusd?: unknown }
      | undefined;
    return {
      tokens: usageCounter(row?.tokens),
      costMicrousd: usageCounter(row?.cost_microusd),
    };
  }

  const sinceMs = input.since.getTime();
  const records = await listFileAiUsageRecords({
    tenantId: input.tenantId,
    limit: FILE_USAGE_RECORD_LIMIT,
  });
  let tokens = 0;
  let costMicrousd = 0;
  for (const record of records) {
    if (!(Date.parse(record.recordedAt) >= sinceMs)) continue;
    if (sourceStreamId !== null && record.sourceStreamId !== sourceStreamId) continue;
    tokens += recordTokens(record);
    costMicrousd += usageCounter(record.estimatedCostMicrousd);
  }
  return {
    tokens: usageCounter(tokens),
    costMicrousd: usageCounter(costMicrousd),
  };
}

function recordTokens(record: AiUsageRecord) {
  return Math.max(
    usageCounter(record.usage.totalTokens),
    usageCounter(record.usage.inputTokens) +
      usageCounter(record.usage.outputTokens),
  );
}

function usageCounter(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(USAGE_COUNTER_MAX, Math.ceil(parsed))
    : 0;
}
