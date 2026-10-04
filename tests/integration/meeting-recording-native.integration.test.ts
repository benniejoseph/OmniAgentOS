import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { readMeetingLinkedSources, saveMeeting } from "@/lib/meetings/store";
import { getOperationJob } from "@/lib/operations/job-queue";
import { claimNativeMeetingRecordingEffect, holdNativeMeetingRecordingEffect, loadNativeMeetingRecordingJob, readNativeMeetingRecording,
  reviewNativeMeetingRecording, submitNativeMeetingRecording } from "@/lib/capture/meeting-recording-native-store";
import type { MeetingRecordingRequest, MeetingRecordingScope } from "@/lib/capture/meeting-recording-native-contracts";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const user = "11111111-1111-4111-8111-111111111111", owner = "recording-native@example.test", canonical = `actor:${user}`;
const roleName = "recording_native_test_runtime", at = "2026-10-05T10:00:00.123Z";

// Opt-in disposable database. Setup uses admin; admission, exact recovery and
// provider-effect claims use the real non-bypass serving role. No provider runs.
integration("native recording atomic queue acceptance under serving RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient(); admin = postgres(databaseUrl!, { max: 3, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`; await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`); roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,
      omni_tenant_workspaces,omni_tenant_workspace_memberships,omni_work_projects,omni_work_project_memberships,
      omni_agent_runs,omni_tool_executions TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_meetings,omni_capture_recordings,omni_capture_segments,omni_capture_media_heads,omni_operation_jobs TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_meeting_revisions,omni_capture_media_revisions,omni_events TO ${roleName}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${roleName}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES (${user},${owner},'fixture-only')`;
    await closeDatabaseClient(); const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("recording-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('omni_meeting_recording_processing_acceptances') AS acceptance_rls,
      has_table_privilege(current_user,'public.omni_auth_user_actor_identifiers','SELECT') AS identity_table_read,
      row_security_active('omni_meeting_recording_processing_effects') AS effect_rls FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, acceptance_rls: true, effect_rls: true, identity_table_read: false });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) { if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); } await admin.end(); }
  });
  async function fixture(tag: string) {
    const tenantId = `recording-native-${tag}`, workspaceId = `workspace:${tenantId}`, recordingId = `recording-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`${tag}:member`},${tenantId},${user},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},${tag},${canonical},'active',1,${canonical},${canonical},${at},${at},${at})`;
    await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'user',${canonical},${canonical},1,'manager','active',1,${canonical},${canonical},${at},${at},${at})`;
    await admin`INSERT INTO omni_capture_recordings(id,tenant_id,actor_id,title,language,started_at,duration_ms,byte_count,segment_count,source,created_at,updated_at)
      VALUES (${recordingId},${tenantId},${owner},'Reviewed meeting','en-US',${at},1000,4,1,${`capture:recording:${recordingId}`},${at},${at})`;
    await admin`INSERT INTO omni_capture_segments(id,tenant_id,actor_id,recording_id,segment_index,mime_type,byte_count,duration_ms,audio_sha256,audio_data,created_at,updated_at)
      VALUES (${`${recordingId}:segment:0`},${tenantId},${owner},${recordingId},0,'audio/webm',4,1000,${"a".repeat(64)},${Buffer.from([1,2,3,4])},${at},${at})`;
    const executionScope = createExecutionScope({ tenantId, initiatingActorId: canonical, executingPrincipalType: "user", executingPrincipalId: canonical,
      workspaceId, correlationId: tag, purpose: "meeting.write" });
    const meetingAuthority = { tenantId, workspaceId, canonicalActorId: canonical, readableActorIds: [canonical, owner], executionScope, idempotencyKey: `${tag}:meeting` };
    const draft = { title: "Reviewed meeting", summary: "", status: "completed" as const, scheduledStartAt: at, scheduledEndAt: "2026-10-05T11:00:00.000Z",
      actualStartAt: null, actualEndAt: null, timezone: "UTC", location: "", projectId: null, declaredAccessClass: "owner_private" as const,
      participants: [{ participantId: "participant:owner", displayName: "Owner", email: owner, entityId: null, role: "organizer" as const, response: "accepted" as const,
        attendeeConsent: "granted" as const, recordingConsent: "granted" as const, consentCapturedAt: at, source: "manual" as const }],
      sourceLinks: [{ linkId: "link:recording", kind: "capture_recording" as const, sourceId: recordingId, mediaRole: "recording" as const, label: "Recording" }],
      entityLinks: [], decisions: [], commitments: [], followUps: [] };
    const meeting = await saveMeeting({ authority: meetingAuthority, draft });
    const scope: MeetingRecordingScope = { tenantId, workspaceId, meetingId: meeting.meetingId, recordingId, ownerActorId: owner, canonicalActorId: canonical };
    const reviewed = await reviewNativeMeetingRecording({ scope }); expect(reviewed.eligibility).toEqual({ processable: true, reasonCodes: [] });
    const request: MeetingRecordingRequest = { contract: "asael-meeting-recording-process:1", meetingId: scope.meetingId, workspaceId,
      review: reviewed.pin, languageHints: ["en-US"], speakerMappings: [], rawAudioRetention: { mode: "retain" } };
    return { scope, request, meeting, meetingAuthority, draft };
  }
  function submit(f: Awaited<ReturnType<typeof fixture>>, key = "process-one", request = f.request) {
    return submitNativeMeetingRecording({ authority: { scope: f.scope, executionScope: createExecutionScope({ tenantId: f.scope.tenantId, initiatingActorId: owner,
      executingPrincipalType: "user", executingPrincipalId: owner, workspaceId: f.scope.workspaceId, correlationId: key, causationId: f.scope.recordingId,
      purpose: "capture.recording.media.queue" }) }, request, idempotencyKey: key });
  }
  async function counts(scope: MeetingRecordingScope) {
    return (await admin`SELECT (SELECT count(*)::INTEGER FROM omni_meeting_recording_processing_acceptances WHERE tenant_id=${scope.tenantId}) AS accepted,
      (SELECT count(*)::INTEGER FROM omni_operation_jobs WHERE tenant_id=${scope.tenantId}) AS jobs,
      (SELECT count(*)::INTEGER FROM omni_capture_media_heads WHERE tenant_id=${scope.tenantId}) AS heads,
      (SELECT count(*)::INTEGER FROM omni_events WHERE tenant_id=${scope.tenantId} AND type='meeting.recording.native.accepted') AS events`)[0];
  }
  test("same-key overlap atomically queues once, exact GET never advances it, and new keys cannot bypass acceptance", async () => {
    const f = await fixture("replay"), results = await Promise.all([submit(f), submit(f)]);
    expect(results.map((item) => item.replayed).sort()).toEqual([false,true]); expect(results[0].acceptance).toEqual(results[1].acceptance);
    expect(await counts(f.scope)).toEqual({ accepted: 1, jobs: 1, heads: 1, events: 1 });
    expect((await admin`SELECT owner_actor_id FROM omni_capture_media_heads WHERE tenant_id=${f.scope.tenantId} AND recording_id=${f.scope.recordingId}`)[0].owner_actor_id).toBe(canonical);
    const [linked] = await readMeetingLinkedSources(f.meetingAuthority,f.meeting);
    expect(linked.media).toMatchObject({ processingStatus: "queued",operationJobId: results[0].acceptance.operationJobId });
    await expect(submit(f, "different-key")).rejects.toMatchObject({ status: 409 });
    await expect(submit(f, "process-one", { ...f.request, languageHints: ["fr"] })).rejects.toMatchObject({ status: 409 });
    expect((await readNativeMeetingRecording({ scope: f.scope }, results[0].acceptance.keySha256)).acceptance).toEqual(results[0].acceptance);
    expect(await readNativeMeetingRecording({ scope: f.scope }, "f".repeat(64))).toEqual({ acceptance: null, processing: null });
    expect(await counts(f.scope)).toEqual({ accepted: 1, jobs: 1, heads: 1, events: 1 });
    expect(await runWithDatabaseTenantScope(f.scope.tenantId, () => getSql()`SELECT id FROM omni_meeting_recording_processing_acceptances`)).toEqual([]);
    await expect(readNativeMeetingRecording({ scope: { ...f.scope, ownerActorId: "other@example.test" } }, results[0].acceptance.keySha256)).rejects.toMatchObject({ status: 403 });
  });
  test("typed acceptance event failure rolls back preparation, job, head and receipt together", async () => {
    const f = await fixture("rollback");
    await admin`CREATE FUNCTION recording_fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='meeting.recording.native.accepted' AND NEW.tenant_id='recording-native-rollback' THEN RAISE EXCEPTION 'fixture recording event failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER recording_fixture_event_failure BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION recording_fixture_event_failure()`;
    try { await expect(submit(f)).rejects.toMatchObject({ code: "P0001" });
      expect(await counts(f.scope)).toEqual({ accepted: 0, jobs: 0, heads: 0, events: 0 });
      expect((await admin`SELECT status,completed_at FROM omni_capture_recordings WHERE id=${f.scope.recordingId}`)[0]).toEqual({ status: "recording", completed_at: null });
    } finally { await admin`DROP TRIGGER recording_fixture_event_failure ON omni_events`; await admin`DROP FUNCTION recording_fixture_event_failure()`; }
  });
  test("a provider claim cannot be taken twice and current consent blocks subsequent work", async () => {
    const f = await fixture("claim"), submitted = await submit(f);
    await admin`UPDATE omni_operation_jobs SET status='running',lease_owner='recording-fixture',lease_expires_at=clock_timestamp()+INTERVAL '5 minutes' WHERE id=${submitted.acceptance.operationJobId}`;
    const job = await runWithDatabaseActorScope(f.scope.tenantId, [owner], () => getOperationJob(submitted.acceptance.operationJobId, { tenantId: f.scope.tenantId }));
    if (!job) throw new Error("Expected admitted processing job");
    expect(job.maxAttempts).toBe(1); const accepted = await loadNativeMeetingRecordingJob(job);
    const claimed = await claimNativeMeetingRecordingEffect(accepted, job, "extract", { reviewed: submitted.acceptance.reviewSha256 });
    expect(claimed.committed).toBe(false);
    await expect(claimNativeMeetingRecordingEffect(accepted, job, "extract", { reviewed: submitted.acceptance.reviewSha256 })).rejects.toMatchObject({ code: "meeting_recording_reconciliation_required" });
    await holdNativeMeetingRecordingEffect(accepted, job, "extract", claimed.claimId);
    expect((await readNativeMeetingRecording({ scope: f.scope }, submitted.acceptance.keySha256)).processing?.phase).toBe("reconciliation_required");
    await saveMeeting({ authority: { ...f.meetingAuthority, idempotencyKey: "revoke-consent" }, meetingId: f.scope.meetingId, expectedRevision: 1,
      draft: { ...f.draft, sourceLinks: [],participants: f.draft.participants.map((person) => ({ ...person, recordingConsent: "declined" as const })) } });
    await expect(claimNativeMeetingRecordingEffect(accepted, job, "knowledge", { fixture: true })).rejects.toMatchObject({ code: "meeting_recording_source_link",status: 409 });
    await expect(readNativeMeetingRecording({ scope: f.scope }, submitted.acceptance.keySha256)).rejects.toMatchObject({ code: "meeting_recording_source_link",status: 409 });
    expect((await admin`SELECT state FROM omni_meeting_recording_processing_effects WHERE acceptance_id=${submitted.acceptance.id} AND stage='extract'`)[0].state).toBe("unconfirmed");
    expect(await counts(f.scope)).toEqual({ accepted: 1, jobs: 1, heads: 1, events: 1 });
    await admin`DELETE FROM omni_capture_recordings WHERE id=${f.scope.recordingId}`;
    expect(await admin`SELECT id FROM omni_meeting_recording_processing_acceptances WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
    expect(await admin`SELECT stage FROM omni_meeting_recording_processing_effects WHERE tenant_id=${f.scope.tenantId}`).toEqual([]);
  });
});
