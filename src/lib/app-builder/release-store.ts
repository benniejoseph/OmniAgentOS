import "server-only";

import { createHash } from "node:crypto";
import {
  APP_BUILDER_RELEASE_CONTRACT_VERSION,
  type AppBuilderDeployment,
  type AppBuilderRelease,
} from "@/lib/app-builder/contracts";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type BuilderOwner = Readonly<{ tenantId: string; actorId: string }>;
const pendingLogs: AppBuilderDeployment["logs"] = { status: "pending", eventCount: 0 };
const pendingRoutes: AppBuilderDeployment["routeEvidence"] = { status: "pending", routes: [] };
const pendingBrowser: AppBuilderDeployment["browserEvidence"] = { status: "pending", captures: [] };

export async function listBuilderReleases(sessionId: string, owner: BuilderOwner, limit = 20) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_releases
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `;
  return rows.map(releaseFromRow);
}

export async function getBuilderRelease(releaseId: string, sessionId: string, owner: BuilderOwner) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_releases
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
      AND id = ${releaseId}
    LIMIT 1
  `;
  return rows[0] ? releaseFromRow(rows[0]) : undefined;
}

export async function beginBuilderReleaseReview(input: BuilderOwner & {
  projectId: string;
  sessionId: string;
  deploymentId: string;
  previewProviderDeploymentId: string;
  workspaceSha256: string;
  previewEvidenceSha256: string;
  migrationEvidence: AppBuilderRelease["migrationEvidence"];
  rollbackEvidence: AppBuilderRelease["rollbackEvidence"];
  expiresAt: string;
  idempotencyKey: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const id = builderReleaseId(input.tenantId, input.actorId, input.sessionId, input.idempotencyKey);
  const releaseDigest = canonicalJsonSha256({
    contractVersion: APP_BUILDER_RELEASE_CONTRACT_VERSION,
    id,
    deploymentId: input.deploymentId,
    previewProviderDeploymentId: input.previewProviderDeploymentId,
    workspaceSha256: input.workspaceSha256,
    previewEvidenceSha256: input.previewEvidenceSha256,
    migrationEvidence: input.migrationEvidence,
    rollbackEvidence: input.rollbackEvidence,
    expiresAt: input.expiresAt,
  });
  const rows = await getSql()`
    INSERT INTO omni_app_builder_releases (
      id, tenant_id, owner_actor_id, project_id, session_id, deployment_id,
      contract_version, preview_provider_deployment_id, workspace_sha256,
      preview_evidence_sha256, release_digest, migration_evidence, rollback_evidence,
      status, logs, route_evidence, browser_evidence, created_at, updated_at, expires_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.actorId}, ${input.projectId}, ${input.sessionId},
      ${input.deploymentId}, ${APP_BUILDER_RELEASE_CONTRACT_VERSION},
      ${input.previewProviderDeploymentId}, ${input.workspaceSha256},
      ${input.previewEvidenceSha256}, ${releaseDigest}, ${input.migrationEvidence},
      ${input.rollbackEvidence}, 'review_pending', ${pendingLogs}, ${pendingRoutes},
      ${pendingBrowser}, NOW(), NOW(), ${input.expiresAt}
    )
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING *
  `;
  if (rows[0]) return { release: releaseFromRow(rows[0]), created: true };
  const existing = await getBuilderRelease(id, input.sessionId, input);
  if (!existing) throw new Error("The production release review could not be recorded.");
  return { release: existing, created: false };
}

export async function claimBuilderProductionRelease(input: BuilderOwner & {
  release: AppBuilderRelease;
  releaseDigest: string;
}) {
  const rows = await getSql()`
    UPDATE omni_app_builder_releases
    SET status = 'releasing', released_at = NOW(), updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.release.id}
      AND status = 'review_pending'
      AND release_digest = ${input.releaseDigest}
      AND expires_at > NOW()
    RETURNING *
  `;
  if (rows[0]) return releaseFromRow(rows[0]);
  const existing = await getBuilderRelease(input.release.id, input.release.sessionId, input);
  if (
    existing?.status === "releasing" && !existing.providerDeploymentId &&
    existing.releaseDigest === input.releaseDigest
  ) return existing;
  throw new Error("The production release review changed or expired. Prepare a fresh review before releasing.");
}

export async function queueBuilderProductionRelease(input: BuilderOwner & {
  release: AppBuilderRelease;
  providerProjectId: string;
  providerDeploymentId: string;
  providerState: string;
  deploymentUrl: string;
}) {
  const rows = await getSql()`
    UPDATE omni_app_builder_releases
    SET provider_project_id = ${input.providerProjectId},
        provider_deployment_id = ${input.providerDeploymentId},
        provider_state = ${input.providerState}, deployment_url = ${input.deploymentUrl},
        failure_code = NULL, updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.release.id}
      AND status = 'releasing'
      AND provider_deployment_id IS NULL
    RETURNING *
  `;
  if (!rows[0]) throw new Error("The production deployment receipt could not be finalized.");
  return releaseFromRow(rows[0]);
}

export async function updateBuilderReleaseEvidence(input: BuilderOwner & {
  release: AppBuilderRelease;
  status: AppBuilderRelease["status"];
  providerState: string;
  logs?: AppBuilderRelease["logs"];
  routeEvidence?: AppBuilderRelease["routeEvidence"];
  browserEvidence?: AppBuilderRelease["browserEvidence"];
}) {
  const rows = await getSql()`
    UPDATE omni_app_builder_releases
    SET status = ${input.status}, provider_state = ${input.providerState},
        logs = ${input.logs || input.release.logs},
        route_evidence = ${input.routeEvidence || input.release.routeEvidence},
        browser_evidence = ${input.browserEvidence || input.release.browserEvidence},
        failure_code = NULL, updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.release.id}
      AND status IN ('releasing', 'building', 'incomplete')
    RETURNING *
  `;
  if (rows[0]) return releaseFromRow(rows[0]);
  const existing = await getBuilderRelease(input.release.id, input.release.sessionId, input);
  if (!existing) throw new Error("The production release was not found during refresh.");
  return existing;
}

export async function expireBuilderRelease(input: BuilderOwner & { release: AppBuilderRelease }) {
  const rows = await getSql()`
    UPDATE omni_app_builder_releases
    SET status = 'expired', updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.release.id}
      AND status = 'review_pending'
      AND expires_at <= NOW()
    RETURNING *
  `;
  return rows[0] ? releaseFromRow(rows[0]) : input.release;
}

export async function failBuilderRelease(input: BuilderOwner & {
  release: AppBuilderRelease;
  error: unknown;
  providerState?: string;
}) {
  const failureCode = `release_${createHash("sha256")
    .update(input.error instanceof Error ? input.error.message : "unknown")
    .digest("hex").slice(0, 12)}`;
  const rows = await getSql()`
    UPDATE omni_app_builder_releases
    SET status = 'failed', provider_state = ${input.providerState || input.release.providerState || null},
        failure_code = ${failureCode}, updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.release.id}
      AND status IN ('review_pending', 'releasing', 'building', 'incomplete')
    RETURNING *
  `;
  return rows[0] ? releaseFromRow(rows[0]) : input.release;
}

function builderReleaseId(tenantId: string, actorId: string, sessionId: string, idempotencyKey: string) {
  return `app_build_release_${createHash("sha256")
    .update(`${APP_BUILDER_RELEASE_CONTRACT_VERSION}:${tenantId}:${actorId}:${sessionId}:${idempotencyKey}`)
    .digest("hex").slice(0, 48)}`;
}

function releaseFromRow(row: Record<string, unknown>): AppBuilderRelease {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), ownerActorId: String(row.owner_actor_id),
    projectId: String(row.project_id), sessionId: String(row.session_id), deploymentId: String(row.deployment_id),
    contractVersion: APP_BUILDER_RELEASE_CONTRACT_VERSION,
    previewProviderDeploymentId: String(row.preview_provider_deployment_id),
    workspaceSha256: String(row.workspace_sha256), previewEvidenceSha256: String(row.preview_evidence_sha256),
    releaseDigest: String(row.release_digest),
    migrationEvidence: asRecord(row.migration_evidence) as AppBuilderRelease["migrationEvidence"],
    rollbackEvidence: asRecord(row.rollback_evidence) as AppBuilderRelease["rollbackEvidence"],
    status: String(row.status) as AppBuilderRelease["status"],
    providerProjectId: optionalString(row.provider_project_id), providerDeploymentId: optionalString(row.provider_deployment_id),
    providerState: optionalString(row.provider_state), deploymentUrl: optionalString(row.deployment_url),
    logs: asRecord(row.logs) as AppBuilderRelease["logs"],
    routeEvidence: asRecord(row.route_evidence) as AppBuilderRelease["routeEvidence"],
    browserEvidence: asRecord(row.browser_evidence) as AppBuilderRelease["browserEvidence"],
    failureCode: optionalString(row.failure_code), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at),
    expiresAt: dateValue(row.expires_at), releasedAt: row.released_at ? dateValue(row.released_at) : undefined,
  };
}

function asRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function optionalString(value: unknown) {
  return value === null || value === undefined || String(value) === "" ? undefined : String(value);
}

function dateValue(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new Error("Production release review requires durable database storage.");
}
