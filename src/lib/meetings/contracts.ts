import { randomUUID } from "node:crypto";
import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const MEETING_SCHEMA_VERSION = 1 as const;
export const MEETING_EVENT_TYPES = Object.freeze({
  created: "meeting.created",
  revised: "meeting.revised",
} as const);

const opaqueIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const workspaceIdSchema = opaqueIdSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const canonicalActorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const meetingIdSchema = opaqueIdSchema.regex(
  /^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);

export const meetingAccessClassSchema = z.enum([
  "owner_private",
  "project_members",
  "workspace_members",
]);

export const meetingParticipantSchema = z.object({
  participantId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320).nullable().default(null),
  entityId: opaqueIdSchema.nullable().default(null),
  role: z.enum(["organizer", "required", "optional", "guest"]),
  response: z.enum(["accepted", "declined", "tentative", "needs_action", "unknown"]),
  attendeeConsent: z.enum(["granted", "declined", "pending", "unknown"]),
  recordingConsent: z.enum(["granted", "declined", "pending", "not_required", "unknown"]),
  consentCapturedAt: canonicalTimestampSchema.nullable().default(null),
  source: z.enum(["calendar", "manual"]),
}).strict().superRefine((participant, context) => {
  const hasRecordedConsent = participant.attendeeConsent !== "unknown" ||
    !["unknown", "pending"].includes(participant.recordingConsent);
  if (hasRecordedConsent !== (participant.consentCapturedAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["consentCapturedAt"],
      message: "Captured consent states require exactly one capture timestamp.",
    });
  }
});

export const meetingSourceLinkSchema = z.object({
  linkId: opaqueIdSchema,
  kind: z.enum(["calendar_event", "capture_recording", "capture_asset", "source_revision"]),
  sourceId: opaqueIdSchema,
  sourceRevisionId: opaqueIdSchema,
  sourceRevisionSha256: sha256Schema,
  sourceAuthoritySha256: sha256Schema,
  accessClass: meetingAccessClassSchema,
  mediaRole: z.enum(["calendar", "recording", "transcript", "attachment", "reference"]),
  label: z.string().trim().min(1).max(240),
}).strict();

export const meetingEntityLinkSchema = z.object({
  entityId: opaqueIdSchema,
  entityType: z.enum(["person", "organization", "account", "project"]),
  label: z.string().trim().min(1).max(240),
  relationship: z.enum(["customer", "account", "participant", "subject", "related"]),
}).strict();

export const meetingDecisionSchema = z.object({
  decisionId: opaqueIdSchema,
  summary: z.string().trim().min(1).max(2_000),
  ownerParticipantId: opaqueIdSchema.nullable().default(null),
  sourceLinkId: opaqueIdSchema.nullable().default(null),
}).strict();

export const meetingCommitmentSchema = z.object({
  commitmentId: opaqueIdSchema,
  summary: z.string().trim().min(1).max(2_000),
  ownerParticipantId: opaqueIdSchema.nullable().default(null),
  dueAt: canonicalTimestampSchema.nullable().default(null),
  sourceLinkId: opaqueIdSchema.nullable().default(null),
}).strict();

export const meetingFollowUpSchema = z.object({
  followUpId: opaqueIdSchema,
  label: z.string().trim().min(1).max(500),
  status: z.enum(["proposed", "accepted", "completed", "dismissed"]),
  workItemId: opaqueIdSchema.nullable().default(null),
  draftId: opaqueIdSchema.nullable().default(null),
  commitmentId: opaqueIdSchema.nullable().default(null),
}).strict();

const meetingDefinitionBaseSchema = z.object({
  meetingId: meetingIdSchema.optional(),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().max(8_000).default(""),
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]),
  scheduledStartAt: canonicalTimestampSchema,
  scheduledEndAt: canonicalTimestampSchema,
  actualStartAt: canonicalTimestampSchema.nullable().default(null),
  actualEndAt: canonicalTimestampSchema.nullable().default(null),
  timezone: z.string().trim().min(1).max(100),
  location: z.string().trim().max(500).default(""),
  projectId: opaqueIdSchema.nullable().default(null),
  declaredAccessClass: meetingAccessClassSchema,
  participants: z.array(meetingParticipantSchema).max(250).default([]),
  sourceLinks: z.array(meetingSourceLinkSchema).max(100).default([]),
  entityLinks: z.array(meetingEntityLinkSchema).max(100).default([]),
  decisions: z.array(meetingDecisionSchema).max(250).default([]),
  commitments: z.array(meetingCommitmentSchema).max(250).default([]),
  followUps: z.array(meetingFollowUpSchema).max(250).default([]),
}).strict();

export const meetingDefinitionInputSchema = meetingDefinitionBaseSchema
  .superRefine(validateMeetingDefinition);

const meetingRevisionBodySchema = meetingDefinitionBaseSchema.omit({ meetingId: true }).extend({
  schemaVersion: z.literal(MEETING_SCHEMA_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  meetingId: meetingIdSchema,
  meetingRevisionId: opaqueIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousMeetingRevisionId: opaqueIdSchema.nullable(),
  ownerActorId: canonicalActorIdSchema,
  effectiveAccessClass: meetingAccessClassSchema,
  consentSnapshotSha256: sha256Schema,
  revisedByActorId: canonicalActorIdSchema,
  revisedAt: canonicalTimestampSchema,
}).strict().superRefine((meeting, context) => {
  validateMeetingDefinition(meeting, context);
  if (meeting.meetingRevisionId !== `${meeting.meetingId}:v${meeting.revision}`) {
    context.addIssue({ code: "custom", path: ["meetingRevisionId"], message: "Meeting revision identity is inconsistent." });
  }
  const expectedPrevious = meeting.revision === 1
    ? null
    : `${meeting.meetingId}:v${meeting.revision - 1}`;
  if (meeting.previousMeetingRevisionId !== expectedPrevious) {
    context.addIssue({ code: "custom", path: ["previousMeetingRevisionId"], message: "Meeting revision lineage is inconsistent." });
  }
  const expectedAccess = strictestMeetingAccessClass([
    meeting.declaredAccessClass,
    ...meeting.sourceLinks.map((link) => link.accessClass),
  ]);
  if (meeting.effectiveAccessClass !== expectedAccess) {
    context.addIssue({ code: "custom", path: ["effectiveAccessClass"], message: "Meeting access is not the strictest linked authority." });
  }
  if (meeting.consentSnapshotSha256 !== meetingConsentSnapshotSha256(meeting.participants)) {
    context.addIssue({ code: "custom", path: ["consentSnapshotSha256"], message: "Meeting consent snapshot digest does not match." });
  }
});

export const meetingRevisionSchema = meetingRevisionBodySchema.extend({
  meetingSha256: sha256Schema,
}).strict().superRefine((meeting, context) => {
  const { meetingSha256: _digest, ...body } = meeting;
  if (canonicalJsonSha256(body) !== meeting.meetingSha256) {
    context.addIssue({ code: "custom", path: ["meetingSha256"], message: "Meeting digest does not match its immutable revision." });
  }
});

export type MeetingAccessClass = z.infer<typeof meetingAccessClassSchema>;
export type MeetingParticipant = Readonly<z.infer<typeof meetingParticipantSchema>>;
export type MeetingSourceLink = Readonly<z.infer<typeof meetingSourceLinkSchema>>;
export type MeetingDefinitionInput = Readonly<z.infer<typeof meetingDefinitionInputSchema>>;
export type MeetingRevision = Readonly<z.infer<typeof meetingRevisionSchema>>;

export function createMeetingId() {
  return `meeting:${randomUUID()}`;
}

export function strictestMeetingAccessClass(
  classes: readonly MeetingAccessClass[],
): MeetingAccessClass {
  const rank: Record<MeetingAccessClass, number> = {
    owner_private: 0,
    project_members: 1,
    workspace_members: 2,
  };
  return classes.reduce<MeetingAccessClass>(
    (strictest, candidate) => rank[candidate] < rank[strictest] ? candidate : strictest,
    "workspace_members",
  );
}

export function meetingConsentSnapshotSha256(
  participants: readonly MeetingParticipant[],
) {
  return canonicalJsonSha256(participants.map((participant) => ({
    participantId: participant.participantId,
    attendeeConsent: participant.attendeeConsent,
    recordingConsent: participant.recordingConsent,
    consentCapturedAt: participant.consentCapturedAt,
  })));
}

export function buildMeetingRevision(input: {
  tenantId: string;
  workspaceId: string;
  ownerActorId: string;
  meetingId: string;
  revision: number;
  definition: z.input<typeof meetingDefinitionInputSchema>;
  revisedAt?: string;
}): MeetingRevision {
  const definition = meetingDefinitionInputSchema.parse(input.definition);
  const revisedAt = input.revisedAt || new Date().toISOString();
  const body = meetingRevisionBodySchema.parse({
    ...definition,
    schemaVersion: MEETING_SCHEMA_VERSION,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    meetingId: input.meetingId,
    meetingRevisionId: `${input.meetingId}:v${input.revision}`,
    revision: input.revision,
    previousMeetingRevisionId: input.revision === 1
      ? null
      : `${input.meetingId}:v${input.revision - 1}`,
    ownerActorId: input.ownerActorId,
    effectiveAccessClass: strictestMeetingAccessClass([
      definition.declaredAccessClass,
      ...definition.sourceLinks.map((link) => link.accessClass),
    ]),
    consentSnapshotSha256: meetingConsentSnapshotSha256(definition.participants),
    revisedByActorId: input.ownerActorId,
    revisedAt,
  });
  return deepFreeze(meetingRevisionSchema.parse({
    ...body,
    meetingSha256: canonicalJsonSha256(body),
  }));
}

export function parseMeetingRevision(value: unknown) {
  const parsed = meetingRevisionSchema.safeParse(value);
  return parsed.success ? deepFreeze(parsed.data) : undefined;
}

function validateMeetingDefinition(
  meeting: z.infer<typeof meetingDefinitionInputSchema>,
  context: z.RefinementCtx,
) {
  if (Date.parse(meeting.scheduledEndAt) <= Date.parse(meeting.scheduledStartAt)) {
    context.addIssue({ code: "custom", path: ["scheduledEndAt"], message: "Meeting end must follow its start." });
  }
  if ((meeting.actualStartAt === null) !== (meeting.actualEndAt === null)) {
    context.addIssue({ code: "custom", path: ["actualStartAt"], message: "Actual meeting times must be recorded together." });
  } else if (meeting.actualStartAt && meeting.actualEndAt && Date.parse(meeting.actualEndAt) <= Date.parse(meeting.actualStartAt)) {
    context.addIssue({ code: "custom", path: ["actualEndAt"], message: "Actual meeting end must follow its start." });
  }
  uniqueField(meeting.participants, "participantId", context, "participants");
  uniqueField(meeting.sourceLinks, "linkId", context, "sourceLinks");
  uniqueField(meeting.entityLinks, "entityId", context, "entityLinks");
  uniqueField(meeting.decisions, "decisionId", context, "decisions");
  uniqueField(meeting.commitments, "commitmentId", context, "commitments");
  uniqueField(meeting.followUps, "followUpId", context, "followUps");
  if (meeting.sourceLinks.filter((link) => link.kind === "calendar_event").length > 1) {
    context.addIssue({ code: "custom", path: ["sourceLinks"], message: "A meeting can link only one calendar event revision." });
  }
  if (meeting.declaredAccessClass === "project_members" && !meeting.projectId) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "Project access requires an exact project." });
  }
  const hasRecording = meeting.sourceLinks.some((link) =>
    link.mediaRole === "recording" || link.kind === "capture_recording"
  );
  if (hasRecording && (
    meeting.participants.length === 0 ||
    meeting.participants.some((participant) =>
      !["granted", "not_required"].includes(participant.recordingConsent)
    )
  )) {
    context.addIssue({
      code: "custom",
      path: ["participants"],
      message: "Every participant must explicitly permit recording before recording media is linked.",
    });
  }
  const participantIds = new Set(meeting.participants.map((item) => item.participantId));
  const sourceLinkIds = new Set(meeting.sourceLinks.map((item) => item.linkId));
  const commitmentIds = new Set(meeting.commitments.map((item) => item.commitmentId));
  for (const [collection, records] of [["decisions", meeting.decisions], ["commitments", meeting.commitments]] as const) {
    records.forEach((record, index) => {
      if (record.ownerParticipantId && !participantIds.has(record.ownerParticipantId)) {
        context.addIssue({ code: "custom", path: [collection, index, "ownerParticipantId"], message: "Referenced participant is missing." });
      }
      if (record.sourceLinkId && !sourceLinkIds.has(record.sourceLinkId)) {
        context.addIssue({ code: "custom", path: [collection, index, "sourceLinkId"], message: "Referenced source link is missing." });
      }
    });
  }
  meeting.followUps.forEach((followUp, index) => {
    if (followUp.commitmentId && !commitmentIds.has(followUp.commitmentId)) {
      context.addIssue({ code: "custom", path: ["followUps", index, "commitmentId"], message: "Referenced commitment is missing." });
    }
  });
}

function uniqueField<T extends Record<string, unknown>>(
  records: readonly T[],
  field: keyof T,
  context: z.RefinementCtx,
  path: string,
) {
  const values = records.map((record) => record[field]);
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: [path], message: `${path} identities must be unique.` });
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
