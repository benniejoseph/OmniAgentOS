import { z } from "zod/mini";
import { browserRefreshEnvironment, type VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";
import type { ContactPolicy, EntityOption, LibraryItem, LinkedSource, Meeting, MeetingCommitmentProposal, MeetingCommitmentView, MeetingDraft, ProcessedMeetingMediaView, ProjectOption, WorkspaceContext } from "./meetings-workspace";

// The browser uses Zod's functional entry point so response validation does not
// include the classic fluent API. Field bounds and receipt checks stay intact.
export type MeetingReadState = {
  loaded: boolean;
  loading: boolean;
  error?: string;
  stale?: boolean;
};
export function freezeMeetingSubmission(draft: MeetingDraft, base: {
  meetingId: string;
  revision: number;
} | undefined, key: string) {
  return Object.freeze({ draft: structuredClone(draft), base: base ? { ...base } : undefined, key });
}
const id = z.string().check(z.minLength(1)).check(z.maxLength(512));
const digest = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const time = z.string().check(z.refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Invalid canonical timestamp"));
const access = z.enum(["owner_private", "project_members", "workspace_members"]);
const participant = z.looseObject({ participantId: id, displayName: z.string().check(z.minLength(1)).check(z.maxLength(160)), email: z.nullable(z.string()), entityId: z.nullable(id), role: z.enum(["organizer", "required", "optional", "guest"]), response: z.enum(["accepted", "declined", "tentative", "needs_action", "unknown"]), attendeeConsent: z.enum(["granted", "declined", "pending", "unknown"]), recordingConsent: z.enum(["granted", "declined", "pending", "not_required", "unknown"]), consentCapturedAt: z.nullable(time), source: z.enum(["calendar", "manual"]) });
const sourceKind = z.enum(["calendar_event", "capture_recording", "capture_asset", "source_revision"]);
const mediaRole = z.enum(["calendar", "recording", "transcript", "attachment", "reference"]);
const sourceLink = z.looseObject({ linkId: id, kind: sourceKind, sourceId: id, sourceRevisionId: id, sourceRevisionSha256: digest, sourceAuthoritySha256: digest, accessClass: access, mediaRole, label: z.string().check(z.minLength(1)).check(z.maxLength(240)) });
const meetingSchema = z.looseObject({
  schemaVersion: z.literal(1), tenantId: id, workspaceId: id, meetingId: id, meetingRevisionId: id, meetingSha256: digest,
  revision: z.int().check(z.positive()), ownerActorId: id, title: z.string().check(z.minLength(1)).check(z.maxLength(240)), summary: z.string().check(z.maxLength(8000)),
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]), scheduledStartAt: time, scheduledEndAt: time, actualStartAt: z.nullable(time), actualEndAt: z.nullable(time), timezone: z.string().check(z.minLength(1)), location: z.string(), projectId: z.nullable(id), declaredAccessClass: access, effectiveAccessClass: access, revisedAt: time,
  participants: z.array(participant).check(z.maxLength(250)), sourceLinks: z.array(sourceLink).check(z.maxLength(100)),
  entityLinks: z.array(z.looseObject({ entityId: id, entityType: z.enum(["person", "organization", "account", "project"]), label: z.string(), relationship: z.enum(["customer", "account", "participant", "subject", "related"]) })).check(z.maxLength(100)),
  decisions: z.array(z.looseObject({ decisionId: id, summary: z.string(), ownerParticipantId: z.nullable(id), sourceLinkId: z.nullable(id) })).check(z.maxLength(250)),
  commitments: z.array(z.looseObject({ commitmentId: id, summary: z.string(), ownerParticipantId: z.nullable(id), dueAt: z.nullable(time), sourceLinkId: z.nullable(id) })).check(z.maxLength(250)),
  followUps: z.array(z.looseObject({ followUpId: id, label: z.string(), status: z.enum(["proposed", "accepted", "completed", "dismissed"]), workItemId: z.nullable(id), draftId: z.nullable(id), commitmentId: z.nullable(id) })).check(z.maxLength(250)),
}).check(z.refine((value) => value.meetingRevisionId === `${value.meetingId}:v${value.revision}`, "Meeting revision does not match its identity"));
const contextSchema = z.looseObject({ workspaceId: id, accessLevel: z.string().check(z.minLength(1)), canWrite: z.boolean() });
const citation = z.looseObject({ turnId: id, segmentIndex: z.int().check(z.nonnegative()), startMilliseconds: z.int().check(z.nonnegative()), endMilliseconds: z.int().check(z.nonnegative()), speakerLabel: z.string().check(z.minLength(1)), speakerParticipantId: z.optional(id) });
const cited = z.object({ text: z.string().check(z.minLength(1)).check(z.maxLength(12000)), citations: z.array(citation).check(z.minLength(1)).check(z.maxLength(24)) });
const mediaSchema = z.looseObject({ processingStatus: z.enum(["queued", "processing", "waiting", "ready", "failed"]), operationJobId: id, rawAudioDeletedAt: z.nullable(time), updatedAt: time, output: z.nullable(z.looseObject({
    mediaRevisionId: id, processedAt: time, languageTags: z.array(z.string()).check(z.maxLength(24)),
    turns: z.array(z.looseObject({ turnId: id, startMilliseconds: z.number().check(z.nonnegative()), endMilliseconds: z.number().check(z.nonnegative()), languageTag: z.string(), speaker: z.looseObject({ label: z.string(), identity: z.enum(["known", "diarized", "unknown"]), participantId: z.optional(id), displayName: z.optional(z.string()) }), text: z.string().check(z.maxLength(24000)) })).check(z.maxLength(50000)),
    chapters: z.array(z.looseObject(z.extend(cited, { chapterId: id, title: z.string(), startMilliseconds: z.number(), endMilliseconds: z.number() }).shape)).check(z.maxLength(240)), summary: z.looseObject(cited.shape),
    actionItems: z.array(z.looseObject(z.extend(cited, { actionItemId: id, ownerParticipantId: z.optional(id), dueAt: z.optional(time), ownershipEvidence: z.enum(["explicit", "unconfirmed"]), dueDateEvidence: z.enum(["explicit", "unconfirmed"]) }).shape)).check(z.maxLength(500)),
    decisions: z.array(z.looseObject(z.extend(cited, { decisionId: id }).shape)).check(z.maxLength(500)), warnings: z.array(z.string()).check(z.maxLength(100)),
  })) });
const linkedSource = z.looseObject({ linkId: id, kind: sourceKind, sourceId: id, mediaRole, label: z.string(), revisionState: z.enum(["exact", "changed", "unavailable"]), status: z.nullable(z.string()), mediaType: z.nullable(z.string()), durationMs: z.nullable(z.number().check(z.nonnegative())), byteCount: z.nullable(z.number().check(z.nonnegative())), updatedAt: z.nullable(time), transcript: z.nullable(z.string().check(z.maxLength(500000))), transcriptTruncated: z.boolean(), media: z.nullable(mediaSchema), segments: z.array(z.looseObject({ segmentIndex: z.int().check(z.nonnegative()), mimeType: z.string(), durationMs: z.number().check(z.nonnegative()) })).check(z.maxLength(1440)) });
const proposalSchema = z.looseObject({ proposalId: id, proposalSha256: digest, meetingId: id, meetingRevisionId: id, projectId: id, mediaRevisionId: id, actionItemId: id, title: z.string().check(z.minLength(1)).check(z.maxLength(12000)), citations: z.array(citation).check(z.minLength(1)).check(z.maxLength(24)), ownership: z.looseObject({ participantId: z.nullable(id), displayName: z.nullable(z.string()), authority: z.enum(["explicit_transcript", "confirmation_required"]) }), dueDate: z.looseObject({ dueAt: z.nullable(time), authority: z.enum(["explicit_transcript", "confirmation_required"]) }) });
const resolutionSchema = z.looseObject({ proposalId: id, proposalSha256: digest, decision: z.enum(["confirmed", "dismissed"]), ownerParticipantId: z.nullable(id), ownerDisplayName: z.nullable(z.string()), ownershipAuthority: z.nullable(z.enum(["explicit_transcript", "user_confirmed"])), dueAt: z.nullable(time), dueDateAuthority: z.nullable(z.enum(["explicit_transcript", "user_confirmed"])), workItemId: z.nullable(id), draftId: z.nullable(id), communicationPolicyId: z.nullable(id), meetingRevisionId: z.nullable(id), resolutionSha256: digest });
const viewSchema = z.looseObject({ proposal: proposalSchema, resolution: z.nullable(resolutionSchema) }).check(z.refine(({ proposal, resolution }) => !resolution || (resolution.proposalId === proposal.proposalId && resolution.proposalSha256 === proposal.proposalSha256 && (resolution.decision === "confirmed" ? Boolean(resolution.ownerParticipantId && resolution.ownerDisplayName && resolution.ownershipAuthority && resolution.workItemId && resolution.meetingRevisionId) : !resolution.workItemId && !resolution.draftId && !resolution.ownerParticipantId) && Boolean(resolution.draftId) === Boolean(resolution.communicationPolicyId)), "Resolution is not bound to its proposal"));
const policySchema = z.looseObject({ id, displayName: z.string(), address: z.string(), channel: z.literal("email") });
function parse<T>(schema: z.ZodMiniType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(`${label} returned an incomplete response. The result could not be confirmed.`);
  return result.data;
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} returned conflicting identities.`);
}
export function parseMeetingList(value: unknown, tenantId?: string): {
  meetings: Meeting[];
  context: WorkspaceContext;
} {
  const data = parse(z.object({ meetings: z.array(meetingSchema).check(z.maxLength(200)), context: contextSchema }), value, "Meetings");
  unique(data.meetings.map((item) => item.meetingId), "Meetings");
  if (data.meetings.some((item) => item.workspaceId !== data.context.workspaceId || (tenantId && item.tenantId !== tenantId)))
    throw new Error("Meeting scope could not be confirmed.");
  return data;
}
export function parseMeetingDetail(value: unknown, meetingId: string, tenantId?: string): {
  meeting: Meeting;
  context: WorkspaceContext;
  linkedSources: LinkedSource[];
} {
  const data = parse(z.object({ meeting: meetingSchema, context: contextSchema, linkedSources: z.array(linkedSource).check(z.maxLength(100)) }), value, "Meeting detail");
  if (data.meeting.meetingId !== meetingId || data.meeting.workspaceId !== data.context.workspaceId || (tenantId && data.meeting.tenantId !== tenantId))
    throw new Error("The returned meeting does not match the requested identity.");
  unique(data.linkedSources.map((item) => item.linkId), "Meeting sources");
  if (data.linkedSources.some((item) => !data.meeting.sourceLinks.some((link) => link.linkId === item.linkId && link.sourceId === item.sourceId && link.kind === item.kind)))
    throw new Error("Meeting source identities could not be confirmed.");
  return data;
}
export function parseMeetingCommitments(value: unknown, meetingId: string) {
  const data = parse(z.object({ meeting: z.looseObject({ meetingId: id, meetingRevisionId: id, revision: z.int().check(z.positive()) }), context: contextSchema, commitments: z.array(viewSchema).check(z.maxLength(500)), eligiblePolicies: z.array(policySchema).check(z.maxLength(200)) }), value, "Commitment review");
  if (data.meeting.meetingId !== meetingId || data.meeting.meetingRevisionId !== `${meetingId}:v${data.meeting.revision}` || data.commitments.some((item) => item.proposal.meetingId !== meetingId))
    throw new Error("Commitment review does not match this meeting.");
  unique(data.commitments.map((item) => item.proposal.proposalId), "Commitment review");
  return data as {
    meeting: {
      meetingId: string;
      meetingRevisionId: string;
      revision: number;
    };
    context: WorkspaceContext;
    commitments: MeetingCommitmentView[];
    eligiblePolicies: ContactPolicy[];
  };
}
export function assertMeetingCommitmentRead(received: readonly MeetingCommitmentView[], confirmed: Iterable<MeetingCommitmentView>, meetingId: string) {
  for (const receipt of confirmed) {
    if (receipt.proposal.meetingId !== meetingId)
      continue;
    const latest = received.find((item) => item.proposal.proposalId === receipt.proposal.proposalId);
    if (!latest || (latest.proposal.proposalSha256 === receipt.proposal.proposalSha256 && receipt.resolution && latest.resolution?.resolutionSha256 !== receipt.resolution.resolutionSha256))
      throw new Error("The latest read has not confirmed the accepted commitment receipt. Its confirmed result is retained.");
  }
}
export function parseMeetingOptions(kind: "projects", value: unknown): ProjectOption[];
export function parseMeetingOptions(kind: "entities", value: unknown): EntityOption[];
export function parseMeetingOptions(kind: "library", value: unknown): LibraryItem[];
export function parseMeetingOptions(kind: "projects" | "entities" | "library", value: unknown) {
  if (kind === "projects")
    return parse(z.object({ projects: z.array(z.object({ id, title: z.string() })).check(z.maxLength(100)) }), value, "Projects").projects;
  if (kind === "entities")
    return parse(z.object({ entities: z.array(z.object({ entityId: id, entityTypeId: z.string(), canonicalLabel: z.string(), state: z.string() })) }), value, "Entities").entities.filter((item) => item.state === "active" && ["person", "organization", "account", "project"].includes(item.entityTypeId));
  return parse(z.object({ items: z.array(z.object({ id, kind: z.string(), sourceAuthority: z.string(), sourceId: id, title: z.string(), sourceLabel: z.string(), status: z.string(), currentVersion: z.object({ sourceRevisionId: z.nullable(id), mediaType: z.string() }) })).check(z.maxLength(100)) }), value, "Library").items;
}
export function parseMeetingMutation(value: unknown, submitted: MeetingDraft, base: {
  meetingId: string;
  revision: number;
} | undefined, tenantId?: string) {
  const meetingId = base?.meetingId ?? parse(z.object({ meeting: z.object({ meetingId: id }) }), value, "Meeting save").meeting.meetingId;
  const data = parseMeetingDetail(value, meetingId, tenantId);
  if (!base && data.meeting.revision !== 1)
    throw new Error("The created meeting receipt does not identify its first revision.");
  if (base && data.meeting.revision !== base.revision + 1)
    throw new Error("The saved revision does not match this edit. Refresh the meeting to check its outcome.");
  const expected = { ...submitted, sourceLinks: submitted.sourceLinks.map((source) => ({ linkId: source.linkId, kind: source.kind, sourceId: source.sourceId, ...(source.sourceRevisionId ? { sourceRevisionId: source.sourceRevisionId } : {}), mediaRole: source.mediaRole, label: source.label })) };
  if (!matchesSubmitted(data.meeting, expected))
    throw new Error("The saved meeting does not match the submitted values, consent or source identities.");
  return data;
}
function matchesSubmitted(actual: unknown, submitted: unknown): boolean {
  if (typeof submitted === "string")
    return actual === submitted.trim();
  if (Array.isArray(submitted))
    return Array.isArray(actual) && actual.length === submitted.length && submitted.every((value, index) => matchesSubmitted(actual[index], value));
  if (submitted && typeof submitted === "object")
    return Boolean(actual) && typeof actual === "object" && Object.entries(submitted).every(([key, value]) => value === undefined || matchesSubmitted((actual as Record<string, unknown>)[key], value));
  return actual === submitted;
}
export function parseMeetingProposalReceipt(value: unknown, target: {
  meetingId: string;
  meetingRevisionId?: string;
  projectId?: string;
  mediaRevisionId: string;
  actionItemId: string;
}) {
  const data = parse(z.object({ commitment: viewSchema }), value, "Commitment proposal").commitment;
  if (data.proposal.meetingId !== target.meetingId || (target.meetingRevisionId && data.proposal.meetingRevisionId !== target.meetingRevisionId) || (target.projectId && data.proposal.projectId !== target.projectId) || data.proposal.mediaRevisionId !== target.mediaRevisionId || data.proposal.actionItemId !== target.actionItemId)
    throw new Error("The proposal receipt does not match the submitted evidence.");
  return data as MeetingCommitmentView;
}
export type MeetingResolutionSubmission = {
  decision: "confirmed" | "dismissed";
  ownerParticipantId?: string;
  dueAt?: string | null;
  communication?: {
    policyId: string;
    recipientParticipantId: string;
    subject: string;
    body: string;
  } | null;
};
export function parseMeetingResolutionReceipt(value: unknown, proposal: MeetingCommitmentProposal, submitted: MeetingResolutionSubmission, recipientEmail?: string) {
  const envelope = parse(z.object({ commitment: viewSchema, meeting: z.optional(meetingSchema), draft: z.optional(z.nullable(z.looseObject({ id, policyId: id, recipient: z.string().check(z.minLength(1)), subject: z.string(), body: z.string(), draftSha256: digest }))) }), value, "Commitment decision");
  const data = envelope.commitment;
  const result = data.resolution;
  if (data.proposal.proposalId !== proposal.proposalId || data.proposal.proposalSha256 !== proposal.proposalSha256 || !result || result.decision !== submitted.decision)
    throw new Error("The decision receipt does not match the submitted proposal.");
  if (submitted.decision === "confirmed" && (result.ownerParticipantId !== submitted.ownerParticipantId || result.dueAt !== (submitted.dueAt ?? null) || result.communicationPolicyId !== (submitted.communication?.policyId ?? null) || Boolean(result.draftId) !== Boolean(submitted.communication)))
    throw new Error("The decision receipt does not match the confirmed owner, due date or draft policy.");
  if (envelope.meeting && envelope.meeting.meetingId !== proposal.meetingId)
    throw new Error("The decision returned another meeting.");
  if (envelope.draft && (!submitted.communication || !recipientEmail || envelope.draft.id !== result.draftId || envelope.draft.policyId !== submitted.communication.policyId || envelope.draft.recipient.trim().toLocaleLowerCase("en-US") !== recipientEmail.trim().toLocaleLowerCase("en-US") || envelope.draft.subject !== submitted.communication.subject.trim() || envelope.draft.body !== submitted.communication.body.trim()))
    throw new Error("The governed draft receipt does not match its submitted recipient or content.");
  // Existing replay replies omit the draft after server-side content checks. The UI
  // must distinguish that identity receipt from a returned immutable draft body.
  return { commitment: data as MeetingCommitmentView, meeting: envelope.meeting as Meeting | undefined, draftVerification: !submitted.communication ? "not_requested" as const : envelope.draft ? "returned_content" as const : "identity_only" as const };
}
export function parseMeetingMediaReceipt(value: unknown, recordingId: string, meetingId: string) {
  const head = z.extend(mediaSchema, { recordingId: id, meetingId: z.optional(id), rawAudioDeletedAt: z.optional(z.nullable(time)), output: z.optional(mediaSchema.shape.output) });
  const data = parse(z.object({ recording: z.object({ id }), media: head, job: z.object({ id, status: z.enum(["queued", "running", "completed", "failed", "canceled"]) }) }), value, "Recording processing");
  if (data.recording.id !== recordingId || data.media.recordingId !== recordingId || data.media.meetingId !== meetingId || data.media.operationJobId !== data.job.id)
    throw new Error("The processing receipt does not match the selected recording and meeting.");
  return { ...data.media, rawAudioDeletedAt: data.media.rawAudioDeletedAt ?? null, output: data.media.output ?? null } as ProcessedMeetingMediaView;
}
export function meetingCalendarReceipt(value: unknown) {
  const data = parse(z.object({ provider: z.literal("google"), sources: z.array(z.looseObject({ source: z.string(), status: z.enum(["healthy", "syncing", "error"]), imported: z.int().check(z.nonnegative()) })) }), value, "Calendar sync");
  const calendars = data.sources.filter((source) => source.source === "calendar");
  if (calendars.length !== 1)
    throw new Error("Calendar sync returned no confirmed calendar result.");
  const calendar = calendars[0];
  return { status: calendar.status, message: calendar.status === "error" ? "Google Calendar could not be synchronized. Check Connections." : calendar.status === "syncing" ? `Calendar sync is continuing. ${calendar.imported} changes imported so far.` : `${calendar.imported} calendar changes synchronized.` };
}
/** Instance-bound reads and one synchronously claimed mutation. Abort is not a server cancellation receipt. */
export function createMeetingRequestGate() {
  let mounted = false;
  let epoch = 0;
  let action: object | undefined;
  const reads = new Map<string, AbortController>();
  const invalidateReads = () => { for (const controller of reads.values()) controller.abort(); reads.clear(); };
  return {
    mount() { mounted = true; epoch += 1; },
    dispose() { mounted = false; epoch += 1; action = undefined; invalidateReads(); },
    invalidateReads,
    isWriting: () => Boolean(action),
    abortRead(channel: string) { reads.get(channel)?.abort(); reads.delete(channel); },
    beginRead(channel: string) {
      reads.get(channel)?.abort();
      const controller = new AbortController();
      const generation = epoch;
      reads.set(channel, controller);
      const owns = () => mounted && generation === epoch && reads.get(channel) === controller;
      return { signal: controller.signal, abort: () => controller.abort(), owns, current: () => owns() && !controller.signal.aborted };
    },
    beginWrite() {
      if (!mounted || action) return undefined;
      const token = {};
      const generation = epoch;
      action = token;
      return { current: () => mounted && generation === epoch && action === token, finish: () => { if (action === token) action = undefined; } };
    },
  };
}

/** Continue unchanged pending heads; stop local reads when hidden or disposed. */
export function startMeetingMediaReads(onRead: (signal: AbortSignal) => Promise<void>, environment: VisibleRefreshEnvironment = browserRefreshEnvironment) {
  let disposed = false;
  let running = false;
  let timer: number | undefined;
  let polling: AbortController | undefined;
  const clear = () => { if (timer !== undefined) environment.clearTimer(timer); timer = undefined; };
  const schedule = () => { if (!disposed && !running && environment.isVisible()) timer = environment.setTimer(() => { timer = undefined; void poll(); }, 3000); };
  const poll = async () => {
    if (disposed || running || !environment.isVisible()) return;
    running = true;
    polling = new AbortController();
    try { await onRead(polling.signal); } finally { running = false; schedule(); }
  };
  const wake = () => { clear(); if (environment.isVisible()) void poll(); else polling?.abort(); };
  environment.addVisibilityListener(wake);
  environment.addFocusListener(wake);
  schedule();
  return () => { disposed = true; clear(); polling?.abort(); environment.removeVisibilityListener(wake); environment.removeFocusListener(wake); };
}
