import "server-only";

import { createHash } from "node:crypto";
import {
  APP_BUILDER_DEPLOYMENT_CONTRACT_VERSION,
  type AppBuilderDeployment,
} from "@/lib/app-builder/contracts";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import {
  createPendingBuilderReadinessEvidence,
  normalizeBuilderBrowserEvidence,
} from "@/lib/app-builder/verification";

type BuilderOwner = Readonly<{ tenantId: string; actorId: string }>;

const pendingLogs: AppBuilderDeployment["logs"] = { status: "pending", eventCount: 0 };
const pendingRoutes: AppBuilderDeployment["routeEvidence"] = { status: "pending", routes: [] };
const pendingBrowser = createPendingBuilderReadinessEvidence("preview");

export async function listBuilderDeployments(sessionId: string, owner: BuilderOwner, limit = 20) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_deployments
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `;
  return rows.map(deploymentFromRow);
}

export async function getBuilderDeployment(
  deploymentId: string,
  sessionId: string,
  owner: BuilderOwner,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_deployments
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
      AND id = ${deploymentId}
    LIMIT 1
  `;
  return rows[0] ? deploymentFromRow(rows[0]) : undefined;
}

export async function getBuilderDeploymentForIdempotency(input: BuilderOwner & {
  sessionId: string;
  idempotencyKey: string;
}) {
  return getBuilderDeployment(
    builderDeploymentId(input.tenantId, input.actorId, input.sessionId, input.idempotencyKey),
    input.sessionId,
    input,
  );
}

export async function beginBuilderDeployment(input: BuilderOwner & {
  projectId: string;
  sessionId: string;
  checkpointId: string;
  verificationId: string;
  repositoryDeliveryId?: string;
  commitSha?: string;
  workspaceSha256: string;
  fileManifestSha256: string;
  fileCount: number;
  byteCount: number;
  secretScanSha256: string;
  smokeRoutes: readonly string[];
  idempotencyKey: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const id = builderDeploymentId(input.tenantId, input.actorId, input.sessionId, input.idempotencyKey);
  const rows = await getSql()`
    INSERT INTO omni_app_builder_deployments (
      id, tenant_id, owner_actor_id, project_id, session_id, contract_version,
      checkpoint_id, verification_id, repository_delivery_id, commit_sha,
      workspace_sha256, file_manifest_sha256, file_count, byte_count,
      secret_scan_sha256, smoke_routes, status, logs, route_evidence, browser_evidence,
      created_at, updated_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.actorId}, ${input.projectId}, ${input.sessionId},
      ${APP_BUILDER_DEPLOYMENT_CONTRACT_VERSION}, ${input.checkpointId},
      ${input.verificationId}, ${input.repositoryDeliveryId || null}, ${input.commitSha || null},
      ${input.workspaceSha256}, ${input.fileManifestSha256}, ${input.fileCount},
      ${input.byteCount}, ${input.secretScanSha256}, ${input.smokeRoutes}, 'preparing', ${pendingLogs},
      ${pendingRoutes}, ${pendingBrowser}, NOW(), NOW()
    )
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING *
  `;
  if (rows[0]) return { deployment: deploymentFromRow(rows[0]), created: true };
  const existing = await getBuilderDeployment(id, input.sessionId, input);
  if (!existing) throw new Error("The Vercel preview deployment claim could not be recorded.");
  return { deployment: existing, created: false };
}

export async function queueBuilderDeployment(input: BuilderOwner & {
  deployment: AppBuilderDeployment;
  providerProjectId: string;
  providerDeploymentId: string;
  providerState: string;
  deploymentUrl: string;
}) {
  const rows = await getSql()`
    UPDATE omni_app_builder_deployments
    SET status = 'queued', provider_project_id = ${input.providerProjectId},
        provider_deployment_id = ${input.providerDeploymentId},
        provider_state = ${input.providerState}, deployment_url = ${input.deploymentUrl},
        failure_code = NULL, updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.deployment.id}
      AND status = 'preparing'
    RETURNING *
  `;
  if (!rows[0]) throw new Error("The Vercel preview deployment receipt could not be finalized.");
  return deploymentFromRow(rows[0]);
}

export async function updateBuilderDeploymentEvidence(input: BuilderOwner & {
  deployment: AppBuilderDeployment;
  status: AppBuilderDeployment["status"];
  providerState: string;
  logs?: AppBuilderDeployment["logs"];
  routeEvidence?: AppBuilderDeployment["routeEvidence"];
  browserEvidence?: AppBuilderDeployment["browserEvidence"];
}) {
  const rows = await getSql()`
    UPDATE omni_app_builder_deployments
    SET status = ${input.status}, provider_state = ${input.providerState},
        logs = ${input.logs || input.deployment.logs},
        route_evidence = ${input.routeEvidence || input.deployment.routeEvidence},
        browser_evidence = ${input.browserEvidence || input.deployment.browserEvidence},
        failure_code = NULL, updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.deployment.id}
      AND status IN ('queued', 'building', 'verifying', 'incomplete')
    RETURNING *
  `;
  if (rows[0]) return deploymentFromRow(rows[0]);
  const existing = await getBuilderDeployment(input.deployment.id, input.deployment.sessionId, input);
  if (!existing) throw new Error("The Vercel preview deployment was not found during refresh.");
  return existing;
}

export async function failBuilderDeployment(input: BuilderOwner & {
  deployment: AppBuilderDeployment;
  error: unknown;
  providerState?: string;
}) {
  const failureCode = `vercel_${createHash("sha256")
    .update(input.error instanceof Error ? input.error.message : "unknown")
    .digest("hex").slice(0, 12)}`;
  const rows = await getSql()`
    UPDATE omni_app_builder_deployments
    SET status = 'failed', provider_state = ${input.providerState || input.deployment.providerState || null},
        failure_code = ${failureCode}, updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.deployment.id}
      AND status IN ('preparing', 'queued', 'building', 'verifying', 'incomplete')
    RETURNING *
  `;
  return rows[0] ? deploymentFromRow(rows[0]) : input.deployment;
}

function builderDeploymentId(tenantId: string, actorId: string, sessionId: string, idempotencyKey: string) {
  return `app_build_deployment_${createHash("sha256")
    .update(`${APP_BUILDER_DEPLOYMENT_CONTRACT_VERSION}:${tenantId}:${actorId}:${sessionId}:${idempotencyKey}`)
    .digest("hex").slice(0, 48)}`;
}

function deploymentFromRow(row: Record<string, unknown>): AppBuilderDeployment {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    contractVersion: APP_BUILDER_DEPLOYMENT_CONTRACT_VERSION,
    checkpointId: String(row.checkpoint_id),
    verificationId: String(row.verification_id),
    repositoryDeliveryId: optionalString(row.repository_delivery_id),
    commitSha: optionalString(row.commit_sha),
    workspaceSha256: String(row.workspace_sha256),
    fileManifestSha256: String(row.file_manifest_sha256),
    fileCount: Number(row.file_count),
    byteCount: Number(row.byte_count),
    secretScanSha256: String(row.secret_scan_sha256),
    smokeRoutes: Array.isArray(row.smoke_routes) ? row.smoke_routes.map(String) : [],
    providerProjectId: optionalString(row.provider_project_id),
    providerDeploymentId: optionalString(row.provider_deployment_id),
    providerState: optionalString(row.provider_state),
    deploymentUrl: optionalString(row.deployment_url),
    status: String(row.status) as AppBuilderDeployment["status"],
    logs: asLogs(row.logs),
    routeEvidence: asRouteEvidence(row.route_evidence),
    browserEvidence: asBrowserEvidence(row.browser_evidence),
    failureCode: optionalString(row.failure_code),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function asLogs(value: unknown): AppBuilderDeployment["logs"] {
  const record = asRecord(value);
  return {
    status: String(record.status || "pending") as AppBuilderDeployment["logs"]["status"],
    ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
    eventCount: Number(record.eventCount || 0),
  };
}

function asRouteEvidence(value: unknown): AppBuilderDeployment["routeEvidence"] {
  const record = asRecord(value);
  return {
    status: String(record.status || "pending") as AppBuilderDeployment["routeEvidence"]["status"],
    routes: Array.isArray(record.routes)
      ? record.routes.filter((route): route is AppBuilderDeployment["routeEvidence"]["routes"][number] => Boolean(route && typeof route === "object"))
      : [],
  };
}

function asBrowserEvidence(value: unknown): AppBuilderDeployment["browserEvidence"] {
  return normalizeBuilderBrowserEvidence(value);
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
  if (!hasDatabaseUrl()) throw new Error("Vercel preview deployment requires durable database storage.");
}
