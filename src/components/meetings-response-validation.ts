import type {
  ContactPolicy, EntityOption, LibraryItem, LinkedSource, Meeting,
  MeetingCommitmentProposal, ProcessedMeetingMediaView,
  ProjectOption, WorkspaceContext, MeetingCommitmentView,
} from "./meetings-workspace";
import type { MeetingResolutionReconciliation } from "@/lib/meetings/commitment-resolution-intent";
import type { MeetingResolutionSubmission } from "./meetings-workspace-state";

// Browser response checks only. Keep the classic response contract's loose domain
// records and stripped envelopes/options. Known nested fields are parsed into new
// objects; extension values remain untouched, as with the former passthrough.
type Row = Record<string, unknown>;
type Parser<T> = (value: unknown) => T;
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid meeting response");
}
function object(value: unknown): Row {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Row;
}
function exactKeys(row: Row, keys: readonly string[]) {
  requireValue(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
}
function string(value: unknown, min = 0, max = Infinity): string {
  requireValue(typeof value === "string" && value.length >= min && value.length <= max);
  return value;
}
function id(value: unknown) { return string(value, 1, 512); }
function proposalActorId(value: unknown) {
  const result = string(value).trim();
  requireValue(result.length > 0 && result.length <= 240);
  return result;
}
function digest(value: unknown) {
  const result = string(value);
  requireValue(/^[a-f0-9]{64}$/.test(result));
  return result;
}
function time(value: unknown) {
  const result = string(value);
  requireValue(Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result);
  return result;
}
function number(value: unknown, min = -Infinity, integer = false): number {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= min && (!integer || Number.isSafeInteger(value)));
  return value;
}
function positiveInteger(value: unknown) {
  const result = number(value, 0, true);
  requireValue(result > 0);
  return result;
}
function nonnegativeInteger(value: unknown) { return number(value, 0, true); }
function boolean(value: unknown): boolean { requireValue(typeof value === "boolean"); return value; }
function member<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  requireValue(typeof value === "string" && options.includes(value));
  return value as T[number];
}
function nullable<T>(value: unknown, parse: Parser<T>): T | null { return value === null ? null : parse(value); }
function optional<K extends string, T>(row: Row, key: K, parse: Parser<T>): Partial<Record<K, T | undefined>> {
  if (!(key in row)) return {};
  return { [key]: row[key] === undefined ? undefined : parse(row[key]) } as Partial<Record<K, T | undefined>>;
}
function array<T>(value: unknown, parse: Parser<T>, max = Infinity, min = 0): T[] {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max);
  // Array.from visits holes as undefined, matching the former required item checks.
  return Array.from(value, (item) => parse(item));
}
function loose<T extends Row>(row: Row, known: T): T & Row {
  const result: Row = { ...known };
  for (const key in row) {
    if (key !== "__proto__" && !Object.hasOwn(known, key)) result[key] = row[key];
  }
  return result as T & Row;
}
const access = (value: unknown) => member(value, ["owner_private", "project_members", "workspace_members"]);
const sourceKind = (value: unknown) => member(value, ["calendar_event", "capture_recording", "capture_asset", "source_revision"]);
const mediaRole = (value: unknown) => member(value, ["calendar", "recording", "transcript", "attachment", "reference"]);
function participant(value: unknown) {
  const row = object(value);
  return loose(row, {
    participantId: id(row.participantId), displayName: string(row.displayName, 1, 160),
    email: nullable(row.email, string), entityId: nullable(row.entityId, id),
    role: member(row.role, ["organizer", "required", "optional", "guest"]),
    response: member(row.response, ["accepted", "declined", "tentative", "needs_action", "unknown"]),
    attendeeConsent: member(row.attendeeConsent, ["granted", "declined", "pending", "unknown"]),
    recordingConsent: member(row.recordingConsent, ["granted", "declined", "pending", "not_required", "unknown"]),
    consentCapturedAt: nullable(row.consentCapturedAt, time), source: member(row.source, ["calendar", "manual"]),
  });
}
function sourceLink(value: unknown) {
  const row = object(value);
  return loose(row, {
    linkId: id(row.linkId), kind: sourceKind(row.kind), sourceId: id(row.sourceId), sourceRevisionId: id(row.sourceRevisionId),
    sourceRevisionSha256: digest(row.sourceRevisionSha256), sourceAuthoritySha256: digest(row.sourceAuthoritySha256),
    accessClass: access(row.accessClass), mediaRole: mediaRole(row.mediaRole), label: string(row.label, 1, 240),
  });
}
export function readMeeting(value: unknown): Meeting & Row {
  const row = object(value);
  requireValue(row.schemaVersion === 1);
  const result = loose(row, {
    schemaVersion: 1 as const, tenantId: id(row.tenantId), workspaceId: id(row.workspaceId), meetingId: id(row.meetingId),
    meetingRevisionId: id(row.meetingRevisionId), meetingSha256: digest(row.meetingSha256), revision: positiveInteger(row.revision),
    ownerActorId: id(row.ownerActorId), title: string(row.title, 1, 240), summary: string(row.summary, 0, 8000),
    status: member(row.status, ["scheduled", "in_progress", "completed", "cancelled"]),
    scheduledStartAt: time(row.scheduledStartAt), scheduledEndAt: time(row.scheduledEndAt),
    actualStartAt: nullable(row.actualStartAt, time), actualEndAt: nullable(row.actualEndAt, time),
    timezone: string(row.timezone, 1), location: string(row.location), projectId: nullable(row.projectId, id),
    declaredAccessClass: access(row.declaredAccessClass), effectiveAccessClass: access(row.effectiveAccessClass), revisedAt: time(row.revisedAt),
    participants: array(row.participants, participant, 250), sourceLinks: array(row.sourceLinks, sourceLink, 100),
    entityLinks: array(row.entityLinks, (value) => {
      const item = object(value);
      return loose(item, { entityId: id(item.entityId), entityType: member(item.entityType, ["person", "organization", "account", "project"]), label: string(item.label), relationship: member(item.relationship, ["customer", "account", "participant", "subject", "related"]) });
    }, 100),
    decisions: array(row.decisions, (value) => {
      const item = object(value);
      return loose(item, { decisionId: id(item.decisionId), summary: string(item.summary), ownerParticipantId: nullable(item.ownerParticipantId, id), sourceLinkId: nullable(item.sourceLinkId, id) });
    }, 250),
    commitments: array(row.commitments, (value) => {
      const item = object(value);
      return loose(item, { commitmentId: id(item.commitmentId), summary: string(item.summary), ownerParticipantId: nullable(item.ownerParticipantId, id), dueAt: nullable(item.dueAt, time), sourceLinkId: nullable(item.sourceLinkId, id) });
    }, 250),
    followUps: array(row.followUps, (value) => {
      const item = object(value);
      return loose(item, { followUpId: id(item.followUpId), label: string(item.label), status: member(item.status, ["proposed", "accepted", "completed", "dismissed"]), workItemId: nullable(item.workItemId, id), draftId: nullable(item.draftId, id), commitmentId: nullable(item.commitmentId, id) });
    }, 250),
  });
  requireValue(result.meetingRevisionId === `${result.meetingId}:v${result.revision}`);
  return result;
}
function context(value: unknown): WorkspaceContext & Row {
  const row = object(value);
  return loose(row, { workspaceId: id(row.workspaceId), accessLevel: string(row.accessLevel, 1), canWrite: boolean(row.canWrite) });
}
function citation(value: unknown) {
  const row = object(value);
  return loose(row, {
    turnId: id(row.turnId), segmentIndex: nonnegativeInteger(row.segmentIndex),
    startMilliseconds: nonnegativeInteger(row.startMilliseconds), endMilliseconds: nonnegativeInteger(row.endMilliseconds),
    speakerLabel: string(row.speakerLabel, 1), ...optional(row, "speakerParticipantId", id),
  });
}
function citedFields(row: Row) { return { text: string(row.text, 1, 12000), citations: array(row.citations, citation, 24, 1) }; }
function mediaOutput(value: unknown): NonNullable<ProcessedMeetingMediaView["output"]> & Row {
  const row = object(value);
  return loose(row, {
    mediaRevisionId: id(row.mediaRevisionId), processedAt: time(row.processedAt), languageTags: array(row.languageTags, string, 24),
    turns: array(row.turns, (value) => {
      const item = object(value); const speaker = object(item.speaker);
      return loose(item, {
        turnId: id(item.turnId), startMilliseconds: number(item.startMilliseconds, 0), endMilliseconds: number(item.endMilliseconds, 0), languageTag: string(item.languageTag),
        speaker: loose(speaker, { label: string(speaker.label), identity: member(speaker.identity, ["known", "diarized", "unknown"]), ...optional(speaker, "participantId", id), ...optional(speaker, "displayName", string) }),
        text: string(item.text, 0, 24000),
      });
    }, 50000),
    chapters: array(row.chapters, (value) => {
      const item = object(value);
      return loose(item, { ...citedFields(item), chapterId: id(item.chapterId), title: string(item.title), startMilliseconds: number(item.startMilliseconds), endMilliseconds: number(item.endMilliseconds) });
    }, 240),
    summary: (() => { const item = object(row.summary); return loose(item, citedFields(item)); })(),
    actionItems: array(row.actionItems, (value) => {
      const item = object(value);
      return loose(item, { ...citedFields(item), actionItemId: id(item.actionItemId), ...optional(item, "ownerParticipantId", id), ...optional(item, "dueAt", time), ownershipEvidence: member(item.ownershipEvidence, ["explicit", "unconfirmed"]), dueDateEvidence: member(item.dueDateEvidence, ["explicit", "unconfirmed"]) });
    }, 500),
    decisions: array(row.decisions, (value) => {
      const item = object(value); return loose(item, { ...citedFields(item), decisionId: id(item.decisionId) });
    }, 500),
    warnings: array(row.warnings, string, 100),
  });
}
function mediaFields(row: Row) {
  return { processingStatus: member(row.processingStatus, ["queued", "processing", "waiting", "ready", "failed"]), operationJobId: id(row.operationJobId), updatedAt: time(row.updatedAt) };
}
function media(value: unknown): ProcessedMeetingMediaView & Row {
  const row = object(value);
  return loose(row, { ...mediaFields(row), rawAudioDeletedAt: nullable(row.rawAudioDeletedAt, time), output: nullable(row.output, mediaOutput) });
}
function linkedSource(value: unknown): LinkedSource & Row {
  const row = object(value);
  return loose(row, {
    linkId: id(row.linkId), kind: sourceKind(row.kind), sourceId: id(row.sourceId), mediaRole: mediaRole(row.mediaRole), label: string(row.label),
    revisionState: member(row.revisionState, ["exact", "changed", "unavailable"]), status: nullable(row.status, string), mediaType: nullable(row.mediaType, string),
    durationMs: nullable(row.durationMs, (value) => number(value, 0)), byteCount: nullable(row.byteCount, (value) => number(value, 0)),
    updatedAt: nullable(row.updatedAt, time), transcript: nullable(row.transcript, (value) => string(value, 0, 500000)),
    transcriptTruncated: boolean(row.transcriptTruncated), media: nullable(row.media, media),
    segments: array(row.segments, (value) => {
      const item = object(value);
      return loose(item, { segmentIndex: nonnegativeInteger(item.segmentIndex), mimeType: string(item.mimeType), durationMs: number(item.durationMs, 0) });
    }, 1440),
  });
}
function proposal(value: unknown): MeetingCommitmentProposal & Row {
  const row = object(value); const ownership = object(row.ownership); const dueDate = object(row.dueDate);
  return loose(row, {
    proposalId: id(row.proposalId), proposalSha256: digest(row.proposalSha256), meetingId: id(row.meetingId), meetingRevisionId: id(row.meetingRevisionId),
    proposedByActorId: proposalActorId(row.proposedByActorId),
    projectId: id(row.projectId), mediaRevisionId: id(row.mediaRevisionId), actionItemId: id(row.actionItemId), title: string(row.title, 1, 12000), citations: array(row.citations, citation, 24, 1),
    ownership: loose(ownership, { participantId: nullable(ownership.participantId, id), displayName: nullable(ownership.displayName, string), authority: member(ownership.authority, ["explicit_transcript", "confirmation_required"]) }),
    dueDate: loose(dueDate, { dueAt: nullable(dueDate.dueAt, time), authority: member(dueDate.authority, ["explicit_transcript", "confirmation_required"]) }),
  });
}
function resolution(value: unknown) {
  const row = object(value);
  const authority = (value: unknown) => member(value, ["explicit_transcript", "user_confirmed"]);
  return loose(row, {
    proposalId: id(row.proposalId), proposalSha256: digest(row.proposalSha256), decision: member(row.decision, ["confirmed", "dismissed"]),
    ownerParticipantId: nullable(row.ownerParticipantId, id), ownerDisplayName: nullable(row.ownerDisplayName, string), ownershipAuthority: nullable(row.ownershipAuthority, authority),
    dueAt: nullable(row.dueAt, time), dueDateAuthority: nullable(row.dueDateAuthority, authority), workItemId: nullable(row.workItemId, id), draftId: nullable(row.draftId, id),
    communicationPolicyId: nullable(row.communicationPolicyId, id), meetingRevisionId: nullable(row.meetingRevisionId, id), resolutionSha256: digest(row.resolutionSha256),
  });
}
// This additive projection is strict even though the older domain records keep
// their extension fields. It is evidence for inspection, never retry authority.
export function readMeetingReconciliation(value: unknown): MeetingResolutionReconciliation {
  const row = object(value);
  exactKeys(row, ["schemaVersion", "requestSha256", "decision", "state", "automaticRetryAllowed", "createdAt", "phases"]);
  requireValue(row.schemaVersion === 1 && row.automaticRetryAllowed === false);
  const decision = member(row.decision, ["confirmed", "dismissed"]);
  const state = member(row.state, ["pending", "partial", "uncertain", "resolved"]);
  const phases = array(row.phases, (value) => {
    const item = object(value);
    exactKeys(item, ["phase", "at", "resourceId", "evidenceSha256"]);
    const phase = member(item.phase, ["work_started", "work_completed", "draft_started", "draft_completed", "meeting_started", "meeting_completed", "resolution_started", "interrupted"]);
    const resourceId = nullable(item.resourceId, (value) => string(value).trim());
    requireValue(resourceId === null || resourceId.length > 0 && resourceId.length <= 240);
    const evidenceSha256 = nullable(item.evidenceSha256, digest);
    requireValue(phase.endsWith("_completed") ? resourceId !== null && evidenceSha256 !== null : resourceId === null && evidenceSha256 === null);
    return { phase, at: offsetTime(item.at), resourceId, evidenceSha256 };
  }, 8);
  const names = phases.map((phase) => phase.phase);
  requireValue(new Set(names).size === names.length);
  const sequence = names.at(-1) === "interrupted" ? names.slice(0, -1) : names;
  const plans = decision === "dismissed" ? [["resolution_started"]] : [
    ["work_started", "work_completed", "meeting_started", "meeting_completed", "resolution_started"],
    ["work_started", "work_completed", "draft_started", "draft_completed", "meeting_started", "meeting_completed", "resolution_started"],
  ];
  requireValue(plans.some((plan) => sequence.every((phase, index) => plan[index] === phase)));
  const unacknowledged = names.some((phase) => phase.endsWith("_started") && !names.includes(phase.replace("_started", "_completed") as typeof names[number]));
  const unresolved = names.includes("interrupted") || unacknowledged ? "uncertain" : names.some((phase) => phase.endsWith("_completed")) ? "partial" : "pending";
  requireValue(state === "resolved" ? names.at(-1) === "resolution_started" : state === unresolved);
  return { schemaVersion: 1, requestSha256: digest(row.requestSha256), decision, state, automaticRetryAllowed: false, createdAt: offsetTime(row.createdAt), phases };
}
function offsetTime(value: unknown) {
  const result = string(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result);
  requireValue(match);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximum = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  requireValue(maximum !== undefined && day >= 1 && day <= maximum);
  return result;
}
export function readMeetingReconciliationError(value: unknown) {
  const row = object(value);
  exactKeys(row, ["error", "code", ...(Object.hasOwn(row, "reconciliation") ? ["reconciliation"] : [])]);
  requireValue(row.code === "meeting_commitment_reconciliation_required");
  string(row.error, 1, 4000);
  return row.reconciliation === undefined ? undefined : readMeetingReconciliation(row.reconciliation);
}
export async function meetingResolutionRequestDigest(proposal: MeetingCommitmentProposal, scope: Pick<Meeting, "tenantId" | "workspaceId">, submitted: MeetingResolutionSubmission) {
  const communication = submitted.communication;
  const request = submitted.decision === "dismissed" ? { decision: "dismissed" } : {
    decision: "confirmed", ownerParticipantId: submitted.ownerParticipantId || proposal.ownership.participantId,
    dueAt: submitted.dueAt === undefined ? proposal.dueDate.dueAt : submitted.dueAt === null ? null : new Date(submitted.dueAt).toISOString(),
    communication: communication ? { connectionId: null, policyId: communication.policyId, recipientParticipantId: communication.recipientParticipantId, subject: communication.subject.trim(), body: communication.body.trim() } : null,
  };
  // A shared Meeting can have a different owner; the proposal's actor owns this intent.
  const body = { schemaVersion: 1, contract: "meeting-commitment-resolution-intent:1", tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    meetingId: proposal.meetingId, proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, ownerActorId: proposalActorId(proposal.proposedByActorId), request };
  function sorted(value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
    return value;
  }
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted(body))));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function assertMeetingReconciliationRead(received: readonly MeetingCommitmentView[], retained: Iterable<MeetingCommitmentView>) {
  for (const previous of retained) {
    if (!previous.reconciliation) continue;
    const next = received.find((view) => view.proposal.proposalId === previous.proposal.proposalId);
    const keepsEvidence = next && next.proposal.proposalSha256 === previous.proposal.proposalSha256 && next.proposal.proposedByActorId === previous.proposal.proposedByActorId && next.reconciliation &&
      next.reconciliation.requestSha256 === previous.reconciliation.requestSha256 && next.reconciliation.decision === previous.reconciliation.decision &&
      next.reconciliation.createdAt === previous.reconciliation.createdAt &&
      previous.reconciliation.phases.every((phase, index) => {
        const current = next.reconciliation!.phases[index];
        return current && current.phase === phase.phase && current.at === phase.at && current.resourceId === phase.resourceId && current.evidenceSha256 === phase.evidenceSha256;
      });
    if (!keepsEvidence) throw new Error("The latest read has not retained the recorded resolution intent and phase receipts. Existing evidence remains available for inspection.");
  }
}
export function meetingResolutionReceiptHref(proposal: MeetingCommitmentProposal, phase: MeetingResolutionReconciliation["phases"][number]): string | undefined {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (phase.phase === "work_completed" && uuid.test(proposal.projectId) && phase.resourceId && uuid.test(phase.resourceId))
    return `/app/projects?project=${encodeURIComponent(proposal.projectId)}&task=${encodeURIComponent(phase.resourceId)}`;
  if (phase.phase === "meeting_completed" && proposal.meetingId.startsWith("meeting:") && uuid.test(proposal.meetingId.slice(8)) &&
    phase.resourceId?.startsWith(`${proposal.meetingId}:v`) && /^[1-9]\d*$/.test(phase.resourceId.slice(proposal.meetingId.length + 2)))
    return `/app/meetings/${encodeURIComponent(proposal.meetingId)}`;
  return undefined;
}
function commitmentView(value: unknown) {
  const row = object(value); const proposed = proposal(row.proposal); const resolved = nullable(row.resolution, resolution);
  requireValue(!resolved || (resolved.proposalId === proposed.proposalId && resolved.proposalSha256 === proposed.proposalSha256 &&
    (resolved.decision === "confirmed" ? Boolean(resolved.ownerParticipantId && resolved.ownerDisplayName && resolved.ownershipAuthority && resolved.workItemId && resolved.meetingRevisionId) : !resolved.workItemId && !resolved.draftId && !resolved.ownerParticipantId) &&
    Boolean(resolved.draftId) === Boolean(resolved.communicationPolicyId)));
  const reconciliation = row.reconciliation === undefined ? undefined : readMeetingReconciliation(row.reconciliation);
  requireValue(!reconciliation || ((reconciliation.state === "resolved") === Boolean(resolved) && (!resolved || resolved.decision === reconciliation.decision)));
  if (resolved && reconciliation) {
    const known = (phase: string) => reconciliation.phases.find((item) => item.phase === phase)?.resourceId ?? null;
    requireValue(resolved.decision !== "confirmed" || known("work_completed") === resolved.workItemId && known("draft_completed") === resolved.draftId && known("meeting_completed") === resolved.meetingRevisionId);
  }
  return loose(row, { proposal: proposed, resolution: resolved, ...optional(row, "reconciliation", () => reconciliation) });
}
function policy(value: unknown): ContactPolicy & Row {
  const row = object(value); requireValue(row.channel === "email");
  return loose(row, { id: id(row.id), displayName: string(row.displayName), address: string(row.address), channel: "email" as const });
}
export function readMeetingListEnvelope(value: unknown) {
  const row = object(value);
  return { meetings: array(row.meetings, readMeeting, 200), context: context(row.context) };
}
export function readMeetingDetailEnvelope(value: unknown) {
  const row = object(value);
  return { meeting: readMeeting(row.meeting), context: context(row.context), linkedSources: array(row.linkedSources, linkedSource, 100) };
}
export function readMeetingCommitmentsEnvelope(value: unknown) {
  const row = object(value); const meeting = object(row.meeting);
  return { meeting: loose(meeting, { meetingId: id(meeting.meetingId), meetingRevisionId: id(meeting.meetingRevisionId), revision: positiveInteger(meeting.revision) }), context: context(row.context), commitments: array(row.commitments, commitmentView, 500), eligiblePolicies: array(row.eligiblePolicies, policy, 200) };
}
export function readMeetingIdEnvelope(value: unknown) { return { meeting: { meetingId: id(object(object(value).meeting).meetingId) } }; }
export function readMeetingProposalEnvelope(value: unknown) { return { commitment: commitmentView(object(value).commitment) }; }
function communicationDraft(value: unknown) {
  const row = object(value);
  return loose(row, { id: id(row.id), policyId: id(row.policyId), recipient: string(row.recipient, 1), subject: string(row.subject), body: string(row.body), draftSha256: digest(row.draftSha256) });
}
export function readMeetingResolutionEnvelope(value: unknown) {
  const row = object(value);
  return { commitment: commitmentView(row.commitment), ...optional(row, "meeting", readMeeting), ...optional(row, "draft", (value) => nullable(value, communicationDraft)) };
}
export function readMeetingMediaEnvelope(value: unknown) {
  const row = object(value); const head = object(row.media); const job = object(row.job);
  return {
    recording: { id: id(object(row.recording).id) },
    media: loose(head, { ...mediaFields(head), recordingId: id(head.recordingId), ...optional(head, "meetingId", id), ...optional(head, "rawAudioDeletedAt", (value) => nullable(value, time)), ...optional(head, "output", (value) => nullable(value, mediaOutput)) }),
    job: { id: id(job.id), status: member(job.status, ["queued", "running", "completed", "failed", "canceled"]) },
  };
}
export function readMeetingCalendarEnvelope(value: unknown) {
  const row = object(value); requireValue(row.provider === "google");
  return { provider: "google" as const, sources: array(row.sources, (value) => {
    const item = object(value);
    return loose(item, { source: string(item.source), status: member(item.status, ["healthy", "syncing", "error"]), imported: nonnegativeInteger(item.imported) });
  }) };
}
export function readMeetingProjects(value: unknown): ProjectOption[] {
  return array(object(value).projects, (value) => { const row = object(value); return { id: id(row.id), title: string(row.title) }; }, 100);
}
export function readMeetingEntities(value: unknown): EntityOption[] {
  return array(object(value).entities, (value) => {
    const row = object(value); return { entityId: id(row.entityId), entityTypeId: string(row.entityTypeId), canonicalLabel: string(row.canonicalLabel), state: string(row.state) };
  });
}
export function readMeetingLibrary(value: unknown): LibraryItem[] {
  return array(object(value).items, (value) => {
    const row = object(value); const version = object(row.currentVersion);
    return { id: id(row.id), kind: string(row.kind), sourceAuthority: string(row.sourceAuthority), sourceId: id(row.sourceId), title: string(row.title), sourceLabel: string(row.sourceLabel), status: string(row.status), currentVersion: { sourceRevisionId: nullable(version.sourceRevisionId, id), mediaType: string(version.mediaType) } };
  }, 100);
}
