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
  claimResolution: vi.fn(),
  recordPhase: vi.fn(),
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
  claimMeetingCommitmentResolution: mocks.claimResolution,
  recordMeetingCommitmentResolutionPhase: mocks.recordPhase,
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
  MeetingCommitmentReconciliationRequiredError,
} from "@/lib/app-services/meetings";
import {
  meetingCommitmentProposalId,
  meetingCommitmentResolutionId,
  withMeetingCommitmentProposalDigest,
  withMeetingCommitmentResolutionDigest,
} from "@/lib/meetings/commitment-contracts";
import {
  meetingResolutionIntentBody, meetingResolutionIntentSchema, meetingResolutionReconciliation,
  assertMeetingResolutionPhaseOrder,
  type MeetingResolutionIntent, type MeetingResolutionPhase,
} from "@/lib/meetings/commitment-resolution-intent";
import type { MeetingCommitmentView } from "@/lib/meetings/commitment-contracts";
import { messageDraftSchema } from "@/lib/communications/contracts";
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
let storedIntent: MeetingResolutionIntent | undefined;
let storedPhases: MeetingResolutionPhase[] = [];
let storedView: MeetingCommitmentView = view;
const policy = {
  id: "contact_policy:33333333-3333-4333-8333-333333333333",
  channel: "email",
  address: participant.email,
  status: "active",
  consent: "explicit",
  allowedPurposes: ["follow_up"],
  allowedDisclosure: "relationship_context",
};

function recordedConfirmation() {
  const communication = {
    policyId: policy.id,
    recipientParticipantId: participant.participantId,
    subject: "Follow-up: Customer review",
    body: "Here is the revised rollout plan we discussed.",
  };
  const body = {
    version: "p9.14-governed-communication:1",
    id: "message_draft:44444444-4444-4444-8444-444444444444",
    intentId: "communication_intent:55555555-5555-4555-8555-555555555555",
    policyId: policy.id,
    channel: "email",
    recipient: participant.email,
    subject: communication.subject,
    body: communication.body,
    senderIdentity: "connected_account",
    createdAt: timestamp,
  };
  const draft = messageDraftSchema.parse({
    ...body, state: "ready", lifecycleRevision: 1, updatedAt: timestamp,
    draftSha256: canonicalJsonSha256(body),
  });
  const resolution = withMeetingCommitmentResolutionDigest({
    schemaVersion: 1,
    contractVersion: "p10.8-meeting-commitment-conversion:1",
    resolutionId: meetingCommitmentResolutionId(proposalId),
    proposalId, proposalSha256: proposal.proposalSha256, decision: "confirmed",
    ownerParticipantId: participant.participantId, ownerDisplayName: participant.displayName,
    ownershipAuthority: "explicit_transcript", dueAt: actionItem.dueAt, dueDateAuthority: "explicit_transcript",
    workItemId: "work-item-existing", draftId: draft.id, communicationPolicyId: policy.id,
    meetingRevisionId: `${meetingId}:v2`, resolvedByActorId: canonicalActorId, resolvedAt: timestamp,
  });
  const commitment = { proposal, resolution };
  storedView = commitment;
  storedIntent = meetingResolutionIntentSchema.parse({
    ...meetingResolutionIntentBody({ tenantId: context.tenantId, workspaceId, meetingId, proposalId,
      proposalSha256: proposal.proposalSha256, ownerActorId: canonicalActorId,
      request: { decision: "confirmed", ownerParticipantId: participant.participantId, dueAt: actionItem.dueAt,
        communication: { ...communication, connectionId: null } }, }), createdAt: timestamp,
  });
  mocks.getDraft.mockResolvedValue(draft);
  return { communication, draft, commitment, input: {
    meetingId, proposalId, expectedProposalSha256: proposal.proposalSha256,
    decision: "confirmed" as const, communication,
  } };
}

function expectNoReplayedEffects() {
  expect(mocks.createWorkItem).not.toHaveBeenCalled();
  expect(mocks.createDraft).not.toHaveBeenCalled();
  expect(mocks.saveMeeting).not.toHaveBeenCalled();
  expect(mocks.recordResolution).not.toHaveBeenCalled();
}

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
  storedIntent = undefined;
  storedPhases = [];
  storedView = view;
  mocks.getProposal.mockImplementation(async () => storedView);
  mocks.claimResolution.mockImplementation(async ({ authority, proposal: source, request }) => {
    const candidate = meetingResolutionIntentSchema.parse({
      ...meetingResolutionIntentBody({ tenantId: authority.tenantId, workspaceId: authority.workspaceId,
        meetingId: source.meetingId, proposalId: source.proposalId, proposalSha256: source.proposalSha256,
        ownerActorId: authority.canonicalActorId, request }), createdAt: timestamp,
    });
    if (storedIntent) {
      if (storedIntent.requestSha256 !== candidate.requestSha256) throw new Error("This proposal is bound to a different immutable resolution request.");
      return { state: storedView.resolution ? "resolved" : "incomplete", intent: storedIntent, view: storedView };
    }
    if (storedView.resolution) return { state: "legacy", view: storedView };
    storedIntent = candidate;
    storedView = { ...storedView, reconciliation: meetingResolutionReconciliation(candidate, [], false) };
    return { state: "claimed", intent: candidate, view: storedView };
  });
  mocks.recordPhase.mockImplementation(async ({ intent, phase, resourceId, evidenceSha256 }) => {
    assertMeetingResolutionPhaseOrder(intent, storedPhases, phase);
    storedPhases.push({ phase, at: timestamp, resourceId: resourceId || null, evidenceSha256: evidenceSha256 || null });
    const reconciliation = meetingResolutionReconciliation(intent, storedPhases, false);
    storedView = { ...storedView, reconciliation };
    return reconciliation;
  });
  mocks.listProposals.mockImplementation(async () => [storedView]);
  mocks.listPolicies.mockResolvedValue([policy]);
  mocks.createWorkItem.mockResolvedValue({
    data: { workItem: { id: "work-item-1" } },
    receipt: { receiptSha256: "f".repeat(64) },
  });
  mocks.createDraft.mockResolvedValue({
    data: { draft: { id: "message_draft:44444444-4444-4444-8444-444444444444" } },
    receipt: { receiptSha256: "f".repeat(64) },
  });
  mocks.saveMeeting.mockResolvedValue({ ...meeting, meetingRevisionId: `${meetingId}:v2`, revision: 2 });
  mocks.recordResolution.mockImplementation(async ({ proposal: source, resolution, intent }) => {
    storedView = { proposal: source, resolution, reconciliation: meetingResolutionReconciliation(intent, storedPhases, true) };
    return storedView;
  });
});

describe("meeting commitment app services", () => {
  it("reconciles the exact original draft on replay without creating any effect", async () => {
    const recorded = recordedConfirmation();
    const result = await resolveMeetingCommitmentService(mutationCaller("replay-exact"), recorded.input);
    expect(result.data).toMatchObject({ commitment: recorded.commitment, draft: recorded.draft });
    expect(mocks.getMeeting).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId, workspaceId, canonicalActorId,
    }), meetingId);
    expect(mocks.getDraft).toHaveBeenCalledWith(recorded.draft.id, {
      tenantId: context.tenantId, actorId: context.actorId,
    });
    expectNoReplayedEffects();
  });

  it("compares the selected recipient's email case-insensitively", async () => {
    const recorded = recordedConfirmation();
    mocks.getMeeting.mockResolvedValue({ ...meeting, participants: [{ ...participant, email: " Customer@Example.Test " }] });
    await expect(resolveMeetingCommitmentService(mutationCaller("replay-email-case"), recorded.input)).resolves.toMatchObject({ data: { draft: recorded.draft } });
    expectNoReplayedEffects();
  });

  it.each(["another_recipient", "changed_email", "removed_participant", "unavailable_meeting", "wrong_channel", "changed_subject", "changed_body"])(
    "refuses replay with %s while preserving the existing effects",
    async (change) => {
      const recorded = recordedConfirmation();
      if (change === "another_recipient") {
        recorded.input.communication.recipientParticipantId = "participant:another";
        mocks.getMeeting.mockResolvedValue({ ...meeting, participants: [participant, { ...participant, participantId: "participant:another", email: "another@example.test" }] });
      } else if (change === "changed_email") {
        mocks.getMeeting.mockResolvedValue({ ...meeting, participants: [{ ...participant, email: "changed@example.test" }] });
      } else if (change === "removed_participant") {
        mocks.getMeeting.mockResolvedValue({ ...meeting, participants: [] });
      } else if (change === "unavailable_meeting") {
        mocks.getMeeting.mockResolvedValue(undefined);
      } else if (change === "wrong_channel") {
        mocks.getDraft.mockResolvedValue({ ...recorded.draft, channel: "message" });
      } else if (change === "changed_subject") {
        recorded.input.communication.subject = "A different subject";
      } else {
        recorded.input.communication.body = "A different message";
      }
      await expect(resolveMeetingCommitmentService(mutationCaller(`replay-${change}`), recorded.input)).rejects.toThrow(/different (draft|immutable resolution request)/);
      expectNoReplayedEffects();
    },
  );

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
  it("rejects a distinct recipient identity even when two participants share one email", async () => {
    const recorded = recordedConfirmation();
    mocks.getMeeting.mockResolvedValue({ ...meeting, participants: [participant, { ...participant, participantId: "participant:same-email" }] });
    await expect(resolveMeetingCommitmentService(mutationCaller("same-email-drift"), {
      ...recorded.input, communication: { ...recorded.communication, recipientParticipantId: "participant:same-email" },
    })).rejects.toThrow("different immutable resolution request");
    expectNoReplayedEffects();
  });

  it("keeps legacy accepted communication readable but refuses a new recipient receipt", async () => {
    const recorded = recordedConfirmation();
    storedIntent = undefined;
    const listed = await listMeetingCommitmentsService(createAppServiceCaller({ context }), { meetingId });
    expect(listed.data.commitments[0].resolution).toEqual(recorded.commitment.resolution);
    await expect(resolveMeetingCommitmentService(mutationCaller("legacy"), recorded.input))
      .rejects.toThrow("no exact recipient decision receipt");
    expect(storedIntent).toBeUndefined();
    expectNoReplayedEffects();
  });

  it("commits the decision before a child and prevents a concurrent identical resolution", async () => {
    let signalStarted!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    mocks.createWorkItem.mockImplementation(async () => {
      expect(storedIntent).toBeDefined();
      expect(storedPhases.map((phase) => phase.phase)).toEqual(["work_started"]);
      signalStarted();
      await held;
      return { data: { workItem: { id: "work-item-1" } }, receipt: { receiptSha256: "f".repeat(64) } };
    });
    const input = { meetingId, proposalId, expectedProposalSha256: proposal.proposalSha256, decision: "confirmed" as const };
    const first = resolveMeetingCommitmentService(mutationCaller("concurrent-one"), input);
    await started;
    await expect(resolveMeetingCommitmentService(mutationCaller("concurrent-two"), input))
      .rejects.toBeInstanceOf(MeetingCommitmentReconciliationRequiredError);
    expect(mocks.createWorkItem).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ data: { commitment: { resolution: { decision: "confirmed" } } } });
    expect(mocks.saveMeeting).toHaveBeenCalledTimes(1);
    expect(mocks.recordResolution).toHaveBeenCalledTimes(1);
  });

  it("retains a completed Work receipt when draft creation fails and never repeats either child", async () => {
    mocks.createDraft.mockRejectedValue(new Error("Connection closed; outcome unknown"));
    const input = { meetingId, proposalId, expectedProposalSha256: proposal.proposalSha256,
      decision: "confirmed" as const, communication: { policyId: policy.id, recipientParticipantId: participant.participantId, subject: "Reviewed follow-up", body: "Reviewed content" } };
    await expect(resolveMeetingCommitmentService(mutationCaller("partial-one"), input))
      .rejects.toBeInstanceOf(MeetingCommitmentReconciliationRequiredError);
    const listed = await listMeetingCommitmentsService(createAppServiceCaller({ context }), { meetingId });
    expect(listed.data.commitments[0]).toMatchObject({ resolution: null, reconciliation: {
      state: "uncertain", automaticRetryAllowed: false,
      phases: expect.arrayContaining([{ phase: "work_completed", at: timestamp, resourceId: "work-item-1", evidenceSha256: "f".repeat(64) }]),
    } });
    await expect(resolveMeetingCommitmentService(mutationCaller("partial-two"), input))
      .rejects.toBeInstanceOf(MeetingCommitmentReconciliationRequiredError);
    expect(mocks.createWorkItem).toHaveBeenCalledTimes(1);
    expect(mocks.createDraft).toHaveBeenCalledTimes(1);
    expect(mocks.saveMeeting).not.toHaveBeenCalled();
    expect(mocks.recordResolution).not.toHaveBeenCalled();
  });

  it("records an unknown child outcome without inventing a completion receipt", async () => {
    mocks.createWorkItem.mockRejectedValue(new Error("Response lost after child dispatch"));
    const input = { meetingId, proposalId, expectedProposalSha256: proposal.proposalSha256, decision: "confirmed" as const };
    await expect(resolveMeetingCommitmentService(mutationCaller("lost-one"), input))
      .rejects.toMatchObject({ reconciliationCode: "meeting_commitment_reconciliation_required" });
    expect(storedPhases.map((phase) => phase.phase)).toEqual(["work_started", "interrupted"]);
    expect(storedPhases.every((phase) => phase.resourceId === null)).toBe(true);
    await expect(resolveMeetingCommitmentService(mutationCaller("lost-two"), input)).rejects.toThrow("no child action");
    expect(mocks.createWorkItem).toHaveBeenCalledTimes(1);
  });

  it("validates a selected communication policy before claiming any effects", async () => {
    mocks.listPolicies.mockResolvedValue([]);
    await expect(resolveMeetingCommitmentService(mutationCaller("invalid-policy"), {
      meetingId, proposalId, expectedProposalSha256: proposal.proposalSha256, decision: "confirmed",
      communication: { policyId: policy.id, recipientParticipantId: participant.participantId, subject: "Reviewed subject", body: "Reviewed content" },
    })).rejects.toThrow("eligible follow-up");
    expect(mocks.claimResolution).not.toHaveBeenCalled();
    expect(mocks.createWorkItem).not.toHaveBeenCalled();
  });

});
