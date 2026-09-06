import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parseEntityAccessBinding,
  type EntityAccessBinding,
} from "@/lib/entities/registry";
import type { GraphStorageShadowComparison } from "@/lib/entities/graph-storage-adapter";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

export const GRAPH_QUERY_TELEMETRY_VERSION =
  "p5.6-graph-query-telemetry:1" as const;
export const GRAPH_STORAGE_DECISION_POLICY_VERSION =
  "p5.6-graph-storage-decision:1" as const;

export const GRAPH_STORAGE_DECISION_THRESHOLDS = Object.freeze({
  minimumQuerySamples: 100,
  p95DurationMs: 750,
  entityCount: 50_000,
  relationLimitSaturationBasisPoints: 2_000,
  minimumShadowSamples: 1_000,
  requiredShadowParityBasisPoints: 10_000,
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const adapterIdSchema = z.string().trim().min(3).max(90).regex(
  /^[a-z][a-z0-9._-]{1,79}:[1-9][0-9]{0,8}$/,
);
const timestampSchema = z.string().datetime({ offset: true });
const durationSchema = z.number().finite().min(0).max(3_600_000);
const countSchema = z.number().int().min(0).max(2_147_483_647);

const graphQueryTelemetryBodySchema = z.object({
  version: z.literal(GRAPH_QUERY_TELEMETRY_VERSION),
  telemetryId: identifierSchema,
  tenantId: identifierSchema,
  ownerActorId: identifierSchema,
  accessScopeSha256: sha256Schema,
  correlationId: identifierSchema,
  queryKind: z.literal("relationship_paths"),
  status: z.enum(["succeeded", "failed"]),
  failureStage: z.enum([
    "storage_read",
    "evidence_authorization",
    "path_expansion",
  ]).nullable(),
  primaryAdapterId: adapterIdSchema,
  shadowAdapterId: adapterIdSchema.nullable(),
  shadowState: z.enum([
    "not_configured",
    "matched",
    "mismatched",
    "failed",
  ]),
  maxHops: z.number().int().min(1).max(3),
  requestedLimit: z.number().int().min(1).max(24),
  entityCount: countSchema,
  aliasCount: countSchema,
  relationCandidateCount: countSchema,
  relationLimitSaturated: z.boolean(),
  authorizedRelationCount: countSchema,
  rejectedRelationCount: countSchema,
  pathCount: countSchema,
  primaryStorageDurationMs: durationSchema,
  shadowStorageDurationMs: durationSchema.nullable(),
  evidenceAuthorizationDurationMs: durationSchema,
  pathExpansionDurationMs: durationSchema,
  totalDurationMs: durationSchema,
  recordedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.status === "failed") !== (value.failureStage !== null)) {
    context.addIssue({
      code: "custom",
      path: ["failureStage"],
      message: "Only failed graph queries declare a failure stage.",
    });
  }
  if (
    (value.shadowState === "not_configured") !==
      (value.shadowAdapterId === null) ||
    (value.shadowAdapterId === null) !==
      (value.shadowStorageDurationMs === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["shadowState"],
      message: "Graph shadow metadata is inconsistent.",
    });
  }
});

export const graphQueryTelemetrySchema = graphQueryTelemetryBodySchema.extend({
  telemetrySha256: sha256Schema,
}).strict();

export type GraphQueryTelemetry = z.infer<typeof graphQueryTelemetrySchema>;

type GraphQueryTelemetryLedger = {
  schemaVersion: 1;
  samples: GraphQueryTelemetry[];
};

type GraphTelemetrySqlClient = ReturnType<typeof getSql>;

const emptyLedger: GraphQueryTelemetryLedger = {
  schemaVersion: 1,
  samples: [],
};

export function buildGraphQueryTelemetry(input: {
  accessBinding: EntityAccessBinding;
  executionScope: ExecutionScope;
  status?: "succeeded" | "failed";
  failureStage?: GraphQueryTelemetry["failureStage"];
  shadow: GraphStorageShadowComparison;
  maxHops: number;
  requestedLimit: number;
  entityCount: number;
  aliasCount: number;
  relationCandidateCount: number;
  relationLimitSaturated: boolean;
  authorizedRelationCount: number;
  rejectedRelationCount: number;
  pathCount: number;
  evidenceAuthorizationDurationMs: number;
  pathExpansionDurationMs: number;
  totalDurationMs: number;
  recordedAt?: string;
}): GraphQueryTelemetry {
  const binding = parseEntityAccessBinding(input.accessBinding);
  const scope = assertTelemetryScope(input.executionScope, binding);
  const recordedAt = canonicalTimestamp(
    input.recordedAt || new Date().toISOString(),
  );
  const identity = {
    tenantId: binding.tenantId,
    ownerActorId: binding.ownerActorId,
    correlationId: scope.correlationId,
    recordedAt,
    nonce: randomUUID(),
  };
  const body = graphQueryTelemetryBodySchema.parse({
    version: GRAPH_QUERY_TELEMETRY_VERSION,
    telemetryId: `graph_query_${sourceContractSha256(identity).slice(0, 52)}`,
    tenantId: binding.tenantId,
    ownerActorId: binding.ownerActorId,
    accessScopeSha256: binding.accessScopeSha256,
    correlationId: scope.correlationId,
    queryKind: "relationship_paths",
    status: input.status || "succeeded",
    failureStage: input.failureStage || null,
    primaryAdapterId: input.shadow.primaryAdapterId,
    shadowAdapterId: input.shadow.shadowAdapterId,
    shadowState: input.shadow.state,
    maxHops: input.maxHops,
    requestedLimit: input.requestedLimit,
    entityCount: input.entityCount,
    aliasCount: input.aliasCount,
    relationCandidateCount: input.relationCandidateCount,
    relationLimitSaturated: input.relationLimitSaturated,
    authorizedRelationCount: input.authorizedRelationCount,
    rejectedRelationCount: input.rejectedRelationCount,
    pathCount: input.pathCount,
    primaryStorageDurationMs: input.shadow.primaryDurationMs,
    shadowStorageDurationMs: input.shadow.shadowDurationMs,
    evidenceAuthorizationDurationMs: input.evidenceAuthorizationDurationMs,
    pathExpansionDurationMs: input.pathExpansionDurationMs,
    totalDurationMs: input.totalDurationMs,
    recordedAt,
  });
  return deepFreeze(graphQueryTelemetrySchema.parse({
    ...body,
    telemetrySha256: sourceContractSha256(body),
  }));
}

export function parseGraphQueryTelemetry(value: unknown) {
  const parsed = graphQueryTelemetrySchema.parse(value);
  const { telemetrySha256, ...body } = parsed;
  if (sourceContractSha256(body) !== telemetrySha256) {
    throw new Error("Graph query telemetry digest is invalid.");
  }
  return deepFreeze(parsed);
}

export async function recordGraphQueryTelemetry(input: {
  telemetry: GraphQueryTelemetry;
  executionScope: ExecutionScope;
}) {
  const telemetry = parseGraphQueryTelemetry(input.telemetry);
  const scope = assertTelemetryScope(input.executionScope, {
    tenantId: telemetry.tenantId,
    ownerActorId: telemetry.ownerActorId,
    workspaceId: null,
    projectId: null,
    missionId: null,
  });
  if (scope.correlationId !== telemetry.correlationId) {
    throw new Error("Graph query telemetry correlation is invalid.");
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(
      telemetry.tenantId,
      [telemetry.ownerActorId],
      () => getSql().transaction(async (sql: GraphTelemetrySqlClient) => {
        const rows = await sql`
          INSERT INTO omni_graph_query_telemetry (
            tenant_id, id, owner_actor_id, access_scope_sha256,
            correlation_id, query_kind, status, primary_adapter_id,
            shadow_adapter_id, shadow_state, max_hops, requested_limit,
            entity_count, alias_count, relation_candidate_count,
            relation_limit_saturated, authorized_relation_count,
            rejected_relation_count, path_count, total_duration_ms,
            recorded_at, contract, telemetry_sha256
          ) VALUES (
            ${telemetry.tenantId}, ${telemetry.telemetryId},
            ${telemetry.ownerActorId}, ${telemetry.accessScopeSha256},
            ${telemetry.correlationId}, ${telemetry.queryKind},
            ${telemetry.status}, ${telemetry.primaryAdapterId},
            ${telemetry.shadowAdapterId}, ${telemetry.shadowState},
            ${telemetry.maxHops}, ${telemetry.requestedLimit},
            ${telemetry.entityCount}, ${telemetry.aliasCount},
            ${telemetry.relationCandidateCount},
            ${telemetry.relationLimitSaturated},
            ${telemetry.authorizedRelationCount},
            ${telemetry.rejectedRelationCount}, ${telemetry.pathCount},
            ${telemetry.totalDurationMs}, ${telemetry.recordedAt},
            ${telemetry}::jsonb, ${telemetry.telemetrySha256}
          )
          ON CONFLICT (tenant_id, id) DO NOTHING
          RETURNING id
        `;
        const stored = rows[0]
          ? telemetry
          : await loadTelemetry(sql, telemetry.tenantId, telemetry.telemetryId);
        if (stored?.telemetrySha256 !== telemetry.telemetrySha256) {
          throw new Error("Graph query telemetry identity conflict.");
        }
        if (rows[0]) await appendTelemetryEvent(telemetry, scope, sql);
        return stored!;
      }) as Promise<GraphQueryTelemetry>,
    );
  }

  let created = false;
  let stored: GraphQueryTelemetry | undefined;
  await updateJsonFile<GraphQueryTelemetryLedger>(
    getTelemetryFile(),
    emptyLedger,
    (ledger) => {
      const existing = ledger.samples.find((sample) =>
        sample.tenantId === telemetry.tenantId &&
        sample.telemetryId === telemetry.telemetryId
      );
      if (existing) {
        stored = parseGraphQueryTelemetry(existing);
        if (stored.telemetrySha256 !== telemetry.telemetrySha256) {
          throw new Error("Graph query telemetry identity conflict.");
        }
        return ledger;
      }
      created = true;
      stored = telemetry;
      return {
        schemaVersion: 1,
        samples: [...ledger.samples, telemetry].slice(-5_000),
      };
    },
  );
  if (created) await appendTelemetryEvent(telemetry, scope);
  return stored!;
}

export async function recordGraphQueryTelemetrySafely(
  input: Parameters<typeof recordGraphQueryTelemetry>[0],
) {
  try {
    return await recordGraphQueryTelemetry(input);
  } catch (error) {
    console.warn(
      "Graph query telemetry write failed.",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

export async function getGraphStorageDecisionReport(input: {
  accessBinding: EntityAccessBinding;
  executionScope: ExecutionScope;
  windowHours?: number;
  sampleLimit?: number;
}) {
  const binding = parseEntityAccessBinding(input.accessBinding);
  const scope = assertTelemetryScope(input.executionScope, binding);
  const windowHours = Math.min(Math.max(Math.round(input.windowHours || 168), 1), 720);
  const sampleLimit = Math.min(Math.max(Math.round(input.sampleLimit || 2_000), 1), 5_000);
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  let samples: GraphQueryTelemetry[];
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    samples = await runWithDatabaseActorScope(
      binding.tenantId,
      [binding.ownerActorId],
      async () => {
        const rows = await getSql()`
          SELECT contract
          FROM omni_graph_query_telemetry
          WHERE tenant_id = ${binding.tenantId}
            AND owner_actor_id = ${binding.ownerActorId}
            AND access_scope_sha256 = ${binding.accessScopeSha256}
            AND recorded_at >= ${since}::TIMESTAMPTZ
          ORDER BY recorded_at DESC, id COLLATE "C"
          LIMIT ${sampleLimit}
        `;
        return rows.map((row) => parseGraphQueryTelemetry(row.contract));
      },
    );
  } else {
    const ledger = await readJsonFile<GraphQueryTelemetryLedger>(
      getTelemetryFile(),
      emptyLedger,
    );
    samples = ledger.samples.map(parseGraphQueryTelemetry).filter((sample) =>
      sample.tenantId === binding.tenantId &&
      sample.ownerActorId === binding.ownerActorId &&
      sample.accessScopeSha256 === binding.accessScopeSha256 &&
      sample.recordedAt >= since
    ).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
      .slice(0, sampleLimit);
  }
  return summarizeGraphQueryTelemetry(samples, {
    windowHours,
    generatedAt: new Date().toISOString(),
    primaryAdapterId: samples[0]?.primaryAdapterId || "postgres-temporal-graph:1",
    correlationId: scope.correlationId,
  });
}

export function summarizeGraphQueryTelemetry(
  samples: readonly GraphQueryTelemetry[],
  input: {
    windowHours: number;
    generatedAt: string;
    primaryAdapterId: string;
    correlationId?: string;
  },
) {
  const primaryAdapterId = adapterIdSchema.parse(input.primaryAdapterId);
  const allParsed = samples.map(parseGraphQueryTelemetry);
  const parsed = allParsed.filter((sample) =>
    sample.primaryAdapterId === primaryAdapterId
  );
  const successful = parsed.filter((sample) => sample.status === "succeeded");
  const durations = successful.map((sample) => sample.totalDurationMs);
  const storageDurations = successful.map((sample) =>
    sample.primaryStorageDurationMs
  );
  const saturated = successful.filter((sample) =>
    sample.relationLimitSaturated
  ).length;
  const shadowGroups = new Map<string, GraphQueryTelemetry[]>();
  for (const sample of parsed) {
    if (!sample.shadowAdapterId) continue;
    const group = shadowGroups.get(sample.shadowAdapterId) || [];
    group.push(sample);
    shadowGroups.set(sample.shadowAdapterId, group);
  }
  const selectedShadow = [...shadowGroups.entries()].sort((left, right) =>
    right[1].length - left[1].length || left[0].localeCompare(right[0])
  )[0];
  const shadowCandidateAdapterId = selectedShadow?.[0] || null;
  const shadowSamples = selectedShadow?.[1] || [];
  const shadowMatches = shadowSamples.filter((sample) =>
    sample.shadowState === "matched"
  ).length;
  const shadowMismatches = shadowSamples.filter((sample) =>
    sample.shadowState === "mismatched"
  ).length;
  const shadowFailures = shadowSamples.filter((sample) =>
    sample.shadowState === "failed"
  ).length;
  const saturationBasisPoints = ratioBasisPoints(saturated, successful.length);
  const shadowParityBasisPoints = ratioBasisPoints(
    shadowMatches,
    shadowSamples.length,
  );
  const p95DurationMs = percentile(durations, 0.95);
  const p95StorageDurationMs = percentile(storageDurations, 0.95);
  const maxEntityCount = Math.max(0, ...successful.map((sample) =>
    sample.entityCount
  ));
  const enoughSamples = successful.length >=
    GRAPH_STORAGE_DECISION_THRESHOLDS.minimumQuerySamples;
  const scalePressure =
    p95DurationMs >= GRAPH_STORAGE_DECISION_THRESHOLDS.p95DurationMs ||
    maxEntityCount >= GRAPH_STORAGE_DECISION_THRESHOLDS.entityCount ||
    saturationBasisPoints >=
      GRAPH_STORAGE_DECISION_THRESHOLDS.relationLimitSaturationBasisPoints;
  const scaleJustifiesShadowEvaluation = enoughSamples && scalePressure;
  const shadowPromotionReady =
    scaleJustifiesShadowEvaluation &&
    shadowSamples.length >=
      GRAPH_STORAGE_DECISION_THRESHOLDS.minimumShadowSamples &&
    shadowParityBasisPoints ===
      GRAPH_STORAGE_DECISION_THRESHOLDS.requiredShadowParityBasisPoints &&
    shadowMismatches === 0 &&
    shadowFailures === 0;
  const disposition = !enoughSamples
    ? "collect_more_telemetry" as const
    : !scalePressure
      ? "retain_postgres" as const
      : shadowPromotionReady
        ? "eligible_for_reviewed_promotion" as const
        : "evaluate_shadow_adapter" as const;
  const body = {
    schemaVersion: 1 as const,
    policyVersion: GRAPH_STORAGE_DECISION_POLICY_VERSION,
    generatedAt: canonicalTimestamp(input.generatedAt),
    windowHours: Math.min(Math.max(Math.round(input.windowHours), 1), 720),
    primaryAdapterId,
    sampleCount: parsed.length,
    excludedOtherPrimarySampleCount: allParsed.length - parsed.length,
    successfulSampleCount: successful.length,
    failedSampleCount: parsed.length - successful.length,
    p95DurationMs,
    p95StorageDurationMs,
    maxDurationMs: Math.max(0, ...durations),
    maxEntityCount,
    maxAliasCount: Math.max(0, ...successful.map((sample) => sample.aliasCount)),
    maxRelationCandidateCount: Math.max(
      0,
      ...successful.map((sample) => sample.relationCandidateCount),
    ),
    relationLimitSaturationBasisPoints: saturationBasisPoints,
    observedShadowAdapterCount: shadowGroups.size,
    shadowCandidateAdapterId,
    shadowSampleCount: shadowSamples.length,
    shadowMatchCount: shadowMatches,
    shadowMismatchCount: shadowMismatches,
    shadowFailureCount: shadowFailures,
    shadowParityBasisPoints,
    thresholds: GRAPH_STORAGE_DECISION_THRESHOLDS,
    scaleJustifiesShadowEvaluation,
    shadowPromotionReady,
    disposition,
  };
  return deepFreeze({
    ...body,
    reportSha256: sourceContractSha256(body),
  });
}

export type GraphStorageDecisionReport = ReturnType<
  typeof summarizeGraphQueryTelemetry
>;

async function appendTelemetryEvent(
  telemetry: GraphQueryTelemetry,
  executionScope: ExecutionScope,
  sql?: GraphTelemetrySqlClient,
) {
  return appendScopedDomainEvent({
    id: `graph-query-measured:${telemetry.telemetrySha256}`,
    streamId: `graph-query-telemetry:${telemetry.ownerActorId}`,
    type: "graph.query.measured",
    executionScope,
    payload: {
      schemaVersion: 1,
      telemetryId: telemetry.telemetryId,
      telemetrySha256: telemetry.telemetrySha256,
      status: telemetry.status,
      primaryAdapterId: telemetry.primaryAdapterId,
      shadowState: telemetry.shadowState,
      maxHops: telemetry.maxHops,
      entityCount: telemetry.entityCount,
      relationCandidateCount: telemetry.relationCandidateCount,
      relationLimitSaturated: telemetry.relationLimitSaturated,
      pathCount: telemetry.pathCount,
      totalDurationMs: telemetry.totalDurationMs,
    },
  }, sql ? { sql } : {});
}

async function loadTelemetry(
  sql: GraphTelemetrySqlClient,
  tenantId: string,
  telemetryId: string,
) {
  const rows = await sql`
    SELECT contract
    FROM omni_graph_query_telemetry
    WHERE tenant_id = ${tenantId} AND id = ${telemetryId}
    LIMIT 1
  `;
  return rows[0] ? parseGraphQueryTelemetry(rows[0].contract) : undefined;
}

function assertTelemetryScope(
  value: ExecutionScope,
  binding: Pick<
    EntityAccessBinding,
    "tenantId" | "ownerActorId" | "workspaceId" | "projectId" | "missionId"
  >,
) {
  const scope = parsePersistedExecutionScope(value);
  if (
    !scope?.initiatingActorId ||
    scope.tenantId !== binding.tenantId ||
    scope.initiatingActorId !== binding.ownerActorId ||
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== binding.ownerActorId ||
    scope.workspaceId !== binding.workspaceId ||
    scope.projectId !== binding.projectId ||
    scope.missionId !== binding.missionId ||
    scope.purpose !== "entity.read.v1"
  ) {
    throw new Error("Graph query telemetry requires one exact user scope.");
  }
  return scope as ExecutionScope & { initiatingActorId: string };
}

function percentile(values: readonly number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function ratioBasisPoints(numerator: number, denominator: number) {
  return denominator > 0
    ? Math.round((numerator * 10_000) / denominator)
    : 0;
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Graph query telemetry timestamp is invalid.");
  }
  return parsed.toISOString();
}

function getTelemetryFile() {
  return getDataPath("graph-query-telemetry.json");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
