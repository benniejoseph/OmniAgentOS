import { beforeEach, describe, expect, it, vi } from "vitest";

const actorId = "actor:11111111-1111-4111-8111-111111111111";
const meetingId = "meeting:22222222-2222-4222-8222-222222222222";
const workspaceId = "workspace:tenant-a";
const timestamp = "2026-09-08T10:00:00.000Z";
const mocks = vi.hoisted(() => ({
  responses: [] as Record<string, unknown>[][],
  queries: [] as Array<{ text: string; values: unknown[] }>,
  event: vi.fn(),
}));

vi.mock("@/lib/db/client", () => {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      mocks.queries.push({ text, values });
      return mocks.responses.shift() || [];
    },
    {
      transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(sql),
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: () => sql,
    hasDatabaseUrl: () => true,
    runWithDatabaseActorScope: async (
      _tenantId: string,
      _actorIds: readonly string[],
      operation: () => Promise<unknown>,
    ) => operation(),
  };
});

vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: mocks.event }));

import {
  mediaArtifactId,
  mediaCitationForTurn,
  mediaTurnId,
  sha256Json,
  withCaptureMediaOutputDigest,
} from "@/lib/capture/media-contracts";
import { createMeetingCommitmentProposal, claimMeetingCommitmentResolution,
  recordMeetingCommitmentResolutionPhase, recordMeetingCommitmentResolution,
} from "@/lib/meetings/commitment-store";
import { withMeetingCommitmentProposalDigest, withMeetingCommitmentResolutionDigest, meetingCommitmentProposalId, meetingCommitmentResolutionId } from "@/lib/meetings/commitment-contracts";
import { meetingResolutionIntentBody, meetingResolutionIntentSchema } from "@/lib/meetings/commitment-resolution-intent";
import { buildMeetingRevision } from "@/lib/meetings/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const participant = {
  participantId: "participant:owner",
  displayName: "Owner",
  email: "owner@example.test",
  entityId: null,
  role: "organizer" as const,
  response: "accepted" as const,
  attendeeConsent: "granted" as const,
  recordingConsent: "granted" as const,
  consentCapturedAt: timestamp,
  source: "manual" as const,
};
const meeting = buildMeetingRevision({
  tenantId: "tenant-a",
  workspaceId,
  ownerActorId: actorId,
  meetingId,
  revision: 1,
  revisedAt: timestamp,
  definition: {
    title: "Customer review",
    status: "completed",
    scheduledStartAt: timestamp,
    scheduledEndAt: "2026-09-08T11:00:00.000Z",
    timezone: "Asia/Kolkata",
    projectId: "project-1",
    declaredAccessClass: "owner_private",
    participants: [participant],
    sourceLinks: [{
      linkId: "link:recording",
      kind: "capture_recording",
      sourceId: "recording-1",
      sourceRevisionId: `capture-recording-revision:${"a".repeat(64)}`,
      sourceRevisionSha256: "a".repeat(64),
      sourceAuthoritySha256: "b".repeat(64),
      accessClass: "owner_private",
      mediaRole: "recording",
      label: "Recording",
    }],
  },
});
const turnInput = {
  segmentId: "segment-1",
  segmentIndex: 0,
  sourceAudioSha256: "c".repeat(64),
  startMilliseconds: 1_000,
  endMilliseconds: 3_000,
  languageTag: "en-US",
  speaker: {
    label: "A",
    identity: "known" as const,
    participantId: participant.participantId,
    displayName: participant.displayName,
  },
  text: "I will send the rollout plan by Thursday.",
};
const turn = { ...turnInput, turnId: mediaTurnId(turnInput) };
const citation = mediaCitationForTurn(turn);
const actionBody = {
  text: "Send the customer the revised rollout plan.",
  citations: [citation],
  ownerParticipantId: participant.participantId,
  dueAt: "2026-09-10T12:00:00.000Z",
  ownershipEvidence: "explicit" as const,
  dueDateEvidence: "explicit" as const,
};
const actionItem = {
  ...actionBody,
  actionItemId: mediaArtifactId("action", actionBody),
};
const media = withCaptureMediaOutputDigest({
  schemaVersion: 1,
  tenantId: "tenant-a",
  ownerActorId: actorId,
  recordingId: "recording-1",
  meetingId,
  mediaRevision: 1,
  mediaRevisionId: "recording-1:media:v1",
  sourceAudioManifestSha256: sha256Json([turn.sourceAudioSha256]),
  transcriptionModel: "gpt-4o-transcribe-diarize",
  extractionModel: "gpt-5",
  languageTags: ["en-US"],
  turns: [turn],
  chapters: [],
  summary: { text: "A rollout follow-up was assigned.", citations: [citation] },
  actionItems: [actionItem],
  decisions: [],
  warnings: [],
  rawAudioRetention: { mode: "retain" },
  processedAt: "2026-09-08T11:02:00.000Z",
});

const authority = {
  tenantId: "tenant-a",
  workspaceId,
  canonicalActorId: actorId,
  readableActorIds: [actorId],
  idempotencyKey: "meeting-proposal-1",
  executionScope: createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    workspaceId,
    projectId: "project-1",
    correlationId: "meeting-proposal-1",
    purpose: "meeting.commitment.propose",
  }),
} as const;

const proposalFixture = withMeetingCommitmentProposalDigest({
  schemaVersion: 1, contractVersion: "p10.8-meeting-commitment-conversion:1",
  proposalId: meetingCommitmentProposalId({ tenantId: authority.tenantId, workspaceId, meetingId, mediaRevisionId: media.mediaRevisionId, actionItemId: actionItem.actionItemId }),
  tenantId: authority.tenantId, workspaceId, meetingId, meetingRevisionId: meeting.meetingRevisionId, meetingSha256: meeting.meetingSha256,
  projectId: "project-1", sourceLinkId: "link:recording", recordingId: media.recordingId, mediaRevisionId: media.mediaRevisionId,
  mediaOutputSha256: media.outputSha256, actionItemId: actionItem.actionItemId, actionItemSha256: sha256Json(actionItem),
  title: actionItem.text, citations: actionItem.citations,
  ownership: { participantId: participant.participantId, displayName: participant.displayName, authority: "explicit_transcript" },
  dueDate: { dueAt: actionItem.dueAt, authority: "explicit_transcript" }, proposedByActorId: actorId, proposedAt: timestamp,
});
const decision = { decision: "confirmed" as const, ownerParticipantId: participant.participantId, dueAt: actionItem.dueAt, communication: null };
const intentFixture = meetingResolutionIntentSchema.parse({
  ...meetingResolutionIntentBody({ tenantId: authority.tenantId, workspaceId, meetingId,
    proposalId: proposalFixture.proposalId, proposalSha256: proposalFixture.proposalSha256, ownerActorId: actorId, request: decision }),
  createdAt: timestamp,
});
function proposalRow(withIntent = false) {
  return { proposal_snapshot: proposalFixture, resolution_snapshot: null,
    ...(withIntent ? { intent_snapshot: intentFixture, resolution_phases: [] } : {}),
  };
}

beforeEach(() => {
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockReset().mockResolvedValue({ id: "event-1" });
});

describe("meeting commitment store", () => {
  it("persists a proposal bound only to the exact cited media action", async () => {
    mocks.responses.push([], [], [{ proposed_at: timestamp }], []);
    const view = await createMeetingCommitmentProposal({
      authority,
      meeting,
      media,
      actionItem,
    });

    expect(view.proposal).toMatchObject({
      meetingRevisionId: meeting.meetingRevisionId,
      mediaRevisionId: media.mediaRevisionId,
      actionItemId: actionItem.actionItemId,
      ownership: { authority: "explicit_transcript" },
      dueDate: { authority: "explicit_transcript" },
    });
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_meeting_commitment_proposals")
    )).toBe(true);
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "meeting.commitment.proposed" }),
      expect.objectContaining({ sql: expect.any(Function) }),
    );
  });

  it("refuses to propose work when the meeting has no canonical project", async () => {
    const projectless = buildMeetingRevision({
      tenantId: "tenant-a",
      workspaceId,
      ownerActorId: actorId,
      meetingId,
      revision: 1,
      revisedAt: timestamp,
      definition: {
        title: "Unscoped meeting",
        status: "completed",
        scheduledStartAt: timestamp,
        scheduledEndAt: "2026-09-08T11:00:00.000Z",
        timezone: "Asia/Kolkata",
        projectId: null,
        declaredAccessClass: "owner_private",
        participants: [participant],
        sourceLinks: meeting.sourceLinks,
      },
    });
    await expect(createMeetingCommitmentProposal({
      authority,
      meeting: projectless,
      media,
      actionItem,
    })).rejects.toThrow(/Link this meeting to a project/);
    expect(mocks.queries).toHaveLength(0);
  });
  it("commits exactly one decision under the proposal resolution lock before any child store", async () => {
    mocks.responses.push([], [proposalRow()], [], [{ created_at: timestamp }], [{ effective_access_class: "owner_private" }], []);
    const claim = await claimMeetingCommitmentResolution({ authority, proposal: proposalFixture, request: decision });
    expect(claim.state).toBe("claimed");
    expect(mocks.queries[0]).toMatchObject({ text: expect.stringContaining("pg_advisory_xact_lock"), values: [expect.stringContaining(`${proposalFixture.proposalId}:resolution`)] });
    const write = mocks.queries.findIndex((query) => query.text.includes("INSERT INTO omni_meeting_commitment_resolution_intents"));
    expect(write).toBeGreaterThan(0);
    expect(mocks.queries[write].values).toContainEqual(intentFixture);
    expect(mocks.queries.some((query) => /INSERT INTO omni_(project_tasks|message_drafts|meeting_commitment_resolutions)\b/.test(query.text))).toBe(false);
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ type: "meeting.commitment.resolution.claimed" }), expect.anything());
  });

  it("returns an existing incomplete claim without issuing a second admission", async () => {
    mocks.responses.push([], [proposalRow(true)], [{ intent_snapshot: intentFixture }]);
    const claim = await claimMeetingCommitmentResolution({ authority, proposal: proposalFixture, request: decision });
    expect(claim).toMatchObject({ state: "incomplete", view: { reconciliation: { state: "pending", automaticRetryAllowed: false } } });
    expect(mocks.queries.some((query) => query.text.includes("INSERT"))).toBe(false);
  });

  it("refuses changed owner decisions before writing phase or resolution evidence", async () => {
    mocks.responses.push([], [proposalRow(true)], [{ intent_snapshot: intentFixture }]);
    await expect(claimMeetingCommitmentResolution({ authority, proposal: proposalFixture,
      request: { ...decision, ownerParticipantId: "participant:other" },
    })).rejects.toThrow("different immutable resolution request");
    expect(mocks.queries.some((query) => query.text.includes("INSERT"))).toBe(false);
  });

  it("rejects foreign tenant, workspace and actor claims before acquiring a connection", async () => {
    for (const change of [{ tenantId: "foreign" }, { workspaceId: "workspace:foreign" }, { canonicalActorId: "actor:33333333-3333-4333-8333-333333333333" }]) {
      await expect(claimMeetingCommitmentResolution({ authority: { ...authority, ...change }, proposal: proposalFixture, request: decision })).rejects.toThrow("exact proposal owner");
    }
    expect(mocks.queries).toHaveLength(0);
  });

  it("records before-effect evidence only after validating the existing owner intent", async () => {
    mocks.responses.push([], [{ intent_snapshot: intentFixture }], [proposalRow(true)], [], [{ recorded_at: timestamp }], []);
    const state = await recordMeetingCommitmentResolutionPhase({ authority, intent: intentFixture, phase: "work_started" });
    expect(state).toMatchObject({ state: "uncertain", phases: [{ phase: "work_started", resourceId: null, evidenceSha256: null }] });
    expect(mocks.queries.filter((query) => query.text.includes("INSERT"))).toHaveLength(1);
  });

  it("will not acknowledge a completion without its started phase", async () => {
    mocks.responses.push([], [{ intent_snapshot: intentFixture }], [proposalRow(true)], []);
    await expect(recordMeetingCommitmentResolutionPhase({ authority, intent: intentFixture, phase: "work_completed", resourceId: "task-one", evidenceSha256: "a".repeat(64) })).rejects.toThrow("do not permit");
    expect(mocks.queries.some((query) => query.text.includes("INSERT"))).toBe(false);
  });

  it("refuses a final resolution without a matching durable decision claim", async () => {
    const resolution = withMeetingCommitmentResolutionDigest({ schemaVersion: 1, contractVersion: "p10.8-meeting-commitment-conversion:1",
      resolutionId: meetingCommitmentResolutionId(proposalFixture.proposalId), proposalId: proposalFixture.proposalId, proposalSha256: proposalFixture.proposalSha256,
      decision: "confirmed", ownerParticipantId: participant.participantId, ownerDisplayName: participant.displayName, ownershipAuthority: "explicit_transcript",
      dueAt: actionItem.dueAt, dueDateAuthority: "explicit_transcript", workItemId: "task-one", draftId: null, communicationPolicyId: null,
      meetingRevisionId: `${meetingId}:v2`, resolvedByActorId: actorId, resolvedAt: timestamp });
    mocks.responses.push([], [proposalRow()], []);
    await expect(recordMeetingCommitmentResolution({ authority, proposal: proposalFixture, resolution, intent: intentFixture })).rejects.toThrow("decision was not claimed");
    expect(mocks.queries.some((query) => query.text.includes("INSERT"))).toBe(false);
  });

});
