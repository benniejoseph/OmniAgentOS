import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  getMeeting: vi.fn(),
  readLinkedSources: vi.fn(),
  saveMeeting: vi.fn(),
  createProposal: vi.fn(),
  getProposal: vi.fn(),
  listProposals: vi.fn(),
  recordResolution: vi.fn(),
  createWorkItem: vi.fn(),
  createDraft: vi.fn(),
  listPolicies: vi.fn(),
  getDraft: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));
vi.mock("@/lib/meetings/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meetings/store")>()),
  getMeeting: mocks.getMeeting,
  readMeetingLinkedSources: mocks.readLinkedSources,
  saveMeeting: mocks.saveMeeting,
}));
vi.mock("@/lib/meetings/commitment-store", () => ({
  createMeetingCommitmentProposal: mocks.createProposal,
  getMeetingCommitmentView: mocks.getProposal,
  listMeetingCommitmentViews: mocks.listProposals,
  recordMeetingCommitmentResolution: mocks.recordResolution,
}));
vi.mock("@/lib/app-services/projects", () => ({
  createWorkItemService: mocks.createWorkItem,
}));
vi.mock("@/lib/app-services/communications", () => ({
  createCommunicationDraftService: mocks.createDraft,
}));
vi.mock("@/lib/communications/store", () => ({
  listPersonContactPolicies: mocks.listPolicies,
  getMessageDraft: mocks.getDraft,
}));

import {
  createAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  listMeetingCommitmentsService,
  proposeMeetingCommitmentService,
  resolveMeetingCommitmentService,
} from "@/lib/app-services/meetings";
import {
  meetingCommitmentProposalId,
  withMeetingCommitmentProposalDigest,
} from "@/lib/meetings/commitment-contracts";
import { buildMeetingRevision } from "@/lib/meetings/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { SecurityContext } from "@/lib/security/types";

const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const workspaceId = `workspace:personal:${authUserId}`;
const meetingId = "meeting:22222222-2222-4222-8222-222222222222";
const timestamp = "2026-09-08T10:00:00.000Z";
const context = {
  tenantId: "tenant-meeting",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-meeting",
    tenantName: "Meeting tenant",
  },
} satisfies SecurityContext;
const participant = {
  participantId: "participant:owner",
  displayName: "Customer Owner",
  email: "customer@example.test",
  entityId: null,
  role: "required" as const,
  response: "accepted" as const,
  attendeeConsent: "granted" as const,
  recordingConsent: "granted" as const,
  consentCapturedAt: timestamp,
  source: "manual" as const,
};
const meeting = buildMeetingRevision({
  tenantId: context.tenantId,
  workspaceId,
  ownerActorId: canonicalActorId,
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
const actionItem = {
  actionItemId: `media-action:${"c".repeat(64)}`,
  text: "Send the customer the revised rollout plan.",
  citations: [{
    turnId: `media-turn:${"d".repeat(64)}`,
    segmentIndex: 0,
    startMilliseconds: 10_000,
    endMilliseconds: 12_000,
    speakerLabel: "A",
    speakerParticipantId: participant.participantId,
  }],
  ownerParticipantId: participant.participantId,
  dueAt: "2026-09-10T12:00:00.000Z",
  ownershipEvidence: "explicit" as const,
  dueDateEvidence: "explicit" as const,
};
const media = {
  tenantId: context.tenantId,
  meetingId,
  recordingId: "recording-1",
  mediaRevisionId: "recording-1:media:v1",
  outputSha256: "e".repeat(64),
  actionItems: [actionItem],
};
const proposalId = meetingCommitmentProposalId({
  tenantId: context.tenantId,
  workspaceId,
  meetingId,
  mediaRevisionId: media.mediaRevisionId,
  actionItemId: actionItem.actionItemId,
});
const proposal = withMeetingCommitmentProposalDigest({
  schemaVersion: 1,
  contractVersion: "p10.8-meeting-commitment-conversion:1",
  proposalId,
  tenantId: context.tenantId,
  workspaceId,
  meetingId,
  meetingRevisionId: meeting.meetingRevisionId,
  meetingSha256: meeting.meetingSha256,
  projectId: "project-1",
  sourceLinkId: "link:recording",
  recordingId: "recording-1",
  mediaRevisionId: media.mediaRevisionId,
  mediaOutputSha256: media.outputSha256,
  actionItemId: actionItem.actionItemId,
  actionItemSha256: canonicalJsonSha256(actionItem),
  title: actionItem.text,
  citations: actionItem.citations,
  ownership: {
    participantId: participant.participantId,
    displayName: participant.displayName,
    authority: "explicit_transcript",
  },
  dueDate: {
    dueAt: actionItem.dueAt,
    authority: "explicit_transcript",
  },
  proposedByActorId: canonicalActorId,
  proposedAt: timestamp,
});
const view = { proposal, resolution: null };
const policy = {
  id: "contact_policy:33333333-3333-4333-8333-333333333333",
  channel: "email",
  address: participant.email,
  status: "active",
  consent: "explicit",
  allowedPurposes: ["follow_up"],
  allowedDisclosure: "relationship_context",
};

function access() {
  return {
    actorBinding: {
      canonicalActorId,
      readableOwnerActorIds: [canonicalActorId, context.actorId],
    },
    authority: {
      workspaceId,
      accessLevel: "manager",
      canWrite: true,
      authoritySha256: "a".repeat(64),
    },
  };
}

function mutationCaller(idempotencyKey: string) {
  return createAppServiceCaller({
    context,
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      workspaceId,
      correlationId: idempotencyKey,
      purpose: "api.meeting.commitment",
    }),
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requestAccess.mockResolvedValue(access());
  mocks.getMeeting.mockResolvedValue(meeting);
  mocks.readLinkedSources.mockResolvedValue([{ media: { output: media } }]);
  mocks.createProposal.mockResolvedValue(view);
  mocks.getProposal.mockResolvedValue(view);
  mocks.listProposals.mockResolvedValue([view]);
  mocks.listPolicies.mockResolvedValue([policy]);
  mocks.createWorkItem.mockResolvedValue({
    data: { workItem: { id: "work-item-1" } },
    receipt: {},
  });
  mocks.createDraft.mockResolvedValue({
    data: { draft: { id: "message_draft:44444444-4444-4444-8444-444444444444" } },
    receipt: {},
  });
  mocks.saveMeeting.mockResolvedValue({ ...meeting, meetingRevisionId: `${meetingId}:v2`, revision: 2 });
  mocks.recordResolution.mockImplementation(async ({ proposal: source, resolution }) => ({
    proposal: source,
    resolution,
  }));
});

describe("meeting commitment app services", () => {
  it("lists actor-owned eligible policies next to evidence-bound proposals", async () => {
    const result = await listMeetingCommitmentsService(
      createAppServiceCaller({ context }),
      { meetingId },
    );
    expect(result.receipt.operation).toBe("app.meetings.commitments.list");
    expect(result.data.commitments).toEqual([view]);
    expect(result.data.eligiblePolicies).toEqual([policy]);
  });

  it("proposes only an exact media action without creating effects", async () => {
    const result = await proposeMeetingCommitmentService(
      mutationCaller("commitment-propose-1"),
      { meetingId, mediaRevisionId: media.mediaRevisionId, actionItemId: actionItem.actionItemId },
    );
    expect(result.receipt.operation).toBe("app.meetings.commitments.propose");
    expect(mocks.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      meeting,
      media,
      actionItem,
    }));
    expect(mocks.createWorkItem).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("confirms canonical work and an unsent governed draft exactly once", async () => {
    const communication = {
      policyId: policy.id,
      recipientParticipantId: participant.participantId,
      subject: "Follow-up: Customer review",
      body: "Here is the revised rollout plan we discussed.",
    };
    const result = await resolveMeetingCommitmentService(
      mutationCaller("commitment-confirm-1"),
      {
        meetingId,
        proposalId,
        expectedProposalSha256: proposal.proposalSha256,
        decision: "confirmed",
        communication,
      },
    );

    expect(result.receipt.operation).toBe("app.meetings.commitments.resolve");
    expect(mocks.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/:work$/) }),
      expect.objectContaining({
        projectId: "project-1",
        dueAt: actionItem.dueAt,
        detail: expect.stringContaining("Evidence: 0:10–0:12 Speaker A"),
      }),
    );
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/:draft$/) }),
      expect.objectContaining({
        policyId: policy.id,
        purpose: "follow_up",
        disclosure: "relationship_context",
      }),
    );
    expect(mocks.saveMeeting).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
      draft: expect.objectContaining({
        commitments: [expect.objectContaining({
          ownerParticipantId: participant.participantId,
        })],
        followUps: [expect.objectContaining({
          workItemId: "work-item-1",
          draftId: "message_draft:44444444-4444-4444-8444-444444444444",
        })],
      }),
    }));
    expect(result.data.commitment.resolution).toMatchObject({
      decision: "confirmed",
      ownershipAuthority: "explicit_transcript",
      dueDateAuthority: "explicit_transcript",
      workItemId: "work-item-1",
    });
  });
});
