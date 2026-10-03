import { z } from "zod";
import { browserRefreshEnvironment, type VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";
import type { ContactPolicy, EntityOption, LibraryItem, LinkedSource, Meeting, MeetingCommitmentProposal, MeetingCommitmentView, MeetingDraft, ProcessedMeetingMediaView, ProjectOption, WorkspaceContext } from "./meetings-workspace";

export type MeetingReadState = { loaded: boolean; loading: boolean; error?: string; stale?: boolean };
export function freezeMeetingSubmission(draft: MeetingDraft, base: { meetingId: string; revision: number } | undefined, key: string) {
  return Object.freeze({ draft: structuredClone(draft), base: base ? { ...base } : undefined, key });
}
const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Invalid canonical timestamp");
const access = z.enum(["owner_private", "project_members", "workspace_members"]);
const participant = z.object({ participantId: id, displayName: z.string().min(1).max(160), email: z.string().nullable(), entityId: id.nullable(), role: z.enum(["organizer", "required", "optional", "guest"]), response: z.enum(["accepted", "declined", "tentative", "needs_action", "unknown"]), attendeeConsent: z.enum(["granted", "declined", "pending", "unknown"]), recordingConsent: z.enum(["granted", "declined", "pending", "not_required", "unknown"]), consentCapturedAt: time.nullable(), source: z.enum(["calendar", "manual"]) }).passthrough();
const sourceKind = z.enum(["calendar_event", "capture_recording", "capture_asset", "source_revision"]);
const mediaRole = z.enum(["calendar", "recording", "transcript", "attachment", "reference"]);
const sourceLink = z.object({ linkId: id, kind: sourceKind, sourceId: id, sourceRevisionId: id, sourceRevisionSha256: digest, sourceAuthoritySha256: digest, accessClass: access, mediaRole, label: z.string().min(1).max(240) }).passthrough();
const meetingSchema = z.object({
  schemaVersion: z.literal(1), tenantId: id, workspaceId: id, meetingId: id, meetingRevisionId: id, meetingSha256: digest,
  revision: z.number().int().positive().safe(), ownerActorId: id, title: z.string().min(1).max(240), summary: z.string().max(8000),
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]), scheduledStartAt: time, scheduledEndAt: time, actualStartAt: time.nullable(), actualEndAt: time.nullable(), timezone: z.string().min(1), location: z.string(), projectId: id.nullable(), declaredAccessClass: access, effectiveAccessClass: access, revisedAt: time,
  participants: z.array(participant).max(250), sourceLinks: z.array(sourceLink).max(100),
  entityLinks: z.array(z.object({ entityId: id, entityType: z.enum(["person", "organization", "account", "project"]), label: z.string(), relationship: z.enum(["customer", "account", "participant", "subject", "related"]) }).passthrough()).max(100),
  decisions: z.array(z.object({ decisionId: id, summary: z.string(), ownerParticipantId: id.nullable(), sourceLinkId: id.nullable() }).passthrough()).max(250),
  commitments: z.array(z.object({ commitmentId: id, summary: z.string(), ownerParticipantId: id.nullable(), dueAt: time.nullable(), sourceLinkId: id.nullable() }).passthrough()).max(250),
  followUps: z.array(z.object({ followUpId: id, label: z.string(), status: z.enum(["proposed", "accepted", "completed", "dismissed"]), workItemId: id.nullable(), draftId: id.nullable(), commitmentId: id.nullable() }).passthrough()).max(250),
}).passthrough().refine((value) => value.meetingRevisionId === `${value.meetingId}:v${value.revision}`, "Meeting revision does not match its identity");
const contextSchema = z.object({ workspaceId: id, accessLevel: z.string().min(1), canWrite: z.boolean() }).passthrough();
const citation = z.object({ turnId: id, segmentIndex: z.number().int().nonnegative(), startMilliseconds: z.number().int().nonnegative(), endMilliseconds: z.number().int().nonnegative(), speakerLabel: z.string().min(1), speakerParticipantId: id.optional() }).passthrough();
const cited = z.object({ text: z.string().min(1).max(12000), citations: z.array(citation).min(1).max(24) });
const mediaSchema = z.object({ processingStatus: z.enum(["queued", "processing", "waiting", "ready", "failed"]), operationJobId: id, rawAudioDeletedAt: time.nullable(), updatedAt: time, output: z.object({
  mediaRevisionId: id, processedAt: time, languageTags: z.array(z.string()).max(24),
  turns: z.array(z.object({ turnId: id, startMilliseconds: z.number().nonnegative(), endMilliseconds: z.number().nonnegative(), languageTag: z.string(), speaker: z.object({ label: z.string(), identity: z.enum(["known", "diarized", "unknown"]), participantId: id.optional(), displayName: z.string().optional() }).passthrough(), text: z.string().max(24000) }).passthrough()).max(50000),
  chapters: z.array(cited.extend({ chapterId: id, title: z.string(), startMilliseconds: z.number(), endMilliseconds: z.number() }).passthrough()).max(240), summary: cited.passthrough(),
  actionItems: z.array(cited.extend({ actionItemId: id, ownerParticipantId: id.optional(), dueAt: time.optional(), ownershipEvidence: z.enum(["explicit", "unconfirmed"]), dueDateEvidence: z.enum(["explicit", "unconfirmed"]) }).passthrough()).max(500),
  decisions: z.array(cited.extend({ decisionId: id }).passthrough()).max(500), warnings: z.array(z.string()).max(100),
}).passthrough().nullable() }).passthrough();
const linkedSource = z.object({ linkId: id, kind: sourceKind, sourceId: id, mediaRole, label: z.string(), revisionState: z.enum(["exact", "changed", "unavailable"]), status: z.string().nullable(), mediaType: z.string().nullable(), durationMs: z.number().nonnegative().nullable(), byteCount: z.number().nonnegative().nullable(), updatedAt: time.nullable(), transcript: z.string().max(500000).nullable(), transcriptTruncated: z.boolean(), media: mediaSchema.nullable(), segments: z.array(z.object({ segmentIndex: z.number().int().nonnegative(), mimeType: z.string(), durationMs: z.number().nonnegative() }).passthrough()).max(1440) }).passthrough();
const proposalSchema = z.object({ proposalId: id, proposalSha256: digest, meetingId: id, meetingRevisionId: id, projectId: id, mediaRevisionId: id, actionItemId: id, title: z.string().min(1).max(12000), citations: z.array(citation).min(1).max(24), ownership: z.object({ participantId: id.nullable(), displayName: z.string().nullable(), authority: z.enum(["explicit_transcript", "confirmation_required"]) }).passthrough(), dueDate: z.object({ dueAt: time.nullable(), authority: z.enum(["explicit_transcript", "confirmation_required"]) }).passthrough() }).passthrough();
const resolutionSchema = z.object({ proposalId: id, proposalSha256: digest, decision: z.enum(["confirmed", "dismissed"]), ownerParticipantId: id.nullable(), ownerDisplayName: z.string().nullable(), ownershipAuthority: z.enum(["explicit_transcript", "user_confirmed"]).nullable(), dueAt: time.nullable(), dueDateAuthority: z.enum(["explicit_transcript", "user_confirmed"]).nullable(), workItemId: id.nullable(), draftId: id.nullable(), communicationPolicyId: id.nullable(), meetingRevisionId: id.nullable(), resolutionSha256: digest }).passthrough();
const viewSchema = z.object({ proposal: proposalSchema, resolution: resolutionSchema.nullable() }).passthrough().refine(({ proposal, resolution }) => !resolution || (resolution.proposalId === proposal.proposalId && resolution.proposalSha256 === proposal.proposalSha256 && (resolution.decision === "confirmed" ? Boolean(resolution.ownerParticipantId && resolution.ownerDisplayName && resolution.ownershipAuthority && resolution.workItemId && resolution.meetingRevisionId) : !resolution.workItemId && !resolution.draftId && !resolution.ownerParticipantId) && Boolean(resolution.draftId) === Boolean(resolution.communicationPolicyId)), "Resolution is not bound to its proposal");
const policySchema = z.object({ id, displayName: z.string(), address: z.string(), channel: z.literal("email") }).passthrough();
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label} returned an incomplete response. The result could not be confirmed.`);
  return result.data;
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} returned conflicting identities.`);
}
export function parseMeetingList(value: unknown, tenantId?: string): { meetings: Meeting[]; context: WorkspaceContext } {
  const data = parse(z.object({ meetings: z.array(meetingSchema).max(200), context: contextSchema }), value, "Meetings");
  unique(data.meetings.map((item) => item.meetingId), "Meetings");
  if (data.meetings.some((item) => item.workspaceId !== data.context.workspaceId || (tenantId && item.tenantId !== tenantId))) throw new Error("Meeting scope could not be confirmed.");
  return data;
}
export function parseMeetingDetail(value: unknown, meetingId: string, tenantId?: string): { meeting: Meeting; context: WorkspaceContext; linkedSources: LinkedSource[] } {
  const data = parse(z.object({ meeting: meetingSchema, context: contextSchema, linkedSources: z.array(linkedSource).max(100) }), value, "Meeting detail");
  if (data.meeting.meetingId !== meetingId || data.meeting.workspaceId !== data.context.workspaceId || (tenantId && data.meeting.tenantId !== tenantId)) throw new Error("The returned meeting does not match the requested identity.");
  unique(data.linkedSources.map((item) => item.linkId), "Meeting sources");
  if (data.linkedSources.some((item) => !data.meeting.sourceLinks.some((link) => link.linkId === item.linkId && link.sourceId === item.sourceId && link.kind === item.kind))) throw new Error("Meeting source identities could not be confirmed.");
  return data;
}
export function parseMeetingCommitments(value: unknown, meetingId: string) {
  const data = parse(z.object({ meeting: z.object({ meetingId: id, meetingRevisionId: id, revision: z.number().int().positive() }).passthrough(), context: contextSchema, commitments: z.array(viewSchema).max(500), eligiblePolicies: z.array(policySchema).max(200) }), value, "Commitment review");
  if (data.meeting.meetingId !== meetingId || data.meeting.meetingRevisionId !== `${meetingId}:v${data.meeting.revision}` || data.commitments.some((item) => item.proposal.meetingId !== meetingId)) throw new Error("Commitment review does not match this meeting.");
  unique(data.commitments.map((item) => item.proposal.proposalId), "Commitment review");
  return data as { meeting: { meetingId: string; meetingRevisionId: string; revision: number }; context: WorkspaceContext; commitments: MeetingCommitmentView[]; eligiblePolicies: ContactPolicy[] };
}
export function assertMeetingCommitmentRead(received: readonly MeetingCommitmentView[], confirmed: Iterable<MeetingCommitmentView>, meetingId: string) {
  for (const receipt of confirmed) {
    if (receipt.proposal.meetingId !== meetingId) continue;
    const latest = received.find((item) => item.proposal.proposalId === receipt.proposal.proposalId);
    if (!latest || (latest.proposal.proposalSha256 === receipt.proposal.proposalSha256 && receipt.resolution && latest.resolution?.resolutionSha256 !== receipt.resolution.resolutionSha256)) throw new Error("The latest read has not confirmed the accepted commitment receipt. Its confirmed result is retained.");
  }
}
export function parseMeetingOptions(kind: "projects", value: unknown): ProjectOption[];
export function parseMeetingOptions(kind: "entities", value: unknown): EntityOption[];
export function parseMeetingOptions(kind: "library", value: unknown): LibraryItem[];
export function parseMeetingOptions(kind: "projects" | "entities" | "library", value: unknown) {
  if (kind === "projects") return parse(z.object({ projects: z.array(z.object({ id, title: z.string() })).max(100) }), value, "Projects").projects;
  if (kind === "entities") return parse(z.object({ entities: z.array(z.object({ entityId: id, entityTypeId: z.string(), canonicalLabel: z.string(), state: z.string() })) }), value, "Entities").entities.filter((item) => item.state === "active" && ["person", "organization", "account", "project"].includes(item.entityTypeId));
  return parse(z.object({ items: z.array(z.object({ id, kind: z.string(), sourceAuthority: z.string(), sourceId: id, title: z.string(), sourceLabel: z.string(), status: z.string(), currentVersion: z.object({ sourceRevisionId: id.nullable(), mediaType: z.string() }) })).max(100) }), value, "Library").items;
}
export function parseMeetingMutation(value: unknown, submitted: MeetingDraft, base: { meetingId: string; revision: number } | undefined, tenantId?: string) {
  const meetingId = base?.meetingId ?? parse(z.object({ meeting: z.object({ meetingId: id }) }), value, "Meeting save").meeting.meetingId;
  const data = parseMeetingDetail(value, meetingId, tenantId);
  if (!base && data.meeting.revision !== 1) throw new Error("The created meeting receipt does not identify its first revision.");
  if (base && data.meeting.revision !== base.revision + 1) throw new Error("The saved revision does not match this edit. Refresh the meeting to check its outcome.");
  const expected = { ...submitted, sourceLinks: submitted.sourceLinks.map((source) => ({ linkId: source.linkId, kind: source.kind, sourceId: source.sourceId, ...(source.sourceRevisionId ? { sourceRevisionId: source.sourceRevisionId } : {}), mediaRole: source.mediaRole, label: source.label })) };
  if (!matchesSubmitted(data.meeting, expected)) throw new Error("The saved meeting does not match the submitted values, consent or source identities.");
  return data;
}
function matchesSubmitted(actual: unknown, submitted: unknown): boolean {
  if (typeof submitted === "string") return actual === submitted.trim();
  if (Array.isArray(submitted)) return Array.isArray(actual) && actual.length === submitted.length && submitted.every((value, index) => matchesSubmitted(actual[index], value));
  if (submitted && typeof submitted === "object") return Boolean(actual) && typeof actual === "object" && Object.entries(submitted).every(([key, value]) => value === undefined || matchesSubmitted((actual as Record<string, unknown>)[key], value));
  return actual === submitted;
}
export function parseMeetingProposalReceipt(value: unknown, target: { meetingId: string; meetingRevisionId?: string; projectId?: string; mediaRevisionId: string; actionItemId: string }) {
  const data = parse(z.object({ commitment: viewSchema }), value, "Commitment proposal").commitment;
  if (data.proposal.meetingId !== target.meetingId || (target.meetingRevisionId && data.proposal.meetingRevisionId !== target.meetingRevisionId) || (target.projectId && data.proposal.projectId !== target.projectId) || data.proposal.mediaRevisionId !== target.mediaRevisionId || data.proposal.actionItemId !== target.actionItemId) throw new Error("The proposal receipt does not match the submitted evidence.");
  return data as MeetingCommitmentView;
}
export type MeetingResolutionSubmission = { decision: "confirmed" | "dismissed"; ownerParticipantId?: string; dueAt?: string | null; communication?: { policyId: string; recipientParticipantId: string; subject: string; body: string } | null };
export function parseMeetingResolutionReceipt(value: unknown, proposal: MeetingCommitmentProposal, submitted: MeetingResolutionSubmission, recipientEmail?: string) {
  const envelope = parse(z.object({ commitment: viewSchema, meeting: meetingSchema.optional(), draft: z.object({ id, policyId: id, recipient: z.string().min(1), subject: z.string(), body: z.string(), draftSha256: digest }).passthrough().nullable().optional() }), value, "Commitment decision");
  const data = envelope.commitment;
  const result = data.resolution;
  if (data.proposal.proposalId !== proposal.proposalId || data.proposal.proposalSha256 !== proposal.proposalSha256 || !result || result.decision !== submitted.decision) throw new Error("The decision receipt does not match the submitted proposal.");
  if (submitted.decision === "confirmed" && (result.ownerParticipantId !== submitted.ownerParticipantId || result.dueAt !== (submitted.dueAt ?? null) || result.communicationPolicyId !== (submitted.communication?.policyId ?? null) || Boolean(result.draftId) !== Boolean(submitted.communication))) throw new Error("The decision receipt does not match the confirmed owner, due date or draft policy.");
  if (envelope.meeting && envelope.meeting.meetingId !== proposal.meetingId) throw new Error("The decision returned another meeting.");
  if (envelope.draft && (!submitted.communication || !recipientEmail || envelope.draft.id !== result.draftId || envelope.draft.policyId !== submitted.communication.policyId || envelope.draft.recipient.trim().toLocaleLowerCase("en-US") !== recipientEmail.trim().toLocaleLowerCase("en-US") || envelope.draft.subject !== submitted.communication.subject.trim() || envelope.draft.body !== submitted.communication.body.trim())) throw new Error("The governed draft receipt does not match its submitted recipient or content.");
  // Existing replay replies omit the draft after server-side content checks. The UI
  // must distinguish that identity receipt from a returned immutable draft body.
  return { commitment: data as MeetingCommitmentView, meeting: envelope.meeting as Meeting | undefined, draftVerification: !submitted.communication ? "not_requested" as const : envelope.draft ? "returned_content" as const : "identity_only" as const };
}
export function parseMeetingMediaReceipt(value: unknown, recordingId: string, meetingId: string) {
  const head = mediaSchema.extend({ recordingId: id, meetingId: id.optional(), rawAudioDeletedAt: time.nullable().optional(), output: mediaSchema.shape.output.optional() });
  const data = parse(z.object({ recording: z.object({ id }), media: head, job: z.object({ id, status: z.enum(["queued", "running", "completed", "failed", "canceled"]) }) }), value, "Recording processing");
  if (data.recording.id !== recordingId || data.media.recordingId !== recordingId || data.media.meetingId !== meetingId || data.media.operationJobId !== data.job.id) throw new Error("The processing receipt does not match the selected recording and meeting.");
  return { ...data.media, rawAudioDeletedAt: data.media.rawAudioDeletedAt ?? null, output: data.media.output ?? null } as ProcessedMeetingMediaView;
}
export function meetingCalendarReceipt(value: unknown) {
  const data = parse(z.object({ provider: z.literal("google"), sources: z.array(z.object({ source: z.string(), status: z.enum(["healthy", "syncing", "error"]), imported: z.number().int().nonnegative() }).passthrough()) }), value, "Calendar sync");
  const calendars = data.sources.filter((source) => source.source === "calendar");
  if (calendars.length !== 1) throw new Error("Calendar sync returned no confirmed calendar result.");
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
