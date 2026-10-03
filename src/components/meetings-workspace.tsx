"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Clock3,
  FileAudio,
  FileText,
  Link2,
  ListChecks,
  Loader2,
  Mail,
  MapPin,
  MessageSquareText,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { assertMeetingCommitmentRead, createMeetingRequestGate, freezeMeetingSubmission, startMeetingMediaReads, meetingCalendarReceipt, parseMeetingCommitments, parseMeetingDetail, parseMeetingList, parseMeetingMediaReceipt, parseMeetingMutation, parseMeetingProposalReceipt, parseMeetingResolutionReceipt, parseMeetingOptions, type MeetingReadState } from "./meetings-workspace-state";
import styles from "@/components/meetings-workspace.module.css";

type MeetingStatus = "scheduled" | "in_progress" | "completed" | "cancelled";
type AccessClass = "owner_private" | "project_members" | "workspace_members";
type Participant = {
  participantId: string;
  displayName: string;
  email: string | null;
  entityId: string | null;
  role: "organizer" | "required" | "optional" | "guest";
  response: "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
  attendeeConsent: "granted" | "declined" | "pending" | "unknown";
  recordingConsent: "granted" | "declined" | "pending" | "not_required" | "unknown";
  consentCapturedAt: string | null;
  source: "calendar" | "manual";
};
type SourceLink = {
  linkId: string;
  kind: "calendar_event" | "capture_recording" | "capture_asset" | "source_revision";
  sourceId: string;
  sourceRevisionId?: string;
  sourceRevisionSha256?: string;
  sourceAuthoritySha256?: string;
  accessClass?: AccessClass;
  mediaRole: "calendar" | "recording" | "transcript" | "attachment" | "reference";
  label: string;
};
type EntityLink = {
  entityId: string;
  entityType: "person" | "organization" | "account" | "project";
  label: string;
  relationship: "customer" | "account" | "participant" | "subject" | "related";
};
type Decision = { decisionId: string; summary: string; ownerParticipantId: string | null; sourceLinkId: string | null };
type Commitment = { commitmentId: string; summary: string; ownerParticipantId: string | null; dueAt: string | null; sourceLinkId: string | null };
type FollowUp = { followUpId: string; label: string; status: "proposed" | "accepted" | "completed" | "dismissed"; workItemId: string | null; draftId: string | null; commitmentId: string | null };
export type Meeting = {
  schemaVersion: 1;
  tenantId: string;
  workspaceId: string;
  meetingId: string;
  meetingRevisionId: string;
  revision: number;
  ownerActorId: string;
  title: string;
  summary: string;
  status: MeetingStatus;
  scheduledStartAt: string;
  scheduledEndAt: string;
  actualStartAt: string | null;
  actualEndAt: string | null;
  timezone: string;
  location: string;
  projectId: string | null;
  declaredAccessClass: AccessClass;
  effectiveAccessClass: AccessClass;
  participants: Participant[];
  sourceLinks: SourceLink[];
  entityLinks: EntityLink[];
  decisions: Decision[];
  commitments: Commitment[];
  followUps: FollowUp[];
  revisedAt: string;
  meetingSha256: string;
};
type MediaCitation = {
  turnId: string;
  segmentIndex: number;
  startMilliseconds: number;
  endMilliseconds: number;
  speakerLabel: string;
  speakerParticipantId?: string;
};
type MediaTurn = {
  turnId: string;
  startMilliseconds: number;
  endMilliseconds: number;
  languageTag: string;
  speaker: {
    label: string;
    identity: "known" | "diarized" | "unknown";
    participantId?: string;
    displayName?: string;
  };
  text: string;
};
type CitedMediaText = { text: string; citations: MediaCitation[] };
export type ProcessedMeetingMediaView = {
  processingStatus: "queued" | "processing" | "waiting" | "ready" | "failed";
  operationJobId: string;
  rawAudioDeletedAt: string | null;
  updatedAt: string;
  output: null | {
    mediaRevisionId: string;
    processedAt: string;
    languageTags: string[];
    turns: MediaTurn[];
    chapters: Array<CitedMediaText & {
      chapterId: string;
      title: string;
      startMilliseconds: number;
      endMilliseconds: number;
    }>;
    summary: CitedMediaText;
    actionItems: Array<CitedMediaText & {
      actionItemId: string;
      ownerParticipantId?: string;
      dueAt?: string;
      ownershipEvidence: "explicit" | "unconfirmed";
      dueDateEvidence: "explicit" | "unconfirmed";
    }>;
    decisions: Array<CitedMediaText & { decisionId: string }>;
    warnings: string[];
  };
};
export function meetingRecordingCanProcess(
  canWrite: boolean,
  participants: Pick<Participant, "recordingConsent">[],
  source: Pick<LinkedSource, "kind" | "media">,
) {
  return canWrite &&
    source.kind === "capture_recording" &&
    (!source.media || source.media.processingStatus === "failed") &&
    participants.length > 0 &&
    participants.every((participant) =>
      ["granted", "not_required"].includes(participant.recordingConsent)
    );
}
export type LinkedSource = {
  linkId: string;
  kind: SourceLink["kind"];
  sourceId: string;
  mediaRole: SourceLink["mediaRole"];
  label: string;
  revisionState: "exact" | "changed" | "unavailable";
  status: string | null;
  mediaType: string | null;
  durationMs: number | null;
  byteCount: number | null;
  updatedAt: string | null;
  transcript: string | null;
  transcriptTruncated: boolean;
  media: ProcessedMeetingMediaView | null;
  segments: Array<{ segmentIndex: number; mimeType: string; durationMs: number }>;
};
export type WorkspaceContext = { workspaceId: string; accessLevel: string; canWrite: boolean };
export type ContactPolicy = {
  id: string;
  displayName: string;
  address: string;
  channel: "email";
};
export type MeetingCommitmentProposal = {
  proposalId: string;
  proposalSha256: string;
  meetingId: string;
  meetingRevisionId: string;
  projectId: string;
  mediaRevisionId: string;
  actionItemId: string;
  title: string;
  citations: MediaCitation[];
  ownership: {
    participantId: string | null;
    displayName: string | null;
    authority: "explicit_transcript" | "confirmation_required";
  };
  dueDate: {
    dueAt: string | null;
    authority: "explicit_transcript" | "confirmation_required";
  };
};
export type MeetingCommitmentResolution = {
  proposalId: string;
  proposalSha256: string;
  resolutionSha256: string;
  decision: "confirmed" | "dismissed";
  ownerParticipantId: string | null;
  ownerDisplayName: string | null;
  ownershipAuthority: "explicit_transcript" | "user_confirmed" | null;
  dueAt: string | null;
  dueDateAuthority: "explicit_transcript" | "user_confirmed" | null;
  workItemId: string | null;
  draftId: string | null;
  communicationPolicyId: string | null;
};
export type MeetingCommitmentView = {
  proposal: MeetingCommitmentProposal;
  resolution: MeetingCommitmentResolution | null;
};
export type ProjectOption = { id: string; title: string };
export type EntityOption = { entityId: string; entityTypeId: string; canonicalLabel: string; state: string };
export type LibraryItem = {
  id: string;
  kind: string;
  sourceAuthority: string;
  sourceId: string;
  title: string;
  sourceLabel: string;
  status: string;
  currentVersion: { sourceRevisionId: string | null; mediaType: string };
};
export type MeetingDraft = Omit<Meeting,
  "schemaVersion" | "tenantId" | "workspaceId" | "meetingId" |
  "meetingRevisionId" | "revision" | "ownerActorId" |
  "effectiveAccessClass" | "revisedAt" | "meetingSha256"
>;

export function MeetingsWorkspace({ initialMeetingId }: { initialMeetingId?: string }) {
  const { session, status, refresh } = useWorkspaceSession();
  const reason = permissionMessage(session, status, "read");
  if (reason && (!session || (session.authEnabled && !session.authenticated))) return <section className={styles.shell} aria-labelledby="meetings-title"><header className={styles.hero}><h1 id="meetings-title">Meetings</h1></header><p role="status">{reason}</p><button className={styles.secondaryButton} disabled={status === "loading"} onClick={() => void refresh()}>Check workspace access</button></section>;
  return <ScopedMeetingsWorkspace key={JSON.stringify([session?.context?.tenantId, session?.context?.actorId, session?.membership?.role ?? session?.context?.role, initialMeetingId])} initialMeetingId={initialMeetingId} />;
}

type ReadChannel = "list" | "detail" | "commitments" | "projects" | "entities" | "library";
const initialReads: Record<ReadChannel, MeetingReadState> = Object.fromEntries(
  ["list", "detail", "commitments", "projects", "entities", "library"].map((key) => [key, { loaded: false, loading: false }]),
) as Record<ReadChannel, MeetingReadState>;

function ScopedMeetingsWorkspace({ initialMeetingId }: { initialMeetingId?: string }) {
  const { session, status: sessionStatus } = useWorkspaceSession();
  const tenantId = session?.context?.tenantId;
  const workflowReason = permissionMessage(session, sessionStatus, "manage.workflow");
  const mediaReason = permissionMessage(session, sessionStatus, "write.memory");
  const proposalReason = permissionMessage(session, sessionStatus, "run.agent");
  const [gate] = useState(createMeetingRequestGate);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Meeting>();
  const selectedRef = useRef<Meeting | undefined>(undefined);
  const [selectionId, setSelectionId] = useState(initialMeetingId);
  const selectionRef = useRef(initialMeetingId);
  const [linkedSources, setLinkedSources] = useState<LinkedSource[]>([]);
  const [commitmentSnapshot, setCommitmentSnapshot] = useState<ReturnType<typeof parseMeetingCommitments>>();
  const confirmedCommitments = useRef(new Map<string, MeetingCommitmentView>());
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [reads, setReads] = useState(initialReads);
  const [editor, setEditor] = useState<MeetingDraft>();
  const [editBase, setEditBase] = useState<{ meetingId: string; revision: number }>();
  const mutationKeyRef = useRef("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<string>();
  const [announcement, setAnnouncement] = useState("Checking meetings.");
  const [calendarSyncMessage, setCalendarSyncMessage] = useState("Calendar checks on open and every five minutes while this page remains mounted.");
  const [calendarSyncedAt, setCalendarSyncedAt] = useState<string>();
  const [calendarSyncStatus, setCalendarSyncStatus] = useState("unchecked");
  const editorOrigin = useRef<HTMLElement | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const receiptElement = useRef<HTMLDivElement>(null);
  const editorOpen = useRef(false);
  const focusFrame = useRef<number | undefined>(undefined);

  const read = useCallback(async (channel: ReadChannel, path: string, apply: (body: Record<string, unknown>) => void, signal?: AbortSignal) => {
    const request = gate.beginRead(channel);
    if (signal?.aborted) request.abort();
    signal?.addEventListener("abort", request.abort, { once: true });
    setReads((current) => ({ ...current, [channel]: { ...current[channel], loading: true } }));
    try {
      const body = await readJson(path, { signal: request.signal });
      if (!request.current()) return;
      apply(body);
      setReads((current) => ({ ...current, [channel]: { loaded: true, loading: false } }));
    } catch (failure) {
      if (request.current()) setReads((current) => ({ ...current, [channel]: { ...current[channel], loading: false, error: message(failure) } }));
    } finally {
      signal?.removeEventListener("abort", request.abort);
      if (request.owns() && request.signal.aborted) setReads((current) => ({ ...current, [channel]: { ...current[channel], loading: false } }));
    }
  }, [gate]);

  const loadList = useCallback(() => read("list", "/api/meetings?limit=200", (body) => {
    const data = parseMeetingList(body, tenantId);
    setMeetings(data.meetings);
    setWorkspaceContext(data.context);
    if (!selectionRef.current && data.meetings[0]) {
      selectionRef.current = data.meetings[0].meetingId;
      setSelectionId(data.meetings[0].meetingId);
    }
  }), [read, tenantId]);

  const loadDetail = useCallback((meetingId: string, signal?: AbortSignal) => read("detail", `/api/meetings/${encodeURIComponent(meetingId)}`, (body) => {
    const data = parseMeetingDetail(body, meetingId, tenantId);
    if (selectionRef.current !== meetingId) return;
    const previous = selectedRef.current;
    if (previous?.meetingId === meetingId && (data.meeting.revision < previous.revision || (data.meeting.revision === previous.revision && data.meeting.meetingSha256 !== previous.meetingSha256))) throw new Error("The meeting revision changed inconsistently. Retry its detail.");
    selectedRef.current = data.meeting;
    setSelected(data.meeting);
    setLinkedSources(data.linkedSources);
    setWorkspaceContext(data.context);
  }, signal), [read, tenantId]);

  const loadCommitments = useCallback((meetingId: string, signal?: AbortSignal) => read("commitments", `/api/meetings/${encodeURIComponent(meetingId)}/commitments`, (body) => {
    const data = parseMeetingCommitments(body, meetingId);
    assertMeetingCommitmentRead(data.commitments, confirmedCommitments.current.values(), meetingId);
    if (selectionRef.current === meetingId) setCommitmentSnapshot(data);
  }, signal), [read]);

  const loadOptions = useCallback(() => {
    void read("projects", "/api/projects?view=summary&limit=100", (body) => setProjects(parseMeetingOptions("projects", body)));
    void read("entities", "/api/entities", (body) => setEntities(parseMeetingOptions("entities", body)));
    void read("library", "/api/library?kind=meeting,recording,transcript,document,file,image,audio,video&limit=100", (body) => setLibrary(parseMeetingOptions("library", body)));
  }, [read]);
  const refresh = useCallback(() => {
    void loadList();
    loadOptions();
    if (selectionRef.current) {
      void loadDetail(selectionRef.current);
      void loadCommitments(selectionRef.current);
    }
  }, [loadList, loadOptions, loadDetail, loadCommitments]);

  useEffect(() => {
    gate.mount();
    const timer = window.setTimeout(refresh, 0);
    return () => { gate.dispose(); window.clearTimeout(timer); if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current); };
  }, [gate, refresh]);
  useEffect(() => {
    if (!selectionId) return;
    void loadDetail(selectionId);
    void loadCommitments(selectionId);
    return () => { gate.abortRead("detail"); gate.abortRead("commitments"); };
  }, [selectionId, gate, loadDetail, loadCommitments]);

  const syncCalendar = useCallback(async () => {
    if (mediaReason) return;
    const action = gate.beginWrite();
    if (!action) return;
    setBusy("calendar");
    setCalendarSyncMessage("Checking Google Calendar for changes…");
    setCalendarSyncStatus("pending");
    let refreshAfter = false;
    try {
      const body = await readJson("/api/oauth/google/sync?source=calendar", { method: "POST" });
      if (!action.current()) return;
      const result = meetingCalendarReceipt(body);
      setCalendarSyncMessage(result.message);
      setCalendarSyncStatus(result.status);
      if (result.status === "healthy") setCalendarSyncedAt(new Date().toISOString());
      setAnnouncement(result.message);
      refreshAfter = true;
    } catch (failure) {
      if (action.current()) {
        setCalendarSyncMessage(message(failure));
        setCalendarSyncStatus("unconfirmed");
      }
    } finally {
      if (action.current()) { setBusy(undefined); action.finish(); if (refreshAfter) refresh(); }
    }
  }, [gate, mediaReason, refresh]);
  useEffect(() => {
    const initial = window.setTimeout(() => void syncCalendar(), 700);
    const interval = window.setInterval(() => void syncCalendar(), 5 * 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [syncCalendar]);

  const pendingMedia = linkedSources.some((source) => source.media && ["queued", "processing", "waiting"].includes(source.media.processingStatus));
  useEffect(() => {
    if (!selectionId || !pendingMedia) return;
    return startMeetingMediaReads((signal) => loadDetail(selectionId, signal));
  }, [selectionId, pendingMedia, loadDetail]);

  const markStale = () => {
    gate.invalidateReads();
    setReads((current) => Object.fromEntries(Object.entries(current).map(([key, state]) => [key, { ...state, loading: false, stale: state.loaded }])) as typeof current);
  };
  const restoreEditorFocus = () => {
    focusFrame.current = window.requestAnimationFrame(() => {
      if (!editorOpen.current && (document.activeElement === document.body || document.activeElement === null)) (editorOrigin.current?.isConnected ? editorOrigin.current : pageHeading.current)?.focus();
    });
  };
  const openEditor = (meeting?: Meeting) => {
    if (gate.isWriting() || workflowReason || !workspaceContext?.canWrite) return;
    editorOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutationKeyRef.current = meeting ? `meeting-update:${meeting.meetingId}:${meeting.revision}:${crypto.randomUUID()}` : `meeting-create:${crypto.randomUUID()}`;
    setEditBase(meeting ? { meetingId: meeting.meetingId, revision: meeting.revision } : undefined);
    setEditor(meeting ? meetingDraft(meeting) : emptyMeetingDraft());
    editorOpen.current = true;
    setError(undefined);
    focusFrame.current = window.requestAnimationFrame(() => { if (editorOpen.current && (document.activeElement === document.body || document.activeElement === editorOrigin.current)) editorHeading.current?.focus(); });
  };
  const closeEditor = () => {
    if (gate.isWriting()) return;
    editorOpen.current = false;
    setEditor(undefined);
    setEditBase(undefined);
    restoreEditorFocus();
  };

  async function mutate(label: string, request: () => Promise<Record<string, unknown>>, accept: (body: Record<string, unknown>) => string, after?: () => void) {
    const action = gate.beginWrite();
    if (!action) return;
    const origin = document.activeElement;
    setBusy(label);
    setError(undefined);
    let accepted = false;
    try {
      const body = await request();
      if (!action.current()) return;
      const feedback = accept(body);
      accepted = true;
      setReceipt(feedback);
      setAnnouncement(feedback);
    } catch (failure) {
      if (action.current()) setError(`${message(failure)} Check the current meeting before retrying an uncertain change.`);
    } finally {
      if (action.current()) {
        setBusy(undefined);
        action.finish();
        if (accepted) {
          after?.();
          refresh();
          focusFrame.current = window.requestAnimationFrame(() => {
            if (!gate.isWriting() && (document.activeElement === origin || document.activeElement === document.body)) receiptElement.current?.focus();
          });
        }
      }
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || workflowReason || !workspaceContext?.canWrite) return;
    const { draft: submitted, base, key } = freezeMeetingSubmission(editor, editBase, mutationKeyRef.current);
    await mutate("save", () => readJson(base ? `/api/meetings/${encodeURIComponent(base.meetingId)}` : "/api/meetings", {
      method: base ? "PATCH" : "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ ...submitted, ...(base ? { expectedRevision: base.revision } : {}), sourceLinks: submitted.sourceLinks.map(sourceLinkRequest) }),
    }), (body) => {
      const data = parseMeetingMutation(body, submitted, base, tenantId);
      markStale();
      setMeetings((current) => [data.meeting, ...current.filter((item) => item.meetingId !== data.meeting.meetingId)].sort((a, b) => b.scheduledStartAt.localeCompare(a.scheduledStartAt)));
      selectionRef.current = data.meeting.meetingId;
      setSelectionId(data.meeting.meetingId);
      selectedRef.current = data.meeting;
      setSelected(data.meeting);
      setLinkedSources(data.linkedSources);
      editorOpen.current = false;
      setEditor(undefined);
      setEditBase(undefined);
      mutationKeyRef.current = "";
      return base ? `Meeting revision ${data.meeting.revision} confirmed.` : "Meeting creation confirmed.";
    });
  }

  async function processLinkedRecording(source: LinkedSource) {
    const meeting = selectedRef.current;
    if (!meeting || !workspaceContext || mediaReason || !meetingRecordingCanProcess(workspaceContext.canWrite, meeting.participants, source)) return;
    const target = { meetingId: meeting.meetingId, recordingId: source.sourceId, workspaceId: workspaceContext.workspaceId };
    await mutate(`recording:${source.sourceId}`, () => readJson(`/api/capture/recordings/${encodeURIComponent(target.recordingId)}/complete`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": `meeting-media:${target.meetingId}:${target.recordingId}` },
      body: JSON.stringify({ meetingId: target.meetingId, workspaceId: target.workspaceId, rawAudioRetention: { mode: "retain" } }),
    }), (body) => {
      const media = parseMeetingMediaReceipt(body, target.recordingId, target.meetingId);
      markStale();
      setLinkedSources((current) => current.map((item) => item.sourceId === target.recordingId ? { ...item, media } : item));
      return `Recording ${target.recordingId}: ${media.processingStatus} confirmed. Processing continues independently of this page.`;
    });
  }

  async function proposeCommitment(mediaRevisionId: string, actionItemId: string) {
    const meeting = selectedRef.current;
    if (!meeting || !workspaceContext?.canWrite || proposalReason || !meeting.projectId || !commitmentsCurrent) return;
    const target = { meetingId: meeting.meetingId, meetingRevisionId: meeting.meetingRevisionId, projectId: meeting.projectId, mediaRevisionId, actionItemId };
    await mutate(`proposal:${actionItemId}`, () => readJson(`/api/meetings/${encodeURIComponent(target.meetingId)}/commitments`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": `meeting-proposal:${mediaRevisionId}:${actionItemId}` },
      body: JSON.stringify({ mediaRevisionId, actionItemId }),
    }), (body) => {
      const commitment = parseMeetingProposalReceipt(body, target);
      markStale();
      confirmedCommitments.current.set(commitment.proposal.proposalId, commitment);
      setCommitmentSnapshot((current) => current ? { ...current, commitments: [...current.commitments.filter((item) => item.proposal.proposalId !== commitment.proposal.proposalId), commitment] } : current);
      return `Proposal ${commitment.proposal.proposalId} confirmed. Review the exact owner, due date and any unsent draft before conversion.`;
    });
  }

  async function resolveCommitment(proposal: MeetingCommitmentProposal, decision: "confirmed" | "dismissed", details: { ownerParticipantId?: string; dueAt?: string | null; communication?: { policyId: string; recipientParticipantId: string; subject: string; body: string } | null } = {}) {
    if (!selectedRef.current || !workspaceContext?.canWrite || workflowReason || !commitmentsCurrent) return;
    const target = structuredClone(proposal);
    const submitted = structuredClone({ decision, ...details });
    const recipientEmail = submitted.communication ? selectedRef.current.participants.find((item) => item.participantId === submitted.communication?.recipientParticipantId)?.email ?? undefined : undefined;
    if (submitted.communication && !recipientEmail) return;
    await mutate(`resolution:${target.proposalId}`, () => readJson(`/api/meetings/${encodeURIComponent(target.meetingId)}/commitments`, {
      method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": `meeting-resolution:${target.proposalSha256}` },
      body: JSON.stringify({ proposalId: target.proposalId, expectedProposalSha256: target.proposalSha256, ...submitted }),
    }), (body) => {
      const result = parseMeetingResolutionReceipt(body, target, submitted, recipientEmail);
      markStale();
      confirmedCommitments.current.set(target.proposalId, result.commitment);
      setCommitmentSnapshot((current) => current ? { ...current, commitments: current.commitments.map((item) => item.proposal.proposalId === target.proposalId ? result.commitment : item) } : current);
      if (result.meeting) {
        selectedRef.current = result.meeting;
        setSelected(result.meeting);
        setMeetings((current) => current.map((item) => item.meetingId === target.meetingId ? result.meeting! : item));
      }
      return decision === "confirmed" ? `Commitment confirmed: WorkItem ${result.commitment.resolution!.workItemId}${result.commitment.resolution!.draftId ? `; unsent draft ${result.commitment.resolution!.draftId}; recipient ${recipientEmail}` : ""}.${result.draftVerification === "identity_only" ? " Draft identity is confirmed; this receipt did not return its content." : result.draftVerification === "returned_content" ? " Returned draft recipient and content match the submitted review." : ""}` : `Proposal ${target.proposalId} dismissal confirmed.`;
    });
  }

  const commitmentsCurrent = Boolean(selected && commitmentSnapshot?.meeting.meetingRevisionId === selected.meetingRevisionId && !reads.commitments.error && !reads.commitments.loading && !reads.commitments.stale);
  const commitmentViews = commitmentSnapshot?.meeting.meetingId === selected?.meetingId ? commitmentSnapshot?.commitments ?? [] : [];
  const canWrite = Boolean(workspaceContext?.canWrite && !workflowReason);
  const writeReason = workflowReason ?? (workspaceContext?.canWrite === false ? "This workspace grants read access. Contributor access is required to revise meetings." : !workspaceContext ? "Meeting write authority has not been checked." : undefined);
  const known = reads.list.loaded;
  const stale = reads.list.loading || Boolean(reads.list.error) || reads.list.stale;
  const upcoming = known ? meetings.filter((meeting) => meeting.status === "scheduled").length : undefined;
  const completed = known ? meetings.filter((meeting) => meeting.status === "completed").length : undefined;
  const unresolvedConsent = known ? meetings.reduce((count, meeting) => count + meeting.participants.filter((person) => ["pending", "unknown"].includes(person.attendeeConsent) || ["pending", "unknown"].includes(person.recordingConsent)).length, 0) : undefined;
  return <section className={styles.shell} aria-labelledby="meetings-title" data-testid="meetings-workspace">
    <p className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    <header className={styles.hero}><div><h1 id="meetings-title" ref={pageHeading} tabIndex={-1}>Meetings</h1><p>People, consent, source evidence and reviewed follow-through.</p></div><div className={styles.heroActions}>
      <button type="button" className={styles.secondaryButton} onClick={refresh} disabled={reads.list.loading}>Refresh meetings</button>
      <button type="button" className={styles.secondaryButton} onClick={() => void syncCalendar()} disabled={Boolean(busy) || Boolean(mediaReason)}>Sync Calendar{busy === "calendar" ? "…" : ""}</button>
      <Link href="/app/capture" className={styles.secondaryButton}>Open Capture</Link>
      <button type="button" className={styles.primaryButton} disabled={!canWrite || Boolean(busy)} onClick={() => openEditor()}>New meeting</button>
    </div></header>
    <div className={styles.calendarSyncStatus} role="status"><div><strong>Google Calendar · {calendarSyncStatus}</strong><p>{mediaReason ?? calendarSyncMessage}</p></div><p>{calendarSyncedAt ? `Last confirmed sync ${formatTimestamp(calendarSyncedAt)}` : "No successful calendar sync has been confirmed on this page."}</p></div>
    {writeReason ? <p className={styles.fieldHelp}>{writeReason}</p> : null}
    <section className={styles.metrics} aria-label="Meeting overview"><Metric value={upcoming} label="Scheduled" detail={known && stale ? "last loaded" : "in this window"} /><Metric value={completed} label="Completed" detail={known && stale ? "last loaded" : "in this window"} /><Metric value={unresolvedConsent} label="Consent checks" detail="unresolved participant states" warning={Boolean(unresolvedConsent)} /><Metric value={known ? meetings.length : undefined} label="Readable meetings" detail="up to 200 records" /></section>
    <details className={styles.coverage}><summary>Source coverage</summary><p>Meeting counts describe up to 200 readable records. Projects and Library each return up to 100 options; these windows may omit older records. Entity options come from the readable registry.</p><dl>{(Object.keys(reads) as ReadChannel[]).map((key) => <div key={key}><dt>{key === "list" ? "Meetings" : key}</dt><dd>{reads[key].loading ? reads[key].loaded ? "Refreshing; last loaded records retained." : "Checking; availability unknown." : reads[key].error ? reads[key].loaded ? "Refresh failed; last loaded records retained." : "Unavailable." : reads[key].stale ? "Last loaded; awaiting refresh." : reads[key].loaded ? "Loaded." : key === "detail" || key === "commitments" ? "No meeting selected." : "Not checked."}{reads[key].error ? <p>{reads[key].error}</p> : null}</dd></div>)}</dl></details>
    {receipt ? <div className={styles.receipt} role="status" ref={receiptElement} tabIndex={-1}><p>{receipt}</p>{selected ? <Link href={`/app/meetings/${encodeURIComponent(selected.meetingId)}`}>Open this meeting’s permanent link</Link> : null}</div> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {reads.list.error ? <div className={styles.error}><p>{reads.list.error}</p><button className={styles.secondaryButton} onClick={() => void loadList()}>Retry meeting list</button></div> : null}
    {editor ? <MeetingEditor draft={editor} setDraft={setEditor} projects={projects} entities={entities} library={library} saving={Boolean(busy)} blockedReason={writeReason} pendingLabel={busy === "calendar" ? "Calendar sync in progress…" : "Saving…"} editing={Boolean(editBase)} headingRef={editorHeading} onSubmit={save} onCancel={closeEditor} /> : <div className={styles.workspace}>
      <aside className={styles.rail} aria-label="Meeting list"><div className={styles.railHeading}><h2>Timeline</h2><span>{known ? `${stale ? "Last loaded: " : ""}${meetings.length} in window` : "Count unavailable"}</span></div>
        {meetings.length ? meetings.map((meeting) => <Link key={meeting.meetingId} href={`/app/meetings/${encodeURIComponent(meeting.meetingId)}`} aria-current={selected?.meetingId === meeting.meetingId ? "page" : undefined} className={selected?.meetingId === meeting.meetingId ? styles.selectedRailItem : styles.railItem}><span className={styles.statusDot} data-status={meeting.status} /><span><strong>{meeting.title}</strong><small>{formatCompactDate(meeting.scheduledStartAt)} · {meeting.status.replaceAll("_", " ")} · {meeting.participants.length} people</small></span><ChevronRight size={16} aria-hidden="true" /></Link>) : <div className={styles.emptyRail}><p>{known ? "No meetings were returned in this readable window." : reads.list.loading ? "Checking the meeting list…" : "Meeting availability is unknown."}</p></div>}
      </aside>
      <section className={styles.canvas} aria-label="Selected meeting" aria-busy={reads.detail.loading}>
        {reads.detail.error ? <div className={styles.error}><p>{reads.detail.error}{selected ? " Last loaded detail remains below." : ""}</p><button className={styles.secondaryButton} onClick={() => selectionId && void loadDetail(selectionId)}>Retry meeting detail</button></div> : null}
        {selected ? <><p className={styles.readStatus}>{reads.detail.loading || reads.detail.error || reads.detail.stale ? "Last loaded meeting detail." : "Meeting detail loaded."}</p>
          {!commitmentsCurrent ? <div className={styles.notice}><p>{reads.commitments.error ?? (reads.commitments.loading ? "Checking commitment review; availability is not yet confirmed." : "Commitment review is awaiting the current meeting revision. Retained proposals are not actionable.")}</p><button className={styles.secondaryButton} disabled={reads.commitments.loading} onClick={() => void loadCommitments(selected.meetingId)}>Retry commitment review</button></div> : null}
          <MeetingDetail meeting={selected} linkedSources={linkedSources} commitmentViews={commitmentViews} commitmentsKnown={Boolean(commitmentSnapshot)} eligiblePolicies={commitmentSnapshot?.eligiblePolicies ?? []} project={projects.find((item) => item.id === selected.projectId)} canWrite={canWrite} writeBusy={Boolean(busy)} canProcess={!mediaReason && Boolean(workspaceContext?.canWrite)} canPropose={!proposalReason && Boolean(workspaceContext?.canWrite) && commitmentsCurrent} canResolve={canWrite && commitmentsCurrent} processingRecordingId={busy?.startsWith("recording:") ? busy.slice(10) : undefined} commitmentBusyId={busy?.startsWith("proposal:") ? busy.slice(9) : busy?.startsWith("resolution:") ? busy.slice(11) : undefined} onEdit={() => openEditor(selected)} onProcessRecording={(source) => void processLinkedRecording(source)} onProposeCommitment={(media, action) => void proposeCommitment(media, action)} onResolveCommitment={(proposal, decision, details) => void resolveCommitment(proposal, decision, details)} />
        </> : <div className={styles.emptyCanvas}><h2>{reads.detail.loading ? "Checking meeting detail" : selectionId ? "Meeting detail is unavailable" : known ? "No meeting selected" : "Meetings are unavailable"}</h2><p>{selectionId ? "The exact requested meeting must be loaded before its evidence or actions can be shown." : known ? "Create a meeting or choose a record from the timeline." : "The source reads have not established whether meetings are available."}</p></div>}
      </section>
    </div>}
  </section>;
}
function MeetingDetail({
  meeting,
  linkedSources,
  commitmentViews,
  commitmentsKnown,
  eligiblePolicies,
  project,
  canWrite,
  writeBusy,
  canProcess,
  canPropose,
  canResolve,
  processingRecordingId,
  commitmentBusyId,
  onEdit,
  onProcessRecording,
  onProposeCommitment,
  onResolveCommitment,
}: {
  meeting: Meeting;
  linkedSources: LinkedSource[];
  commitmentViews: MeetingCommitmentView[];
  commitmentsKnown: boolean;
  eligiblePolicies: ContactPolicy[];
  project?: ProjectOption;
  canWrite: boolean;
  writeBusy: boolean;
  canProcess: boolean;
  canPropose: boolean;
  canResolve: boolean;
  processingRecordingId?: string;
  commitmentBusyId?: string;
  onEdit: () => void;
  onProcessRecording: (source: LinkedSource) => void;
  onProposeCommitment: (mediaRevisionId: string, actionItemId: string) => void;
  onResolveCommitment: (
    proposal: MeetingCommitmentProposal,
    decision: "confirmed" | "dismissed",
    details?: {
      ownerParticipantId?: string;
      dueAt?: string | null;
      communication?: {
        policyId: string;
        recipientParticipantId: string;
        subject: string;
        body: string;
      } | null;
    },
  ) => void;
}) {
  const transcriptSources = linkedSources.filter((source) =>
    source.transcript && !source.media?.output
  );
  const processedMedia = linkedSources.filter((source) => source.media);
  return (
    <div className={styles.detail}>
      <div className={styles.detailTopline}>
        <Link href="/app/meetings" className={styles.backLink}><ArrowLeft size={14} /> All meetings</Link>
        <div className={styles.badges}>
          <span data-tone={meeting.status}>{meeting.status.replace("_", " ")}</span>
          <span><ShieldCheck size={12} /> {accessLabel(meeting.effectiveAccessClass)}</span>
          <span>revision {meeting.revision}</span>
        </div>
      </div>
      <header className={styles.meetingHeader}>
        <div><p className={styles.eyebrow}>{formatDateRange(meeting.scheduledStartAt, meeting.scheduledEndAt)}</p><h2>{meeting.title}</h2><p>{meeting.summary || "No meeting summary has been recorded yet."}</p></div>
        <button type="button" className={styles.secondaryButton} disabled={!canWrite || writeBusy} onClick={onEdit}><Save size={16} aria-hidden="true" /> Revise</button>
      </header>

      <div className={styles.metadataGrid}>
        <Metadata icon={<Clock3 size={16} />} label="Time" value={`${formatTime(meeting.scheduledStartAt)}–${formatTime(meeting.scheduledEndAt)} · ${meeting.timezone}`} />
        <Metadata icon={<MapPin size={16} />} label="Location" value={meeting.location || "Not specified"} />
        <Metadata icon={<ListChecks size={16} />} label="Project" value={project?.title || meeting.projectId || "No linked project"} href={meeting.projectId ? `/app/projects?project=${encodeURIComponent(meeting.projectId)}` : undefined} />
        <Metadata icon={<Link2 size={16} />} label="Source policy" value={`${meeting.sourceLinks.length} exact link${meeting.sourceLinks.length === 1 ? "" : "s"} · ${accessLabel(meeting.effectiveAccessClass)}`} />
      </div>

      <details className={styles.provenance}><summary>Meeting identity and access</summary><dl><div><dt>Meeting ID</dt><dd><code>{meeting.meetingId}</code></dd></div><div><dt>Revision</dt><dd><code>{meeting.meetingRevisionId}</code></dd></div><div><dt>Revision digest</dt><dd><code>{meeting.meetingSha256}</code></dd></div><div><dt>Tenant</dt><dd><code>{meeting.tenantId}</code></dd></div><div><dt>Workspace</dt><dd><code>{meeting.workspaceId}</code></dd></div><div><dt>Owner</dt><dd><code>{meeting.ownerActorId}</code></dd></div><div><dt>Declared access</dt><dd>{accessLabel(meeting.declaredAccessClass)}</dd></div><div><dt>Effective access</dt><dd>{accessLabel(meeting.effectiveAccessClass)}</dd></div></dl></details>

      <section className={styles.section}>
        <SectionHeading icon={<UsersRound size={17} />} eyebrow="People & permission" title="Participants and consent" count={meeting.participants.length} />
        {meeting.participants.length ? <div className={styles.participantGrid}>{meeting.participants.map((participant) => (
          <article key={participant.participantId} className={styles.participantCard}>
            <div className={styles.avatar}>{initials(participant.displayName)}</div>
            <div><strong>{participant.displayName}</strong><p>{participant.email || participant.role}</p><div className={styles.consentRow}><ConsentBadge label="attendee" value={participant.attendeeConsent} /><ConsentBadge label="recording" value={participant.recordingConsent} /></div><details className={styles.provenance}><summary>Participant evidence</summary><p><code>{participant.participantId}</code></p><p>Source: {participant.source} · Response: {participant.response.replaceAll("_", " ")}</p><p>{participant.consentCapturedAt ? `Consent recorded ${formatTimestamp(participant.consentCapturedAt)}` : "No consent capture timestamp recorded."}</p></details></div>
          </article>
        ))}</div> : <EmptyLine>No participants have been attached.</EmptyLine>}
      </section>

      <section className={styles.section}>
        <SectionHeading icon={<FileAudio size={17} />} eyebrow="Revision-bound evidence" title="Media and source links" count={linkedSources.length} />
        {linkedSources.length ? <div className={styles.sourceGrid}>{linkedSources.map((source) => (
          <article key={source.linkId} className={styles.sourceCard}>
            <div className={styles.sourceIcon}>{source.kind === "calendar_event" ? <CalendarDays size={18} /> : source.mediaRole === "transcript" ? <FileText size={18} /> : <FileAudio size={18} />}</div>
            <div><strong>{source.label}</strong><p>{source.kind.replaceAll("_", " ")} · {source.mediaType || source.mediaRole}</p><small>{source.durationMs !== null ? formatDuration(source.durationMs) : source.byteCount !== null ? formatBytes(source.byteCount) : "Source size unavailable"}</small></div>
            <span className={styles.revisionState} data-state={source.revisionState}>{source.revisionState === "exact" ? <Check size={12} /> : <AlertTriangle size={12} />}{source.revisionState}</span>
            <details className={styles.sourceEvidence}><summary>Exact source identity</summary><dl>{Object.entries(meeting.sourceLinks.find((link) => link.linkId === source.linkId) ?? {}).filter(([key]) => ["linkId", "sourceId", "sourceRevisionId", "sourceRevisionSha256", "sourceAuthoritySha256", "accessClass"].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}</dl></details>
            {source.kind === "capture_recording" && (!source.media || source.media.processingStatus === "failed") ? (
              <button
                type="button"
                className={styles.processMediaButton}
                disabled={writeBusy || !meetingRecordingCanProcess(canProcess, meeting.participants, source)}
                onClick={() => onProcessRecording(source)}
              >
                {processingRecordingId === source.sourceId
                  ? <Loader2 className="animate-spin" size={13} />
                  : <Sparkles size={13} />}
                Process recording
              </button>
            ) : null}
            {source.kind === "capture_recording" && !meetingRecordingCanProcess(canProcess, meeting.participants, source) && (!source.media || source.media.processingStatus === "failed") ? <p className={styles.fieldHelp}>{!canProcess ? "Write access is required to process this recording." : "Every participant must explicitly grant recording consent or have consent marked not required."}</p> : null}
          </article>
        ))}</div> : <EmptyLine>No calendar, recording, transcript, or asset is linked.</EmptyLine>}
      </section>

      <section className={styles.section}>
        <SectionHeading icon={<MessageSquareText size={17} />} eyebrow="Cited conversation record" title="Processed media" count={processedMedia.length} />
        {processedMedia.length ? processedMedia.map((source) => (
          <ProcessedMeetingMedia
            key={source.linkId}
            label={source.label}
            media={source.media!}
            meetingHasProject={Boolean(meeting.projectId)}
            canWrite={canPropose}
            writeBusy={writeBusy}
            commitmentViews={commitmentViews}
            commitmentBusyId={commitmentBusyId}
            onProposeCommitment={onProposeCommitment}
          />
        )) : transcriptSources.length ? transcriptSources.map((source) => (
          <article key={source.linkId} className={styles.transcript}>
            <div><strong>{source.label}</strong><span>{source.transcriptTruncated ? "First 500,000 characters" : "Exact linked revision"}</span></div>
            <p>{source.transcript}</p>
          </article>
        )) : <EmptyLine>No processed output or readable transcript was returned. Processing a linked recording requires explicit recording consent.</EmptyLine>}
      </section>

      <section className={styles.section}>
        <SectionHeading
          icon={<CheckCircle2 size={17} />}
          eyebrow="Evidence → governed action"
          title="Commitment conversion"
          count={commitmentsKnown ? commitmentViews.length : undefined}
        />
        {commitmentViews.length ? (
          <div className={styles.commitmentGrid}>
            {commitmentViews.map((view) => (
              <CommitmentProposalCard
                key={`${view.proposal.proposalId}:${view.proposal.proposalSha256}`}
                view={view}
                meeting={meeting}
                policies={eligiblePolicies}
                canWrite={canResolve}
                busy={writeBusy}
                onResolve={onResolveCommitment}
              />
            ))}
          </div>
        ) : (
          <EmptyLine>
            {commitmentsKnown ? "No proposals were returned in the last loaded review. Propose a cited action item, then review the owner and due date before any WorkItem or draft is created." : "Commitment availability is unknown until its source read succeeds."}
          </EmptyLine>
        )}
      </section>

      <div className={styles.twoColumn}>
        <RecordSection icon={<Sparkles size={17} />} eyebrow="Outcome" title="Decisions" records={meeting.decisions.map((decision) => ({ id: decision.decisionId, title: decision.summary, meta: participantName(meeting, decision.ownerParticipantId) }))} empty="No decisions recorded." />
        <RecordSection icon={<CircleUserRound size={17} />} eyebrow="Ownership" title="Commitments" records={meeting.commitments.map((commitment) => ({ id: commitment.commitmentId, title: commitment.summary, meta: [participantName(meeting, commitment.ownerParticipantId), commitment.dueAt ? `Due ${formatCompactDate(commitment.dueAt)}` : ""].filter(Boolean).join(" · ") }))} empty="No commitments recorded." />
      </div>

      <section className={styles.section}>
        <SectionHeading icon={<ListChecks size={17} />} eyebrow="Execution bridge" title="Follow-up" count={meeting.followUps.length} />
        {meeting.followUps.length ? <div className={styles.followUpList}>{meeting.followUps.map((followUp) => (
          <div key={followUp.followUpId}><span data-status={followUp.status} /><div><strong>{followUp.label}</strong><p>{followUp.workItemId ? `Work item ${followUp.workItemId}` : followUp.draftId ? `Draft ${followUp.draftId}` : "Not converted yet"}</p></div><em>{followUp.status}</em></div>
        ))}</div> : <EmptyLine>Confirmed cited commitments appear here with their canonical WorkItem and optional governed draft.</EmptyLine>}
      </section>

      {meeting.entityLinks.length ? <section className={styles.section}>
        <SectionHeading icon={<CircleUserRound size={17} />} eyebrow="Customer context" title="Linked accounts and entities" count={meeting.entityLinks.length} />
        <div className={styles.entityList}>{meeting.entityLinks.map((entity) => <span key={entity.entityId}><strong>{entity.label}</strong><small>{entity.relationship} · {entity.entityType}</small></span>)}</div>
      </section> : null}
    </div>
  );
}

export function ProcessedMeetingMedia({
  label,
  media,
  meetingHasProject = false,
  canWrite = false,
  writeBusy = false,
  commitmentViews = [],
  commitmentBusyId,
  onProposeCommitment,
}: {
  label: string;
  media: ProcessedMeetingMediaView;
  meetingHasProject?: boolean;
  canWrite?: boolean;
  writeBusy?: boolean;
  commitmentViews?: MeetingCommitmentView[];
  commitmentBusyId?: string;
  onProposeCommitment?: (mediaRevisionId: string, actionItemId: string) => void;
}) {
  const output = media.output;
  if (!output) {
    return (
      <article className={styles.mediaPending} data-status={media.processingStatus}>
        {media.processingStatus === "failed"
          ? <AlertTriangle size={18} />
          : <Loader2 className="animate-spin" size={18} />}
        <div>
          <strong>{label}</strong>
          <p>{media.processingStatus === "failed"
            ? "Media processing failed. Check the recording state before retrying."
            : "Audio is stored. Diarization, timestamping, chapters, and cited extraction are continuing in the background."}</p>
        </div>
        <span>{media.processingStatus}</span><p className={styles.mediaJob}>Operation job <code>{media.operationJobId}</code> · Updated {formatTimestamp(media.updatedAt)}{media.rawAudioDeletedAt ? " · Raw audio deleted" : ""}</p>
      </article>
    );
  }
  return (
    <article className={styles.processedMedia}>
      <p className={styles.readStatus}>Processing state: {media.processingStatus} · Operation job <code>{media.operationJobId}</code>{media.processingStatus !== "ready" ? ". The last stored output remains below." : ""}</p>
      <header className={styles.mediaHeader}>
        <div>
          <p className={styles.eyebrow}>Immutable {output.mediaRevisionId}</p>
          <h4>{label}</h4>
          <p>{output.languageTags.join(" · ")} · processed {formatCompactDate(output.processedAt)}</p>
        </div>
        <div className={styles.badges}>
          <span data-tone="completed"><Check size={12} /> Cited</span>
          {media.rawAudioDeletedAt ? <span><ShieldCheck size={12} /> Raw audio deleted</span> : null}
        </div>
      </header>

      <div className={styles.mediaSummary}>
        <strong>Summary</strong>
        <p>{output.summary.text}</p>
        <MediaCitations citations={output.summary.citations} />
      </div>

      {output.chapters.length ? (
        <div className={styles.mediaChapters}>
          {output.chapters.map((chapter) => (
            <section key={chapter.chapterId}>
              <span>{formatMediaTimestamp(chapter.startMilliseconds)}–{formatMediaTimestamp(chapter.endMilliseconds)}</span>
              <strong>{chapter.title}</strong>
              <p>{chapter.text}</p>
              <MediaCitations citations={chapter.citations} />
            </section>
          ))}
        </div>
      ) : null}

      {output.actionItems.length || output.decisions.length ? (
        <div className={styles.mediaInsights}>
          <div>
            <strong>Action items</strong>
            {output.actionItems.length ? output.actionItems.map((item) => {
              const commitment = commitmentViews.find((view) =>
                view.proposal.actionItemId === item.actionItemId &&
                view.proposal.mediaRevisionId === output.mediaRevisionId
              );
              return (
              <section key={item.actionItemId} className={styles.actionItem}>
                <p>{item.text}</p>
                <small>{[
                  item.ownerParticipantId ? "Explicit owner" : "Owner unconfirmed",
                  item.dueAt ? `Due ${formatCompactDate(item.dueAt)}` : "Due date unconfirmed",
                ].join(" · ")}</small>
                <MediaCitations citations={item.citations} />
                {commitment ? (
                  <span className={styles.proposalState} data-state={commitment.resolution?.decision || "proposed"}>
                    {commitment.resolution?.decision || "proposal ready"}
                  </span>
                ) : canWrite ? (
                  <button
                    type="button"
                    className={styles.proposeButton}
                    disabled={!meetingHasProject || writeBusy || commitmentBusyId === item.actionItemId}
                    onClick={() => onProposeCommitment?.(output.mediaRevisionId, item.actionItemId)}
                  >
                    {commitmentBusyId === item.actionItemId
                      ? <Loader2 className="animate-spin" size={12} />
                      : <Plus size={12} />}
                    {meetingHasProject ? "Propose as work" : "Link a project first"}
                  </button>
                ) : <p className={styles.fieldHelp}>Current meeting review and contributor access are required to propose this action.</p>}
              </section>
            );
            }) : <p className={styles.mutedLine}>No explicit action items found.</p>}
          </div>
          <div>
            <strong>Decisions</strong>
            {output.decisions.length ? output.decisions.map((decision) => (
              <section key={decision.decisionId}>
                <p>{decision.text}</p>
                <MediaCitations citations={decision.citations} />
              </section>
            )) : <p className={styles.mutedLine}>No explicit decisions found.</p>}
          </div>
        </div>
      ) : null}

      <div className={styles.mediaTranscript}>
        <div><strong>Speaker transcript</strong><span>{output.turns.length} timestamped turns</span></div>
        <ol tabIndex={0} aria-label={`${label} speaker transcript`}>
          {output.turns.map((turn) => (
            <li key={turn.turnId}>
              <span>{formatMediaTimestamp(turn.startMilliseconds)}</span>
              <strong>{turn.speaker.displayName || `Speaker ${turn.speaker.label}`}</strong>
              <p>{turn.text}</p>
              <small>{turn.languageTag}{turn.speaker.identity === "known" ? " · confirmed participant" : " · diarized label"}</small>
            </li>
          ))}
        </ol>
      </div>
      {output.warnings.length ? (
        <p className={styles.mediaWarning}><AlertTriangle size={13} /> {output.warnings.join(" · ")}</p>
      ) : null}
    </article>
  );
}

function CommitmentProposalCard({
  view,
  meeting,
  policies,
  canWrite,
  busy,
  onResolve,
}: {
  view: MeetingCommitmentView;
  meeting: Meeting;
  policies: ContactPolicy[];
  canWrite: boolean;
  busy: boolean;
  onResolve: (
    proposal: MeetingCommitmentProposal,
    decision: "confirmed" | "dismissed",
    details?: {
      ownerParticipantId?: string;
      dueAt?: string | null;
      communication?: {
        policyId: string;
        recipientParticipantId: string;
        subject: string;
        body: string;
      } | null;
    },
  ) => void;
}) {
  const { proposal, resolution } = view;
  const draftMessageLabelId = useId();
  const [ownerParticipantId, setOwnerParticipantId] = useState(
    proposal.ownership.participantId || "",
  );
  const [dueAt, setDueAt] = useState(localDateTimeInput(proposal.dueDate.dueAt));
  const [includeDraft, setIncludeDraft] = useState(false);
  const [policyId, setPolicyId] = useState(policies[0]?.id || "");
  const [subject, setSubject] = useState(`Follow-up: ${meeting.title}`);
  const [body, setBody] = useState(
    `Following up on ${meeting.title}:\n\n${proposal.title}\n\nPlease reply with any corrections.`,
  );
  if (resolution) {
    return (
      <article className={styles.commitmentCard} data-state={resolution.decision}>
        <div className={styles.commitmentCardHeader}>
          <div>
            <span>{resolution.decision === "confirmed" ? <CheckCircle2 size={14} /> : <X size={14} />}</span>
            <strong>{resolution.decision === "confirmed" ? "Confirmed commitment" : "Dismissed proposal"}</strong>
          </div>
          <small>{resolution.decision}</small>
        </div>
        <p>{proposal.title}</p>
        {resolution.decision === "confirmed" ? (
          <div className={styles.resolutionFacts}>
            <span><strong>Owner</strong>{resolution.ownerDisplayName} · {authorityLabel(resolution.ownershipAuthority)}</span>
            <span><strong>Due</strong>{resolution.dueAt ? formatCompactDate(resolution.dueAt) : "No due date"}{resolution.dueDateAuthority ? ` · ${authorityLabel(resolution.dueDateAuthority)}` : ""}</span>
            <span><strong>WorkItem</strong>{resolution.workItemId}</span>
            {resolution.draftId ? <span><strong>Governed draft</strong>{resolution.draftId} · unsent</span> : null}
          </div>
        ) : null}
        <MediaCitations citations={proposal.citations} />
      </article>
    );
  }

  const policy = policies.find((candidate) => candidate.id === policyId);
  const recipient = policy
    ? meeting.participants.find((participant) =>
        participant.email?.trim().toLocaleLowerCase("en-US") ===
          policy.address.trim().toLocaleLowerCase("en-US")
      )
    : undefined;
  return (
    <form
      className={styles.commitmentCard}
      data-state="proposed"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ownerParticipantId || !canWrite || busy || (dueAt && !Number.isFinite(new Date(dueAt).getTime()))) return;
        onResolve(proposal, "confirmed", {
          ownerParticipantId,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          communication: includeDraft && policy && recipient ? {
            policyId: policy.id,
            recipientParticipantId: recipient.participantId,
            subject,
            body,
          } : null,
        });
      }}
    >
      <div className={styles.commitmentCardHeader}>
        <div><span><Sparkles size={14} /></span><strong>Review proposed commitment</strong></div>
        <small>no effects yet</small>
      </div>
      <p>{proposal.title}</p>
      <details className={styles.provenance}><summary>Exact proposal evidence</summary><dl><div><dt>Proposal</dt><dd><code>{proposal.proposalId}</code></dd></div><div><dt>Digest</dt><dd><code>{proposal.proposalSha256}</code></dd></div><div><dt>Meeting revision</dt><dd><code>{proposal.meetingRevisionId}</code></dd></div><div><dt>Media revision</dt><dd><code>{proposal.mediaRevisionId}</code></dd></div><div><dt>Action item</dt><dd><code>{proposal.actionItemId}</code></dd></div><div><dt>Project</dt><dd><code>{proposal.projectId}</code></dd></div></dl></details>
      <MediaCitations citations={proposal.citations} />
      <div className={styles.proposalEvidence}>
        <span data-evidence={proposal.ownership.authority}>
          Owner · {proposal.ownership.authority === "explicit_transcript" ? "cited in transcript" : "confirmation required"}
        </span>
        <span data-evidence={proposal.dueDate.authority}>
          Due date · {proposal.dueDate.authority === "explicit_transcript" ? "cited in transcript" : "optional confirmation"}
        </span>
      </div>
      <div className={styles.commitmentFormGrid}>
        <label>
          <span>Confirmed owner</span>
          <select aria-label="Confirmed owner"
            value={ownerParticipantId}
            onChange={(event) => setOwnerParticipantId(event.target.value)}
            required
            disabled={!canWrite || busy}
          >
            <option value="">Choose a participant</option>
            {meeting.participants.map((participant) => (
              <option key={participant.participantId} value={participant.participantId}>
                {participant.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Confirmed due date · optional</span>
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            disabled={!canWrite || busy}
          />
        </label>
      </div>
      <label className={styles.draftToggle}>
        <input
          type="checkbox"
          checked={includeDraft}
          disabled={!policies.length || !canWrite || busy}
          onChange={(event) => setIncludeDraft(event.target.checked)}
        />
        <span><Mail size={14} /> Also prepare an unsent, governed follow-up email</span>
      </label>
      {!policies.length ? (
        <p className={styles.policyNotice}>No eligible participant contact policy exists. The WorkItem can still be confirmed without a draft.</p>
      ) : includeDraft ? (
        <div className={styles.draftFields}>
          <label>
            <span>Approved recipient policy</span>
            <select aria-label="Approved recipient policy" value={policyId} onChange={(event) => setPolicyId(event.target.value)} required disabled={!canWrite || busy}>
              {policies.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName} · {candidate.address}
                </option>
              ))}
            </select>
          </label>
          <p>Exact recipient: {recipient?.displayName ?? "Unavailable"} · {policy?.address ?? "Unavailable"}<br /><code>{recipient?.participantId}</code><br /><code>{policy?.id}</code></p>
          <label><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} required maxLength={998} disabled={!canWrite || busy} /></label>
          <label><span id={draftMessageLabelId}>Message</span><textarea aria-labelledby={draftMessageLabelId} rows={5} value={body} onChange={(event) => setBody(event.target.value)} required maxLength={50000} disabled={!canWrite || busy} /></label>
          <p><ShieldCheck size={13} /> Draft only. Sending remains a separate governed approval.</p>
        </div>
      ) : null}
      <div className={styles.commitmentActions}>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={!canWrite || busy}
          onClick={() => onResolve(proposal, "dismissed")}
        >
          Dismiss
        </button>
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={!canWrite || busy || !ownerParticipantId || (includeDraft && (!policy || !recipient))}
        >
          {busy ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
          Confirm WorkItem{includeDraft ? " + draft" : ""}
        </button>
      </div>
      {!canWrite ? <p className={styles.fieldHelp}>Current proposal review and contributor access are required before a decision can be submitted.</p> : null}
    </form>
  );
}

function MediaCitations({ citations }: { citations: MediaCitation[] }) {
  return (
    <div className={styles.citations} role="group" aria-label="Transcript citations">
      {citations.map((citation) => (
        <details key={`${citation.turnId}:${citation.segmentIndex}:${citation.startMilliseconds}`}><summary>{formatMediaTimestamp(citation.startMilliseconds)} · Speaker {citation.speakerLabel}</summary><dl><div><dt>Turn</dt><dd><code>{citation.turnId}</code></dd></div><div><dt>Segment</dt><dd>{citation.segmentIndex}</dd></div><div><dt>Time range</dt><dd>{citation.startMilliseconds}–{citation.endMilliseconds} ms</dd></div>{citation.speakerParticipantId ? <div><dt>Participant</dt><dd><code>{citation.speakerParticipantId}</code></dd></div> : null}</dl></details>
      ))}
    </div>
  );
}

function MeetingEditor({ draft, setDraft, projects, entities, library, saving, blockedReason, pendingLabel, editing, headingRef, onSubmit, onCancel }: {
  draft: MeetingDraft;
  setDraft: React.Dispatch<React.SetStateAction<MeetingDraft | undefined>>;
  projects: ProjectOption[];
  entities: EntityOption[];
  library: LibraryItem[];
  saving: boolean;
  blockedReason?: string;
  pendingLabel: string;
  editing: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const [sourceSelection, setSourceSelection] = useState("");
  const summaryLabelId = useId();
  const [entitySelection, setEntitySelection] = useState("");
  const sourceOptions = useMemo(() => library.filter((item) =>
    !draft.sourceLinks.some((link) => link.sourceId === item.sourceId && sourceKind(item) === link.kind)
  ), [draft.sourceLinks, library]);
  function patch(change: Partial<MeetingDraft>) {
    if (saving || blockedReason) return;
    setDraft((current) => current ? { ...current, ...change } : current);
  }
  function addParticipant() {
    patch({ participants: [...draft.participants, emptyParticipant()] });
  }
  function updateParticipant(index: number, change: Partial<Participant>) {
    const participants = draft.participants.map((participant, itemIndex) => itemIndex === index
      ? normalizeMeetingParticipantConsent({ ...participant, ...change })
      : participant);
    patch({ participants });
  }
  function addSource() {
    const item = library.find((candidate) => candidate.id === sourceSelection);
    if (!item) return;
    patch({ sourceLinks: [...draft.sourceLinks, meetingSourceLinkFromLibrary(item)] });
    setSourceSelection("");
  }
  function addEntity() {
    const entity = entities.find((candidate) => candidate.entityId === entitySelection);
    if (!entity || !isMeetingEntityType(entity.entityTypeId)) return;
    patch({ entityLinks: [...draft.entityLinks, {
      entityId: entity.entityId,
      entityType: entity.entityTypeId,
      label: entity.canonicalLabel,
      relationship: entity.entityTypeId === "person" ? "participant" : entity.entityTypeId === "account" ? "account" : "customer",
    }] });
    setEntitySelection("");
  }
  return (
    <form className={styles.editor} onSubmit={onSubmit}>
      <div className={styles.editorHeader}><div><p className={styles.eyebrow}>Immutable meeting revision</p><h2 ref={headingRef} tabIndex={-1}>{editing ? "Revise meeting" : "Create meeting"}</h2><p>Every linked source is resolved again on save. Recording media requires explicit consent from every participant.</p></div><button type="button" className={styles.iconButton} disabled={saving} onClick={onCancel} aria-label="Close meeting editor"><X size={18} /></button></div>
      {blockedReason ? <p className={styles.notice}>{blockedReason}</p> : null}
      <fieldset className={styles.formSection} disabled={saving || Boolean(blockedReason)}><legend>Meeting metadata</legend><div className={styles.formGrid}>
        <label className={styles.wideField}><span>Title</span><input required maxLength={240} value={draft.title} onChange={(event) => patch({ title: event.currentTarget.value })} /></label>
        <label><span>Status</span><select aria-label="Status" value={draft.status} onChange={(event) => patch({ status: event.currentTarget.value as MeetingStatus })}><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
        <label><span>Access ceiling</span><select aria-label="Access ceiling" value={draft.declaredAccessClass} onChange={(event) => patch({ declaredAccessClass: event.currentTarget.value as AccessClass })}><option value="owner_private">Owner only</option><option value="project_members">Project members</option><option value="workspace_members">Workspace members</option></select></label>
        <label><span>Starts</span><input required type="datetime-local" value={toLocalInput(draft.scheduledStartAt)} onChange={(event) => patch({ scheduledStartAt: fromLocalInput(event.currentTarget.value) })} /></label>
        <label><span>Ends</span><input required type="datetime-local" value={toLocalInput(draft.scheduledEndAt)} onChange={(event) => patch({ scheduledEndAt: fromLocalInput(event.currentTarget.value) })} /></label>
        <label><span>Timezone</span><input required maxLength={100} value={draft.timezone} onChange={(event) => patch({ timezone: event.currentTarget.value })} /></label>
        <label><span>Location</span><input maxLength={500} value={draft.location} onChange={(event) => patch({ location: event.currentTarget.value })} /></label>
        <label><span>Project</span><select aria-label="Project" value={draft.projectId || ""} onChange={(event) => patch({ projectId: event.currentTarget.value || null })}><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className={styles.wideField}><span id={summaryLabelId}>Summary</span><textarea aria-labelledby={summaryLabelId} rows={3} maxLength={8000} value={draft.summary} onChange={(event) => patch({ summary: event.currentTarget.value })} /></label>
      </div></fieldset>

      <fieldset className={styles.formSection} disabled={saving || Boolean(blockedReason)}><legend>Participants and consent</legend><p className={styles.fieldHelp}>Consent timestamps are attached automatically when you record an explicit state.</p>
        <div className={styles.editorRows}>{draft.participants.map((participant, index) => <div key={participant.participantId} className={styles.participantEditor}>
          <label><span>Name</span><input required maxLength={160} value={participant.displayName} onChange={(event) => updateParticipant(index, { displayName: event.currentTarget.value })} /></label>
          <label><span>Email</span><input type="email" maxLength={320} value={participant.email || ""} onChange={(event) => updateParticipant(index, { email: event.currentTarget.value || null })} /></label>
          <label><span>Role</span><select aria-label="Role" value={participant.role} onChange={(event) => updateParticipant(index, { role: event.currentTarget.value as Participant["role"] })}><option value="organizer">Organizer</option><option value="required">Required</option><option value="optional">Optional</option><option value="guest">Guest</option></select></label>
          <label><span>Response</span><select aria-label="Response" value={participant.response} onChange={(event) => updateParticipant(index, { response: event.currentTarget.value as Participant["response"] })}><option value="accepted">Accepted</option><option value="tentative">Tentative</option><option value="declined">Declined</option><option value="needs_action">Needs action</option><option value="unknown">Unknown</option></select></label>
          <label><span>Attendee consent</span><select aria-label="Attendee consent" value={participant.attendeeConsent} onChange={(event) => updateParticipant(index, { attendeeConsent: event.currentTarget.value as Participant["attendeeConsent"] })}><option value="unknown">Unknown</option><option value="pending">Pending</option><option value="granted">Granted</option><option value="declined">Declined</option></select></label>
          <label><span>Recording consent</span><select aria-label="Recording consent" value={participant.recordingConsent} onChange={(event) => updateParticipant(index, { recordingConsent: event.currentTarget.value as Participant["recordingConsent"] })}><option value="unknown">Unknown</option><option value="pending">Pending</option><option value="granted">Granted</option><option value="declined">Declined</option><option value="not_required">Not required</option></select></label>
          <button type="button" className={styles.removeButton} onClick={() => patch({ participants: draft.participants.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /> Remove</button>
        </div>)}</div>
        <button type="button" className={styles.addButton} onClick={addParticipant}><Plus size={14} /> Add participant</button>
      </fieldset>

      <fieldset className={styles.formSection} disabled={saving || Boolean(blockedReason)}><legend>Calendar, media, and source permissions</legend><p className={styles.fieldHelp}>Choose from your governed Library. Exact calendar/source revisions are retained; captured items are re-digested on save.</p>
        <div className={styles.picker}><select aria-label="Governed source" value={sourceSelection} onChange={(event) => setSourceSelection(event.currentTarget.value)}><option value="">Choose a governed source…</option>{sourceOptions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.sourceLabel} · {item.kind}</option>)}</select><button type="button" onClick={addSource} disabled={!sourceSelection}><Link2 size={14} /> Link source</button></div>
        <div className={styles.chipList}>{draft.sourceLinks.map((source) => <span key={source.linkId}><strong>{source.label}</strong><small>{source.kind.replaceAll("_", " ")} · {source.mediaRole}</small><button type="button" onClick={() => patch({ sourceLinks: draft.sourceLinks.filter((item) => item.linkId !== source.linkId) })} aria-label={`Remove ${source.label}`}><X size={13} /></button></span>)}</div>
      </fieldset>

      <fieldset className={styles.formSection} disabled={saving || Boolean(blockedReason)}><legend>Customer and account context</legend><div className={styles.picker}><select aria-label="Entity Registry record" value={entitySelection} onChange={(event) => setEntitySelection(event.currentTarget.value)}><option value="">Choose an Entity Registry record…</option>{entities.filter((entity) => !draft.entityLinks.some((link) => link.entityId === entity.entityId)).map((entity) => <option key={entity.entityId} value={entity.entityId}>{entity.canonicalLabel} · {entity.entityTypeId}</option>)}</select><button type="button" onClick={addEntity} disabled={!entitySelection}><Plus size={14} /> Link entity</button></div><div className={styles.chipList}>{draft.entityLinks.map((entity) => <span key={entity.entityId}><strong>{entity.label}</strong><small>{entity.relationship} · {entity.entityType}</small><button type="button" onClick={() => patch({ entityLinks: draft.entityLinks.filter((item) => item.entityId !== entity.entityId) })} aria-label={`Remove ${entity.label}`}><X size={13} /></button></span>)}</div></fieldset>

      <div className={styles.editorFooter}><button type="button" className={styles.secondaryButton} disabled={saving} onClick={onCancel}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={saving || Boolean(blockedReason)}>{saving ? pendingLabel : editing ? "Publish revision" : "Create meeting"}</button></div>
    </form>
  );
}

function Metric({ value, label, detail, warning }: { value: number | undefined; label: string; detail: string; warning?: boolean }) { return <div data-warning={warning || undefined}><strong>{value ?? "Unavailable"}</strong><span>{label}</span><small>{detail}</small></div>; }
function Metadata({ icon, label, value, href }: { icon: React.ReactNode; label: string; value: string; href?: string }) { const content = <><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></>; return href ? <Link href={href} className={styles.metadata}>{content}</Link> : <div className={styles.metadata}>{content}</div>; }
function SectionHeading({ icon, eyebrow, title, count }: { icon: React.ReactNode; eyebrow: string; title: string; count: number | undefined }) { return <div className={styles.sectionHeading}><div>{icon}<span><small>{eyebrow}</small><h3>{title}</h3></span></div><strong>{count ?? "Count unavailable"}</strong></div>; }
function ConsentBadge({ label, value }: { label: string; value: string }) { return <span className={styles.consentBadge} data-consent={value}>{value === "granted" || value === "not_required" ? <Check size={11} /> : value === "declined" ? <X size={11} /> : <Clock3 size={11} />}{label}: {value.replace("_", " ")}</span>; }
function EmptyLine({ children }: { children: React.ReactNode }) { return <div className={styles.emptyLine}>{children}</div>; }
function RecordSection({ icon, eyebrow, title, records, empty }: { icon: React.ReactNode; eyebrow: string; title: string; records: Array<{ id: string; title: string; meta: string }>; empty: string }) { return <section className={styles.section}><SectionHeading icon={icon} eyebrow={eyebrow} title={title} count={records.length} />{records.length ? <div className={styles.recordList}>{records.map((record) => <div key={record.id}><span /><div><strong>{record.title}</strong>{record.meta ? <p>{record.meta}</p> : null}</div></div>)}</div> : <EmptyLine>{empty}</EmptyLine>}</section>; }

function emptyMeetingDraft(): MeetingDraft {
  const start = new Date();
  start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    title: "", summary: "", status: "scheduled",
    scheduledStartAt: start.toISOString(), scheduledEndAt: end.toISOString(),
    actualStartAt: null, actualEndAt: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    location: "", projectId: null, declaredAccessClass: "owner_private",
    participants: [], sourceLinks: [], entityLinks: [], decisions: [], commitments: [], followUps: [],
  };
}
function meetingDraft(meeting: Meeting): MeetingDraft { return { title: meeting.title, summary: meeting.summary, status: meeting.status, scheduledStartAt: meeting.scheduledStartAt, scheduledEndAt: meeting.scheduledEndAt, actualStartAt: meeting.actualStartAt, actualEndAt: meeting.actualEndAt, timezone: meeting.timezone, location: meeting.location, projectId: meeting.projectId, declaredAccessClass: meeting.declaredAccessClass, participants: meeting.participants.map((item) => ({ ...item })), sourceLinks: meeting.sourceLinks.map((item) => ({ ...item })), entityLinks: meeting.entityLinks.map((item) => ({ ...item })), decisions: meeting.decisions.map((item) => ({ ...item })), commitments: meeting.commitments.map((item) => ({ ...item })), followUps: meeting.followUps.map((item) => ({ ...item })) }; }
function emptyParticipant(): Participant { return { participantId: `meeting-participant:${crypto.randomUUID()}`, displayName: "", email: null, entityId: null, role: "required", response: "unknown", attendeeConsent: "unknown", recordingConsent: "unknown", consentCapturedAt: null, source: "manual" }; }
export function normalizeMeetingParticipantConsent(participant: Participant): Participant { const captured = participant.attendeeConsent !== "unknown" || !["unknown", "pending"].includes(participant.recordingConsent); return { ...participant, consentCapturedAt: captured ? participant.consentCapturedAt || new Date().toISOString() : null }; }
function sourceLinkRequest(source: SourceLink) { return { linkId: source.linkId, kind: source.kind, sourceId: source.sourceId, sourceRevisionId: source.sourceRevisionId, mediaRole: source.mediaRole, label: source.label }; }
export function meetingSourceLinkFromLibrary(item: LibraryItem): SourceLink { const kind = sourceKind(item); return { linkId: `meeting-link:${crypto.randomUUID()}`, kind, sourceId: item.sourceId, ...(item.sourceAuthority === "source_item" && item.currentVersion.sourceRevisionId ? { sourceRevisionId: item.currentVersion.sourceRevisionId } : {}), mediaRole: sourceMediaRole(item, kind), label: item.title }; }
function sourceKind(item: LibraryItem): SourceLink["kind"] { if (item.sourceAuthority === "capture_recording" || item.sourceAuthority === "capture_transcript") return "capture_recording"; if (item.sourceAuthority === "capture_asset") return "capture_asset"; if (item.kind === "meeting") return "calendar_event"; return "source_revision"; }
function sourceMediaRole(item: LibraryItem, kind: SourceLink["kind"]): SourceLink["mediaRole"] { if (kind === "calendar_event") return "calendar"; if (item.kind === "transcript") return "transcript"; if (item.kind === "recording" || item.currentVersion.mediaType.startsWith("audio/") || item.currentVersion.mediaType.startsWith("video/")) return "recording"; return kind === "capture_asset" ? "attachment" : "reference"; }
function isMeetingEntityType(value: string): value is EntityLink["entityType"] { return ["person", "organization", "account", "project"].includes(value); }
function participantName(meeting: Meeting, id: string | null) { return id ? meeting.participants.find((participant) => participant.participantId === id)?.displayName || "Unresolved owner" : ""; }
function accessLabel(access: AccessClass) { return access === "owner_private" ? "Owner only" : access === "project_members" ? "Project members" : "Workspace members"; }
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?"; }
function formatDateRange(start: string, end: string) { const first = new Date(start); const last = new Date(end); return `${first.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · ${formatTime(start)}–${formatTime(end === start ? last.toISOString() : end)}`; }
function formatTime(value: string) { return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function formatCompactDate(value: string) { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); }
function formatTimestamp(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function formatDuration(ms: number) { const minutes = Math.round(ms / 60_000); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`; }
function formatMediaTimestamp(ms: number) { const seconds = Math.max(0, Math.floor(ms / 1_000)); const hours = Math.floor(seconds / 3_600); const minutes = Math.floor((seconds % 3_600) / 60); const remainder = seconds % 60; return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`; }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function authorityLabel(value: MeetingCommitmentResolution["ownershipAuthority"] | MeetingCommitmentResolution["dueDateAuthority"]) { return value === "explicit_transcript" ? "transcript evidence" : value === "user_confirmed" ? "user confirmed" : "not set"; }
function localDateTimeInput(value: string | null) { return value ? toLocalInput(value) : ""; }
function toLocalInput(value: string) { const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function fromLocalInput(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); }
async function readJson(path: string, init?: RequestInit) { const response = await fetch(path, { cache: "no-store", ...init }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(String(payload.error || payload.message || `${path} returned ${response.status}`)); return payload as Record<string, unknown>; }
function message(error: unknown) { return error instanceof Error ? error.message : "Meetings could not be updated."; }
