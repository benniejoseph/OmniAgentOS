import { browserRefreshEnvironment, type VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";
import type { ContactPolicy, EntityOption, LibraryItem, LinkedSource, Meeting, MeetingCommitmentProposal, MeetingCommitmentView, MeetingDraft, ProcessedMeetingMediaView, ProjectOption, WorkspaceContext } from "./meetings-workspace";
import { readMeetingCalendarEnvelope, readMeetingCommitmentsEnvelope, readMeetingDetailEnvelope, readMeetingEntities, readMeetingIdEnvelope, readMeetingLibrary, readMeetingListEnvelope, readMeetingMediaEnvelope, readMeetingProjects, readMeetingProposalEnvelope, readMeetingResolutionEnvelope } from "./meetings-response-validation";

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
function parse<T>(parser: (value: unknown) => T, value: unknown, label: string): T {
  try { return parser(value); }
  catch { throw new Error(`${label} returned an incomplete response. The result could not be confirmed.`); }
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} returned conflicting identities.`);
}
export function parseMeetingList(value: unknown, tenantId?: string): {
  meetings: Meeting[];
  context: WorkspaceContext;
} {
  const data = parse(readMeetingListEnvelope, value, "Meetings");
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
  const data = parse(readMeetingDetailEnvelope, value, "Meeting detail");
  if (data.meeting.meetingId !== meetingId || data.meeting.workspaceId !== data.context.workspaceId || (tenantId && data.meeting.tenantId !== tenantId))
    throw new Error("The returned meeting does not match the requested identity.");
  unique(data.linkedSources.map((item) => item.linkId), "Meeting sources");
  if (data.linkedSources.some((item) => !data.meeting.sourceLinks.some((link) => link.linkId === item.linkId && link.sourceId === item.sourceId && link.kind === item.kind)))
    throw new Error("Meeting source identities could not be confirmed.");
  return data;
}
export function parseMeetingCommitments(value: unknown, meetingId: string) {
  const data = parse(readMeetingCommitmentsEnvelope, value, "Commitment review");
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
    if (!latest || (latest.proposal.proposalSha256 === receipt.proposal.proposalSha256 && (latest.proposal.proposedByActorId !== receipt.proposal.proposedByActorId || receipt.resolution && latest.resolution?.resolutionSha256 !== receipt.resolution.resolutionSha256)))
      throw new Error("The latest read has not confirmed the accepted commitment receipt. Its confirmed result is retained.");
  }
}
export function parseMeetingOptions(kind: "projects", value: unknown): ProjectOption[];
export function parseMeetingOptions(kind: "entities", value: unknown): EntityOption[];
export function parseMeetingOptions(kind: "library", value: unknown): LibraryItem[];
export function parseMeetingOptions(kind: "projects" | "entities" | "library", value: unknown) {
  if (kind === "projects")
    return parse(readMeetingProjects, value, "Projects");
  if (kind === "entities")
    return parse(readMeetingEntities, value, "Entities").filter((item) => item.state === "active" && ["person", "organization", "account", "project"].includes(item.entityTypeId));
  return parse(readMeetingLibrary, value, "Library");
}
export function parseMeetingMutation(value: unknown, submitted: MeetingDraft, base: {
  meetingId: string;
  revision: number;
} | undefined, tenantId?: string) {
  const meetingId = base?.meetingId ?? parse(readMeetingIdEnvelope, value, "Meeting save").meeting.meetingId;
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
  const data = parse(readMeetingProposalEnvelope, value, "Commitment proposal").commitment;
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
  const envelope = parse(readMeetingResolutionEnvelope, value, "Commitment decision");
  const data = envelope.commitment;
  const result = data.resolution;
  if (data.proposal.proposalId !== proposal.proposalId || data.proposal.proposalSha256 !== proposal.proposalSha256 || data.proposal.proposedByActorId !== proposal.proposedByActorId || !result || result.decision !== submitted.decision)
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
  const data = parse(readMeetingMediaEnvelope, value, "Recording processing");
  if (data.recording.id !== recordingId || data.media.recordingId !== recordingId || data.media.meetingId !== meetingId || data.media.operationJobId !== data.job.id)
    throw new Error("The processing receipt does not match the selected recording and meeting.");
  return { ...data.media, rawAudioDeletedAt: data.media.rawAudioDeletedAt ?? null, output: data.media.output ?? null } as ProcessedMeetingMediaView;
}
export function meetingCalendarReceipt(value: unknown) {
  const data = parse(readMeetingCalendarEnvelope, value, "Calendar sync");
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
