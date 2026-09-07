import { describe, expect, it } from "vitest";

import {
  meetingCommitmentProposalId,
  meetingCommitmentResolutionId,
  withMeetingCommitmentProposalDigest,
  withMeetingCommitmentResolutionDigest,
} from "@/lib/meetings/commitment-contracts";

const proposalId = meetingCommitmentProposalId({
  tenantId: "tenant-a",
  workspaceId: "workspace:tenant-a",
  meetingId: "meeting:11111111-1111-4111-8111-111111111111",
  mediaRevisionId: "recording-1:media:v1",
  actionItemId: `media-action:${"a".repeat(64)}`,
});

function proposal() {
  return withMeetingCommitmentProposalDigest({
    schemaVersion: 1,
    contractVersion: "p10.8-meeting-commitment-conversion:1",
    proposalId,
    tenantId: "tenant-a",
    workspaceId: "workspace:tenant-a",
    meetingId: "meeting:11111111-1111-4111-8111-111111111111",
    meetingRevisionId: "meeting:11111111-1111-4111-8111-111111111111:v1",
    meetingSha256: "b".repeat(64),
    projectId: "project-1",
    sourceLinkId: "link:recording",
    recordingId: "recording-1",
    mediaRevisionId: "recording-1:media:v1",
    mediaOutputSha256: "c".repeat(64),
    actionItemId: `media-action:${"a".repeat(64)}`,
    actionItemSha256: "d".repeat(64),
    title: "Send the customer the revised rollout plan.",
    citations: [{
      turnId: `media-turn:${"e".repeat(64)}`,
      segmentIndex: 0,
      startMilliseconds: 10_000,
      endMilliseconds: 12_000,
      speakerLabel: "A",
      speakerParticipantId: "participant:owner",
    }],
    ownership: {
      participantId: "participant:owner",
      displayName: "Owner",
      authority: "explicit_transcript",
    },
    dueDate: {
      dueAt: "2026-09-10T12:00:00.000Z",
      authority: "explicit_transcript",
    },
    proposedByActorId: "actor:11111111-1111-4111-8111-111111111111",
    proposedAt: "2026-09-08T12:00:00.000Z",
  });
}

describe("meeting commitment conversion contracts", () => {
  it("binds each proposal to the exact meeting, media revision, action, and citations", () => {
    const value = proposal();
    expect(value.proposalId).toBe(proposalId);
    expect(value.proposalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.citations[0]).toMatchObject({
      startMilliseconds: 10_000,
      speakerParticipantId: "participant:owner",
    });
  });

  it("requires confirmation instead of inventing an unverified owner", () => {
    expect(() => withMeetingCommitmentProposalDigest({
      ...proposal(),
      ownership: {
        participantId: "participant:invented",
        displayName: "Invented",
        authority: "confirmation_required",
      },
    })).toThrow(/Unconfirmed ownership/);
  });

  it("records confirmed effects and their evidence authority together", () => {
    const source = proposal();
    const resolution = withMeetingCommitmentResolutionDigest({
      schemaVersion: 1,
      contractVersion: "p10.8-meeting-commitment-conversion:1",
      resolutionId: meetingCommitmentResolutionId(source.proposalId),
      proposalId: source.proposalId,
      proposalSha256: source.proposalSha256,
      decision: "confirmed",
      ownerParticipantId: "participant:owner",
      ownerDisplayName: "Owner",
      ownershipAuthority: "explicit_transcript",
      dueAt: "2026-09-10T12:00:00.000Z",
      dueDateAuthority: "explicit_transcript",
      workItemId: "work-item-1",
      draftId: "message_draft:22222222-2222-4222-8222-222222222222",
      communicationPolicyId: "contact_policy:33333333-3333-4333-8333-333333333333",
      meetingRevisionId: "meeting:11111111-1111-4111-8111-111111111111:v2",
      resolvedByActorId: "actor:11111111-1111-4111-8111-111111111111",
      resolvedAt: "2026-09-08T12:05:00.000Z",
    });
    expect(resolution.decision).toBe("confirmed");
    expect(resolution.resolutionSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps dismissed proposals free of WorkItem and draft effects", () => {
    const source = proposal();
    expect(() => withMeetingCommitmentResolutionDigest({
      schemaVersion: 1,
      contractVersion: "p10.8-meeting-commitment-conversion:1",
      resolutionId: meetingCommitmentResolutionId(source.proposalId),
      proposalId: source.proposalId,
      proposalSha256: source.proposalSha256,
      decision: "dismissed",
      ownerParticipantId: null,
      ownerDisplayName: null,
      ownershipAuthority: null,
      dueAt: null,
      dueDateAuthority: null,
      workItemId: "work-item-not-allowed",
      draftId: null,
      communicationPolicyId: null,
      meetingRevisionId: null,
      resolvedByActorId: "actor:11111111-1111-4111-8111-111111111111",
      resolvedAt: "2026-09-08T12:05:00.000Z",
    })).toThrow(/Confirmed commitments require/);
  });
});
