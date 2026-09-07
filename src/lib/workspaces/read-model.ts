import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import type { CanonicalStatus } from "@/lib/status/canonical";
import { parseCanonicalWorkItemV1 } from "@/lib/workspaces/contracts";

export const CANONICAL_WORK_ITEM_READ_SCHEMA_VERSION = 1 as const;

export type CanonicalWorkItemSourceAuthority =
  | "legacy_project_task"
  | "legacy_mission"
  | "legacy_mission_task";

export type CanonicalWorkItemStatusView = Readonly<{
  schemaVersion: typeof CANONICAL_WORK_ITEM_READ_SCHEMA_VERSION;
  authority: "canonical_work_item_v1";
  persistence: "postgres" | "local_projection";
  workspaceId: string | null;
  projectId: string;
  workItemId: string;
  kind: "task" | "milestone";
  sourceAuthority: CanonicalWorkItemSourceAuthority;
  sourceId: string;
  status: CanonicalStatus;
  sourceStatus: string;
  statusRevision: number;
  updatedAt: string;
}>;

export type CanonicalWorkItemStatusFallback = Readonly<{
  projectId: string;
  workItemId: string;
  kind: "task" | "milestone";
  sourceId: string;
  status: CanonicalStatus;
  sourceStatus: string;
  updatedAt: string;
}>;

export async function canonicalWorkItemStatuses(
  tenantId: string,
  sourceAuthority: CanonicalWorkItemSourceAuthority,
  fallbacks: readonly CanonicalWorkItemStatusFallback[],
) {
  const unique = uniqueFallbacks(fallbacks);
  if (!unique.length) return new Map<string, CanonicalWorkItemStatusView>();
  if (!hasDatabaseUrl()) {
    return new Map(unique.map((fallback) => [
      fallback.sourceId,
      localStatus(sourceAuthority, fallback),
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
      projection
    FROM omni_work_items
    WHERE tenant_id = ${tenantId}
      AND source_authority = ${sourceAuthority}
      AND source_id = ANY(${sourceIds}::TEXT[])
    ORDER BY source_id ASC
  `;
  const views = new Map<string, CanonicalWorkItemStatusView>();
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
    if (views.has(sourceId)) {
      throw new Error(`Canonical WorkItem source is ambiguous for ${sourceAuthority}:${sourceId}.`);
    }
    views.set(sourceId, Object.freeze({
      schemaVersion: CANONICAL_WORK_ITEM_READ_SCHEMA_VERSION,
      authority: "canonical_work_item_v1",
      persistence: "postgres",
      workspaceId: projection.workspaceId,
      projectId: projection.projectId,
      workItemId: projection.workItemId,
      kind: projection.kind,
      sourceAuthority,
      sourceId,
      status: projection.canonicalStatus,
      sourceStatus: projection.sourceStatus,
      statusRevision: projection.statusRevision,
      updatedAt: projection.updatedAt,
    }));
  }
  const missing = sourceIds.filter((sourceId) => !views.has(sourceId));
  if (missing.length) {
    throw new Error(
      `Canonical WorkItem projection is missing for ${sourceAuthority}:${missing.join(",")}.`,
    );
  }
  return views;
}

function localStatus(
  sourceAuthority: CanonicalWorkItemSourceAuthority,
  fallback: CanonicalWorkItemStatusFallback,
): CanonicalWorkItemStatusView {
  return Object.freeze({
    schemaVersion: CANONICAL_WORK_ITEM_READ_SCHEMA_VERSION,
    authority: "canonical_work_item_v1",
    persistence: "local_projection",
    workspaceId: null,
    projectId: fallback.projectId,
    workItemId: fallback.workItemId,
    kind: fallback.kind,
    sourceAuthority,
    sourceId: fallback.sourceId,
    status: fallback.status,
    sourceStatus: fallback.sourceStatus,
    statusRevision: 1,
    updatedAt: fallback.updatedAt,
  });
}

function uniqueFallbacks(fallbacks: readonly CanonicalWorkItemStatusFallback[]) {
  if (fallbacks.length > 500) {
    throw new Error("Canonical WorkItem reads are limited to 500 sources.");
  }
  const unique = new Map<string, CanonicalWorkItemStatusFallback>();
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
