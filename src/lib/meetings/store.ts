import { createHash } from "node:crypto";

import {
  captureMediaHeadFromRow,
  type CaptureMediaHead,
} from "@/lib/capture/media-store";
import type { CaptureMediaOutput } from "@/lib/capture/media-contracts";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  buildMeetingRevision,
  meetingDraftInputSchema,
  parseMeetingRevision,
  MEETING_EVENT_TYPES,
  type MeetingAccessClass,
  type MeetingDraftInput,
  type MeetingRevision,
  type MeetingSourceLink,
  type MeetingSourceLinkRequest,
} from "@/lib/meetings/contracts";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  canonicalJsonSha256,
  idempotencyKeySha256,
} from "@/lib/tools/effect-receipt";

type MeetingSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export type MeetingReadAuthority = Readonly<{
  tenantId: string;
  workspaceId: string;
  canonicalActorId: string;
  readableActorIds: readonly string[];
}>;

export type MeetingMutationAuthority = MeetingReadAuthority & Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

export type MeetingLinkedSourceView = Readonly<{
  linkId: string;
  kind: MeetingSourceLink["kind"];
  sourceId: string;
  mediaRole: MeetingSourceLink["mediaRole"];
  label: string;
  revisionState: "exact" | "changed" | "unavailable";
  status: string | null;
  mediaType: string | null;
  durationMs: number | null;
  byteCount: number | null;
  updatedAt: string | null;
  transcript: string | null;
  transcriptTruncated: boolean;
  media: MeetingProcessedMediaView | null;
  segments: readonly Readonly<{
    segmentIndex: number;
    mimeType: string;
    durationMs: number;
  }>[];
}>;

export type MeetingProcessedMediaView = Readonly<{
  processingStatus: CaptureMediaHead["processingStatus"];
  operationJobId: string;
  rawAudioDeletedAt: string | null;
  updatedAt: string;
  output: CaptureMediaOutput | null;
}>;

export class MeetingConflictError extends Error {
  readonly code = "meeting_conflict";

  constructor(message = "The meeting changed. Refresh and try again.") {
    super(message);
    this.name = "MeetingConflictError";
  }
}

export class MeetingNotFoundError extends Error {
  readonly code = "meeting_not_found";

  constructor() {
    super("The selected meeting was not found.");
    this.name = "MeetingNotFoundError";
  }
}

export class MeetingUnavailableError extends Error {
  readonly code = "meeting_unavailable";

  constructor() {
    super("Meetings require the canonical database authority.");
    this.name = "MeetingUnavailableError";
  }
}

export async function listMeetings(
  authority: MeetingReadAuthority,
  options: { limit?: number; status?: MeetingRevision["status"] } = {},
) {
  requireDatabase();
  await ensureDatabaseSchema();
  const valid = validateReadAuthority(authority);
  const limit = Math.min(Math.max(Math.trunc(options.limit || 100), 1), 200);
  return runWithDatabaseActorScope(valid.tenantId, valid.readableActorIds, async () => {
    const rows = options.status
      ? await getSql()`
          SELECT meeting_snapshot
          FROM omni_meetings
          WHERE tenant_id = ${valid.tenantId}
            AND workspace_id = ${valid.workspaceId}
            AND status = ${options.status}
          ORDER BY scheduled_start_at DESC, meeting_id
          LIMIT ${limit}
        `
      : await getSql()`
          SELECT meeting_snapshot
          FROM omni_meetings
          WHERE tenant_id = ${valid.tenantId}
            AND workspace_id = ${valid.workspaceId}
          ORDER BY scheduled_start_at DESC, meeting_id
          LIMIT ${limit}
        `;
    return Object.freeze(rows.map(meetingFromRow));
  });
}

export async function getMeeting(
  authority: MeetingReadAuthority,
  meetingId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  const valid = validateReadAuthority(authority);
  return runWithDatabaseActorScope(valid.tenantId, valid.readableActorIds, async () => {
    const rows = await getSql()`
      SELECT meeting_snapshot
      FROM omni_meetings
      WHERE tenant_id = ${valid.tenantId}
        AND workspace_id = ${valid.workspaceId}
        AND meeting_id = ${requiredId(meetingId, "meeting")}
      LIMIT 1
    `;
    return rows[0] ? meetingFromRow(rows[0]) : undefined;
  });
}

export async function findMeetingBySourceItemId(
  authority: MeetingReadAuthority,
  sourceItemId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  const valid = validateReadAuthority(authority);
  const sourceId = requiredId(sourceItemId, "source item");
  return runWithDatabaseActorScope(valid.tenantId, valid.readableActorIds, async () => {
    const rows = await getSql()`
      SELECT meeting_snapshot
      FROM omni_meetings
      WHERE tenant_id = ${valid.tenantId}
        AND workspace_id = ${valid.workspaceId}
        AND meeting_snapshot -> 'sourceLinks' @>
          ${JSON.stringify([{ sourceId }])}::JSONB
      ORDER BY scheduled_start_at DESC, meeting_id
      LIMIT 1
    `;
    return rows[0] ? meetingFromRow(rows[0]) : undefined;
  });
}

export async function readMeetingLinkedSources(
  authority: MeetingReadAuthority,
  meeting: MeetingRevision,
): Promise<readonly MeetingLinkedSourceView[]> {
  requireDatabase();
  await ensureDatabaseSchema();
  const valid = validateReadAuthority(authority);
  if (meeting.tenantId !== valid.tenantId || meeting.workspaceId !== valid.workspaceId) {
    throw new MeetingConflictError("Meeting source scope is invalid.");
  }
  return runWithDatabaseActorScope(valid.tenantId, valid.readableActorIds, async () => {
    const views: MeetingLinkedSourceView[] = [];
    for (const link of meeting.sourceLinks) {
      if (link.kind === "capture_recording") {
        views.push(await readCaptureRecordingView(
          getSql(),
          valid,
          meeting.meetingId,
          link,
        ));
      } else if (link.kind === "capture_asset") {
        views.push(await readCaptureAssetView(getSql(), valid, link));
      } else {
        views.push(Object.freeze({
          linkId: link.linkId,
          kind: link.kind,
          sourceId: link.sourceId,
          mediaRole: link.mediaRole,
          label: link.label,
          revisionState: "exact" as const,
          status: null,
          mediaType: null,
          durationMs: null,
          byteCount: null,
          updatedAt: null,
          transcript: null,
          transcriptTruncated: false,
          media: null,
          segments: Object.freeze([]),
        }));
      }
    }
    return Object.freeze(views);
  });
}

export async function saveMeeting(input: {
  authority: MeetingMutationAuthority;
  draft: MeetingDraftInput;
  meetingId?: string;
  expectedRevision?: number;
}): Promise<MeetingRevision> {
  requireDatabase();
  await ensureDatabaseSchema();
  const authority = validateMutationAuthority(input.authority);
  const draft = meetingDraftInputSchema.parse(input.draft);
  const requestedMeetingId = input.meetingId
    ? requiredId(input.meetingId, "meeting")
    : undefined;
  const expectedRevision = input.expectedRevision === undefined
    ? undefined
    : positiveInteger(input.expectedRevision);
  if ((requestedMeetingId === undefined) !== (expectedRevision === undefined)) {
    throw new MeetingConflictError("Meeting updates require both an exact meeting and expected revision.");
  }
  const idempotencySha256 = idempotencyKeySha256({
    tenantId: authority.tenantId,
    idempotencyKey: authority.idempotencyKey,
  });
  const requestSha256 = canonicalJsonSha256({
    workspaceId: authority.workspaceId,
    canonicalActorId: authority.canonicalActorId,
    meetingId: requestedMeetingId || null,
    expectedRevision: expectedRevision || null,
    draft,
  });

  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: MeetingSql) => {
      await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${authority.tenantId}:${authority.workspaceId}:${authority.canonicalActorId}:${idempotencySha256}`},
          0
        ))
      `;
      const replay = await sql`
        SELECT meeting_snapshot, mutation_request_sha256
        FROM omni_meeting_revisions
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND revised_by_actor_id = ${authority.canonicalActorId}
          AND mutation_idempotency_sha256 = ${idempotencySha256}
        LIMIT 1
      `;
      if (replay[0]) {
        if (String(replay[0].mutation_request_sha256) !== requestSha256) {
          throw new MeetingConflictError(
            "Idempotency-Key is already bound to a different meeting revision.",
          );
        }
        return meetingFromRow(replay[0]);
      }

      const meetingId = requestedMeetingId || deterministicMeetingId({
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
        canonicalActorId: authority.canonicalActorId,
        idempotencySha256,
      });
      await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${authority.tenantId}:${authority.workspaceId}:${meetingId}`},
          0
        ))
      `;
      const heads = await sql`
        SELECT owner_actor_id, current_revision
        FROM omni_meetings
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND meeting_id = ${meetingId}
        FOR UPDATE
      `;
      const head = heads[0];
      if (expectedRevision === undefined && head) {
        throw new MeetingConflictError("The meeting already exists.");
      }
      if (expectedRevision !== undefined && !head) throw new MeetingNotFoundError();
      if (head && String(head.owner_actor_id) !== authority.canonicalActorId) {
        throw new MeetingConflictError("Only the meeting owner can revise it.");
      }
      if (head && positiveInteger(head.current_revision) !== expectedRevision) {
        throw new MeetingConflictError();
      }
      await assertProjectLink(sql, authority, draft.projectId);
      await assertEntityLinks(sql, authority, draft.entityLinks);
      const sourceLinks = await resolveMeetingSourceLinks(sql, authority, draft.sourceLinks, draft.projectId);
      const clock = await sql`SELECT clock_timestamp() AS revised_at`;
      const revisionNumber = head ? positiveInteger(head.current_revision) + 1 : 1;
      const meeting = buildMeetingRevision({
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
        ownerActorId: authority.canonicalActorId,
        meetingId,
        revision: revisionNumber,
        definition: { ...draft, meetingId, sourceLinks },
        revisedAt: timestamp(clock[0]?.revised_at),
      });
      await sql`
        INSERT INTO omni_meeting_revisions (
          tenant_id, workspace_id, meeting_id, meeting_revision,
          meeting_revision_id, owner_actor_id, project_id,
          effective_access_class, status, scheduled_start_at,
          scheduled_end_at, consent_snapshot_sha256, meeting_sha256,
          meeting_snapshot, mutation_idempotency_sha256,
          mutation_request_sha256, revised_by_actor_id, revised_at
        ) VALUES (
          ${meeting.tenantId}, ${meeting.workspaceId}, ${meeting.meetingId},
          ${meeting.revision}, ${meeting.meetingRevisionId},
          ${meeting.ownerActorId}, ${meeting.projectId},
          ${meeting.effectiveAccessClass}, ${meeting.status},
          ${meeting.scheduledStartAt}, ${meeting.scheduledEndAt},
          ${meeting.consentSnapshotSha256}, ${meeting.meetingSha256},
          ${meeting}::JSONB, ${idempotencySha256}, ${requestSha256},
          ${meeting.revisedByActorId}, ${meeting.revisedAt}
        )
      `;
      if (head) {
        const updated = await sql`
          UPDATE omni_meetings
          SET project_id = ${meeting.projectId},
              effective_access_class = ${meeting.effectiveAccessClass},
              status = ${meeting.status},
              scheduled_start_at = ${meeting.scheduledStartAt},
              scheduled_end_at = ${meeting.scheduledEndAt},
              current_revision = ${meeting.revision},
              current_revision_id = ${meeting.meetingRevisionId},
              consent_snapshot_sha256 = ${meeting.consentSnapshotSha256},
              meeting_sha256 = ${meeting.meetingSha256},
              meeting_snapshot = ${meeting}::JSONB,
              updated_by_actor_id = ${meeting.revisedByActorId},
              updated_at = ${meeting.revisedAt}
          WHERE tenant_id = ${meeting.tenantId}
            AND workspace_id = ${meeting.workspaceId}
            AND meeting_id = ${meeting.meetingId}
            AND current_revision = ${meeting.revision - 1}
          RETURNING meeting_id
        `;
        if (!updated[0]) throw new MeetingConflictError();
      } else {
        await sql`
          INSERT INTO omni_meetings (
            tenant_id, workspace_id, meeting_id, owner_actor_id, project_id,
            effective_access_class, status, scheduled_start_at,
            scheduled_end_at, current_revision, current_revision_id,
            consent_snapshot_sha256, meeting_sha256, meeting_snapshot,
            created_by_actor_id, updated_by_actor_id, created_at, updated_at
          ) VALUES (
            ${meeting.tenantId}, ${meeting.workspaceId}, ${meeting.meetingId},
            ${meeting.ownerActorId}, ${meeting.projectId},
            ${meeting.effectiveAccessClass}, ${meeting.status},
            ${meeting.scheduledStartAt}, ${meeting.scheduledEndAt},
            ${meeting.revision}, ${meeting.meetingRevisionId},
            ${meeting.consentSnapshotSha256}, ${meeting.meetingSha256},
            ${meeting}::JSONB, ${meeting.revisedByActorId},
            ${meeting.revisedByActorId}, ${meeting.revisedAt},
            ${meeting.revisedAt}
          )
        `;
      }
      await appendScopedDomainEvent({
        id: `meeting-revision:${meeting.meetingSha256}`,
        streamId: meeting.meetingId,
        type: meeting.revision === 1 ? MEETING_EVENT_TYPES.created : MEETING_EVENT_TYPES.revised,
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          workspaceId: meeting.workspaceId,
          meetingId: meeting.meetingId,
          meetingRevisionId: meeting.meetingRevisionId,
          revision: meeting.revision,
          previousMeetingRevisionId: meeting.previousMeetingRevisionId,
          effectiveAccessClass: meeting.effectiveAccessClass,
          consentSnapshotSha256: meeting.consentSnapshotSha256,
          meetingSha256: meeting.meetingSha256,
          sourceLinkCount: meeting.sourceLinks.length,
          participantCount: meeting.participants.length,
        },
      }, { sql });
      return meeting;
    }) as Promise<MeetingRevision>,
  );
}

async function resolveMeetingSourceLinks(
  sql: MeetingSql,
  authority: MeetingMutationAuthority,
  requests: readonly MeetingSourceLinkRequest[],
  meetingProjectId: string | null,
): Promise<MeetingSourceLink[]> {
  const links: MeetingSourceLink[] = [];
  for (const request of requests) {
    if (request.kind === "capture_recording") {
      links.push(await resolveCaptureRecordingLink(sql, authority, request));
    } else if (request.kind === "capture_asset") {
      links.push(await resolveCaptureAssetLink(sql, authority, request));
    } else {
      links.push(await resolveSourceRevisionLink(sql, authority, request, meetingProjectId));
    }
  }
  return links;
}

async function resolveSourceRevisionLink(
  sql: MeetingSql,
  authority: MeetingMutationAuthority,
  request: MeetingSourceLinkRequest,
  meetingProjectId: string | null,
): Promise<MeetingSourceLink> {
  if (!request.sourceRevisionId) {
    throw new MeetingConflictError("Source-backed meeting links require an exact revision ID.");
  }
  const rows = await sql`
    SELECT source_item_id, id AS source_revision_id, owner_actor_id,
      workspace_id, project_id, mission_id, visibility, sensitivity,
      permission_set_sha256, purpose_set_sha256, retention_policy_id,
      retention_expires_at, source_kind, source_revision_sha256
    FROM omni_source_revisions
    WHERE tenant_id = ${authority.tenantId}
      AND source_item_id = ${request.sourceId}
      AND id = ${request.sourceRevisionId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new MeetingConflictError("The exact linked source revision is unavailable.");
  const sourceKind = String(row.source_kind);
  if (request.kind === "calendar_event" && sourceKind !== "calendar_event") {
    throw new MeetingConflictError("The linked source is not a calendar event.");
  }
  if (request.kind === "calendar_event" && request.mediaRole !== "calendar") {
    throw new MeetingConflictError("Calendar links require the calendar media role.");
  }
  const accessClass = sourceAccessClass(String(row.visibility));
  const workspaceId = nullableString(row.workspace_id);
  const projectId = nullableString(row.project_id);
  if (accessClass === "workspace_members" && workspaceId !== authority.workspaceId) {
    throw new MeetingConflictError("The source belongs to a different workspace.");
  }
  if (accessClass === "project_members" && (
    workspaceId !== authority.workspaceId || projectId !== meetingProjectId
  )) {
    throw new MeetingConflictError("The source belongs to a different project.");
  }
  if (accessClass === "owner_private" && !authority.readableActorIds.includes(String(row.owner_actor_id))) {
    throw new MeetingConflictError("The private source belongs to a different actor.");
  }
  return Object.freeze({
    ...request,
    sourceRevisionId: request.sourceRevisionId,
    sourceRevisionSha256: requiredSha(row.source_revision_sha256),
    sourceAuthoritySha256: canonicalJsonSha256({
      kind: "source_revision",
      tenantId: authority.tenantId,
      ownerActorId: row.owner_actor_id,
      workspaceId,
      projectId,
      missionId: nullableString(row.mission_id),
      visibility: row.visibility,
      sensitivity: row.sensitivity,
      permissionSetSha256: row.permission_set_sha256,
      purposeSetSha256: row.purpose_set_sha256,
      retentionPolicyId: row.retention_policy_id,
      retentionExpiresAt: nullableTimestamp(row.retention_expires_at),
    }),
    accessClass,
  });
}

async function resolveCaptureRecordingLink(
  sql: MeetingSql,
  authority: MeetingMutationAuthority,
  request: MeetingSourceLinkRequest,
): Promise<MeetingSourceLink> {
  if (!["recording", "transcript"].includes(request.mediaRole)) {
    throw new MeetingConflictError("Capture recordings can be linked only as recording or transcript media.");
  }
  const rows = await sql`
    SELECT id, actor_id, status, language, started_at, completed_at,
      duration_ms, byte_count, segment_count, transcript, source,
      knowledge_document_id, ingest_job_id, updated_at
    FROM omni_capture_recordings
    WHERE tenant_id = ${authority.tenantId}
      AND id = ${request.sourceId}
      AND actor_id = ANY(${authority.readableActorIds})
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new MeetingConflictError("The linked recording is unavailable.");
  const body = captureRecordingRevisionBody(authority.tenantId, row);
  return resolvedCaptureLink(request, body, "capture-recording-revision");
}

async function resolveCaptureAssetLink(
  sql: MeetingSql,
  authority: MeetingMutationAuthority,
  request: MeetingSourceLinkRequest,
): Promise<MeetingSourceLink> {
  const rows = await sql`
    SELECT id, actor_id, filename, media_type, byte_count, content_sha256,
      status, extraction_status, knowledge_document_id, updated_at
    FROM omni_capture_assets
    WHERE tenant_id = ${authority.tenantId}
      AND id = ${request.sourceId}
      AND actor_id = ANY(${authority.readableActorIds})
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new MeetingConflictError("The linked capture asset is unavailable.");
  const body = captureAssetRevisionBody(authority.tenantId, row);
  return resolvedCaptureLink(request, body, "capture-asset-revision");
}

async function readCaptureRecordingView(
  sql: MeetingSql,
  authority: MeetingReadAuthority,
  meetingId: string,
  link: MeetingSourceLink,
): Promise<MeetingLinkedSourceView> {
  const rows = await sql`
    SELECT id, actor_id, status, language, started_at, completed_at,
      duration_ms, byte_count, segment_count, transcript, source,
      knowledge_document_id, ingest_job_id, updated_at
    FROM omni_capture_recordings
    WHERE tenant_id = ${authority.tenantId}
      AND id = ${link.sourceId}
      AND actor_id = ANY(${authority.readableActorIds})
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return unavailableLinkedSource(link);
  const mediaRows = await sql`
    SELECT *
    FROM omni_capture_media_heads
    WHERE tenant_id = ${authority.tenantId}
      AND owner_actor_id = ${String(row.actor_id)}
      AND recording_id = ${link.sourceId}
      AND meeting_id = ${meetingId}
    LIMIT 1
  `;
  const media = mediaRows[0]
    ? meetingProcessedMediaView(captureMediaHeadFromRow(mediaRows[0]))
    : null;
  const body = captureRecordingRevisionBody(authority.tenantId, row);
  const revisionState = canonicalJsonSha256(body) === link.sourceRevisionSha256
    ? "exact" as const
    : "changed" as const;
  const segmentRows = revisionState === "exact"
    ? await sql`
        SELECT segment_index, mime_type, duration_ms
        FROM omni_capture_segments
        WHERE tenant_id = ${authority.tenantId}
          AND recording_id = ${link.sourceId}
          AND actor_id = ANY(${authority.readableActorIds})
        ORDER BY segment_index ASC
        LIMIT 1440
      `
    : [];
  const transcript = String(row.transcript || "");
  const boundedTranscript = transcript.slice(0, 500_000);
  return Object.freeze({
    linkId: link.linkId,
    kind: link.kind,
    sourceId: link.sourceId,
    mediaRole: link.mediaRole,
    label: link.label,
    revisionState,
    status: String(row.status),
    mediaType: segmentRows[0] ? String(segmentRows[0].mime_type) : "audio/*",
    durationMs: Number(row.duration_ms),
    byteCount: Number(row.byte_count),
    updatedAt: timestamp(row.updated_at),
    transcript: revisionState === "exact" ? boundedTranscript : null,
    transcriptTruncated: revisionState === "exact" && boundedTranscript.length < transcript.length,
    media,
    segments: Object.freeze(segmentRows.map((segment) => Object.freeze({
      segmentIndex: Number(segment.segment_index),
      mimeType: String(segment.mime_type),
      durationMs: Number(segment.duration_ms),
    }))),
  });
}

async function readCaptureAssetView(
  sql: MeetingSql,
  authority: MeetingReadAuthority,
  link: MeetingSourceLink,
): Promise<MeetingLinkedSourceView> {
  const rows = await sql`
    SELECT id, actor_id, filename, media_type, byte_count, content_sha256,
      status, extraction_status, knowledge_document_id, updated_at
    FROM omni_capture_assets
    WHERE tenant_id = ${authority.tenantId}
      AND id = ${link.sourceId}
      AND actor_id = ANY(${authority.readableActorIds})
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return unavailableLinkedSource(link);
  const revisionState = canonicalJsonSha256(
    captureAssetRevisionBody(authority.tenantId, row),
  ) === link.sourceRevisionSha256
    ? "exact" as const
    : "changed" as const;
  return Object.freeze({
    linkId: link.linkId,
    kind: link.kind,
    sourceId: link.sourceId,
    mediaRole: link.mediaRole,
    label: link.label,
    revisionState,
    status: String(row.status),
    mediaType: String(row.media_type),
    durationMs: null,
    byteCount: Number(row.byte_count),
    updatedAt: timestamp(row.updated_at),
    transcript: null,
    transcriptTruncated: false,
    media: null,
    segments: Object.freeze([]),
  });
}

function unavailableLinkedSource(link: MeetingSourceLink): MeetingLinkedSourceView {
  return Object.freeze({
    linkId: link.linkId,
    kind: link.kind,
    sourceId: link.sourceId,
    mediaRole: link.mediaRole,
    label: link.label,
    revisionState: "unavailable",
    status: null,
    mediaType: null,
    durationMs: null,
    byteCount: null,
    updatedAt: null,
    transcript: null,
    transcriptTruncated: false,
    media: null,
    segments: Object.freeze([]),
  });
}

function meetingProcessedMediaView(
  head: CaptureMediaHead,
): MeetingProcessedMediaView {
  return Object.freeze({
    processingStatus: head.processingStatus,
    operationJobId: head.operationJobId,
    rawAudioDeletedAt: head.rawAudioDeletedAt || null,
    updatedAt: head.updatedAt,
    output: head.output || null,
  });
}

function captureRecordingRevisionBody(tenantId: string, row: SqlRow) {
  return {
    kind: "capture_recording",
    tenantId,
    recordingId: row.id,
    ownerActorId: row.actor_id,
    status: row.status,
    language: row.language,
    startedAt: timestamp(row.started_at),
    completedAt: nullableTimestamp(row.completed_at),
    durationMs: Number(row.duration_ms),
    byteCount: Number(row.byte_count),
    segmentCount: Number(row.segment_count),
    transcriptSha256: canonicalJsonSha256(String(row.transcript || "")),
    source: row.source,
    knowledgeDocumentId: nullableString(row.knowledge_document_id),
    ingestJobId: nullableString(row.ingest_job_id),
    updatedAt: timestamp(row.updated_at),
  };
}

function captureAssetRevisionBody(tenantId: string, row: SqlRow) {
  return {
    kind: "capture_asset",
    tenantId,
    assetId: row.id,
    ownerActorId: row.actor_id,
    filename: row.filename,
    mediaType: row.media_type,
    byteCount: Number(row.byte_count),
    contentSha256: row.content_sha256,
    status: row.status,
    extractionStatus: row.extraction_status,
    knowledgeDocumentId: nullableString(row.knowledge_document_id),
    updatedAt: timestamp(row.updated_at),
  };
}

function resolvedCaptureLink(
  request: MeetingSourceLinkRequest,
  body: Record<string, unknown>,
  revisionPrefix: string,
): MeetingSourceLink {
  const sourceRevisionSha256 = canonicalJsonSha256(body);
  const sourceRevisionId = `${revisionPrefix}:${sourceRevisionSha256}`;
  if (request.sourceRevisionId && request.sourceRevisionId !== sourceRevisionId) {
    throw new MeetingConflictError("The linked capture source changed. Refresh and try again.");
  }
  return Object.freeze({
    ...request,
    sourceRevisionId,
    sourceRevisionSha256,
    sourceAuthoritySha256: canonicalJsonSha256({
      kind: body.kind,
      tenantId: body.tenantId,
      ownerActorId: body.ownerActorId,
      accessClass: "owner_private",
    }),
    accessClass: "owner_private",
  });
}

async function assertProjectLink(
  sql: MeetingSql,
  authority: MeetingMutationAuthority,
  projectId: string | null,
) {
  if (!projectId) return;
  const rows = await sql`
    SELECT project_id
    FROM omni_work_projects
    WHERE tenant_id = ${authority.tenantId}
      AND workspace_id = ${authority.workspaceId}
      AND project_id = ${projectId}
    LIMIT 1
  `;
  if (!rows[0]) throw new MeetingConflictError("The linked project is unavailable.");
}

async function assertEntityLinks(
  sql: MeetingSql,
  authority: MeetingMutationAuthority,
  links: readonly MeetingDraftInput["entityLinks"][number][],
) {
  for (const link of links) {
    const rows = await sql`
      SELECT id
      FROM omni_entity_records
      WHERE tenant_id = ${authority.tenantId}
        AND id = ${link.entityId}
        AND entity_type_id = ${link.entityType}
        AND state = 'active'
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new MeetingConflictError(`The linked ${link.entityType} entity is unavailable.`);
    }
  }
}

function sourceAccessClass(visibility: string): MeetingAccessClass {
  if (visibility === "workspace_shared") return "workspace_members";
  if (visibility === "project_shared") return "project_members";
  if (["user_private", "agent_private", "mission_shared"].includes(visibility)) {
    return "owner_private";
  }
  throw new MeetingConflictError("The linked source visibility is unsupported.");
}

function meetingFromRow(row: SqlRow): MeetingRevision {
  const meeting = parseMeetingRevision(jsonValue(row.meeting_snapshot));
  if (!meeting) throw new MeetingConflictError("Stored meeting revision is invalid.");
  return meeting;
}

function validateReadAuthority(authority: MeetingReadAuthority) {
  const readableActorIds = [...new Set(authority.readableActorIds.map((id) => id.trim()))]
    .filter(Boolean);
  if (
    !authority.tenantId.trim() || !authority.workspaceId.startsWith("workspace:") ||
    !/^actor:[0-9a-f-]{36}$/.test(authority.canonicalActorId) ||
    !readableActorIds.includes(authority.canonicalActorId)
  ) {
    throw new MeetingConflictError("Meeting authority is invalid.");
  }
  return { ...authority, readableActorIds };
}

function validateMutationAuthority(authority: MeetingMutationAuthority) {
  const read = validateReadAuthority(authority);
  const scope = parsePersistedExecutionScope(authority.executionScope);
  if (
    !scope || scope.tenantId !== authority.tenantId ||
    scope.initiatingActorId !== authority.canonicalActorId ||
    scope.workspaceId !== authority.workspaceId || scope.projectId !== null ||
    scope.missionId !== null ||
    scope.purpose !== "meeting.write"
  ) {
    throw new MeetingConflictError("Meeting mutation scope is invalid.");
  }
  const idempotencyKey = authority.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 512) {
    throw new MeetingConflictError("Meeting Idempotency-Key is invalid.");
  }
  return { ...read, executionScope: scope, idempotencyKey };
}

function deterministicMeetingId(input: Record<string, string>) {
  const digest = createHash("sha256").update(canonicalJsonSha256(input), "utf8").digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return `meeting:${uuid}`;
}

function requiredId(value: string, label: string) {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(id)) {
    throw new MeetingConflictError(`The ${label} ID is invalid.`);
  }
  return id;
}

function requiredSha(value: unknown) {
  const sha = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new MeetingConflictError("A source digest is invalid.");
  return sha;
}

function positiveInteger(value: unknown) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 1) {
    throw new MeetingConflictError("Meeting revision is invalid.");
  }
  return integer;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new MeetingConflictError("Meeting timestamp is invalid.");
  return date.toISOString();
}

function nullableTimestamp(value: unknown) {
  return value === null || value === undefined ? null : timestamp(value);
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new MeetingUnavailableError();
}
