import { createHash } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import { appendDomainEvent } from "@/lib/events/store";
import { hasGoogleWorkspaceCapability } from "@/lib/connectors/google-workspace-capabilities";
import {
  MEETING_CALENDAR_ACCEPTANCE_CONTRACT, meetingCalendarRequestSha256, meetingCalendarSyncId,
  nativeMeetingCalendarScopeSchema, nativeMeetingCalendarSyncSchema, nativeMeetingCalendarSyncRequestSchema,
  nativeMeetingCalendarSettlementSchema, nativeMeetingCalendarSyncIdSchema,
  nativeMeetingCalendarConnectionSchema,
  type MeetingCalendarScope, type MeetingCalendarSync, type MeetingCalendarSyncRequest, type MeetingCalendarSettlement,
} from "@/lib/mobile/meeting-calendar-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export class MeetingCalendarError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message); this.name = "MeetingCalendarError";
  }
}
export type MeetingCalendarAuthority = Readonly<{
  scope: MeetingCalendarScope; accountEmail: string; executionScope?: ExecutionScope;
}>;
function fail(code: string, message: string, status = 409): never { throw new MeetingCalendarError(code, status, message); }
function validate(authority: MeetingCalendarAuthority, mutation = false) {
  nativeMeetingCalendarScopeSchema.parse(authority.scope);
  if (mutation && (!authority.executionScope || authority.executionScope.tenantId !== authority.scope.tenantId ||
    authority.executionScope.initiatingActorId !== authority.scope.ownerActorId || authority.executionScope.executingPrincipalType !== "user" ||
    authority.executionScope.executingPrincipalId !== authority.scope.ownerActorId || authority.executionScope.delegationId !== null ||
    authority.executionScope.workspaceId !== null || authority.executionScope.projectId !== null || authority.executionScope.missionId !== null ||
    authority.executionScope.contextGrantIds.length !== 0 || authority.executionScope.capabilityGrantIds.length !== 0 ||
    authority.executionScope.purpose !== "api.meetings.calendar.sync")) {
    fail("calendar_authority_invalid", "Current authenticated Calendar authority is required.", 403);
  }
  if (!hasDatabaseUrl()) fail("calendar_storage_unavailable", "Durable Calendar sync storage is unavailable.", 503);
}
async function owned<T>(authority: MeetingCalendarAuthority, operation: () => Promise<T>) {
  validate(authority);
  return runWithDatabaseActorScope(authority.scope.tenantId, [authority.scope.ownerActorId], async () => {
    await ensureDatabaseSchema(); return operation();
  });
}
function timestamp(value: unknown) {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}
function fromRow(row: Record<string, unknown>): MeetingCalendarSync {
  return nativeMeetingCalendarSyncSchema.parse({
    acceptance: {
      contract: MEETING_CALENDAR_ACCEPTANCE_CONTRACT, id: row.id,
      scope: { tenantId: row.tenant_id, ownerActorId: row.owner_actor_id, canonicalActorId: row.canonical_actor_id, workspaceId: row.workspace_id },
      connectionId: row.connection_id, authorizationGeneration: Number(row.authorization_generation),
      idempotencyKeySha256: row.idempotency_key_sha256, requestSha256: row.request_sha256,
      acceptedAt: timestamp(row.accepted_at),
    },
    state: row.state, settlement: row.settlement ?? null, updatedAt: timestamp(row.updated_at),
  });
}
function matchScope(authority: MeetingCalendarAuthority, sync: MeetingCalendarSync) {
  if (Object.entries(authority.scope).some(([key, value]) => sync.acceptance.scope[key as keyof MeetingCalendarScope] !== value)) {
    fail("calendar_acceptance_not_found", "Calendar sync acceptance was not found.", 404);
  }
  return sync;
}

export async function readMeetingCalendarConnection(authority: MeetingCalendarAuthority, connectionId?: string) {
  return owned(authority, async () => {
    const rows = await getSql()`SELECT id,tenant_id,actor_id,account_email,authorization_generation,status,scopes,
        source_sync_health,last_synced_at,sync_retry_at,updated_at
      FROM omni_oauth_grants WHERE tenant_id=${authority.scope.tenantId} AND actor_id=${authority.scope.ownerActorId}
        AND provider='google' AND account_email=${authority.accountEmail} AND connection_purpose='personal'
        AND (${connectionId ?? null}::TEXT IS NULL OR id=${connectionId ?? null}::TEXT)
      ORDER BY (status='active') DESC,updated_at DESC,id LIMIT 2`;
    if (!rows.length) return null;
    if (rows.length > 1 && rows[0].status === "active" && rows[1].status === "active") {
      fail("calendar_connection_ambiguous", "The current account's Calendar connection is ambiguous.");
    }
    const row = rows[0], health = row.source_sync_health as Record<string, unknown> | null;
    const coverage = health?.calendar as Record<string, unknown> | undefined;
    return nativeMeetingCalendarConnectionSchema.parse({
      id: row.id, tenantId: row.tenant_id, ownerActorId: row.actor_id, accountEmail: row.account_email,
      authorizationGeneration: Number(row.authorization_generation), status: row.status,
      calendarReadAllowed: Array.isArray(row.scopes) && hasGoogleWorkspaceCapability(row.scopes.map(String), "calendar.events.read"),
      coverage: coverage ? { status: coverage.status, backfillState: coverage.backfillState, lastAttemptedAt: coverage.lastAttemptedAt,
        lastSuccessfulAt: coverage.lastSuccessfulAt ?? null, failureCode: coverage.failureCode ?? "none" } : null,
      lastSyncedAt: row.last_synced_at ? timestamp(row.last_synced_at) : null,
      retryAfter: row.sync_retry_at ? timestamp(row.sync_retry_at) : null, updatedAt: timestamp(row.updated_at),
    });
  });
}

/** Claims the sole first attempt before any credential opening/provider work. */
export async function acceptMeetingCalendarSync(input: {
  authority: MeetingCalendarAuthority; request: MeetingCalendarSyncRequest; idempotencyKey: string;
}): Promise<{ sync: MeetingCalendarSync; newlyAccepted: boolean }> {
  const { authority } = input;
  validate(authority, true);
  const request = nativeMeetingCalendarSyncRequestSchema.parse(input.request), scope = authority.scope;
  if (authority.executionScope?.causationId !== request.connectionId) fail("calendar_authority_invalid", "Calendar execution must name its exact connection.", 403);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(input.idempotencyKey)) fail("calendar_key_invalid", "A valid Idempotency-Key is required.", 400);
  const keySha = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const id = meetingCalendarSyncId(scope, keySha), requestSha = meetingCalendarRequestSha256(scope, request);
  return owned(authority, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`;
    const prior = await sql`SELECT * FROM omni_meeting_calendar_sync_acceptances
      WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha}`;
    if (prior[0]) {
      const sync = matchScope(authority, fromRow(prior[0]));
      if (sync.acceptance.requestSha256 !== requestSha) fail("calendar_key_conflict", "This request key already belongs to a different Calendar sync.");
      return { sync, newlyAccepted: false };
    }
    // Parent lock serializes separate native request keys and OAuth changes.
    // Only public metadata is selected; credentials and cursors remain sealed.
    const grants = await sql`SELECT id,tenant_id,actor_id,provider,account_email,connection_purpose,scopes,status,
        authorization_generation,sync_lease_owner_id,sync_lease_expires_at
      FROM omni_oauth_grants WHERE tenant_id=${scope.tenantId} AND actor_id=${scope.ownerActorId}
        AND id=${request.connectionId} AND provider='google' FOR UPDATE`;
    const grant = grants[0];
    if (!grant || grant.account_email !== authority.accountEmail || grant.connection_purpose !== "personal") {
      fail("calendar_connection_not_found", "The current account's Calendar connection was not found.", 404);
    }
    if (grant.status !== "active" || Number(grant.authorization_generation) !== request.expectedAuthorizationGeneration ||
      !Array.isArray(grant.scopes) || !hasGoogleWorkspaceCapability(grant.scopes.map(String), "calendar.events.read")) {
      fail("calendar_connection_changed", "Refresh the Calendar connection and review its current authorization before syncing.");
    }
    const pending = await sql`SELECT id FROM omni_meeting_calendar_sync_acceptances
      WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND connection_id=${request.connectionId}
        AND state IN ('accepted','unconfirmed') LIMIT 1`;
    if (pending.length) fail("calendar_sync_unconfirmed", "A previous sync remains unconfirmed. Read its exact receipt; another request cannot repeat it.");
    if (grant.sync_lease_owner_id && Date.parse(String(grant.sync_lease_expires_at)) > Date.now()) {
      fail("calendar_sync_busy", "This Calendar connection is already syncing. Refresh its status before starting another sync.");
    }
    const at = new Date().toISOString();
    await appendDomainEvent({ id: `${id}:accepted`, type: "meeting.calendar.sync.accepted", streamId: id,
      executionScope: authority.executionScope, payload: { requestId: id, connectionId: request.connectionId, requestSha256: requestSha, state: "accepted" } }, { sql });
    const rows = await sql`INSERT INTO omni_meeting_calendar_sync_acceptances
      (id,tenant_id,owner_actor_id,canonical_actor_id,workspace_id,connection_id,authorization_generation,
        idempotency_key_sha256,request_sha256,accepted_at,state,settlement,updated_at)
      VALUES(${id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${scope.workspaceId},${request.connectionId},
        ${request.expectedAuthorizationGeneration},${keySha},${requestSha},${at},'accepted',NULL,${at}) RETURNING *`;
    return { sync: fromRow(rows[0]), newlyAccepted: true };
  }) as Promise<{ sync: MeetingCalendarSync; newlyAccepted: boolean }>);
}

export async function readMeetingCalendarSync(authority: MeetingCalendarAuthority, id: string, keySha: string) {
  nativeMeetingCalendarSyncIdSchema.parse(id);
  if (!/^[a-f0-9]{64}$/.test(keySha) || id !== meetingCalendarSyncId(authority.scope, keySha)) return null;
  return owned(authority, async () => {
    const rows = await getSql()`SELECT * FROM omni_meeting_calendar_sync_acceptances
      WHERE tenant_id=${authority.scope.tenantId} AND owner_actor_id=${authority.scope.ownerActorId}
        AND id=${id} AND idempotency_key_sha256=${keySha} LIMIT 1`;
    return rows[0] ? matchScope(authority, fromRow(rows[0])) : null;
  });
}
export async function readBlockedMeetingCalendarSync(authority: MeetingCalendarAuthority, connectionId: string) {
  return owned(authority, async () => {
    const rows = await getSql()`SELECT * FROM omni_meeting_calendar_sync_acceptances
      WHERE tenant_id=${authority.scope.tenantId} AND owner_actor_id=${authority.scope.ownerActorId}
        AND connection_id=${connectionId} AND state IN ('accepted','unconfirmed') LIMIT 1`;
    return rows[0] ? matchScope(authority, fromRow(rows[0])) : null;
  });
}
/** Terminal evidence is stored separately from immutable request acceptance. */
export async function settleMeetingCalendarSync(authority: MeetingCalendarAuthority, id: string, settlement: MeetingCalendarSettlement | null) {
  validate(authority, true); nativeMeetingCalendarSyncIdSchema.parse(id);
  if (settlement) nativeMeetingCalendarSettlementSchema.parse(settlement);
  return owned(authority, () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`SELECT * FROM omni_meeting_calendar_sync_acceptances
      WHERE tenant_id=${authority.scope.tenantId} AND owner_actor_id=${authority.scope.ownerActorId} AND id=${id} FOR UPDATE`;
    if (!rows[0]) fail("calendar_acceptance_not_found", "Calendar sync acceptance was not found.", 404);
    const current = matchScope(authority, fromRow(rows[0]));
    if (authority.executionScope?.causationId !== current.acceptance.connectionId) fail("calendar_authority_invalid", "Calendar execution must name its exact connection.", 403);
    if (current.state !== "accepted") return current;
    const state = settlement ? "settled" : "unconfirmed", at = settlement?.settledAt ?? new Date().toISOString();
    await appendDomainEvent({ id: `${id}:${state}`, type: `meeting.calendar.sync.${state}`, streamId: id,
      executionScope: authority.executionScope, payload: { requestId: id, connectionId: current.acceptance.connectionId, requestSha256: current.acceptance.requestSha256, state } }, { sql });
    const updated = await sql`UPDATE omni_meeting_calendar_sync_acceptances SET state=${state},settlement=${settlement}::JSONB,updated_at=${at}
      WHERE tenant_id=${authority.scope.tenantId} AND owner_actor_id=${authority.scope.ownerActorId} AND id=${id} RETURNING *`;
    return fromRow(updated[0]);
  }) as Promise<MeetingCalendarSync>);
}
