import "server-only";

import { createHash } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  MARKET_ANALYSIS_VERSION,
  marketAnalysisVersionSchema,
  marketAnalysisVersionsResultSchema,
  marketSerializedChartStateSchema,
  marketTechnicalFeaturesResultSchema,
  type MarketAnalysisVersion,
  type MarketAnalysisVersionsResult,
  type MarketInstrumentId,
  type MarketInterval,
  type MarketSerializedChartState,
  type MarketTechnicalFeaturesResult,
  type MarketTechnicalLayerId,
} from "@/lib/market-research/contracts";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const MAX_CHART_STATE_BYTES = 768 * 1_024;

export class MarketAnalysisStoreUnavailableError extends Error {
  constructor() {
    super("Saved market analysis requires the configured database.");
    this.name = "MarketAnalysisStoreUnavailableError";
  }
}

export async function saveMarketAnalysisVersion(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
  features: MarketTechnicalFeaturesResult;
  visibleLayerIds?: MarketTechnicalLayerId[];
  chartState?: MarketSerializedChartState;
}): Promise<{ inserted: boolean; version: MarketAnalysisVersion }> {
  assertMutationScope(input);
  if (!hasDatabaseUrl()) throw new MarketAnalysisStoreUnavailableError();
  await ensureDatabaseSchema();
  const features = marketTechnicalFeaturesResultSchema.parse(input.features);
  const chartState = parseBoundedChartState(input.chartState || {
    sources: null,
    groups: [],
  });
  const visibleLayerIds = uniqueLayerIds(
    input.visibleLayerIds || features.layers
      .filter((layer) => layer.defaultVisible)
      .map((layer) => layer.id),
  );
  const idempotencyKeySha256 = sha256(input.idempotencyKey);
  const chartStateSha256 = canonicalJsonSha256(chartState);
  const savedAt = new Date().toISOString();
  const versionBody = {
    contractVersion: MARKET_ANALYSIS_VERSION,
    instrumentId: features.snapshot.instrumentId,
    interval: features.snapshot.interval,
    snapshotId: features.snapshot.id,
    snapshotSha256: features.snapshot.sha256,
    detectorVersion: features.detectorVersion,
    technicalResultSha256: features.resultSha256,
    visibleLayerIds,
    chartStateSha256,
    chartState,
    annotationCount: features.annotations.length,
    detectionCount: features.detections.length,
    candidateCount: features.detections.filter((item) =>
      item.reviewState === "candidate_rule"
    ).length,
    savedAt,
  };
  const versionSha256 = canonicalJsonSha256(versionBody);
  const id = `market_analysis_${digest([
    input.tenantId,
    input.actorId,
    idempotencyKeySha256,
    versionSha256,
  ].join(":"))}`;
  const version = marketAnalysisVersionSchema.parse({
    id,
    ...versionBody,
    versionSha256,
  });
  const eventPayloadSha256 = canonicalJsonSha256({
    analysisVersionId: id,
    versionSha256,
    snapshotSha256: version.snapshotSha256,
    technicalResultSha256: version.technicalResultSha256,
    chartStateSha256,
  });

  const inserted = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`
      INSERT INTO omni_market_analysis_versions (
        schema_version, id, tenant_id, owner_actor_id, contract_version,
        instrument_id, interval, snapshot_id, snapshot_sha256,
        detector_version, technical_result_sha256, technical_features,
        visible_layer_ids, chart_state_sha256, chart_state,
        annotation_count, detection_count, candidate_count,
        idempotency_key_sha256, version_sha256, analysis_version, saved_at
      ) VALUES (
        1, ${version.id}, ${input.tenantId}, ${input.actorId},
        ${MARKET_ANALYSIS_VERSION}, ${version.instrumentId}, ${version.interval},
        ${version.snapshotId}, ${version.snapshotSha256},
        ${version.detectorVersion}, ${version.technicalResultSha256},
        ${features}::JSONB, ${version.visibleLayerIds}::TEXT[],
        ${version.chartStateSha256}, ${version.chartState}::JSONB,
        ${version.annotationCount}, ${version.detectionCount},
        ${version.candidateCount}, ${idempotencyKeySha256},
        ${version.versionSha256}, ${version}::JSONB, ${version.savedAt}
      )
      ON CONFLICT (tenant_id, owner_actor_id, idempotency_key_sha256)
      DO NOTHING
      RETURNING id
    `;
    if (rows[0]) {
      await sql`
        INSERT INTO omni_market_analysis_events (
          schema_version, id, tenant_id, owner_actor_id,
          analysis_version_id, event_type, idempotency_key_sha256,
          payload_sha256, occurred_at
        ) VALUES (
          1, ${eventId(version.id, idempotencyKeySha256)},
          ${input.tenantId}, ${input.actorId}, ${version.id},
          'market.analysis_version.saved', ${idempotencyKeySha256},
          ${eventPayloadSha256}, ${version.savedAt}
        )
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
    return Boolean(rows[0]);
  }) as boolean;

  if (inserted) return { inserted: true, version };
  const existing = await readByIdempotencyKey({
    tenantId: input.tenantId,
    actorId: input.actorId,
    idempotencyKeySha256,
  });
  if (!existing) throw new Error("The saved market analysis could not be reconciled.");
  return { inserted: false, version: existing };
}

export async function listMarketAnalysisVersions(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  limit: number;
}): Promise<MarketAnalysisVersionsResult> {
  assertOwner(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) {
    return marketAnalysisVersionsResultSchema.parse({
      contractVersion: MARKET_ANALYSIS_VERSION,
      instrumentId: input.instrumentId,
      interval: input.interval,
      versions: [],
      total: 0,
    });
  }
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT analysis_version, COUNT(*) OVER() AS total_count
    FROM omni_market_analysis_versions
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND instrument_id = ${input.instrumentId}
      AND interval = ${input.interval}
    ORDER BY saved_at DESC, id DESC
    LIMIT ${input.limit}
  `;
  return marketAnalysisVersionsResultSchema.parse({
    contractVersion: MARKET_ANALYSIS_VERSION,
    instrumentId: input.instrumentId,
    interval: input.interval,
    versions: rows.map((row) => parseVersion(row.analysis_version)),
    total: rows[0] ? Number(rows[0].total_count) : 0,
  });
}

function parseVersion(value: unknown) {
  const parsed = marketAnalysisVersionSchema.parse(value);
  const { versionSha256, id: _id, ...body } = parsed;
  if (canonicalJsonSha256(body) !== versionSha256) {
    throw new Error("Saved market analysis digest does not match its body.");
  }
  return parsed;
}

async function readByIdempotencyKey(input: {
  tenantId: string;
  actorId: string;
  idempotencyKeySha256: string;
}) {
  const rows = await getSql()`
    SELECT analysis_version
    FROM omni_market_analysis_versions
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND idempotency_key_sha256 = ${input.idempotencyKeySha256}
    LIMIT 1
  `;
  return rows[0] ? parseVersion(rows[0].analysis_version) : null;
}

function parseBoundedChartState(value: unknown) {
  const parsed = marketSerializedChartStateSchema.parse(value);
  const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (bytes > MAX_CHART_STATE_BYTES) {
    throw new Error("The chart drawing state exceeds the private storage limit.");
  }
  return parsed;
}

function uniqueLayerIds(values: MarketTechnicalLayerId[]) {
  return [...new Set(values)].sort();
}

function assertMutationScope(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
}) {
  assertOwner(input.tenantId, input.actorId);
  assertExecutionScopeTenant(input.executionScope, input.tenantId);
  if (
    input.executionScope.initiatingActorId !== input.actorId ||
    !input.idempotencyKey.trim()
  ) {
    throw new Error("Market analysis mutation scope is invalid.");
  }
}

function assertOwner(tenantId: string, actorId: string) {
  if (!tenantId.trim() || !actorId.trim()) {
    throw new Error("Market analysis access requires an exact tenant and actor.");
  }
}

function eventId(versionId: string, idempotencyKeySha256: string) {
  return `market_analysis_event_${digest(`${versionId}:${idempotencyKeySha256}`)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}
