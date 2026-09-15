import "server-only";

import { createHash } from "node:crypto";
import {
  APP_BUILDER_DELIVERY_CONTRACT_VERSION,
  APP_BUILDER_REPOSITORY_CONTRACT_VERSION,
  type AppBuilderDelivery,
  type AppBuilderRepository,
  type AppBuilderRepositoryBinding,
} from "@/lib/app-builder/contracts";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";

type BuilderOwner = Readonly<{ tenantId: string; actorId: string }>;

export async function getBuilderRepositoryBinding(sessionId: string, owner: BuilderOwner) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_repository_bindings
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
    LIMIT 1
  `;
  return rows[0] ? bindingFromRow(rows[0]) : undefined;
}

export async function getBuilderRepositoryBindingById(
  id: string,
  sessionId: string,
  owner: BuilderOwner,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_repository_bindings
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
      AND id = ${id}
    LIMIT 1
  `;
  return rows[0] ? bindingFromRow(rows[0]) : undefined;
}

export async function bindBuilderRepository(input: BuilderOwner & {
  projectId: string;
  sessionId: string;
  repository: AppBuilderRepository;
  baseSha: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const id = repositoryBindingId(input.tenantId, input.actorId, input.sessionId);
  const rows = await getSql()`
    INSERT INTO omni_app_builder_repository_bindings (
      id, tenant_id, owner_actor_id, project_id, session_id, contract_version,
      repository_id, repository_owner, repository_name, repository_full_name,
      is_private, default_branch, base_sha, revision, bound_at, updated_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.actorId}, ${input.projectId}, ${input.sessionId},
      ${APP_BUILDER_REPOSITORY_CONTRACT_VERSION}, ${input.repository.repositoryId},
      ${input.repository.owner}, ${input.repository.name}, ${input.repository.fullName},
      ${input.repository.private}, ${input.repository.defaultBranch}, ${input.baseSha},
      1, NOW(), NOW()
    )
    ON CONFLICT (tenant_id, owner_actor_id, session_id) DO UPDATE SET
      repository_id = EXCLUDED.repository_id,
      repository_owner = EXCLUDED.repository_owner,
      repository_name = EXCLUDED.repository_name,
      repository_full_name = EXCLUDED.repository_full_name,
      is_private = EXCLUDED.is_private,
      default_branch = EXCLUDED.default_branch,
      base_sha = EXCLUDED.base_sha,
      revision = omni_app_builder_repository_bindings.revision + 1,
      bound_at = NOW(),
      updated_at = NOW()
    RETURNING *
  `;
  if (!rows[0]) throw new Error("The GitHub repository binding could not be recorded.");
  return bindingFromRow(rows[0]);
}

export async function listBuilderDeliveries(sessionId: string, owner: BuilderOwner, limit = 20) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_deliveries
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `;
  return rows.map(deliveryFromRow);
}

export async function getBuilderDelivery(
  deliveryId: string,
  sessionId: string,
  owner: BuilderOwner,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_deliveries
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
      AND id = ${deliveryId}
    LIMIT 1
  `;
  return rows[0] ? deliveryFromRow(rows[0]) : undefined;
}

export async function getBuilderDeliveryForIdempotency(input: BuilderOwner & {
  sessionId: string;
  idempotencyKey: string;
}) {
  const id = deliveryId(input.tenantId, input.actorId, input.sessionId, input.idempotencyKey);
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_deliveries
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND session_id = ${input.sessionId}
      AND id = ${id}
    LIMIT 1
  `;
  return rows[0] ? deliveryFromRow(rows[0]) : undefined;
}

export async function beginBuilderDelivery(input: BuilderOwner & {
  projectId: string;
  sessionId: string;
  repositoryBindingId: string;
  checkpointId: string;
  verificationId: string;
  workspaceSha256: string;
  baseSha: string;
  branchName: string;
  secretScanSha256: string;
  secretFindingCount: number;
  idempotencyKey: string;
}) {
  const id = deliveryId(input.tenantId, input.actorId, input.sessionId, input.idempotencyKey);
  const rows = await getSql()`
    INSERT INTO omni_app_builder_deliveries (
      id, tenant_id, owner_actor_id, project_id, session_id, repository_binding_id,
      contract_version, checkpoint_id, verification_id, workspace_sha256, base_sha,
      branch_name, secret_scan_sha256, secret_finding_count, status, created_at, updated_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.actorId}, ${input.projectId}, ${input.sessionId},
      ${input.repositoryBindingId}, ${APP_BUILDER_DELIVERY_CONTRACT_VERSION},
      ${input.checkpointId}, ${input.verificationId}, ${input.workspaceSha256},
      ${input.baseSha}, ${input.branchName}, ${input.secretScanSha256},
      ${input.secretFindingCount}, 'preparing', NOW(), NOW()
    )
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING *
  `;
  if (rows[0]) return { delivery: deliveryFromRow(rows[0]), created: true };
  const existing = await getBuilderDeliveryForIdempotency(input);
  if (!existing) throw new Error("The GitHub delivery claim could not be recorded.");
  return { delivery: existing, created: false };
}

export async function completeBuilderDelivery(input: BuilderOwner & {
  delivery: AppBuilderDelivery;
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}) {
  const rows = await getSql()`
    UPDATE omni_app_builder_deliveries
    SET status = 'pull_request_open',
        commit_sha = ${input.commitSha},
        pull_request_number = ${input.pullRequestNumber},
        pull_request_url = ${input.pullRequestUrl},
        failure_code = NULL,
        updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.delivery.id}
      AND status = 'preparing'
    RETURNING *
  `;
  if (!rows[0]) throw new Error("The GitHub pull-request receipt could not be finalized.");
  return deliveryFromRow(rows[0]);
}

export async function failBuilderDelivery(input: BuilderOwner & {
  delivery: AppBuilderDelivery;
  error: unknown;
  commitSha?: string;
}) {
  const failureCode = `github_${createHash("sha256")
    .update(input.error instanceof Error ? input.error.message : "unknown")
    .digest("hex").slice(0, 12)}`;
  const rows = await getSql()`
    UPDATE omni_app_builder_deliveries
    SET status = 'failed', commit_sha = ${input.commitSha || null}, failure_code = ${failureCode}, updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND id = ${input.delivery.id}
      AND status = 'preparing'
    RETURNING *
  `;
  return rows[0] ? deliveryFromRow(rows[0]) : input.delivery;
}

function repositoryBindingId(tenantId: string, actorId: string, sessionId: string) {
  return `app_build_repository_${createHash("sha256")
    .update(`${APP_BUILDER_REPOSITORY_CONTRACT_VERSION}:${tenantId}:${actorId}:${sessionId}`)
    .digest("hex").slice(0, 48)}`;
}

function deliveryId(tenantId: string, actorId: string, sessionId: string, idempotencyKey: string) {
  return `app_build_delivery_${createHash("sha256")
    .update(`${APP_BUILDER_DELIVERY_CONTRACT_VERSION}:${tenantId}:${actorId}:${sessionId}:${idempotencyKey}`)
    .digest("hex").slice(0, 48)}`;
}

function bindingFromRow(row: Record<string, unknown>): AppBuilderRepositoryBinding {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), ownerActorId: String(row.owner_actor_id),
    projectId: String(row.project_id), sessionId: String(row.session_id),
    contractVersion: APP_BUILDER_REPOSITORY_CONTRACT_VERSION,
    repositoryId: String(row.repository_id), repositoryOwner: String(row.repository_owner),
    repositoryName: String(row.repository_name), repositoryFullName: String(row.repository_full_name),
    private: Boolean(row.is_private), defaultBranch: String(row.default_branch), baseSha: String(row.base_sha),
    revision: Number(row.revision), boundAt: dateValue(row.bound_at), updatedAt: dateValue(row.updated_at),
  };
}

function deliveryFromRow(row: Record<string, unknown>): AppBuilderDelivery {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), ownerActorId: String(row.owner_actor_id),
    projectId: String(row.project_id), sessionId: String(row.session_id),
    repositoryBindingId: String(row.repository_binding_id),
    contractVersion: APP_BUILDER_DELIVERY_CONTRACT_VERSION,
    checkpointId: String(row.checkpoint_id), verificationId: String(row.verification_id),
    workspaceSha256: String(row.workspace_sha256), baseSha: String(row.base_sha),
    branchName: String(row.branch_name), commitSha: optionalString(row.commit_sha),
    pullRequestNumber: row.pull_request_number === null || row.pull_request_number === undefined
      ? undefined : Number(row.pull_request_number),
    pullRequestUrl: optionalString(row.pull_request_url), secretScanSha256: String(row.secret_scan_sha256),
    secretFindingCount: Number(row.secret_finding_count),
    status: String(row.status) as AppBuilderDelivery["status"], failureCode: optionalString(row.failure_code),
    createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at),
  };
}

function optionalString(value: unknown) {
  return value === null || value === undefined || String(value) === "" ? undefined : String(value);
}

function dateValue(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new Error("GitHub delivery requires durable database storage.");
}
