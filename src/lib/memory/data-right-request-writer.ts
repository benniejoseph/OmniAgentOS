import { createHash } from "node:crypto";
import { z } from "zod";

import { appendScopedDomainEvent, type DomainEvent } from "@/lib/events/store";
import {
  buildMemoryDataRightRequestEventV1,
  parseMemoryDataRightRequestRecordV1,
  type MemoryDataRightRequestRecordV1,
} from "@/lib/memory/data-right-request-contracts";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);

type SqlRow = Record<string, unknown>;

export type MemoryDataRightRequestWriterSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
  readonly transactionScoped: boolean;
};

export type RecordHeldMemoryDataRightRequestInputV1 = Readonly<{
  executionScope: ExecutionScope;
  request: unknown;
  governanceDecisionId: string;
}>;

export type RecordHeldMemoryDataRightRequestResultV1 = Readonly<{
  request: MemoryDataRightRequestRecordV1;
  event: DomainEvent;
  authorityGranted: false;
  runtimeAccepted: false;
}>;

/**
 * Persists one exact human export/forget request inside an existing
 * schema-owner system transaction. This module deliberately exposes no route,
 * database client, environment lookup, or transaction opener.
 *
 * The insert remains held under v64. It records user intent and metadata-only
 * event evidence, but cannot activate, consume, or authorize the request.
 */
export async function recordHeldMemoryDataRightRequestV1(
  input: RecordHeldMemoryDataRightRequestInputV1,
  sql: MemoryDataRightRequestWriterSql,
): Promise<RecordHeldMemoryDataRightRequestResultV1> {
  if (!sql.transactionScoped) {
    throw new Error(
      "Memory data-right request persistence requires an existing database transaction.",
    );
  }

  const executionScope = parsePersistedExecutionScope(input.executionScope);
  const request = parseMemoryDataRightRequestRecordV1(input.request);
  const governanceDecisionId = opaqueIdSchema.parse(input.governanceDecisionId);
  if (
    !executionScope ||
    !executionScope.initiatingActorId ||
    executionScope.tenantId !== request.tenantId ||
    executionScope.initiatingActorId !== request.subjectActorId ||
    executionScope.executingPrincipalType !== "user" ||
    executionScope.executingPrincipalId !== request.subjectActorId ||
    executionScope.purpose !== request.purposeId ||
    request.state !== "held" ||
    request.lifecycleRevision !== 0
  ) {
    throw new Error(
      "Memory data-right request persistence requires the exact held human request scope.",
    );
  }

  const preflightRows = await sql.query(
    `SELECT
       current_user = pg_get_userbyid(schema_relation.relowner) AS schema_owner,
       NULLIF(current_setting('omni.tenant_id', TRUE), '') AS tenant_id,
       public.omni_system_scope_enabled() AS system_scope,
       EXISTS (
         SELECT 1 FROM omni_schema_version
         WHERE version = 64
           AND name = 'tenant_memory_data_right_requests_shadow'
           AND checksum =
             '5a9480a12b1a3211bddc076fec7fa802f92080798efec56c6703435ee8b66525'
       ) AS request_schema_valid,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid =
           'omni_tenant_memory_data_right_requests'::regclass
           AND conname =
             'omni_memory_data_right_request_activation_hold_check'
           AND contype = 'c'
           AND convalidated
           AND pg_get_expr(conbin, conrelid) =
             '(state <> ALL (ARRAY[''active''::text, ''consumed''::text]))'
       ) AS activation_hold_valid,
       EXISTS (
         SELECT 1 FROM pg_class request_relation
         WHERE request_relation.oid =
           'omni_tenant_memory_data_right_requests'::regclass
           AND request_relation.relrowsecurity
           AND request_relation.relforcerowsecurity
       )
       AND (
         SELECT count(*) FROM pg_policy
         WHERE polrelid =
           'omni_tenant_memory_data_right_requests'::regclass
       ) = 2
       AND EXISTS (
         SELECT 1 FROM pg_policy
         WHERE polrelid =
           'omni_tenant_memory_data_right_requests'::regclass
           AND polname = 'omni_tenant_isolation'
           AND polpermissive
           AND polcmd = '*'
           AND polroles = ARRAY[0::OID]
           AND pg_get_expr(polqual, polrelid) =
             'omni_tenant_visible(tenant_id)'
           AND pg_get_expr(polwithcheck, polrelid) =
             'omni_tenant_visible(tenant_id)'
       )
       AND EXISTS (
         SELECT 1 FROM pg_policy
         WHERE polrelid =
           'omni_tenant_memory_data_right_requests'::regclass
           AND polname = 'omni_memory_data_right_request_holdback'
           AND NOT polpermissive
           AND polcmd = '*'
           AND polroles = ARRAY[0::OID]
           AND pg_get_expr(polqual, polrelid) =
             'omni_system_scope_enabled()'
           AND pg_get_expr(polwithcheck, polrelid) =
             'omni_system_scope_enabled()'
       )
       AND (
         SELECT count(*) FROM pg_trigger
         WHERE tgrelid =
           'omni_tenant_memory_data_right_requests'::regclass
           AND NOT tgisinternal
           AND tgenabled = 'O'
           AND tgname IN (
             'omni_memory_data_right_request_validate_insert',
             'omni_memory_data_right_request_mutation_hold',
             'omni_memory_data_right_request_no_truncate'
           )
       ) = 3 AS request_boundary_valid
     FROM pg_class schema_relation
     WHERE schema_relation.oid = 'omni_schema_version'::regclass
     LIMIT 1`,
  );
  const preflight = exactlyOne(preflightRows, "data-right request preflight");
  if (
    preflight.schema_owner !== true ||
    preflight.tenant_id !== null ||
    preflight.system_scope !== true ||
    preflight.request_schema_valid !== true ||
    preflight.activation_hold_valid !== true ||
    preflight.request_boundary_valid !== true
  ) {
    throw new Error("Memory data-right request persistence preflight failed closed.");
  }

  const userRows = await sql.query(
    `SELECT id, actor_id, status
     FROM omni_auth_users
     WHERE actor_id = $1
     ORDER BY id ASC
     LIMIT 2
     FOR SHARE`,
    [request.subjectActorId],
  );
  const user = exactlyOne(userRows, "data-right request canonical user");
  if (
    user.actor_id !== request.subjectActorId ||
    user.status !== "active" ||
    typeof user.id !== "string"
  ) {
    throw new Error("Memory data-right request canonical user is unavailable.");
  }

  const membershipRows = await sql.query(
    `SELECT id, tenant_id, user_id, status
     FROM omni_auth_memberships
     WHERE tenant_id = $1 AND user_id = $2
     ORDER BY id ASC
     LIMIT 2
     FOR SHARE`,
    [request.tenantId, user.id],
  );
  const membership = exactlyOne(
    membershipRows,
    "data-right request tenant membership",
  );
  if (
    membership.tenant_id !== request.tenantId ||
    membership.user_id !== user.id ||
    membership.status !== "active"
  ) {
    throw new Error("Memory data-right request tenant membership is unavailable.");
  }

  const requestRows = await sql.query(
    `INSERT INTO omni_tenant_memory_data_right_requests (
       schema_version, tenant_id, request_id, request_generation, purpose_id,
       subject_actor_id, executing_principal_type, executing_principal_id,
       confirmation_kind, request_binding_sha256, resource_ids,
       not_before, expires_at, state, lifecycle_revision,
       created_by_actor_id, activated_by_actor_id, consumed_by_actor_id,
       revoked_by_actor_id, created_at, activated_at, consumed_at, revoked_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       'held', 0, $14, NULL, NULL, NULL, statement_timestamp(), NULL, NULL,
       NULL, statement_timestamp()
     )
     RETURNING *`,
    [
      request.schemaVersion,
      request.tenantId,
      request.requestId,
      request.requestGeneration,
      request.purposeId,
      request.subjectActorId,
      request.executingPrincipalType,
      request.executingPrincipalId,
      request.confirmationKind,
      request.requestBindingSha256,
      [...request.resourceIds],
      request.notBefore,
      request.expiresAt,
      request.createdByActorId,
    ],
  );
  const persistedRequest = requestFromRow(
    exactlyOne(requestRows, "held data-right request insert"),
  );
  assertPersistedRequestBinding(request, persistedRequest);
  const requestEvent = buildMemoryDataRightRequestEventV1(
    persistedRequest,
    governanceDecisionId,
  );
  const eventIdentity = sha256Json([
    persistedRequest.tenantId,
    persistedRequest.requestId,
    persistedRequest.requestGeneration,
    persistedRequest.requestBindingSha256,
  ]);
  const streamIdentity = sha256Json([
    persistedRequest.tenantId,
    persistedRequest.requestId,
  ]);
  const event = await appendScopedDomainEvent(
    {
      id: `memory-data-right-request-held:${eventIdentity}`,
      streamId: `memory-data-right-request:${streamIdentity}`,
      type: requestEvent.type,
      payload: requestEvent.payload,
      executionScope,
    },
    { sql },
  );

  return Object.freeze({
    request: persistedRequest,
    event,
    authorityGranted: false as const,
    runtimeAccepted: false as const,
  });
}

function assertPersistedRequestBinding(
  requested: MemoryDataRightRequestRecordV1,
  persisted: MemoryDataRightRequestRecordV1,
) {
  if (
    persisted.schemaVersion !== requested.schemaVersion ||
    persisted.tenantId !== requested.tenantId ||
    persisted.requestId !== requested.requestId ||
    persisted.requestGeneration !== requested.requestGeneration ||
    persisted.purposeId !== requested.purposeId ||
    persisted.subjectActorId !== requested.subjectActorId ||
    persisted.executingPrincipalType !== requested.executingPrincipalType ||
    persisted.executingPrincipalId !== requested.executingPrincipalId ||
    persisted.confirmationKind !== requested.confirmationKind ||
    persisted.requestBindingSha256 !== requested.requestBindingSha256 ||
    !arraysEqual(persisted.resourceIds, requested.resourceIds) ||
    Date.parse(persisted.notBefore) < Date.parse(requested.notBefore) ||
    persisted.expiresAt !== requested.expiresAt ||
    persisted.createdByActorId !== requested.createdByActorId ||
    persisted.state !== "held" ||
    persisted.lifecycleRevision !== 0
  ) {
    throw new Error("Persisted memory data-right request binding changed.");
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function sha256Json(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestFromRow(row: SqlRow) {
  return parseMemoryDataRightRequestRecordV1({
    schemaVersion: Number(row.schema_version),
    tenantId: row.tenant_id,
    requestId: row.request_id,
    requestGeneration: Number(row.request_generation),
    purposeId: row.purpose_id,
    subjectActorId: row.subject_actor_id,
    executingPrincipalType: row.executing_principal_type,
    executingPrincipalId: row.executing_principal_id,
    confirmationKind: row.confirmation_kind,
    requestBindingSha256: row.request_binding_sha256,
    resourceIds: row.resource_ids,
    notBefore: canonicalDatabaseTimestamp(row.not_before, "request notBefore"),
    expiresAt: canonicalDatabaseTimestamp(row.expires_at, "request expiresAt"),
    state: row.state,
    lifecycleRevision: Number(row.lifecycle_revision),
    createdByActorId: row.created_by_actor_id,
    activatedByActorId: row.activated_by_actor_id,
    consumedByActorId: row.consumed_by_actor_id,
    revokedByActorId: row.revoked_by_actor_id,
    createdAt: canonicalDatabaseTimestamp(row.created_at, "request createdAt"),
    activatedAt: optionalDatabaseTimestamp(row.activated_at, "request activatedAt"),
    consumedAt: optionalDatabaseTimestamp(row.consumed_at, "request consumedAt"),
    revokedAt: optionalDatabaseTimestamp(row.revoked_at, "request revokedAt"),
    updatedAt: canonicalDatabaseTimestamp(row.updated_at, "request updatedAt"),
  });
}

function exactlyOne(rows: SqlRow[], label: string): SqlRow {
  if (rows.length !== 1) {
    throw new Error(`${label} must return exactly one row.`);
  }
  return rows[0];
}

function optionalDatabaseTimestamp(value: unknown, label: string) {
  return value === null ? null : canonicalDatabaseTimestamp(value, label);
}

function canonicalDatabaseTimestamp(value: unknown, label: string): string {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} is invalid.`);
  }
  const canonical = new Date(timestamp).toISOString();
  if (typeof value === "string" && value !== canonical) {
    throw new Error(`${label} is invalid.`);
  }
  return canonicalTimestampSchema.parse(canonical);
}
