import "server-only";

import { createHash } from "node:crypto";
import {
  APP_BUILDER_CONTRACT_VERSION,
  APP_BUILDER_TEMPLATE_ID,
  appBuilderSessionStatusSchema,
  type AppBuilderActivity,
  type AppBuilderSession,
  type AppBuilderSessionStatus,
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
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    ...(row.stopped_at ? { stoppedAt: new Date(String(row.stopped_at)).toISOString() } : {}),
  });
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

function requireBuilderDatabase() {
  if (!hasDatabaseUrl()) throw new Error("App Builder requires the configured project database.");
}
