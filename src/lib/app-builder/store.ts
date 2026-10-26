import "server-only";

import { createHash } from "node:crypto";
import {
  APP_BUILDER_CHECKPOINT_CONTRACT_VERSION,
  APP_BUILDER_CONTRACT_VERSION,
  APP_BUILDER_TEMPLATE_ID,
  APP_BUILDER_VERIFICATION_CONTRACT_VERSION,
  appBuilderSessionStatusSchema,
  builderWorkspaceModeSchema,
  type AppBuilderWorkspaceMode,
  type AppBuilderActivity,
  type AppBuilderCheckpoint,
  type AppBuilderSession,
  type AppBuilderSessionStatus,
  type AppBuilderVerification,
} from "@/lib/app-builder/contracts";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { normalizeBuilderBrowserEvidence, normalizeBuilderVerificationChecks } from "@/lib/app-builder/verification";

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
  workspaceMode?: AppBuilderWorkspaceMode;
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
      detail: { templateId: APP_BUILDER_TEMPLATE_ID, workspaceMode: input.workspaceMode || "interactive" },
      eventKey: input.idempotencyKey,
    });
  }
  return { session: { ...session, workspaceMode: rows[0] ? input.workspaceMode || "interactive" : await getBuilderSessionWorkspaceMode(session, input) }, created: Boolean(rows[0]) };
}

/** The immutable server event owns this mode; candidate code cannot switch it in its Sandbox. */
export async function getBuilderSessionWorkspaceMode(session: AppBuilderSession, owner: BuilderOwner): Promise<AppBuilderWorkspaceMode> {
  if (session.tenantId !== owner.tenantId || session.ownerActorId !== owner.actorId) throw new Error("Builder workspace mode requires its exact owner.");
  requireBuilderDatabase();
  await ensureDatabaseSchema();
  return readBuilderSessionWorkspaceMode(getSql(), session, owner);
}
async function readBuilderSessionWorkspaceMode(sql: SqlClient, session: AppBuilderSession, owner: BuilderOwner): Promise<AppBuilderWorkspaceMode> {
  const rows = await sql`SELECT detail, payload_sha256 FROM omni_app_builder_events
    WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.actorId} AND session_id=${session.id}
      AND event_type='app_builder.session.provisioning_started' ORDER BY occurred_at ASC,id ASC LIMIT 2`;
  if (rows.length > 1) throw new Error("Builder workspace provisioning identity is ambiguous.");
  if (!rows.length) return "interactive"; // Sessions created before typed provisioning events retain their original behavior.
  const detail = asRecord(rows[0].detail);
  if (rows[0].payload_sha256 !== canonicalJsonSha256({ contractVersion: APP_BUILDER_CONTRACT_VERSION, sessionId: session.id, projectId: session.projectId, eventType: "app_builder.session.provisioning_started", detail })) throw new Error("Builder workspace provisioning evidence changed.");
  return builderWorkspaceModeSchema.parse(detail.workspaceMode ?? "interactive");
}

/** Rotate only an explicitly disposable engineering workspace. History and the
 * per-project session identity remain intact; transport retries cannot provision
 * the same replacement twice. Missing must mean a confirmed provider not-found. */
export async function resetSourceOnlyBuilderSessionRecord(input: BuilderOwner & {
  session: AppBuilderSession; expectedRevision: number; idempotencyKey: string;
  reason: "failed" | "stopped" | "sandbox_missing";
}): Promise<{ session: AppBuilderSession; reset: boolean }> {
  requireBuilderDatabase(); await ensureDatabaseSchema();
  if (input.session.tenantId !== input.tenantId || input.session.ownerActorId !== input.actorId ||
      !input.idempotencyKey.trim() || input.idempotencyKey.length > 512 || input.expectedRevision !== input.session.revision) throw new Error("Builder reprovision requires the exact owner, session revision and request identity.");
  const requestSha256 = canonicalJsonSha256({ tenantId: input.tenantId, actorId: input.actorId, sessionId: input.session.id, idempotencyKey: input.idempotencyKey });
  const inputSha256 = canonicalJsonSha256({ previousRevision: input.expectedRevision, previousSandboxName: input.session.sandboxName, reason: input.reason });
  return getSql().transaction(async (sql: SqlClient) => {
    const rows = await sql`SELECT * FROM omni_app_builder_sessions WHERE tenant_id=${input.tenantId} AND owner_actor_id=${input.actorId} AND project_id=${input.session.projectId} AND id=${input.session.id} FOR UPDATE`;
    if (rows.length !== 1) throw new Error("The engineering Builder session is unavailable.");
    const current = sessionFromRow(rows[0]);
    if (await readBuilderSessionWorkspaceMode(sql, current, input) !== "source_only") throw new Error("Interactive Builder workspaces cannot be automatically replaced.");
    const previous = await sql`SELECT detail,payload_sha256 FROM omni_app_builder_events WHERE tenant_id=${input.tenantId} AND owner_actor_id=${input.actorId} AND session_id=${current.id} AND event_type='app_builder.session.reprovisioning_started' AND detail->>'requestSha256'=${requestSha256} LIMIT 2`;
    if (previous.length) {
      const detail = asRecord(previous[0].detail);
      if (previous.length !== 1 || detail.inputSha256 !== inputSha256 || detail.nextSandboxName !== current.sandboxName || previous[0].payload_sha256 !== canonicalJsonSha256({ contractVersion: APP_BUILDER_CONTRACT_VERSION, sessionId: current.id, projectId: current.projectId, eventType: "app_builder.session.reprovisioning_started", detail })) throw new Error("Builder reprovision request no longer matches its immutable receipt.");
      return { session: { ...current, workspaceMode: "source_only" as const }, reset: false };
    }
    if (current.revision !== input.expectedRevision || current.sandboxName !== input.session.sandboxName ||
        (input.reason !== "sandbox_missing" && current.status !== input.reason)) throw new Error("Builder session changed before engineering workspace recovery.");
    const sandboxName = `asael-${canonicalJsonSha256({ requestSha256, inputSha256 }).slice(0, 28)}`;
    const changed = await sql`UPDATE omni_app_builder_sessions SET sandbox_name=${sandboxName},status='provisioning',revision=revision+1,current_checkpoint_id=NULL,last_error_code=NULL,stopped_at=NULL,updated_at=NOW() WHERE tenant_id=${input.tenantId} AND owner_actor_id=${input.actorId} AND project_id=${current.projectId} AND id=${current.id} AND revision=${input.expectedRevision} RETURNING *`;
    if (changed.length !== 1) throw new Error("Builder engineering workspace recovery lost its revision.");
    const session = { ...sessionFromRow(changed[0]), workspaceMode: "source_only" as const };
    await appendBuilderActivity({ owner: input, session, eventType: "app_builder.session.reprovisioning_started", eventKey: input.idempotencyKey,
      detail: { workspaceMode: "source_only", requestSha256, inputSha256, reason: input.reason, previousRevision: current.revision, previousSandboxName: current.sandboxName, nextSandboxName: sandboxName }, sql });
    return { session, reset: true };
  }) as Promise<{ session: AppBuilderSession; reset: boolean }>;
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

export async function recordBuilderWorkspaceReplacement(input: BuilderOwner & {
  session: AppBuilderSession;
  eventKey: string;
  detail: Record<string, unknown>;
}) {
  const rows = await getSql()`
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
    throw new Error("Builder session changed while the repository checkout was running. Refresh before retrying.");
  }
  const session = sessionFromRow(rows[0]);
  await appendBuilderActivity({
    owner: input,
    session,
    eventType: "app_builder.repository.checked_out",
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
  sql?: SqlClient;
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
  const sql = input.sql || getSql();
  const rows = await sql`
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
  return normalizeBuilderVerificationChecks(value);
}

function asBrowserEvidence(value: unknown): AppBuilderVerification["browserEvidence"] {
  return normalizeBuilderBrowserEvidence(value);
}

function requireBuilderDatabase() {
  if (!hasDatabaseUrl()) throw new Error("App Builder requires the configured project database.");
}
