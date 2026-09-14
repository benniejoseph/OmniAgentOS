import "server-only";

import { createHash } from "node:crypto";
import {
  APP_BUILDER_CHECKPOINT_CONTRACT_VERSION,
  APP_BUILDER_CONTRACT_VERSION,
  APP_BUILDER_TEMPLATE_ID,
  APP_BUILDER_VERIFICATION_CONTRACT_VERSION,
  appBuilderSessionStatusSchema,
  type AppBuilderActivity,
  type AppBuilderCheckpoint,
  type AppBuilderSession,
  type AppBuilderSessionStatus,
  type AppBuilderVerification,
} from "@/lib/app-builder/contracts";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type BuilderOwner = Readonly<{ tenantId: string; actorId: string }>;

export async function getProjectBuilderSession(projectId: string, owner: BuilderOwner) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_sessions
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND project_id = ${projectId}
    LIMIT 1
  `;
  return rows[0] ? sessionFromRow(rows[0]) : undefined;
}

export async function getBuilderSession(sessionId: string, projectId: string, owner: BuilderOwner) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_sessions
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND project_id = ${projectId}
      AND id = ${sessionId}
    LIMIT 1
  `;
  return rows[0] ? sessionFromRow(rows[0]) : undefined;
}

export async function createBuilderSessionRecord(input: BuilderOwner & {
  projectId: string;
  idempotencyKey: string;
}) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const digest = createHash("sha256")
    .update(`${APP_BUILDER_CONTRACT_VERSION}:${input.tenantId}:${input.actorId}:${input.projectId}:${input.idempotencyKey}`)
    .digest("hex");
  const id = `app_build_${digest.slice(0, 48)}`;
  const sandboxName = `asael-${digest.slice(0, 28)}`;
  const rows = await getSql()`
    INSERT INTO omni_app_builder_sessions (
      id, tenant_id, owner_actor_id, project_id, contract_version,
      template_id, sandbox_name, status, revision, created_at, updated_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.actorId}, ${input.projectId},
      ${APP_BUILDER_CONTRACT_VERSION}, ${APP_BUILDER_TEMPLATE_ID}, ${sandboxName},
      'provisioning', 1, NOW(), NOW()
    )
    ON CONFLICT (tenant_id, owner_actor_id, project_id) DO NOTHING
    RETURNING *
  `;
  const session = rows[0]
    ? sessionFromRow(rows[0])
    : await getProjectBuilderSession(input.projectId, input);
  if (!session) throw new Error("Builder session record could not be created.");
  if (rows[0]) {
    await appendBuilderActivity({
      owner: input,
      session,
      eventType: "app_builder.session.provisioning_started",
      detail: { templateId: APP_BUILDER_TEMPLATE_ID },
      eventKey: input.idempotencyKey,
    });
  }
  return { session, created: Boolean(rows[0]) };
}

export async function transitionBuilderSession(input: BuilderOwner & {
  session: AppBuilderSession;
  status: AppBuilderSessionStatus;
  lastErrorCode?: string;
  eventType: string;
  eventKey: string;
  detail?: Record<string, unknown>;
}) {
  const nextStatus = appBuilderSessionStatusSchema.parse(input.status);
  const stoppedAt = nextStatus === "stopped" ? new Date().toISOString() : null;
  const rows = await getSql()`
    UPDATE omni_app_builder_sessions
    SET status = ${nextStatus},
        revision = revision + 1,
        last_error_code = ${input.lastErrorCode || null},
        stopped_at = ${stoppedAt},
        updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND project_id = ${input.session.projectId}
      AND id = ${input.session.id}
      AND revision = ${input.session.revision}
    RETURNING *
  `;
  if (!rows[0]) throw new Error("Builder session changed while the operation was running. Refresh before retrying.");
  const session = sessionFromRow(rows[0]);
  await appendBuilderActivity({
    owner: input,
    session,
    eventType: input.eventType,
    detail: input.detail || {},
    eventKey: input.eventKey,
  });
  return session;
}

export async function recordBuilderActivity(input: BuilderOwner & {
  session: AppBuilderSession;
  eventType: string;
  detail: Record<string, unknown>;
  eventKey: string;
}) {
  return appendBuilderActivity({ owner: input, ...input });
}

export async function recordBuilderWorkspaceChange(input: BuilderOwner & {
  session: AppBuilderSession;
  eventKey: string;
  detail: Record<string, unknown>;
}) {
  let rows = await getSql()`
    UPDATE omni_app_builder_sessions
    SET current_checkpoint_id = NULL,
        revision = revision + 1,
        updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND project_id = ${input.session.projectId}
      AND id = ${input.session.id}
      AND revision = ${input.session.revision}
    RETURNING *
  `;
  if (!rows[0]) {
    rows = await getSql()`
      UPDATE omni_app_builder_sessions
      SET current_checkpoint_id = NULL,
          revision = revision + 1,
          updated_at = NOW()
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
        AND project_id = ${input.session.projectId}
        AND id = ${input.session.id}
      RETURNING *
    `;
  }
  if (!rows[0]) throw new Error("Builder workspace change could not be recorded.");
  const session = sessionFromRow(rows[0]);
  await appendBuilderActivity({
    owner: input,
    session,
    eventType: "app_builder.file.updated",
    eventKey: input.eventKey,
    detail: input.detail,
  });
  return session;
}

export async function listBuilderActivity(sessionId: string, owner: BuilderOwner, limit = 40) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const bounded = Math.min(Math.max(limit, 1), 100);
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_events
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${bounded}
  `;
  return rows.map(activityFromRow);
}

export async function getBuilderCheckpoint(
  checkpointId: string,
  sessionId: string,
  owner: BuilderOwner,
) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_checkpoints
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
      AND id = ${checkpointId}
    LIMIT 1
  `;
  return rows[0] ? checkpointFromRow(rows[0]) : undefined;
}

export async function getBuilderCheckpointForIdempotency(input: BuilderOwner & {
  sessionId: string;
  idempotencyKey: string;
}) {
  return getBuilderCheckpoint(
    checkpointId(input, input.idempotencyKey),
    input.sessionId,
    input,
  );
}

export async function listBuilderCheckpoints(
  sessionId: string,
  owner: BuilderOwner,
  limit = 20,
) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const bounded = Math.min(Math.max(limit, 1), 50);
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_checkpoints
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${bounded}
  `;
  return rows.map(checkpointFromRow);
}

export async function recordBuilderCheckpoint(input: BuilderOwner & {
  session: AppBuilderSession;
  idempotencyKey: string;
  providerSnapshotId: string;
  workspaceSha256: string;
  fileCount: number;
  snapshotBytes: number;
  reason: AppBuilderCheckpoint["reason"];
  label: string;
  sourceRunId?: string;
  expiresAt?: string;
}) {
  const id = checkpointId({ ...input, sessionId: input.session.id }, input.idempotencyKey);
  const rows = await getSql()`
    INSERT INTO omni_app_builder_checkpoints (
      id, tenant_id, owner_actor_id, project_id, session_id, contract_version,
      provider_snapshot_id, workspace_sha256, file_count, snapshot_bytes,
      reason, label, source_run_id, session_revision, created_at, expires_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.actorId}, ${input.session.projectId},
      ${input.session.id}, ${APP_BUILDER_CHECKPOINT_CONTRACT_VERSION},
      ${input.providerSnapshotId}, ${input.workspaceSha256}, ${input.fileCount},
      ${input.snapshotBytes}, ${input.reason}, ${input.label},
      ${input.sourceRunId || null}, ${input.session.revision}, NOW(),
      ${input.expiresAt || null}
    )
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING *
  `;
  const checkpoint = rows[0]
    ? checkpointFromRow(rows[0])
    : await getBuilderCheckpoint(id, input.session.id, input);
  if (!checkpoint) throw new Error("Builder checkpoint could not be recorded.");
  return checkpoint;
}

export async function setBuilderCurrentCheckpoint(input: BuilderOwner & {
  session: AppBuilderSession;
  checkpoint: AppBuilderCheckpoint;
  eventType: "app_builder.checkpoint.created" | "app_builder.checkpoint.restored";
  eventKey: string;
}) {
  const rows = await getSql()`
    UPDATE omni_app_builder_sessions
    SET current_checkpoint_id = ${input.checkpoint.id},
        revision = revision + 1,
        updated_at = NOW()
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND project_id = ${input.session.projectId}
      AND id = ${input.session.id}
      AND revision = ${input.session.revision}
    RETURNING *
  `;
  if (!rows[0]) throw new Error("Builder session changed while the checkpoint operation was running. Refresh before retrying.");
  const session = sessionFromRow(rows[0]);
  await appendBuilderActivity({
    owner: input,
    session,
    eventType: input.eventType,
    eventKey: input.eventKey,
    detail: {
      checkpointId: input.checkpoint.id,
      workspaceSha256: input.checkpoint.workspaceSha256,
      fileCount: input.checkpoint.fileCount,
      reason: input.checkpoint.reason,
      sourceRunId: input.checkpoint.sourceRunId || null,
    },
  });
  return session;
}

export async function getBuilderVerification(
  verificationId: string,
  sessionId: string,
  owner: BuilderOwner,
) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_verifications
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
      AND id = ${verificationId}
    LIMIT 1
  `;
  return rows[0] ? verificationFromRow(rows[0]) : undefined;
}

export async function getBuilderVerificationForIdempotency(input: BuilderOwner & {
  sessionId: string;
  idempotencyKey: string;
}) {
  return getBuilderVerification(
    builderVerificationId(input, input.idempotencyKey),
    input.sessionId,
    input,
  );
}

export async function listBuilderVerifications(
  sessionId: string,
  owner: BuilderOwner,
  limit = 10,
) {
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  const bounded = Math.min(Math.max(limit, 1), 30);
  const rows = await getSql()`
    SELECT * FROM omni_app_builder_verifications
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.actorId}
      AND session_id = ${sessionId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${bounded}
  `;
  return rows.map(verificationFromRow);
}

export async function recordBuilderVerification(input: BuilderOwner & {
  session: AppBuilderSession;
  checkpoint: AppBuilderCheckpoint;
  idempotencyKey: string;
  status: AppBuilderVerification["status"];
  checks: AppBuilderVerification["checks"];
  browserEvidence: AppBuilderVerification["browserEvidence"];
}) {
  const id = builderVerificationId({ ...input, sessionId: input.session.id }, input.idempotencyKey);
  const rows = await getSql()`
    INSERT INTO omni_app_builder_verifications (
      id, tenant_id, owner_actor_id, project_id, session_id, checkpoint_id,
      contract_version, workspace_sha256, status, checks, browser_evidence, created_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.actorId}, ${input.session.projectId},
      ${input.session.id}, ${input.checkpoint.id}, ${APP_BUILDER_VERIFICATION_CONTRACT_VERSION},
      ${input.checkpoint.workspaceSha256}, ${input.status}, ${input.checks},
      ${input.browserEvidence}, NOW()
    )
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING *
  `;
  const verification = rows[0]
    ? verificationFromRow(rows[0])
    : await getBuilderVerification(id, input.session.id, input);
  if (!verification) throw new Error("Builder verification could not be recorded.");
  return verification;
}

async function appendBuilderActivity(input: {
  owner: BuilderOwner;
  session: AppBuilderSession;
  eventType: string;
  detail: Record<string, unknown>;
  eventKey: string;
}) {
  const detail = JSON.parse(JSON.stringify(input.detail)) as Record<string, unknown>;
  const payloadSha256 = canonicalJsonSha256({
    contractVersion: APP_BUILDER_CONTRACT_VERSION,
    sessionId: input.session.id,
    projectId: input.session.projectId,
    eventType: input.eventType,
    detail,
  });
  const idDigest = createHash("sha256")
    .update(`${input.owner.tenantId}:${input.session.id}:${input.eventType}:${input.eventKey}:${payloadSha256}`)
    .digest("hex");
  const id = `app_build_event_${idDigest.slice(0, 48)}`;
  const rows = await getSql()`
    INSERT INTO omni_app_builder_events (
      id, tenant_id, owner_actor_id, session_id, event_type,
      detail, payload_sha256, occurred_at
    ) VALUES (
      ${id}, ${input.owner.tenantId}, ${input.owner.actorId}, ${input.session.id},
      ${input.eventType}, ${detail}, ${payloadSha256}, NOW()
    )
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING *
  `;
  return rows[0] ? activityFromRow(rows[0]) : undefined;
}

function sessionFromRow(row: Record<string, unknown>): AppBuilderSession {
  const status = appBuilderSessionStatusSchema.parse(String(row.status || ""));
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    projectId: String(row.project_id),
    contractVersion: APP_BUILDER_CONTRACT_VERSION,
    templateId: APP_BUILDER_TEMPLATE_ID,
    sandboxName: String(row.sandbox_name),
    status,
    revision: Number(row.revision),
    ...(row.current_checkpoint_id ? { currentCheckpointId: String(row.current_checkpoint_id) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    ...(row.stopped_at ? { stoppedAt: new Date(String(row.stopped_at)).toISOString() } : {}),
  });
}

function checkpointFromRow(row: Record<string, unknown>): AppBuilderCheckpoint {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    contractVersion: APP_BUILDER_CHECKPOINT_CONTRACT_VERSION,
    providerSnapshotId: String(row.provider_snapshot_id),
    workspaceSha256: String(row.workspace_sha256),
    fileCount: Number(row.file_count),
    snapshotBytes: Number(row.snapshot_bytes),
    reason: String(row.reason) as AppBuilderCheckpoint["reason"],
    label: String(row.label),
    ...(row.source_run_id ? { sourceRunId: String(row.source_run_id) } : {}),
    sessionRevision: Number(row.session_revision),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.expires_at ? { expiresAt: new Date(String(row.expires_at)).toISOString() } : {}),
  });
}

function verificationFromRow(row: Record<string, unknown>): AppBuilderVerification {
  return Object.freeze({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    checkpointId: String(row.checkpoint_id),
    contractVersion: APP_BUILDER_VERIFICATION_CONTRACT_VERSION,
    workspaceSha256: String(row.workspace_sha256),
    status: String(row.status) as AppBuilderVerification["status"],
    checks: asVerificationChecks(row.checks),
    browserEvidence: asBrowserEvidence(row.browser_evidence),
    createdAt: new Date(String(row.created_at)).toISOString(),
  });
}

function checkpointId(input: BuilderOwner & { sessionId: string }, idempotencyKey: string) {
  const digest = createHash("sha256")
    .update(`${APP_BUILDER_CHECKPOINT_CONTRACT_VERSION}:${input.tenantId}:${input.actorId}:${input.sessionId}:${idempotencyKey}`)
    .digest("hex");
  return `app_build_checkpoint_${digest.slice(0, 48)}`;
}

export function builderVerificationId(input: BuilderOwner & { sessionId: string }, idempotencyKey: string) {
  const digest = createHash("sha256")
    .update(`${APP_BUILDER_VERIFICATION_CONTRACT_VERSION}:${input.tenantId}:${input.actorId}:${input.sessionId}:${idempotencyKey}`)
    .digest("hex");
  return `app_build_verification_${digest.slice(0, 48)}`;
}

function activityFromRow(row: Record<string, unknown>): AppBuilderActivity {
  return Object.freeze({
    id: String(row.id),
    sessionId: String(row.session_id),
    eventType: String(row.event_type),
    detail: asRecord(row.detail),
    payloadSha256: String(row.payload_sha256),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asVerificationChecks(value: unknown): AppBuilderVerification["checks"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return Object.freeze({
      command: String(record.command) as "lint" | "typecheck",
      status: String(record.status) as "passed" | "failed",
      exitCode: Number(record.exitCode),
      durationMs: Number(record.durationMs),
      outputSha256: String(record.outputSha256),
    });
  });
}

function asBrowserEvidence(value: unknown): AppBuilderVerification["browserEvidence"] {
  const record = asRecord(value);
  const captures = Array.isArray(record.captures) ? record.captures.map((item) => {
    const capture = asRecord(item);
    return Object.freeze({
      viewport: String(capture.viewport) as "desktop" | "mobile",
      width: Number(capture.width),
      height: Number(capture.height),
      screenshotSha256: String(capture.screenshotSha256),
      mimeType: String(capture.mimeType),
      byteLength: Number(capture.byteLength),
    });
  }) : [];
  return Object.freeze({
    status: String(record.status) as AppBuilderVerification["browserEvidence"]["status"],
    captures,
    ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
  });
}

function requireBuilderDatabase() {
  if (!hasDatabaseUrl()) throw new Error("App Builder requires the configured project database.");
}
