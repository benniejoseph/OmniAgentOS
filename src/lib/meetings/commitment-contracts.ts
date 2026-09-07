import { z } from "zod";

import { captureMediaCitationSchema } from "@/lib/capture/media-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const MEETING_COMMITMENT_CONVERSION_VERSION =
  "p10.8-meeting-commitment-conversion:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().trim().min(1).max(240);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);

const ownershipEvidenceSchema = z.object({
  participantId: opaqueIdSchema.nullable(),
  displayName: z.string().trim().min(1).max(160).nullable(),
  authority: z.enum(["explicit_transcript", "confirmation_required"]),
}).strict().superRefine((value, context) => {
  const hasOwner = value.participantId !== null || value.displayName !== null;
  if (hasOwner !== (value.participantId !== null && value.displayName !== null)) {
    context.addIssue({
      code: "custom",
      message: "A proposed owner requires both participant identity and display name.",
    });
  }
  if (value.authority === "explicit_transcript" && !value.participantId) {
    context.addIssue({
      code: "custom",
      path: ["participantId"],
      message: "Transcript ownership evidence requires an exact participant.",
    });
  }
  if (value.authority === "confirmation_required" && value.participantId) {
    context.addIssue({
      code: "custom",
      path: ["authority"],
      message: "Unconfirmed ownership cannot name a participant.",
    });
  }
});

const dueDateEvidenceSchema = z.object({
  dueAt: canonicalTimestampSchema.nullable(),
  authority: z.enum(["explicit_transcript", "confirmation_required"]),
}).strict().superRefine((value, context) => {
  if ((value.authority === "explicit_transcript") !== (value.dueAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["dueAt"],
      message: "Only an explicitly evidenced due date may enter a proposal.",
    });
  }
});

const meetingCommitmentProposalBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(MEETING_COMMITMENT_CONVERSION_VERSION),
  proposalId: z.string().regex(/^meeting-commitment-proposal:[a-f0-9]{64}$/),
  tenantId: z.string().trim().min(1).max(160),
  workspaceId: opaqueIdSchema,
  meetingId: z.string().regex(/^meeting:[0-9a-f-]{36}$/),
  meetingRevisionId: opaqueIdSchema,
  meetingSha256: sha256Schema,
  projectId: opaqueIdSchema,
  sourceLinkId: opaqueIdSchema,
  recordingId: opaqueIdSchema,
  mediaRevisionId: opaqueIdSchema,
  mediaOutputSha256: sha256Schema,
  actionItemId: z.string().regex(/^media-action:[a-f0-9]{64}$/),
  actionItemSha256: sha256Schema,
  title: z.string().trim().min(1).max(12_000),
  citations: z.array(captureMediaCitationSchema).min(1).max(24),
  ownership: ownershipEvidenceSchema,
  dueDate: dueDateEvidenceSchema,
  proposedByActorId: opaqueIdSchema,
  proposedAt: canonicalTimestampSchema,
}).strict();

export const meetingCommitmentProposalSchema = meetingCommitmentProposalBodySchema.extend({
  proposalSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { proposalSha256, ...body } = value;
  if (proposalSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["proposalSha256"],
      message: "Proposal digest does not match its immutable evidence.",
    });
  }
});

const meetingCommitmentResolutionBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(MEETING_COMMITMENT_CONVERSION_VERSION),
  resolutionId: z.string().regex(/^meeting-commitment-resolution:[a-f0-9]{64}$/),
  proposalId: z.string().regex(/^meeting-commitment-proposal:[a-f0-9]{64}$/),
  proposalSha256: sha256Schema,
  decision: z.enum(["confirmed", "dismissed"]),
  ownerParticipantId: opaqueIdSchema.nullable(),
  ownerDisplayName: z.string().trim().min(1).max(160).nullable(),
  ownershipAuthority: z.enum(["explicit_transcript", "user_confirmed"]).nullable(),
  dueAt: canonicalTimestampSchema.nullable(),
  dueDateAuthority: z.enum(["explicit_transcript", "user_confirmed"]).nullable(),
  workItemId: opaqueIdSchema.nullable(),
  draftId: z.string().regex(/^message_draft:[0-9a-f-]{36}$/).nullable(),
  communicationPolicyId: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/).nullable(),
  meetingRevisionId: opaqueIdSchema.nullable(),
  resolvedByActorId: opaqueIdSchema,
  resolvedAt: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  const confirmed = value.decision === "confirmed";
  const ownerComplete = value.ownerParticipantId !== null &&
    value.ownerDisplayName !== null && value.ownershipAuthority !== null;
  const draftComplete = value.draftId !== null && value.communicationPolicyId !== null;
  if (confirmed !== ownerComplete || confirmed !== (value.workItemId !== null) ||
      confirmed !== (value.meetingRevisionId !== null)) {
    context.addIssue({
      code: "custom",
      message: "Confirmed commitments require owner, WorkItem, and meeting revision evidence.",
    });
  }
  if ((value.dueAt !== null) !== (value.dueDateAuthority !== null)) {
    context.addIssue({
      code: "custom",
      path: ["dueDateAuthority"],
      message: "Due date and its authority must be recorded together.",
    });
  }
  if ((value.draftId !== null) !== (value.communicationPolicyId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["draftId"],
      message: "A governed draft requires its exact communication policy.",
    });
  }
  if (!confirmed && (value.dueAt !== null || value.dueDateAuthority !== null || draftComplete)) {
    context.addIssue({
      code: "custom",
      message: "Dismissed proposals cannot carry commitment effects.",
    });
  }
});

export const meetingCommitmentResolutionSchema = meetingCommitmentResolutionBodySchema.extend({
  resolutionSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { resolutionSha256, ...body } = value;
  if (resolutionSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["resolutionSha256"],
      message: "Resolution digest does not match its immutable result.",
    });
  }
});

export const meetingCommitmentViewSchema = z.object({
  proposal: meetingCommitmentProposalSchema,
  resolution: meetingCommitmentResolutionSchema.nullable(),
}).strict();

export type MeetingCommitmentProposal = Readonly<
  z.infer<typeof meetingCommitmentProposalSchema>
>;
export type MeetingCommitmentResolution = Readonly<
  z.infer<typeof meetingCommitmentResolutionSchema>
>;
export type MeetingCommitmentView = Readonly<
  z.infer<typeof meetingCommitmentViewSchema>
>;

export function meetingCommitmentProposalId(input: {
  tenantId: string;
  workspaceId: string;
  meetingId: string;
  mediaRevisionId: string;
  actionItemId: string;
}) {
  return `meeting-commitment-proposal:${canonicalJsonSha256(input)}`;
}

export function meetingCommitmentResolutionId(proposalId: string) {
  return `meeting-commitment-resolution:${canonicalJsonSha256({ proposalId })}`;
}

export function withMeetingCommitmentProposalDigest(
  value: z.input<typeof meetingCommitmentProposalBodySchema>,
) {
  const body = meetingCommitmentProposalBodySchema.parse(value);
  return meetingCommitmentProposalSchema.parse({
    ...body,
    proposalSha256: canonicalJsonSha256(body),
  });
}

export function withMeetingCommitmentResolutionDigest(
  value: z.input<typeof meetingCommitmentResolutionBodySchema>,
) {
  const body = meetingCommitmentResolutionBodySchema.parse(value);
  return meetingCommitmentResolutionSchema.parse({
    ...body,
    resolutionSha256: canonicalJsonSha256(body),
  });
}
