export type CaptureIngestGuard = {
  tenantId: string;
  actorId: string;
  ingestJobId: string;
  nativeRecording?: { acceptanceId: string; claimId: string; jobId: string; leaseOwner: string };
} & (
  | { kind: "asset"; captureId: string }
  | { kind: "recording"; captureId: string }
);

type CaptureGuardSqlClient = (
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Array<Record<string, unknown>>>;

export class CaptureIngestInvalidatedError extends Error {
  constructor() {
    super("Capture ingest was invalidated by deletion or replacement.");
    this.name = "CaptureIngestInvalidatedError";
  }
}

export function captureIngestSource(guard: CaptureIngestGuard) {
  return guard.kind === "asset"
    ? `capture:asset:${guard.captureId}`
    : `capture:recording:${guard.captureId}`;
}

export function assertCaptureIngestSource(
  guard: CaptureIngestGuard,
  tenantId: string,
  source: string,
) {
  if (
    guard.tenantId !== tenantId ||
    guard.actorId.trim() !== guard.actorId ||
    !guard.actorId ||
    guard.ingestJobId.trim() !== guard.ingestJobId ||
    !guard.ingestJobId ||
    guard.captureId.trim() !== guard.captureId ||
    !guard.captureId ||
    source !== captureIngestSource(guard)
  ) {
    throw new CaptureIngestInvalidatedError();
  }
}

export async function lockActiveCaptureIngest(
  sql: CaptureGuardSqlClient,
  guard: CaptureIngestGuard,
) {
  const rows = guard.kind === "asset"
    ? await sql`
        SELECT id
        FROM omni_capture_assets
        WHERE tenant_id = ${guard.tenantId}
          AND actor_id = ${guard.actorId}
          AND id = ${guard.captureId}
          AND ingest_job_id = ${guard.ingestJobId}
        FOR UPDATE
      `
    : await sql`
        SELECT id
        FROM omni_capture_recordings
        WHERE tenant_id = ${guard.tenantId}
          AND actor_id = ${guard.actorId}
          AND id = ${guard.captureId}
          AND ingest_job_id = ${guard.ingestJobId}
        FOR UPDATE
      `;
  if (rows.length !== 1) {
    throw new CaptureIngestInvalidatedError();
  }
  if (guard.nativeRecording) {
    if (guard.kind !== "recording" || guard.nativeRecording.jobId !== guard.ingestJobId) throw new CaptureIngestInvalidatedError();
    const native = guard.nativeRecording;
    // Keep consent/source-link changes behind the same parent order as native
    // admission while the existing Knowledge write transaction is active.
    await sql`SELECT meeting.meeting_id FROM omni_meetings meeting
      JOIN omni_meeting_recording_processing_acceptances acceptance ON acceptance.tenant_id=meeting.tenant_id
        AND acceptance.workspace_id=meeting.workspace_id AND acceptance.meeting_id=meeting.meeting_id
        AND acceptance.canonical_actor_id=meeting.owner_actor_id
      WHERE acceptance.id=${native.acceptanceId} AND acceptance.tenant_id=${guard.tenantId}
        AND acceptance.owner_actor_id=${guard.actorId} AND acceptance.recording_id=${guard.captureId}
        AND public.omni_native_private_memory_owner_v1(acceptance.tenant_id,acceptance.owner_actor_id,acceptance.canonical_actor_id,TRUE) FOR SHARE OF meeting`;
    const exact = await sql`
      SELECT acceptance.id FROM omni_meeting_recording_processing_acceptances acceptance
      JOIN omni_meeting_recording_processing_effects effect ON effect.acceptance_id=acceptance.id AND effect.stage='knowledge'
        AND effect.state='started' AND effect.claim_id=${native.claimId} AND effect.job_id=${native.jobId}
      JOIN omni_operation_jobs job ON job.id=effect.job_id AND job.tenant_id=acceptance.tenant_id AND job.status='running'
        AND job.lease_owner=${native.leaseOwner} AND job.lease_expires_at>clock_timestamp()
        AND job.payload->>'nativeAcceptanceId'=acceptance.id
      JOIN omni_capture_recordings recording ON recording.id=acceptance.recording_id AND recording.tenant_id=acceptance.tenant_id
        AND recording.actor_id=acceptance.owner_actor_id AND recording.ingest_job_id=job.id
      JOIN omni_meetings meeting ON meeting.tenant_id=acceptance.tenant_id AND meeting.workspace_id=acceptance.workspace_id
        AND meeting.meeting_id=acceptance.meeting_id AND meeting.owner_actor_id=acceptance.canonical_actor_id
      JOIN omni_tenant_workspaces workspace ON workspace.tenant_id=acceptance.tenant_id AND workspace.workspace_id=acceptance.workspace_id AND workspace.state='active'
      JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id=workspace.tenant_id AND membership.workspace_id=workspace.workspace_id
        AND membership.subject_kind='user' AND membership.subject_actor_id=acceptance.canonical_actor_id
        AND membership.state='active' AND membership.access_level IN ('contributor','manager')
      WHERE acceptance.id=${native.acceptanceId} AND acceptance.tenant_id=${guard.tenantId}
        AND acceptance.owner_actor_id=${guard.actorId} AND acceptance.recording_id=${guard.captureId}
        AND public.omni_native_private_memory_owner_v1(acceptance.tenant_id,acceptance.owner_actor_id,acceptance.canonical_actor_id,TRUE)
        AND meeting.meeting_snapshot->'sourceLinks' @> jsonb_build_array(acceptance.source_manifest->'sourceLinkSnapshot')
        AND (SELECT jsonb_agg(jsonb_build_object('participantId',person->'participantId','displayName',person->'displayName',
          'recordingConsent',person->'recordingConsent','consentCapturedAt',person->'consentCapturedAt') ORDER BY ordinal)
          FROM jsonb_array_elements(meeting.meeting_snapshot->'participants') WITH ORDINALITY AS people(person,ordinal))=acceptance.source_manifest->'consentSnapshot'
        AND recording.title=acceptance.source_manifest->'recordingPolicy'->>'title'
        AND recording.language=acceptance.source_manifest->'recordingPolicy'->>'language'
        AND to_jsonb(recording.tags)=acceptance.source_manifest->'recordingPolicy'->'tags'
        AND recording.source=acceptance.source_manifest->'recordingPolicy'->>'source'
        AND recording.started_at=(acceptance.source_manifest->'recordingPolicy'->>'startedAt')::TIMESTAMPTZ
        AND (SELECT count(*) FROM omni_capture_segments segment WHERE segment.tenant_id=acceptance.tenant_id
          AND segment.actor_id=acceptance.owner_actor_id AND segment.recording_id=acceptance.recording_id)=jsonb_array_length(acceptance.source_manifest->'segments')
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(acceptance.source_manifest->'segments') pinned WHERE NOT EXISTS(
          SELECT 1 FROM omni_capture_segments segment WHERE segment.tenant_id=acceptance.tenant_id AND segment.actor_id=acceptance.owner_actor_id
            AND segment.recording_id=acceptance.recording_id AND segment.id=pinned->>'id' AND segment.segment_index=(pinned->>'segmentIndex')::INTEGER
            AND segment.mime_type=pinned->>'mimeType' AND segment.audio_sha256=pinned->>'audioSha256' AND segment.byte_count=(pinned->>'byteCount')::BIGINT
            AND segment.duration_ms=(pinned->>'durationMs')::INTEGER AND segment.raw_audio_deleted_at IS NULL))
    `;
    if (exact.length !== 1) throw new CaptureIngestInvalidatedError();
  }
}
