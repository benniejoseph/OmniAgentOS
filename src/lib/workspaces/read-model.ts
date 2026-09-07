import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import type { CanonicalStatus } from "@/lib/status/canonical";
import {
  parseCanonicalWorkItemV1,
  type CanonicalWorkItemV1,
} from "@/lib/workspaces/contracts";
import {
  canonicalWorkItemSurfaceSchema,
  CANONICAL_WORK_ITEM_SURFACE_VERSION,
  type CanonicalWorkItemSurface,
} from "@/lib/workspaces/surface";

export const CANONICAL_WORK_ITEM_READ_SCHEMA_VERSION = 1 as const;

export type CanonicalWorkItemSourceAuthority =
  | "legacy_project_task"
  | "legacy_mission"
  | "legacy_mission_task";

export type CanonicalWorkItemStatusView = CanonicalWorkItemSurface["status"];

export type CanonicalWorkItemStatusFallback = Readonly<{
  projectId: string;
  workItemId: string;
  kind: "task" | "milestone";
  sourceId: string;
  status: CanonicalStatus;
  sourceStatus: string;
  updatedAt: string;
}>;

export type CanonicalWorkItemSurfaceFallback =
  CanonicalWorkItemStatusFallback & Readonly<{
    assignedAgents?: readonly Readonly<{
      agentId: string;
      principalId?: string | null;
      principalGeneration?: number | null;
    }>[];
    artifacts?: readonly Readonly<{
      artifactId: string;
      kind: string;
      evidenceRefIds?: readonly string[];
    }>[];
    workflowRunId?: string;
    workflowSourceStatus?: RuntimeFacts["sourceStatus"];
    allowCompatibilityFallback?: boolean;
  }>;

type RuntimeFacts = Readonly<{
  availability: "not_started" | "current" | "unavailable";
  workflowRunId: string | null;
  sourceStatus:
    | "queued"
    | "running"
    | "waiting_approval"
    | "paused"
    | "completed"
    | "failed"
    | "canceled"
    | null;
  currentStep: string | null;
  completedSteps: number;
  totalSteps: number;
  progressPercent: number | null;
  updatedAt: string | null;
  usageReceiptCount: number;
  unknownCostReceiptCount: number;
  totalTokens: number;
  knownEstimatedCostMicrousd: number;
}>;

export async function canonicalWorkItemStatuses(
  tenantId: string,
  sourceAuthority: CanonicalWorkItemSourceAuthority,
  fallbacks: readonly CanonicalWorkItemStatusFallback[],
) {
  const surfaces = await canonicalWorkItemSurfaces(
    tenantId,
    sourceAuthority,
    fallbacks,
  );
  return new Map(
    [...surfaces].map(([sourceId, surface]) => [sourceId, surface.status]),
  );
}

export async function canonicalWorkItemSurfaces(
  tenantId: string,
  sourceAuthority: CanonicalWorkItemSourceAuthority,
  fallbacks: readonly CanonicalWorkItemSurfaceFallback[],
) {
  const unique = uniqueFallbacks(fallbacks);
  if (!unique.length) return new Map<string, CanonicalWorkItemSurface>();
  if (!hasDatabaseUrl()) {
    return new Map(unique.map((fallback) => [
      fallback.sourceId,
      buildSurface({
        sourceAuthority,
        fallback,
        projection: localProjection(sourceAuthority, fallback),
        persistence: "local_projection",
        projectionSha256: null,
        sourceRevisionSha256: null,
        runtime: localRuntime(fallback),
      }),
    ]));
  }

  await ensureDatabaseSchema();
  const sourceIds = unique.map((item) => item.sourceId);
  const rows = await getSql()`
    SELECT
      source_id,
      workspace_id,
      project_id,
      work_item_id,
      kind,
      canonical_status,
      source_status,
      status_revision,
      updated_at,
      source_revision_sha256,
      projection_sha256,
      projection
    FROM omni_work_items
    WHERE tenant_id = ${tenantId}
      AND source_authority = ${sourceAuthority}
      AND source_id = ANY(${sourceIds}::TEXT[])
    ORDER BY source_id ASC
  `;
  const projections = new Map<string, {
    projection: CanonicalWorkItemV1;
    projectionSha256: string;
    sourceRevisionSha256: string;
  }>();
  for (const row of rows) {
    const projection = parseCanonicalWorkItemV1(row.projection);
    const sourceId = String(row.source_id || "");
    if (
      projection.tenantId !== tenantId ||
      projection.sourceAuthority !== sourceAuthority ||
      projection.projectId !== String(row.project_id || "") ||
      projection.workItemId !== String(row.work_item_id || "") ||
      projection.kind !== String(row.kind || "") ||
      projection.canonicalStatus !== String(row.canonical_status || "") ||
      projection.sourceStatus !== String(row.source_status || "") ||
      projection.statusRevision !== Number(row.status_revision)
    ) {
      throw new Error(`Canonical WorkItem projection drifted for ${sourceAuthority}:${sourceId}.`);
    }
    if (projections.has(sourceId)) {
      throw new Error(`Canonical WorkItem source is ambiguous for ${sourceAuthority}:${sourceId}.`);
    }
    projections.set(sourceId, {
      projection,
      projectionSha256: String(row.projection_sha256 || ""),
      sourceRevisionSha256: String(row.source_revision_sha256 || ""),
    });
  }
  const missing = unique.filter((fallback) => !projections.has(fallback.sourceId));
  const hardMissing = missing.filter((fallback) => !fallback.allowCompatibilityFallback);
  if (hardMissing.length) {
    throw new Error(
      `Canonical WorkItem projection is missing for ${sourceAuthority}:${hardMissing.map((item) => item.sourceId).join(",")}.`,
    );
  }

  const runtimeBySourceId = await loadRuntimeFacts(tenantId, unique);
  return new Map(unique.map((fallback) => {
    const stored = projections.get(fallback.sourceId);
    if (!stored) {
      return [fallback.sourceId, buildSurface({
        sourceAuthority,
        fallback,
        projection: localProjection(sourceAuthority, fallback),
        persistence: "local_projection",
        projectionSha256: null,
        sourceRevisionSha256: null,
        runtime: localRuntime(fallback, true),
      })];
    }
    return [fallback.sourceId, buildSurface({
      sourceAuthority,
      fallback,
      projection: stored.projection,
      persistence: "postgres",
      projectionSha256: stored.projectionSha256,
      sourceRevisionSha256: stored.sourceRevisionSha256,
      runtime: runtimeBySourceId.get(fallback.sourceId) || localRuntime(fallback, true),
    })];
  }));
}

async function loadRuntimeFacts(
  tenantId: string,
  fallbacks: readonly CanonicalWorkItemSurfaceFallback[],
) {
  const withRuns = fallbacks.filter((item) => item.workflowRunId);
  if (!withRuns.length) return new Map<string, RuntimeFacts>();
  const runIds = [...new Set(withRuns.map((item) => item.workflowRunId!))];
  const streamIds = runIds.map((id) => `workflow:${id}`);
  const rows = await getSql()`
    WITH step_rollup AS (
      SELECT
        workflow_run_id,
        COUNT(*)::BIGINT AS total_steps,
        COUNT(*) FILTER (
          WHERE status IN ('completed', 'skipped')
        )::BIGINT AS completed_steps
      FROM omni_workflow_steps
      WHERE workflow_run_id = ANY(${runIds}::TEXT[])
      GROUP BY workflow_run_id
    ), usage_rollup AS (
      SELECT
        source_stream_id,
        COUNT(*)::BIGINT AS usage_receipt_count,
        COUNT(*) FILTER (
          WHERE estimated_cost_microusd IS NULL
        )::BIGINT AS unknown_cost_receipt_count,
        COALESCE(SUM(estimated_cost_microusd), 0)::BIGINT
          AS known_estimated_cost_microusd,
        COALESCE(SUM(
          CASE
            WHEN jsonb_typeof(usage -> 'totalTokens') = 'number'
              THEN (usage ->> 'totalTokens')::BIGINT
            ELSE
              COALESCE((usage ->> 'inputTokens')::BIGINT, 0) +
              COALESCE((usage ->> 'outputTokens')::BIGINT, 0)
          END
        ), 0)::BIGINT AS total_tokens
      FROM omni_ai_usage
      WHERE tenant_id = ${tenantId}
        AND source_stream_id = ANY(${streamIds}::TEXT[])
      GROUP BY source_stream_id
    )
    SELECT
      run.id,
      run.status,
      run.current_step,
      run.input,
      run.updated_at,
      COALESCE(steps.completed_steps, 0) AS completed_steps,
      COALESCE(steps.total_steps, 0) AS total_steps,
      COALESCE(usage.usage_receipt_count, 0) AS usage_receipt_count,
      COALESCE(usage.unknown_cost_receipt_count, 0) AS unknown_cost_receipt_count,
      COALESCE(usage.known_estimated_cost_microusd, 0)
        AS known_estimated_cost_microusd,
      COALESCE(usage.total_tokens, 0) AS total_tokens
    FROM omni_workflow_runs run
    LEFT JOIN step_rollup steps ON steps.workflow_run_id = run.id
    LEFT JOIN usage_rollup usage
      ON usage.source_stream_id = CONCAT('workflow:', run.id)
    WHERE run.tenant_id = ${tenantId}
      AND run.id = ANY(${runIds}::TEXT[])
  `;
  const rowsById = new Map(rows.map((row) => [String(row.id), row]));
  return new Map(withRuns.map((fallback) => {
    const row = rowsById.get(fallback.workflowRunId!);
    if (!row || !workflowBelongsToWorkItem(row.input, fallback)) {
      return [fallback.sourceId, localRuntime(fallback, true)];
    }
    const totalSteps = boundedCounter(row.total_steps);
    const completedSteps = Math.min(boundedCounter(row.completed_steps), totalSteps);
    return [fallback.sourceId, Object.freeze({
      availability: "current" as const,
      workflowRunId: fallback.workflowRunId!,
      sourceStatus: runtimeStatus(row.status),
      currentStep: optionalText(row.current_step),
      completedSteps,
      totalSteps,
      progressPercent: totalSteps
        ? Math.round((completedSteps / totalSteps) * 100)
        : null,
      updatedAt: new Date(String(row.updated_at)).toISOString(),
      usageReceiptCount: boundedCounter(row.usage_receipt_count),
      unknownCostReceiptCount: boundedCounter(row.unknown_cost_receipt_count),
      totalTokens: boundedCounter(row.total_tokens),
      knownEstimatedCostMicrousd: boundedCounter(row.known_estimated_cost_microusd),
    })];
  }));
}

function buildSurface(input: {
  sourceAuthority: CanonicalWorkItemSourceAuthority;
  fallback: CanonicalWorkItemSurfaceFallback;
  projection: CanonicalWorkItemV1;
  persistence: "postgres" | "local_projection";
  projectionSha256: string | null;
  sourceRevisionSha256: string | null;
  runtime: RuntimeFacts;
}) {
  const usageReceiptCount = input.runtime.usageReceiptCount;
  const unknownCostReceiptCount = input.runtime.unknownCostReceiptCount;
  const costState = usageReceiptCount === 0
    ? "not_recorded"
    : unknownCostReceiptCount === usageReceiptCount
      ? "unknown"
      : unknownCostReceiptCount > 0
        ? "partial"
        : "known";
  return Object.freeze(canonicalWorkItemSurfaceSchema.parse({
    version: CANONICAL_WORK_ITEM_SURFACE_VERSION,
    projection: {
      authority: "canonical_work_item_v1",
      sha256: input.projectionSha256,
      sourceRevisionSha256: input.sourceRevisionSha256,
    },
    status: {
      schemaVersion: CANONICAL_WORK_ITEM_READ_SCHEMA_VERSION,
      authority: "canonical_work_item_v1",
      persistence: input.persistence,
      workspaceId: input.persistence === "postgres"
        ? input.projection.workspaceId
        : null,
      projectId: input.projection.projectId,
      workItemId: input.projection.workItemId,
      kind: input.projection.kind,
      sourceAuthority: input.sourceAuthority,
      sourceId: input.fallback.sourceId,
      status: input.projection.canonicalStatus,
      sourceStatus: input.projection.sourceStatus,
      statusRevision: input.projection.statusRevision,
      updatedAt: input.projection.updatedAt,
    },
    assignment: {
      authority: "canonical_work_item_v1",
      agents: input.projection.assignedAgents,
    },
    artifacts: {
      authority: "canonical_work_item_v1",
      count: input.projection.artifacts.length,
      items: input.projection.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        evidenceCount: artifact.evidenceRefIds.length,
      })),
    },
    execution: {
      authority: "governed_workflow_v1",
      availability: input.runtime.availability,
      workflowRunId: input.runtime.workflowRunId,
      sourceStatus: input.runtime.sourceStatus,
      currentStep: input.runtime.currentStep,
      completedSteps: input.runtime.completedSteps,
      totalSteps: input.runtime.totalSteps,
      progressPercent: input.runtime.progressPercent,
      updatedAt: input.runtime.updatedAt,
    },
    cost: {
      authority: "ai_usage_ledger_v1",
      state: costState,
      usageReceiptCount,
      unknownCostReceiptCount,
      totalTokens: input.runtime.totalTokens,
      knownEstimatedCostMicrousd: input.runtime.knownEstimatedCostMicrousd,
    },
  }));
}

function localProjection(
  sourceAuthority: CanonicalWorkItemSourceAuthority,
  fallback: CanonicalWorkItemSurfaceFallback,
): CanonicalWorkItemV1 {
  return parseCanonicalWorkItemV1({
    schemaVersion: 1,
    tenantId: "local_projection",
    workspaceId: "workspace:local_projection",
    projectId: fallback.projectId,
    workItemId: fallback.workItemId,
    parentWorkItemId: null,
    kind: fallback.kind,
    title: "Local compatibility projection",
    detail: "",
    priority: "normal",
    canonicalStatus: fallback.status,
    sourceStatus: fallback.sourceStatus,
    statusRevision: 1,
    sourceAuthority,
    dependencyWorkItemIds: [],
    ownerActorIds: ["actor:00000000-0000-4000-8000-000000000000"],
    assignedAgents: (fallback.assignedAgents || []).map((assignment) => ({
      agentId: assignment.agentId,
      principalId: assignment.principalId || null,
      principalGeneration: assignment.principalGeneration || null,
    })),
    schedule: { startsAt: null, dueAt: null, timeZone: null },
    recurrence: null,
    risks: [],
    decisions: [],
    artifacts: (fallback.artifacts || []).map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      evidenceRefIds: [...(artifact.evidenceRefIds || [])].sort(),
    })),
    createdAt: fallback.updatedAt,
    updatedAt: fallback.updatedAt,
    terminalAt: ["unverified", "failed", "canceled", "succeeded"].includes(fallback.status)
      ? fallback.updatedAt
      : null,
  });
}

function localRuntime(
  fallback: CanonicalWorkItemSurfaceFallback,
  unavailable = false,
): RuntimeFacts {
  const workflowRunId = fallback.workflowRunId || null;
  return Object.freeze({
    availability: workflowRunId
      ? unavailable ? "unavailable" : "current"
      : "not_started",
    workflowRunId,
    sourceStatus: fallback.workflowSourceStatus || null,
    currentStep: null,
    completedSteps: 0,
    totalSteps: 0,
    progressPercent: null,
    updatedAt: workflowRunId ? fallback.updatedAt : null,
    usageReceiptCount: 0,
    unknownCostReceiptCount: 0,
    totalTokens: 0,
    knownEstimatedCostMicrousd: 0,
  });
}

function workflowBelongsToWorkItem(
  value: unknown,
  fallback: CanonicalWorkItemSurfaceFallback,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = (value as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return record.workItemId === fallback.workItemId ||
    record.projectTaskId === fallback.sourceId ||
    record.missionTaskId === fallback.sourceId;
}

function runtimeStatus(value: unknown): RuntimeFacts["sourceStatus"] {
  const status = String(value || "");
  return [
    "queued", "running", "waiting_approval", "paused",
    "completed", "failed", "canceled",
  ].includes(status) ? status as RuntimeFacts["sourceStatus"] : null;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : null;
}

function boundedCounter(value: unknown) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Canonical WorkItem runtime counter is invalid.");
  }
  return number;
}

function uniqueFallbacks<T extends CanonicalWorkItemStatusFallback>(
  fallbacks: readonly T[],
) {
  if (fallbacks.length > 500) {
    throw new Error("Canonical WorkItem reads are limited to 500 sources.");
  }
  const unique = new Map<string, T>();
  for (const fallback of fallbacks) {
    if (!fallback.sourceId.trim() || !fallback.workItemId.trim()) {
      throw new Error("Canonical WorkItem reads require exact source and work-item ids.");
    }
    const existing = unique.get(fallback.sourceId);
    if (existing && existing.workItemId !== fallback.workItemId) {
      throw new Error(`Canonical WorkItem fallback is ambiguous for ${fallback.sourceId}.`);
    }
    unique.set(fallback.sourceId, fallback);
  }
  return [...unique.values()];
}
