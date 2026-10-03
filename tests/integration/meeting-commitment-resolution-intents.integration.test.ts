import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createProject, createProjectTasks } from "@/lib/projects/store";
import { saveMeeting } from "@/lib/meetings/store";
import { claimMeetingCommitmentResolution, getMeetingCommitmentView, recordMeetingCommitmentResolution, recordMeetingCommitmentResolutionPhase } from "@/lib/meetings/commitment-store";
import { meetingCommitmentProposalId, meetingCommitmentResolutionId, withMeetingCommitmentProposalDigest, withMeetingCommitmentResolutionDigest } from "@/lib/meetings/commitment-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { MeetingResolutionDecision, MeetingResolutionIntent } from "@/lib/meetings/commitment-resolution-intent";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const userId = "77777777-7777-4777-8777-777777777777", otherUserId = "88888888-8888-4888-8888-888888888888";
const actorId = `actor:${userId}`, otherActorId = `actor:${otherUserId}`;
const email = "resolution-intent@example.test", now = "2026-10-04T12:00:00.000Z", hash = "a".repeat(64);

// Destructive opt-in fixture, matching existing scoped integration harnesses.
// Real serving-role claims/progress and an actual idempotent Project task store
// are exercised. No draft delivery, tool provider, transcription or Calendar call.
databaseDescribe("Meeting resolution decision admission under serving Postgres RLS", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`GRANT SELECT ON omni_auth_users,omni_auth_memberships,omni_auth_tenants,
      omni_tenant_workspaces,omni_tenant_workspace_memberships,omni_meetings,omni_meeting_revisions,
      omni_schema_version,
      omni_agent_runs,omni_mission_attempts,omni_project_artifacts,omni_tool_executions TO omni_runtime`;
    await admin`GRANT SELECT,INSERT,UPDATE ON omni_projects,omni_project_tasks,omni_events,
      omni_work_projects,omni_work_project_memberships,omni_work_items,
      omni_work_item_status_history,omni_work_compatibility_mappings TO omni_runtime`;
    await admin`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO omni_runtime`;
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES
      (${userId},${email},'fixture-only'),(${otherUserId},'resolution-other@example.test','fixture-only')`;
  });
  afterAll(async () => {
    await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs();
  });
  async function serving(enabled: boolean) {
    await getSql().query(enabled ? "SET ROLE omni_runtime" : "SET ROLE NONE");
  }
  async function fixture(tag: string) {
    await serving(false);
    const tenantId = `resolution-${tag}`, workspaceId = `workspace:resolution-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenantId},${tag},${tenantId})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES
      (${`${tag}:membership`},${tenantId},${userId},'operator'),(${`${tag}:other-membership`},${tenantId},${otherUserId},'operator')`;
    await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},${tag},${actorId},'active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    for (const owner of [actorId, otherActorId]) {
      await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
        VALUES (${tenantId},${workspaceId},'user',${owner},${owner},1,'manager','active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    }
    const scope = createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId,
      workspaceId, correlationId: `resolution:${tag}`, purpose: "meeting.commitment.fixture" });
    const project = await runWithDatabaseActorScope(tenantId, [actorId], () => createProject({ tenantId, actorId, title: `Meeting ${tag}`, objective: "Resolution admission fixture",
      mutation: { executionScope: scope, idempotencyKey: `${tag}:project` } }));
    const meetingScope = createExecutionScope({ ...scope, purpose: "meeting.write" });
    const authority = { tenantId, workspaceId, canonicalActorId: actorId, readableActorIds: [actorId, email], executionScope: meetingScope, idempotencyKey: `${tag}:meeting` };
    const meeting = await saveMeeting({ authority, draft: {
      title: `Review ${tag}`, summary: "", status: "completed", scheduledStartAt: now, scheduledEndAt: "2026-10-04T13:00:00.000Z", timezone: "UTC",
      actualStartAt: null, actualEndAt: null, location: "", entityLinks: [], decisions: [], commitments: [], followUps: [],
      projectId: project.id, declaredAccessClass: "owner_private", participants: ["one", "two"].map((key) => ({
        participantId: `participant:${key}`, displayName: `Recipient ${key}`, email: "shared@example.test", entityId: null,
        role: "required" as const, response: "accepted" as const, attendeeConsent: "granted" as const, recordingConsent: "not_required" as const,
        consentCapturedAt: now, source: "manual" as const,
      })), sourceLinks: [],
    } });
    const identity = { tenantId, workspaceId, meetingId: meeting.meetingId, mediaRevisionId: `recording-${tag}:media:v1`, actionItemId: `media-action:${hash}` };
    const proposal = withMeetingCommitmentProposalDigest({ schemaVersion: 1, contractVersion: "p10.8-meeting-commitment-conversion:1", proposalId: meetingCommitmentProposalId(identity),
      ...identity, meetingRevisionId: meeting.meetingRevisionId, meetingSha256: meeting.meetingSha256, projectId: project.id,
      sourceLinkId: "link:fixture", recordingId: `recording-${tag}`, mediaOutputSha256: hash, actionItemSha256: hash,
      title: `Follow up ${tag}`, citations: [{ turnId: `media-turn:${hash}`, segmentIndex: 0, startMilliseconds: 0, endMilliseconds: 1000, speakerLabel: "Owner", speakerParticipantId: "participant:one" }],
      ownership: { participantId: "participant:one", displayName: "Recipient one", authority: "explicit_transcript" }, dueDate: { dueAt: null, authority: "confirmation_required" },
      proposedByActorId: actorId, proposedAt: now });
    // Seed immutable evidence directly; this suite tests admission/reconciliation,
    // while domain media/source validation has independent service regressions.
    await admin`INSERT INTO omni_meeting_commitment_proposals(tenant_id,workspace_id,meeting_id,proposal_id,owner_actor_id,project_id,effective_access_class,meeting_revision_id,media_revision_id,action_item_id,proposal_sha256,proposal_snapshot,proposed_at)
      VALUES (${tenantId},${workspaceId},${meeting.meetingId},${proposal.proposalId},${actorId},${project.id},'owner_private',${meeting.meetingRevisionId},${proposal.mediaRevisionId},${proposal.actionItemId},${proposal.proposalSha256},${admin.json(proposal)},${now})`;
    await serving(true);
    const role = await runWithDatabaseActorScope(tenantId, [actorId, email], () => getSql()`SELECT current_user AS role`);
    expect(role[0].role).toBe("omni_runtime");
    return { authority, proposal, project, scope };
  }
  function decision(recipient = "one"): MeetingResolutionDecision {
    return { decision: "confirmed", ownerParticipantId: "participant:one", dueAt: null,
      communication: { connectionId: null, policyId: "contact_policy:99999999-9999-4999-8999-999999999999", recipientParticipantId: `participant:${recipient}`, subject: "Same reviewed subject", body: "Same reviewed content" } };
  }
  async function countIntent(f: Awaited<ReturnType<typeof fixture>>) {
    const rows = await admin`SELECT count(*)::INTEGER AS count FROM omni_meeting_commitment_resolution_intents WHERE tenant_id=${f.authority.tenantId} AND proposal_id=${f.proposal.proposalId}`;
    return rows[0].count;
  }
  async function mark(f: Awaited<ReturnType<typeof fixture>>, intent: MeetingResolutionIntent, phase: Parameters<typeof recordMeetingCommitmentResolutionPhase>[0]["phase"], resourceId?: string, evidenceSha256?: string) {
    return recordMeetingCommitmentResolutionPhase({ authority: f.authority, intent, phase, resourceId, evidenceSha256 });
  }

  test("concurrent distinct participants with the same email cannot both claim effects", async () => {
    const f = await fixture("concurrent");
    const results = await Promise.allSettled(["one", "two"].map((recipient) => claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request: decision(recipient) })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await countIntent(f)).toBe(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled" || winner.value.state !== "claimed") throw new Error("Exactly one request must own admission.");
    const accepted = winner.value;
    const again = await claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request: accepted.intent.request });
    expect(again.state).toBe("incomplete");
    expect(again.view.reconciliation).toMatchObject({ state: "pending", requestSha256: accepted.intent.requestSha256, automaticRetryAllowed: false });
    const counts = await admin`SELECT count(*)::INTEGER AS count FROM omni_project_tasks WHERE tenant_id=${f.authority.tenantId} AND project_id=${f.project.id}`;
    expect(counts[0].count).toBe(0);
  });

  test("identical in-flight submissions admit one caller and retain one immutable request", async () => {
    const f = await fixture("same-request");
    const claims = await Promise.all([1, 2].map(() => claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request: decision() })));
    expect(claims.map((claim) => claim.state).sort()).toEqual(["claimed", "incomplete"]);
    expect(await countIntent(f)).toBe(1);
    const rows = await admin`SELECT request_sha256,intent_snapshot FROM omni_meeting_commitment_resolution_intents WHERE tenant_id=${f.authority.tenantId}`;
    expect(rows[0].intent_snapshot.request.communication.recipientParticipantId).toBe("participant:one");
  });

  test("a completed dismissal replays its immutable terminal receipt without new phases", async () => {
    const f = await fixture("dismissed");
    const request = { decision: "dismissed" as const };
    const claim = await claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request });
    if (claim.state !== "claimed") throw new Error("Expected first claim.");
    await mark(f, claim.intent, "resolution_started");
    const resolution = withMeetingCommitmentResolutionDigest({ schemaVersion: 1, contractVersion: "p10.8-meeting-commitment-conversion:1",
      resolutionId: meetingCommitmentResolutionId(f.proposal.proposalId), proposalId: f.proposal.proposalId, proposalSha256: f.proposal.proposalSha256,
      decision: "dismissed", ownerParticipantId: null, ownerDisplayName: null, ownershipAuthority: null, dueAt: null, dueDateAuthority: null,
      workItemId: null, draftId: null, communicationPolicyId: null, meetingRevisionId: null, resolvedByActorId: actorId, resolvedAt: now });
    const accepted = await recordMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, intent: claim.intent, resolution });
    const replay = await claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request });
    expect(replay).toMatchObject({ state: "resolved", view: { resolution, reconciliation: { state: "resolved", automaticRetryAllowed: false } } });
    expect(replay.view).toEqual(accepted);
    expect(await countIntent(f)).toBe(1);
    expect(await admin`SELECT phase FROM omni_meeting_commitment_resolution_progress WHERE tenant_id=${f.authority.tenantId}`).toEqual([{ phase: "resolution_started" }]);
    expect(await admin`SELECT id FROM omni_project_tasks WHERE tenant_id=${f.authority.tenantId}`).toHaveLength(0);
  });

  test.each([true, false])("interrupted work preserves acknowledged=%s evidence and replay creates no second task", async (acknowledged) => {
    const f = await fixture(acknowledged ? "partial" : "response-lost");
    let childCalls = 0;
    const applyFirstChild = async () => {
      const claimed = await claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request: decision() });
      if (claimed.state !== "claimed") return claimed;
      await mark(f, claimed.intent, "work_started");
      childCalls++;
      const [task] = await runWithDatabaseActorScope(f.authority.tenantId, [actorId, email], () => createProjectTasks(f.project.id, [{ title: "One admitted task" }], {
        tenantId: f.authority.tenantId, actorId, mutation: { executionScope: f.scope, idempotencyKey: `meeting-commitment:${f.proposal.proposalSha256}:work` },
      }));
      expect(task).toBeDefined();
      if (acknowledged) await mark(f, claimed.intent, "work_completed", task.id, canonicalJsonSha256(task));
      await mark(f, claimed.intent, "interrupted");
      return claimed;
    };
    await applyFirstChild();
    expect((await applyFirstChild()).state).toBe("incomplete");
    expect(childCalls).toBe(1);
    const view = await getMeetingCommitmentView(f.authority, f.proposal.meetingId, f.proposal.proposalId);
    expect(view).toMatchObject({ resolution: null, reconciliation: { state: "uncertain", automaticRetryAllowed: false,
      phases: [{ phase: "work_started" }, ...(acknowledged ? [{ phase: "work_completed", resourceId: expect.any(String), evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] : []), { phase: "interrupted" }] } });
    const tasks = await admin`SELECT id FROM omni_project_tasks WHERE tenant_id=${f.authority.tenantId} AND project_id=${f.project.id}`;
    expect(tasks).toHaveLength(1);
    if (acknowledged) expect(view!.reconciliation!.phases[1].resourceId).toBe(tasks[0].id);
    else expect(view!.reconciliation!.phases.every((phase) => phase.resourceId === null)).toBe(true);
  });

  test("owner, workspace and tenant mismatches cannot inspect or progress an intent", async () => {
    const f = await fixture("scope");
    const claimed = await claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request: decision() });
    if (claimed.state !== "claimed") throw new Error("Expected first claim.");
    for (const changed of [{ canonicalActorId: otherActorId, readableActorIds: [otherActorId] }, { workspaceId: "workspace:wrong" }, { tenantId: "foreign" }]) {
      await expect(claimMeetingCommitmentResolution({ authority: { ...f.authority, ...changed }, proposal: f.proposal, request: decision() })).rejects.toThrow();
      await expect(recordMeetingCommitmentResolutionPhase({ authority: { ...f.authority, ...changed }, intent: claimed.intent, phase: "work_started" })).rejects.toThrow();
    }
    const rows = await runWithDatabaseActorScope(f.authority.tenantId, [otherActorId], () => getSql()`SELECT intent_snapshot FROM omni_meeting_commitment_resolution_intents WHERE proposal_id=${f.proposal.proposalId}`);
    expect(rows).toHaveLength(0);
    expect(await getMeetingCommitmentView({ ...f.authority, workspaceId: "workspace:wrong" }, f.proposal.meetingId, f.proposal.proposalId)).toBeUndefined();
  });

  test("serving SQL cannot replace or delete the admitted decision or skip a before phase", async () => {
    const f = await fixture("immutable");
    const claimed = await claimMeetingCommitmentResolution({ authority: f.authority, proposal: f.proposal, request: decision() });
    if (claimed.state !== "claimed") throw new Error("Expected first claim.");
    await expect(runWithDatabaseActorScope(f.authority.tenantId, [actorId], () => getSql()`UPDATE omni_meeting_commitment_resolution_intents SET request_sha256=request_sha256 WHERE proposal_id=${f.proposal.proposalId}`)).rejects.toMatchObject({ code: "42501" });
    await expect(runWithDatabaseActorScope(f.authority.tenantId, [actorId], () => getSql()`DELETE FROM omni_meeting_commitment_resolution_intents WHERE proposal_id=${f.proposal.proposalId}`)).rejects.toMatchObject({ code: "42501" });
    const phase = { phase: "work_completed", at: now, resourceId: "unacknowledged", evidenceSha256: hash };
    await expect(runWithDatabaseActorScope(f.authority.tenantId, [actorId], () => getSql()`INSERT INTO omni_meeting_commitment_resolution_progress
      (tenant_id,workspace_id,meeting_id,proposal_id,owner_actor_id,request_sha256,phase,phase_order,phase_snapshot,recorded_at)
      VALUES (${f.authority.tenantId},${f.authority.workspaceId},${f.proposal.meetingId},${f.proposal.proposalId},${actorId},${claimed.intent.requestSha256},'work_completed',1,${phase}::JSONB,${now})`)).rejects.toMatchObject({ code: "55000" });
  });
});
