import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  createAppServiceCaller,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { createCommunicationDraftService } from "@/lib/app-services/communications";
import { createWorkItemService } from "@/lib/app-services/projects";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { listPersonContactPolicies, getMessageDraft } from "@/lib/communications/store";
import type { CaptureMediaOutput } from "@/lib/capture/media-contracts";
import {
  meetingCommitmentResolutionId,
  withMeetingCommitmentResolutionDigest,
  type MeetingCommitmentResolution,
  type MeetingCommitmentView,
} from "@/lib/meetings/commitment-contracts";
import {
  createMeetingCommitmentProposal,
  claimMeetingCommitmentResolution,
  recordMeetingCommitmentResolutionPhase,
  getMeetingCommitmentView,
  listMeetingCommitmentViews,
  recordMeetingCommitmentResolution,
} from "@/lib/meetings/commitment-store";
import {
  type MeetingResolutionDecision, type MeetingResolutionIntent,
  type MeetingResolutionPhase, type MeetingResolutionReconciliation,
} from "@/lib/meetings/commitment-resolution-intent";
import {
  meetingDraftInputSchema,
  meetingRevisionSchema,
  type MeetingRevision,
} from "@/lib/meetings/contracts";
import {
  getMeeting,
  listMeetings,
  readMeetingLinkedSources,
  saveMeeting,
  MeetingConflictError,
  MeetingNotFoundError,
  type MeetingLinkedSourceView,
  type MeetingMutationAuthority,
} from "@/lib/meetings/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  requestSharedMemoryAccessFromSecurityContext,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { redactSensitive } from "@/lib/security/context";
import {
  createExecutionScope,
  deriveExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const workspaceSelectionSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const meetingListServiceInputSchema = workspaceSelectionSchema.extend({
  status: meetingRevisionSchema.shape.status.optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export const meetingShowServiceInputSchema = workspaceSelectionSchema.extend({
  meetingId: z.string().trim().min(1).max(240),
}).strict();

export const meetingCreateServiceInputSchema = meetingDraftInputSchema.extend({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const meetingUpdateServiceInputSchema = meetingDraftInputSchema.extend({
  workspaceId: z.string().trim().min(1).max(240).optional(),
  meetingId: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const meetingCommitmentListServiceInputSchema = workspaceSelectionSchema.extend({
  meetingId: z.string().trim().min(1).max(240),
}).strict();

export const meetingCommitmentProposeServiceInputSchema =
  meetingCommitmentListServiceInputSchema.extend({
    mediaRevisionId: z.string().trim().min(1).max(260),
    actionItemId: z.string().regex(/^media-action:[a-f0-9]{64}$/),
  }).strict();

const commitmentCommunicationSchema = z.object({
  connectionId: z.string().uuid().optional(),
  policyId: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/),
  recipientParticipantId: z.string().trim().min(1).max(240),
  subject: z.string().trim().min(1).max(998).refine((value) => !/[\r\n]/.test(value)),
  body: z.string().trim().min(1).max(50_000),
}).strict();

export const meetingCommitmentResolveServiceInputSchema = z.discriminatedUnion(
  "decision",
  [
    meetingCommitmentListServiceInputSchema.extend({
      proposalId: z.string().regex(/^meeting-commitment-proposal:[a-f0-9]{64}$/),
      expectedProposalSha256: z.string().regex(/^[a-f0-9]{64}$/),
      decision: z.literal("dismissed"),
    }).strict(),
    meetingCommitmentListServiceInputSchema.extend({
      proposalId: z.string().regex(/^meeting-commitment-proposal:[a-f0-9]{64}$/),
      expectedProposalSha256: z.string().regex(/^[a-f0-9]{64}$/),
      decision: z.literal("confirmed"),
      ownerParticipantId: z.string().trim().min(1).max(240).optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional(),
      communication: commitmentCommunicationSchema.nullable().default(null),
    }).strict(),
  ],
);

export class MeetingWriteDeniedError extends Error {
  constructor() {
    super("Meeting contributor access is required.");
    this.name = "MeetingWriteDeniedError";
  }
}

export async function listMeetingsService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingListServiceInputSchema>,
) {
  const value = meetingListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.list"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "read");
  const meetings = await listMeetings(readAuthority(caller, access), {
    limit: value.limit,
    status: value.status,
  });
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meetings,
  }, { resourceCount: meetings.length });
}

export async function showMeetingService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingShowServiceInputSchema>,
) {
  const value = meetingShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.show"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "read");
  const authority = readAuthority(caller, access);
  const meeting = await getMeeting(authority, value.meetingId);
  const linkedSources = meeting
    ? await readMeetingLinkedSources(authority, meeting)
    : [];
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting: meeting || null,
    linkedSources,
  }, { resourceCount: meeting ? 1 : 0 });
}

export async function createMeetingService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingCreateServiceInputSchema>,
) {
  const value = redactSensitive(
    meetingCreateServiceInputSchema.parse(input),
  ) as z.output<typeof meetingCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.create"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "write");
  requireMeetingWrite(access);
  const { workspaceId: _workspaceId, ...draft } = value;
  void _workspaceId;
  const authority = mutationAuthority(caller, access);
  const meeting = await saveMeeting({
    authority,
    draft,
  });
  const linkedSources = await readMeetingLinkedSources(authority, meeting);
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting,
    linkedSources,
  });
}

export async function updateMeetingService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingUpdateServiceInputSchema>,
) {
  const value = redactSensitive(
    meetingUpdateServiceInputSchema.parse(input),
  ) as z.output<typeof meetingUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.update"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "write");
  requireMeetingWrite(access);
  const {
    workspaceId: _workspaceId,
    meetingId,
    expectedRevision,
    ...draft
  } = value;
  void _workspaceId;
  const authority = mutationAuthority(caller, access);
  const meeting = await saveMeeting({
    authority,
    draft,
    meetingId,
    expectedRevision,
  });
  const linkedSources = await readMeetingLinkedSources(authority, meeting);
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting,
    linkedSources,
  });
}

export async function listMeetingCommitmentsService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingCommitmentListServiceInputSchema>,
) {
  const value = meetingCommitmentListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.commitments.list"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "read");
  const authority = readAuthority(caller, access);
  const meeting = await getMeeting(authority, value.meetingId);
  if (!meeting) return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting: null,
    commitments: [],
    eligiblePolicies: [],
  }, { resourceCount: 0 });
  const [commitments, policies] = await Promise.all([
    listMeetingCommitmentViews(authority, meeting.meetingId),
    listPersonContactPolicies({
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
    }),
  ]);
  const participantEmails = new Set(meeting.participants.flatMap((participant) =>
    participant.email ? [participant.email.trim().toLocaleLowerCase("en-US")] : []
  ));
  const eligiblePolicies = policies.filter((policy) =>
    policy.channel === "email" &&
    policy.status === "active" &&
    policy.consent !== "unknown" &&
    policy.allowedPurposes.includes("follow_up") &&
    policy.allowedDisclosure !== "public_only" &&
    participantEmails.has(policy.address.trim().toLocaleLowerCase("en-US"))
  );
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting: meetingSummaryForCommitments(meeting),
    commitments,
    eligiblePolicies,
  }, { resourceCount: commitments.length });
}

export async function proposeMeetingCommitmentService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingCommitmentProposeServiceInputSchema>,
) {
  const value = meetingCommitmentProposeServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.commitments.propose"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "write");
  requireMeetingWrite(access);
  const authority = mutationAuthority(caller, access, "meeting.commitment.propose");
  const meeting = await getMeeting(authority, value.meetingId);
  if (!meeting) throw new MeetingNotFoundError();
  const sources = await readMeetingLinkedSources(authority, meeting);
  const media = findCommitmentMedia(sources, value.mediaRevisionId);
  const actionItem = media.actionItems.find((item) =>
    item.actionItemId === value.actionItemId
  );
  if (!actionItem) {
    throw new MeetingConflictError("The cited media action item was not found.");
  }
  const commitment = await createMeetingCommitmentProposal({
    authority,
    meeting,
    media,
    actionItem,
  });
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    commitment,
  });
}

export class MeetingCommitmentReconciliationRequiredError extends MeetingConflictError {
  readonly reconciliationCode = "meeting_commitment_reconciliation_required";
  constructor(readonly reconciliation?: MeetingResolutionReconciliation, legacy = false) {
    super(legacy
      ? "This accepted legacy resolution has no exact recipient decision receipt. Inspect its existing effects; it cannot accept a new recipient identity."
      : "This resolution was already claimed and may have partial or uncertain effects. Refresh its phase receipts; no child action will run again automatically.");
    this.name = "MeetingCommitmentReconciliationRequiredError";
  }
}

export async function resolveMeetingCommitmentService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingCommitmentResolveServiceInputSchema>,
) {
  const value = meetingCommitmentResolveServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.meetings.commitments.resolve"));
  const access = await meetingAccess(caller, value.workspaceId, "write");
  requireMeetingWrite(access);
  const authority = mutationAuthority(caller, access, "meeting.commitment.resolve");
  const view = await getMeetingCommitmentView(authority, value.meetingId, value.proposalId);
  if (!view || view.proposal.proposalSha256 !== value.expectedProposalSha256) {
    throw new MeetingConflictError("The exact commitment proposal was not found.");
  }
  const selectedOwnerId = value.decision === "confirmed"
    ? value.ownerParticipantId || view.proposal.ownership.participantId : null;
  if (value.decision === "confirmed" && !selectedOwnerId) {
    throw new MeetingConflictError("Confirm one current meeting participant as the owner.");
  }
  const selectedDueAt = value.decision === "dismissed" ? null : value.dueAt === undefined
    ? view.proposal.dueDate.dueAt : value.dueAt ? new Date(value.dueAt).toISOString() : null;
  const request: MeetingResolutionDecision = value.decision === "dismissed" ? { decision: "dismissed" } : {
    decision: "confirmed", ownerParticipantId: selectedOwnerId!, dueAt: selectedDueAt,
    communication: value.communication ? { ...value.communication, connectionId: value.communication.connectionId || null } : null,
  };
  const claim = () => claimMeetingCommitmentResolution({ authority, proposal: view.proposal, request });
  const replay = async (result: Awaited<ReturnType<typeof claim>>) => {
    if (result.state === "incomplete") throw new MeetingCommitmentReconciliationRequiredError(result.view.reconciliation);
    if (!result.view.resolution) throw new MeetingConflictError("The accepted resolution is unavailable.");
    if (result.state === "legacy" && (result.view.resolution.draftId || value.decision === "confirmed" && value.communication)) {
      throw new MeetingCommitmentReconciliationRequiredError(undefined, true);
    }
    const draft = await assertResolutionReplay(caller, authority, {
      ...result.view, resolution: result.view.resolution,
    }, value);
    return completeAppServiceCall(authorized, { context: publicMeetingContext(access), commitment: result.view, ...(draft ? { draft } : {}) });
  };
  // Existing claims are reconciled before validating a new decision against
  // mutable meeting state. Only the invocation that inserted a claim may act.
  if (view.resolution || view.reconciliation) return replay(await claim());

  const meeting = value.decision === "confirmed" ? await getMeeting(authority, value.meetingId) : undefined;
  const selectedOwner = meeting?.participants.find((participant) => participant.participantId === selectedOwnerId);
  if (value.decision === "confirmed") {
    if (!meeting) throw new MeetingNotFoundError();
    if (meeting.projectId !== view.proposal.projectId) throw new MeetingConflictError("The meeting project changed. Create a fresh proposal.");
    if (!selectedOwner) throw new MeetingConflictError("Confirm one current meeting participant as the owner.");
    const sources = await readMeetingLinkedSources(authority, meeting);
    const media = findCommitmentMedia(sources, view.proposal.mediaRevisionId);
    const action = media.actionItems.find((item) => item.actionItemId === view.proposal.actionItemId);
    if (media.outputSha256 !== view.proposal.mediaOutputSha256 || !action || canonicalJsonSha256(action) !== view.proposal.actionItemSha256) {
      throw new MeetingConflictError("The commitment evidence changed. Create a fresh proposal.");
    }
    if (value.communication) await eligibleCommitmentPolicy(caller, meeting, value.communication);
  }
  const claimed = await claim();
  if (claimed.state !== "claimed") return replay(claimed);
  const intent: MeetingResolutionIntent = claimed.intent;
  let reconciliation = claimed.view.reconciliation;
  const phase = async (name: MeetingResolutionPhase["phase"], resourceId?: string, evidenceSha256?: string) => {
    reconciliation = await recordMeetingCommitmentResolutionPhase({ authority, intent, phase: name, resourceId, evidenceSha256 });
  };
  try {
    if (value.decision === "dismissed") {
      await phase("resolution_started");
      const commitment = await recordMeetingCommitmentResolution({
        authority, proposal: view.proposal, intent,
        resolution: dismissedResolution(view, authority.canonicalActorId),
      });
      return completeAppServiceCall(authorized, { context: publicMeetingContext(access), commitment });
    }
    // Each phase is persisted before and after its child boundary. These are
    // separate transactions; a missing acknowledgement is never replay authority.
    const exactMeeting = meeting!, exactOwner = selectedOwner!;
    const ownershipAuthority = exactOwner.participantId === view.proposal.ownership.participantId &&
      view.proposal.ownership.authority === "explicit_transcript" ? "explicit_transcript" as const : "user_confirmed" as const;
    const dueDateAuthority = selectedDueAt === null ? null : selectedDueAt === view.proposal.dueDate.dueAt &&
      view.proposal.dueDate.authority === "explicit_transcript" ? "explicit_transcript" as const : "user_confirmed" as const;
    const operationKey = commitmentOperationKey(view.proposal.proposalSha256);
    await phase("work_started");
    const workResult = await createWorkItemService(
      childCaller(caller, `${operationKey}:work`, view.proposal.projectId, "meeting.commitment.work_item"),
      { projectId: view.proposal.projectId, title: commitmentWorkItemTitle(view),
        detail: commitmentWorkItemDetail(exactMeeting, view, exactOwner.displayName), priority: "medium", agentId: "atlas",
        ...(selectedDueAt ? { dueAt: selectedDueAt } : {}), },
    );
    const workItem = workResult.data.workItem;
    if (!workItem) throw new MeetingConflictError("The canonical WorkItem could not be created.");
    await phase("work_completed", workItem.id, workResult.receipt.receiptSha256);
    const draftResult = value.communication ? await (async () => {
      await phase("draft_started");
      const result = await createCommitmentDraft(caller, exactMeeting, value.communication!, `${operationKey}:draft`);
      await phase("draft_completed", result.data.draft.id, result.receipt.receiptSha256);
      return result;
    })() : null;
    const draft = draftResult?.data.draft || null;
    await phase("meeting_started");
    const savedMeeting = await attachCommitmentFollowUp({
      authority, meeting: exactMeeting, view, ownerParticipantId: exactOwner.participantId,
      dueAt: selectedDueAt, workItemId: workItem.id, draftId: draft?.id || null, operationKey,
    });
    await phase("meeting_completed", savedMeeting.meetingRevisionId, savedMeeting.meetingSha256);
    const resolution = withMeetingCommitmentResolutionDigest({
      schemaVersion: 1, contractVersion: "p10.8-meeting-commitment-conversion:1",
      resolutionId: meetingCommitmentResolutionId(view.proposal.proposalId),
      proposalId: view.proposal.proposalId, proposalSha256: view.proposal.proposalSha256,
      decision: "confirmed", ownerParticipantId: exactOwner.participantId, ownerDisplayName: exactOwner.displayName,
      ownershipAuthority, dueAt: selectedDueAt, dueDateAuthority, workItemId: workItem.id,
      draftId: draft?.id || null, communicationPolicyId: value.communication?.policyId || null,
      meetingRevisionId: savedMeeting.meetingRevisionId, resolvedByActorId: authority.canonicalActorId, resolvedAt: new Date().toISOString(),
    });
    await phase("resolution_started");
    const commitment = await recordMeetingCommitmentResolution({ authority, proposal: view.proposal, resolution, intent });
    return completeAppServiceCall(authorized, { context: publicMeetingContext(access), commitment, workItem, draft, meeting: savedMeeting });
  } catch {
    // Even the progress write may be uncertain. Preserve the last durable phase
    // and return a bounded reconciliation-required error, never a retry promise.
    await phase("interrupted").catch(() => undefined);
    throw new MeetingCommitmentReconciliationRequiredError(reconciliation);
  }
}

function findCommitmentMedia(
  sources: readonly MeetingLinkedSourceView[],
  mediaRevisionId: string,
) {
  const output = sources.find((source) =>
    source.media?.output?.mediaRevisionId === mediaRevisionId
  )?.media?.output;
  if (!output) {
    throw new MeetingConflictError("The exact processed media revision was not found.");
  }
  return output as CaptureMediaOutput;
}

function meetingSummaryForCommitments(meeting: MeetingRevision) {
  return Object.freeze({
    meetingId: meeting.meetingId,
    meetingRevisionId: meeting.meetingRevisionId,
    revision: meeting.revision,
    title: meeting.title,
    projectId: meeting.projectId,
    participants: meeting.participants,
  });
}

function childCaller(
  caller: AppServiceCaller,
  idempotencyKey: string,
  projectId: string,
  purpose: string,
) {
  return createAppServiceCaller({
    context: caller.context,
    idempotencyKey,
    executionScope: deriveExecutionScope(caller.executionScope!, {
      workspaceId: caller.executionScope?.workspaceId,
      projectId,
      purpose,
    }),
  });
}

async function eligibleCommitmentPolicy(
  caller: AppServiceCaller,
  meeting: MeetingRevision,
  communication: z.output<typeof commitmentCommunicationSchema>,
) {
  const recipient = meeting.participants.find((participant) =>
    participant.participantId === communication.recipientParticipantId
  );
  if (!recipient?.email) {
    throw new MeetingConflictError("The selected follow-up recipient has no meeting email.");
  }
  const policies = await listPersonContactPolicies({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
  });
  const policy = policies.find((candidate) => candidate.id === communication.policyId);
  if (
    !policy ||
    policy.channel !== "email" ||
    policy.status !== "active" ||
    policy.consent === "unknown" ||
    !policy.allowedPurposes.includes("follow_up") ||
    policy.allowedDisclosure === "public_only" ||
    policy.address.trim().toLocaleLowerCase("en-US") !==
      recipient.email.trim().toLocaleLowerCase("en-US")
  ) {
    throw new MeetingConflictError(
      "The selected recipient does not have an eligible follow-up communication policy.",
    );
  }
  return policy;
}

async function createCommitmentDraft(
  caller: AppServiceCaller,
  meeting: MeetingRevision,
  communication: z.output<typeof commitmentCommunicationSchema>,
  idempotencyKey: string,
) {
  const policy = await eligibleCommitmentPolicy(caller, meeting, communication);
  const result = await createCommunicationDraftService(
    childCaller(caller, idempotencyKey, meeting.projectId!, "meeting.commitment.draft"),
    {
      connectionId: communication.connectionId,
      policyId: policy.id,
      purpose: "follow_up",
      disclosure: "relationship_context",
      subject: communication.subject,
      body: communication.body,
    },
  );
  return result;
}

async function attachCommitmentFollowUp(input: {
  authority: MeetingMutationAuthority;
  meeting: MeetingRevision;
  view: MeetingCommitmentView;
  ownerParticipantId: string;
  dueAt: string | null;
  workItemId: string;
  draftId: string | null;
  operationKey: string;
}) {
  const identitySha256 = canonicalJsonSha256({
    proposalId: input.view.proposal.proposalId,
  });
  const commitmentId = `meeting-commitment:${identitySha256}`;
  const followUpId = `meeting-follow-up:${identitySha256}`;
  const commitment = {
    commitmentId,
    summary: input.view.proposal.title.slice(0, 2_000),
    ownerParticipantId: input.ownerParticipantId,
    dueAt: input.dueAt,
    sourceLinkId: input.view.proposal.sourceLinkId,
  };
  const followUp = {
    followUpId,
    label: input.view.proposal.title.slice(0, 500),
    status: "accepted" as const,
    workItemId: input.workItemId,
    draftId: input.draftId,
    commitmentId,
  };
  const priorCommitment = input.meeting.commitments.find((item) =>
    item.commitmentId === commitmentId
  );
  const priorFollowUp = input.meeting.followUps.find((item) =>
    item.followUpId === followUpId
  );
  if (priorCommitment || priorFollowUp) {
    if (
      canonicalJsonSha256(priorCommitment) !== canonicalJsonSha256(commitment) ||
      canonicalJsonSha256(priorFollowUp) !== canonicalJsonSha256(followUp)
    ) {
      throw new MeetingConflictError("The meeting follow-up is bound to different effects.");
    }
    return input.meeting;
  }
  const meetingAuthority = {
    ...input.authority,
    idempotencyKey: `${input.operationKey}:meeting`,
    executionScope: deriveExecutionScope(input.authority.executionScope, {
      projectId: input.meeting.projectId,
      purpose: "meeting.commitment.attach",
    }),
  };
  return saveMeeting({
    authority: meetingAuthority,
    meetingId: input.meeting.meetingId,
    expectedRevision: input.meeting.revision,
    draft: {
      title: input.meeting.title,
      summary: input.meeting.summary,
      status: input.meeting.status,
      scheduledStartAt: input.meeting.scheduledStartAt,
      scheduledEndAt: input.meeting.scheduledEndAt,
      actualStartAt: input.meeting.actualStartAt,
      actualEndAt: input.meeting.actualEndAt,
      timezone: input.meeting.timezone,
      location: input.meeting.location,
      projectId: input.meeting.projectId,
      declaredAccessClass: input.meeting.declaredAccessClass,
      participants: input.meeting.participants,
      sourceLinks: input.meeting.sourceLinks.map((link) => ({
        linkId: link.linkId,
        kind: link.kind,
        sourceId: link.sourceId,
        ...(["capture_recording", "capture_asset"].includes(link.kind)
          ? {}
          : { sourceRevisionId: link.sourceRevisionId }),
        mediaRole: link.mediaRole,
        label: link.label,
      })),
      entityLinks: input.meeting.entityLinks,
      decisions: input.meeting.decisions,
      commitments: [...input.meeting.commitments, commitment],
      followUps: [...input.meeting.followUps, followUp],
    },
  });
}

function commitmentOperationKey(proposalSha256: string) {
  return `meeting-commitment:${proposalSha256}`;
}

function commitmentWorkItemTitle(view: MeetingCommitmentView) {
  const suffix = ` · Meeting ${view.proposal.proposalSha256.slice(0, 8)}`;
  const normalized = view.proposal.title.replace(/\s+/g, " ").trim();
  return `${normalized.slice(0, 240 - suffix.length).trimEnd()}${suffix}`;
}

function commitmentWorkItemDetail(
  meeting: MeetingRevision,
  view: MeetingCommitmentView,
  ownerDisplayName: string,
) {
  const citations = view.proposal.citations.slice(0, 4).map((citation) =>
    `${formatMediaTime(citation.startMilliseconds)}–${formatMediaTime(citation.endMilliseconds)} ` +
    `Speaker ${citation.speakerLabel}`
  ).join("; ");
  return [
    `Confirmed from meeting: ${meeting.title}`,
    `Commitment owner: ${ownerDisplayName}`,
    `Evidence: ${citations}`,
    `Proposal: ${view.proposal.proposalId}`,
  ].join("\n").slice(0, 1_000);
}

function formatMediaTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function dismissedResolution(
  view: MeetingCommitmentView,
  actorId: string,
): MeetingCommitmentResolution {
  return withMeetingCommitmentResolutionDigest({
    schemaVersion: 1,
    contractVersion: "p10.8-meeting-commitment-conversion:1",
    resolutionId: meetingCommitmentResolutionId(view.proposal.proposalId),
    proposalId: view.proposal.proposalId,
    proposalSha256: view.proposal.proposalSha256,
    decision: "dismissed",
    ownerParticipantId: null,
    ownerDisplayName: null,
    ownershipAuthority: null,
    dueAt: null,
    dueDateAuthority: null,
    workItemId: null,
    draftId: null,
    communicationPolicyId: null,
    meetingRevisionId: null,
    resolvedByActorId: actorId,
    resolvedAt: new Date().toISOString(),
  });
}

async function assertResolutionReplay(
  caller: AppServiceCaller,
  authority: MeetingMutationAuthority,
  view: MeetingCommitmentView & { resolution: MeetingCommitmentResolution },
  value: z.output<typeof meetingCommitmentResolveServiceInputSchema>,
) {
  const resolution = view.resolution;
  if (resolution.decision !== value.decision) {
    throw new MeetingConflictError("This commitment proposal is already resolved.");
  }
  if (value.decision === "dismissed") return;
  const expectedOwner = value.ownerParticipantId || view.proposal.ownership.participantId;
  const expectedDueAt = value.dueAt === undefined
    ? view.proposal.dueDate.dueAt
    : value.dueAt
      ? new Date(value.dueAt).toISOString()
      : null;
  if (
    resolution.ownerParticipantId !== expectedOwner ||
    resolution.dueAt !== expectedDueAt ||
    resolution.communicationPolicyId !== (value.communication?.policyId || null) ||
    Boolean(resolution.draftId) !== Boolean(value.communication)
  ) {
    throw new MeetingConflictError("This commitment confirmation is bound to different effects.");
  }
  if (value.communication && resolution.draftId) {
    // A replay reconciles the original draft; it must not confirm a different
    // selected participant merely because the policy and message text match.
    const meeting = await getMeeting(authority, view.proposal.meetingId);
    const recipient = meeting?.participants.find((participant) =>
      participant.participantId === value.communication?.recipientParticipantId
    );
    const draft = await getMessageDraft(resolution.draftId, {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
    });
    if (
      !draft ||
      !recipient?.email ||
      draft.channel !== "email" ||
      draft.recipient.trim().toLocaleLowerCase("en-US") !==
        recipient.email.trim().toLocaleLowerCase("en-US") ||
      (value.communication.connectionId &&
        draft.googleConnectionId !== value.communication.connectionId) ||
      draft.policyId !== value.communication.policyId ||
      draft.subject !== value.communication.subject ||
      draft.body !== value.communication.body
    ) {
      throw new MeetingConflictError("This confirmation is bound to a different draft.");
    }
    return draft;
  }
}

async function meetingAccess(
  caller: AppServiceCaller,
  workspaceId: string | undefined,
  mode: "read" | "write",
) {
  return requestSharedMemoryAccessFromSecurityContext(caller.context, {
    scope: "workspace",
    workspaceId,
    correlationId:
      caller.executionScope?.correlationId || caller.idempotencyKey || crypto.randomUUID(),
    purposeId: mode === "write" ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: `${mode === "write" ? "Manage" : "Read"} source-governed meetings.`,
  });
}

function requireMeetingWrite(access: RequestSharedMemoryAccessV1) {
  if (!access.authority.canWrite) throw new MeetingWriteDeniedError();
}

function readAuthority(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
) {
  return {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
    readableActorIds: access.actorBinding.readableOwnerActorIds,
  };
}

function mutationAuthority(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
  purpose = "meeting.write",
): MeetingMutationAuthority {
  const source = caller.executionScope!;
  return {
    ...readAuthority(caller, access),
    idempotencyKey: caller.idempotencyKey!,
    executionScope: createExecutionScope({
      tenantId: caller.context.tenantId,
      initiatingActorId: access.actorBinding.canonicalActorId,
      executingPrincipalType: source.executingPrincipalType,
      executingPrincipalId: source.executingPrincipalType === "user"
        ? access.actorBinding.canonicalActorId
        : source.executingPrincipalId,
      workspaceId: access.authority.workspaceId,
      correlationId: source.correlationId,
      causationId: source.causationId,
      delegationId: source.delegationId,
      contextGrantIds: source.contextGrantIds,
      capabilityGrantIds: source.capabilityGrantIds,
      purpose,
    }),
  };
}

function publicMeetingContext(access: RequestSharedMemoryAccessV1) {
  return Object.freeze({
    scope: "workspace" as const,
    workspaceId: access.authority.workspaceId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  });
}
