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
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useWorkspaceSession } from "@/components/app-shell/session-context";
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
type Meeting = {
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
type LinkedSource = {
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
type WorkspaceContext = { workspaceId: string; accessLevel: string; canWrite: boolean };
type ContactPolicy = {
  id: string;
  displayName: string;
  address: string;
  channel: "email";
};
type MeetingCommitmentProposal = {
  proposalId: string;
  proposalSha256: string;
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
type MeetingCommitmentResolution = {
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
type MeetingCommitmentView = {
  proposal: MeetingCommitmentProposal;
  resolution: MeetingCommitmentResolution | null;
};
type ProjectOption = { id: string; title: string };
type EntityOption = { entityId: string; entityTypeId: string; canonicalLabel: string; state: string };
type LibraryItem = {
  id: string;
  kind: string;
  sourceAuthority: string;
  sourceId: string;
  title: string;
  sourceLabel: string;
  status: string;
  currentVersion: { sourceRevisionId: string | null; mediaType: string };
};
type MeetingDraft = Omit<Meeting,
  "schemaVersion" | "tenantId" | "workspaceId" | "meetingId" |
  "meetingRevisionId" | "revision" | "ownerActorId" |
  "effectiveAccessClass" | "revisedAt"
>;

export function MeetingsWorkspace({ initialMeetingId }: { initialMeetingId?: string }) {
  const router = useRouter();
  const { session, status: sessionStatus } = useWorkspaceSession();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Meeting>();
  const [linkedSources, setLinkedSources] = useState<LinkedSource[]>([]);
  const [commitmentViews, setCommitmentViews] = useState<MeetingCommitmentView[]>([]);
  const [eligiblePolicies, setEligiblePolicies] = useState<ContactPolicy[]>([]);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editor, setEditor] = useState<MeetingDraft>();
  const [editingMeetingId, setEditingMeetingId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [processingRecordingId, setProcessingRecordingId] = useState<string>();
  const [commitmentBusyId, setCommitmentBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Meetings are ready.");
  const [calendarSyncing, setCalendarSyncing] = useState(false);
  const [calendarSyncMessage, setCalendarSyncMessage] = useState("Calendar updates automatically while this page is open.");
  const [calendarSyncedAt, setCalendarSyncedAt] = useState<string>();
  const controllerRef = useRef<AbortController | null>(null);
  const calendarSyncingRef = useRef(false);
  const mutationKeyRef = useRef("");
  const available = Boolean(session && (!session.authEnabled || session.authenticated));

  const upcoming = meetings.filter((meeting) => meeting.status === "scheduled").length;
  const completed = meetings.filter((meeting) => meeting.status === "completed").length;
  const unresolvedConsent = meetings.reduce((count, meeting) => count + meeting.participants.filter(
    (participant) => participant.attendeeConsent === "pending" ||
      participant.recordingConsent === "pending" ||
      participant.recordingConsent === "unknown",
  ).length, 0);

  async function load() {
    if (!available || sessionStatus !== "ready") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const [meetingPayload, projectPayload, entityPayload, libraryPayload] = await Promise.all([
        readJson("/api/meetings?limit=200", { signal: controller.signal }),
        readJson("/api/projects?view=summary&limit=100", { signal: controller.signal }),
        readJson("/api/entities", { signal: controller.signal }),
        readJson("/api/library?kind=meeting,recording,transcript,document,file,image,audio,video&limit=100", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const nextMeetings = (meetingPayload.meetings || []) as Meeting[];
      setMeetings(nextMeetings);
      setWorkspaceContext(meetingPayload.context as WorkspaceContext);
      setProjects(((projectPayload.projects || []) as Array<Record<string, unknown>>).map((project) => ({
        id: String(project.id),
        title: String(project.title),
      })));
      setEntities(((entityPayload.entities || []) as EntityOption[]).filter((entity) =>
        entity.state === "active" && ["person", "organization", "account", "project"].includes(entity.entityTypeId)
      ));
      setLibrary((libraryPayload.items || []) as LibraryItem[]);
      const targetId = initialMeetingId || nextMeetings[0]?.meetingId;
      if (targetId) await loadDetail(targetId, controller.signal);
      else {
        setSelected(undefined);
        setLinkedSources([]);
        setCommitmentViews([]);
        setEligiblePolicies([]);
      }
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function loadDetail(
    meetingId: string,
    signal?: AbortSignal,
    silent = false,
  ) {
    if (!silent) setDetailLoading(true);
    try {
      const [payload, commitmentPayload] = await Promise.all([
        readJson(`/api/meetings/${encodeURIComponent(meetingId)}`, { signal }),
        readJson(`/api/meetings/${encodeURIComponent(meetingId)}/commitments`, { signal }),
      ]);
      setSelected(payload.meeting as Meeting);
      setLinkedSources((payload.linkedSources || []) as LinkedSource[]);
      setWorkspaceContext(payload.context as WorkspaceContext);
      setCommitmentViews((commitmentPayload.commitments || []) as MeetingCommitmentView[]);
      setEligiblePolicies((commitmentPayload.eligiblePolicies || []) as ContactPolicy[]);
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
    // The authenticated session and requested route own the read boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session, initialMeetingId]);

  async function syncCalendar(silent = false) {
    if (!available || sessionStatus !== "ready" || calendarSyncingRef.current) return;
    calendarSyncingRef.current = true;
    setCalendarSyncing(true);
    if (!silent) setCalendarSyncMessage("Checking Google Calendar for changes…");
    try {
      const payload = await readJson("/api/oauth/google/sync?source=calendar", { method: "POST" });
      const calendar = ((payload.sources || []) as Array<{ source?: string; status?: string; imported?: number }>).find((source) => source.source === "calendar");
      const syncedAt = new Date().toISOString();
      setCalendarSyncedAt(syncedAt);
      setCalendarSyncMessage(calendar?.status === "error"
        ? "Google Calendar could not be refreshed. Check Integrations."
        : `${calendar?.imported || 0} calendar change${calendar?.imported === 1 ? "" : "s"} synchronized.`);
      setAnnouncement("Google Calendar and Meetings are synchronized.");
      await load();
    } catch (syncError) {
      setCalendarSyncMessage(silent
        ? "Automatic Calendar sync is unavailable. Check the Google connection in Integrations."
        : message(syncError));
    } finally {
      calendarSyncingRef.current = false;
      setCalendarSyncing(false);
    }
  }

  useEffect(() => {
    if (!available || sessionStatus !== "ready") return;
    const initial = window.setTimeout(() => void syncCalendar(true), 700);
    const interval = window.setInterval(() => void syncCalendar(true), 5 * 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
    // Calendar refresh follows the authenticated actor and is internally lease-fenced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, sessionStatus, session]);

  const mediaPollingKey = linkedSources.map((source) =>
    source.media && ["queued", "processing", "waiting"].includes(
      source.media.processingStatus,
    )
      ? `${source.sourceId}:${source.media.processingStatus}:${source.media.updatedAt}`
      : ""
  ).filter(Boolean).join("|");

  useEffect(() => {
    if (!selected || !mediaPollingKey) return;
    const timer = window.setTimeout(() => {
      void loadDetail(selected.meetingId, undefined, true).catch((pollError) =>
        setError(message(pollError))
      );
    }, 3_000);
    return () => window.clearTimeout(timer);
    // Polling is owned by the selected meeting and its durable media status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.meetingId, mediaPollingKey]);

  function openCreate() {
    mutationKeyRef.current = `meeting-create:${crypto.randomUUID()}`;
    setEditingMeetingId(undefined);
    setEditor(emptyMeetingDraft());
    setError(undefined);
  }

  function openEdit() {
    if (!selected) return;
    mutationKeyRef.current = `meeting-update:${selected.meetingId}:${selected.revision}:${crypto.randomUUID()}`;
    setEditingMeetingId(selected.meetingId);
    setEditor(meetingDraft(selected));
    setError(undefined);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    try {
      const editedMeeting = editingMeetingId
        ? meetings.find((meeting) => meeting.meetingId === editingMeetingId) || selected
        : undefined;
      const isEdit = Boolean(editingMeetingId && editedMeeting);
      const path = isEdit
        ? `/api/meetings/${encodeURIComponent(editingMeetingId!)}`
        : "/api/meetings";
      const payload = await readJson(path, {
        method: isEdit ? "PATCH" : "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": mutationKeyRef.current || `meeting:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          ...editor,
          ...(isEdit ? { expectedRevision: editedMeeting!.revision } : {}),
          sourceLinks: editor.sourceLinks.map(sourceLinkRequest),
        }),
      });
      const saved = payload.meeting as Meeting;
      setMeetings((current) => [saved, ...current.filter((meeting) => meeting.meetingId !== saved.meetingId)]
        .sort((left, right) => right.scheduledStartAt.localeCompare(left.scheduledStartAt)));
      setSelected(saved);
      setLinkedSources((payload.linkedSources || []) as LinkedSource[]);
      setEditor(undefined);
      setEditingMeetingId(undefined);
      mutationKeyRef.current = "";
      setAnnouncement(isEdit ? `Meeting revision ${saved.revision} published.` : "Meeting created.");
      setError(undefined);
      router.push(`/app/meetings/${encodeURIComponent(saved.meetingId)}`);
      router.refresh();
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function processLinkedRecording(source: LinkedSource) {
    if (!selected || !workspaceContext) return;
    setProcessingRecordingId(source.sourceId);
    setError(undefined);
    try {
      const payload = await readJson(
        `/api/capture/recordings/${encodeURIComponent(source.sourceId)}/complete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `meeting-media:${selected.meetingId}:${source.sourceId}`,
          },
          body: JSON.stringify({
            meetingId: selected.meetingId,
            workspaceId: workspaceContext.workspaceId,
            rawAudioRetention: { mode: "retain" },
          }),
        },
      );
      if (payload.media) {
        setLinkedSources((current) => current.map((candidate) =>
          candidate.sourceId === source.sourceId
            ? { ...candidate, media: payload.media as ProcessedMeetingMediaView }
            : candidate
        ));
      } else {
        await loadDetail(selected.meetingId, undefined, true);
      }
      setAnnouncement(`Background processing started for ${source.label}.`);
    } catch (processError) {
      setError(message(processError));
    } finally {
      setProcessingRecordingId(undefined);
    }
  }

  async function proposeCommitment(mediaRevisionId: string, actionItemId: string) {
    if (!selected) return;
    setCommitmentBusyId(actionItemId);
    setError(undefined);
    try {
      const payload = await readJson(
        `/api/meetings/${encodeURIComponent(selected.meetingId)}/commitments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `meeting-proposal:${mediaRevisionId}:${actionItemId}`,
          },
          body: JSON.stringify({ mediaRevisionId, actionItemId }),
        },
      );
      const commitment = payload.commitment as MeetingCommitmentView;
      setCommitmentViews((current) => [
        ...current.filter((item) =>
          item.proposal.proposalId !== commitment.proposal.proposalId
        ),
        commitment,
      ]);
      setAnnouncement("Evidence-bound commitment proposal created. Review ownership and due date before confirming.");
    } catch (proposalError) {
      setError(message(proposalError));
    } finally {
      setCommitmentBusyId(undefined);
    }
  }

  async function resolveCommitment(
    proposal: MeetingCommitmentProposal,
    decision: "confirmed" | "dismissed",
    details: {
      ownerParticipantId?: string;
      dueAt?: string | null;
      communication?: {
        policyId: string;
        recipientParticipantId: string;
        subject: string;
        body: string;
      } | null;
    } = {},
  ) {
    if (!selected) return;
    setCommitmentBusyId(proposal.proposalId);
    setError(undefined);
    try {
      const payload = await readJson(
        `/api/meetings/${encodeURIComponent(selected.meetingId)}/commitments`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `meeting-resolution:${proposal.proposalSha256}`,
          },
          body: JSON.stringify({
            proposalId: proposal.proposalId,
            expectedProposalSha256: proposal.proposalSha256,
            decision,
            ...details,
          }),
        },
      );
      const commitment = payload.commitment as MeetingCommitmentView;
      setCommitmentViews((current) => current.map((item) =>
        item.proposal.proposalId === commitment.proposal.proposalId
          ? commitment
          : item
      ));
      if (payload.meeting) {
        const saved = payload.meeting as Meeting;
        setSelected(saved);
        setMeetings((current) => current.map((item) =>
          item.meetingId === saved.meetingId ? saved : item
        ));
        await loadDetail(saved.meetingId, undefined, true);
      }
      setAnnouncement(decision === "confirmed"
        ? "Commitment confirmed as canonical work and meeting follow-up."
        : "Commitment proposal dismissed.");
    } catch (resolutionError) {
      setError(message(resolutionError));
    } finally {
      setCommitmentBusyId(undefined);
    }
  }

  return (
    <main className={styles.shell} aria-busy={loading}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Customer memory · governed sources</p>
          <h1>Meetings</h1>
          <p>One durable record for the people, consent, media, decisions, and follow-through around every conversation.</p>
        </div>
        <div className={styles.heroActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => void syncCalendar()} disabled={calendarSyncing}>
            {calendarSyncing ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />} Sync Calendar
          </button>
          <Link href="/app/capture" className={styles.secondaryButton}><FileAudio size={16} /> Open Capture</Link>
          {workspaceContext?.canWrite !== false ? (
            <button type="button" className={styles.primaryButton} onClick={openCreate}>
              <Plus size={16} /> New meeting
            </button>
          ) : null}
        </div>
      </header>

      <div className={styles.calendarSyncStatus} role="status">
        <span><i data-active={calendarSyncing ? "true" : "false"} /> <strong>Google Calendar</strong> · {calendarSyncMessage}</span>
        <small>{calendarSyncedAt ? `Last checked ${formatTimestamp(calendarSyncedAt)}` : "On open · every 5 minutes while open · background every 30 minutes · nightly safety run"}</small>
      </div>

      <section className={styles.metrics} aria-label="Meeting overview">
        <Metric value={upcoming} label="upcoming" detail="scheduled conversations" />
        <Metric value={completed} label="completed" detail="durable meeting records" />
        <Metric value={unresolvedConsent} label="consent checks" detail="still unresolved" warning={unresolvedConsent > 0} />
        <Metric value={meetings.length} label="total" detail="readable in this workspace" />
      </section>

      {error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={17} /> <span>{error}</span>
          <button type="button" onClick={() => { setError(undefined); void load(); }}>Retry</button>
        </div>
      ) : null}

      {editor ? (
        <MeetingEditor
          draft={editor}
          setDraft={setEditor}
          projects={projects}
          entities={entities}
          library={library}
          saving={saving}
          editing={Boolean(editingMeetingId)}
          onSubmit={save}
          onCancel={() => { setEditor(undefined); setEditingMeetingId(undefined); }}
        />
      ) : (
        <div className={styles.workspace}>
          <aside className={styles.rail} aria-label="Meeting list">
            <div className={styles.railHeading}>
              <span>Timeline</span><strong>{meetings.length}</strong>
            </div>
            {meetings.length ? meetings.map((meeting) => (
              <Link
                key={meeting.meetingId}
                href={`/app/meetings/${encodeURIComponent(meeting.meetingId)}`}
                className={selected?.meetingId === meeting.meetingId ? styles.selectedRailItem : styles.railItem}
              >
                <span className={styles.statusDot} data-status={meeting.status} />
                <span><strong>{meeting.title}</strong><small>{formatCompactDate(meeting.scheduledStartAt)} · {meeting.participants.length} people</small></span>
                <ChevronRight size={15} />
              </Link>
            )) : (
              <div className={styles.emptyRail}><CalendarDays size={22} /><p>No meetings yet.</p></div>
            )}
          </aside>

          <section className={styles.canvas}>
            {loading || detailLoading ? (
              <div className={styles.emptyCanvas}><Loader2 className="animate-spin" size={24} /><p>Resolving meeting authority…</p></div>
            ) : selected ? (
              <MeetingDetail
                meeting={selected}
                linkedSources={linkedSources}
                commitmentViews={commitmentViews}
                eligiblePolicies={eligiblePolicies}
                project={projects.find((project) => project.id === selected.projectId)}
                canWrite={workspaceContext?.canWrite ?? false}
                processingRecordingId={processingRecordingId}
                commitmentBusyId={commitmentBusyId}
                onEdit={openEdit}
                onProcessRecording={(source) => void processLinkedRecording(source)}
                onProposeCommitment={(mediaRevisionId, actionItemId) =>
                  void proposeCommitment(mediaRevisionId, actionItemId)}
                onResolveCommitment={(proposal, decision, details) =>
                  void resolveCommitment(proposal, decision, details)}
              />
            ) : (
              <div className={styles.emptyCanvas}>
                <CalendarDays size={34} />
                <h2>Create the first meeting record</h2>
                <p>Link a calendar event or captured conversation, then record participants and consent explicitly.</p>
                {workspaceContext?.canWrite !== false ? <button type="button" className={styles.primaryButton} onClick={openCreate}><Plus size={16} /> New meeting</button> : null}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function MeetingDetail({
  meeting,
  linkedSources,
  commitmentViews,
  eligiblePolicies,
  project,
  canWrite,
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
  eligiblePolicies: ContactPolicy[];
  project?: ProjectOption;
  canWrite: boolean;
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
        {canWrite ? <button type="button" className={styles.secondaryButton} onClick={onEdit}><Save size={15} /> Revise</button> : null}
      </header>

      <div className={styles.metadataGrid}>
        <Metadata icon={<Clock3 size={16} />} label="Time" value={`${formatTime(meeting.scheduledStartAt)}–${formatTime(meeting.scheduledEndAt)} · ${meeting.timezone}`} />
        <Metadata icon={<MapPin size={16} />} label="Location" value={meeting.location || "Not specified"} />
        <Metadata icon={<ListChecks size={16} />} label="Project" value={project?.title || meeting.projectId || "No linked project"} href={meeting.projectId ? `/app/projects?project=${encodeURIComponent(meeting.projectId)}` : undefined} />
        <Metadata icon={<Link2 size={16} />} label="Source policy" value={`${meeting.sourceLinks.length} exact link${meeting.sourceLinks.length === 1 ? "" : "s"} · ${accessLabel(meeting.effectiveAccessClass)}`} />
      </div>

      <section className={styles.section}>
        <SectionHeading icon={<UsersRound size={17} />} eyebrow="People & permission" title="Participants and consent" count={meeting.participants.length} />
        {meeting.participants.length ? <div className={styles.participantGrid}>{meeting.participants.map((participant) => (
          <article key={participant.participantId} className={styles.participantCard}>
            <div className={styles.avatar}>{initials(participant.displayName)}</div>
            <div><strong>{participant.displayName}</strong><p>{participant.email || participant.role}</p><div className={styles.consentRow}><ConsentBadge label="attendee" value={participant.attendeeConsent} /><ConsentBadge label="recording" value={participant.recordingConsent} /></div></div>
          </article>
        ))}</div> : <EmptyLine>No participants have been attached.</EmptyLine>}
      </section>

      <section className={styles.section}>
        <SectionHeading icon={<FileAudio size={17} />} eyebrow="Revision-bound evidence" title="Media and source links" count={linkedSources.length} />
        {linkedSources.length ? <div className={styles.sourceGrid}>{linkedSources.map((source) => (
          <article key={source.linkId} className={styles.sourceCard}>
            <div className={styles.sourceIcon}>{source.kind === "calendar_event" ? <CalendarDays size={18} /> : source.mediaRole === "transcript" ? <FileText size={18} /> : <FileAudio size={18} />}</div>
            <div><strong>{source.label}</strong><p>{source.kind.replaceAll("_", " ")} · {source.mediaType || source.mediaRole}</p><small>{source.durationMs ? formatDuration(source.durationMs) : source.byteCount ? formatBytes(source.byteCount) : "Exact source authority retained"}</small></div>
            <span className={styles.revisionState} data-state={source.revisionState}>{source.revisionState === "exact" ? <Check size={12} /> : <AlertTriangle size={12} />}{source.revisionState}</span>
            {meetingRecordingCanProcess(canWrite, meeting.participants, source) ? (
              <button
                type="button"
                className={styles.processMediaButton}
                disabled={processingRecordingId === source.sourceId}
                onClick={() => onProcessRecording(source)}
              >
                {processingRecordingId === source.sourceId
                  ? <Loader2 className="animate-spin" size={13} />
                  : <Sparkles size={13} />}
                Process recording
              </button>
            ) : null}
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
            canWrite={canWrite}
            commitmentViews={commitmentViews}
            commitmentBusyId={commitmentBusyId}
            onProposeCommitment={onProposeCommitment}
          />
        )) : transcriptSources.length ? transcriptSources.map((source) => (
          <article key={source.linkId} className={styles.transcript}>
            <div><strong>{source.label}</strong><span>{source.transcriptTruncated ? "First 500,000 characters" : "Exact linked revision"}</span></div>
            <p>{source.transcript}</p>
          </article>
        )) : <EmptyLine>Timestamped processing continues after the browser closes. A diarized transcript, chapters, and cited outcomes will appear here when ready.</EmptyLine>}
      </section>

      <section className={styles.section}>
        <SectionHeading
          icon={<CheckCircle2 size={17} />}
          eyebrow="Evidence → governed action"
          title="Commitment conversion"
          count={commitmentViews.length}
        />
        {commitmentViews.length ? (
          <div className={styles.commitmentGrid}>
            {commitmentViews.map((view) => (
              <CommitmentProposalCard
                key={view.proposal.proposalId}
                view={view}
                meeting={meeting}
                policies={eligiblePolicies}
                canWrite={canWrite}
                busy={commitmentBusyId === view.proposal.proposalId}
                onResolve={onResolveCommitment}
              />
            ))}
          </div>
        ) : (
          <EmptyLine>
            Propose a cited action item above, then confirm its owner and due date before any WorkItem or draft is created.
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
  commitmentViews = [],
  commitmentBusyId,
  onProposeCommitment,
}: {
  label: string;
  media: ProcessedMeetingMediaView;
  meetingHasProject?: boolean;
  canWrite?: boolean;
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
            ? "Media processing needs attention. The original audio remains stored."
            : "Audio is stored. Diarization, timestamping, chapters, and cited extraction are continuing in the background."}</p>
        </div>
        <span>{media.processingStatus}</span>
      </article>
    );
  }
  return (
    <article className={styles.processedMedia}>
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
                    disabled={!meetingHasProject || commitmentBusyId === item.actionItemId}
                    onClick={() => onProposeCommitment?.(output.mediaRevisionId, item.actionItemId)}
                  >
                    {commitmentBusyId === item.actionItemId
                      ? <Loader2 className="animate-spin" size={12} />
                      : <Plus size={12} />}
                    {meetingHasProject ? "Propose as work" : "Link a project first"}
                  </button>
                ) : null}
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
        <ol>
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
        if (!ownerParticipantId) return;
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
          <select
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
            <select value={policyId} onChange={(event) => setPolicyId(event.target.value)} required>
              {policies.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName} · {candidate.address}
                </option>
              ))}
            </select>
          </label>
          <label><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} required /></label>
          <label><span>Message</span><textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} required /></label>
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
    </form>
  );
}

function MediaCitations({ citations }: { citations: MediaCitation[] }) {
  return (
    <div className={styles.citations} aria-label="Transcript citations">
      {citations.map((citation) => (
        <span key={citation.turnId}>
          {formatMediaTimestamp(citation.startMilliseconds)} · Speaker {citation.speakerLabel}
        </span>
      ))}
    </div>
  );
}

function MeetingEditor({ draft, setDraft, projects, entities, library, saving, editing, onSubmit, onCancel }: {
  draft: MeetingDraft;
  setDraft: React.Dispatch<React.SetStateAction<MeetingDraft | undefined>>;
  projects: ProjectOption[];
  entities: EntityOption[];
  library: LibraryItem[];
  saving: boolean;
  editing: boolean;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const [sourceSelection, setSourceSelection] = useState("");
  const [entitySelection, setEntitySelection] = useState("");
  const sourceOptions = useMemo(() => library.filter((item) =>
    !draft.sourceLinks.some((link) => link.sourceId === item.sourceId && sourceKind(item) === link.kind)
  ), [draft.sourceLinks, library]);
  function patch(change: Partial<MeetingDraft>) {
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
      <div className={styles.editorHeader}><div><p className={styles.eyebrow}>Immutable meeting revision</p><h2>{editing ? "Revise meeting" : "Create meeting"}</h2><p>Every linked source is resolved again on save. Recording media requires explicit consent from every participant.</p></div><button type="button" className={styles.iconButton} onClick={onCancel} aria-label="Close meeting editor"><X size={18} /></button></div>
      <fieldset className={styles.formSection}><legend>Meeting metadata</legend><div className={styles.formGrid}>
        <label className={styles.wideField}><span>Title</span><input required maxLength={240} value={draft.title} onChange={(event) => patch({ title: event.currentTarget.value })} /></label>
        <label><span>Status</span><select value={draft.status} onChange={(event) => patch({ status: event.currentTarget.value as MeetingStatus })}><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
        <label><span>Access ceiling</span><select value={draft.declaredAccessClass} onChange={(event) => patch({ declaredAccessClass: event.currentTarget.value as AccessClass })}><option value="owner_private">Owner only</option><option value="project_members">Project members</option><option value="workspace_members">Workspace members</option></select></label>
        <label><span>Starts</span><input required type="datetime-local" value={toLocalInput(draft.scheduledStartAt)} onChange={(event) => patch({ scheduledStartAt: fromLocalInput(event.currentTarget.value) })} /></label>
        <label><span>Ends</span><input required type="datetime-local" value={toLocalInput(draft.scheduledEndAt)} onChange={(event) => patch({ scheduledEndAt: fromLocalInput(event.currentTarget.value) })} /></label>
        <label><span>Timezone</span><input required maxLength={100} value={draft.timezone} onChange={(event) => patch({ timezone: event.currentTarget.value })} /></label>
        <label><span>Location</span><input maxLength={500} value={draft.location} onChange={(event) => patch({ location: event.currentTarget.value })} /></label>
        <label><span>Project</span><select value={draft.projectId || ""} onChange={(event) => patch({ projectId: event.currentTarget.value || null })}><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className={styles.wideField}><span>Summary</span><textarea rows={3} maxLength={8000} value={draft.summary} onChange={(event) => patch({ summary: event.currentTarget.value })} /></label>
      </div></fieldset>

      <fieldset className={styles.formSection}><legend>Participants and consent</legend><p className={styles.fieldHelp}>Consent timestamps are attached automatically when you record an explicit state.</p>
        <div className={styles.editorRows}>{draft.participants.map((participant, index) => <div key={participant.participantId} className={styles.participantEditor}>
          <label><span>Name</span><input required maxLength={160} value={participant.displayName} onChange={(event) => updateParticipant(index, { displayName: event.currentTarget.value })} /></label>
          <label><span>Email</span><input type="email" maxLength={320} value={participant.email || ""} onChange={(event) => updateParticipant(index, { email: event.currentTarget.value || null })} /></label>
          <label><span>Role</span><select value={participant.role} onChange={(event) => updateParticipant(index, { role: event.currentTarget.value as Participant["role"] })}><option value="organizer">Organizer</option><option value="required">Required</option><option value="optional">Optional</option><option value="guest">Guest</option></select></label>
          <label><span>Response</span><select value={participant.response} onChange={(event) => updateParticipant(index, { response: event.currentTarget.value as Participant["response"] })}><option value="accepted">Accepted</option><option value="tentative">Tentative</option><option value="declined">Declined</option><option value="needs_action">Needs action</option><option value="unknown">Unknown</option></select></label>
          <label><span>Attendee consent</span><select value={participant.attendeeConsent} onChange={(event) => updateParticipant(index, { attendeeConsent: event.currentTarget.value as Participant["attendeeConsent"] })}><option value="unknown">Unknown</option><option value="pending">Pending</option><option value="granted">Granted</option><option value="declined">Declined</option></select></label>
          <label><span>Recording consent</span><select value={participant.recordingConsent} onChange={(event) => updateParticipant(index, { recordingConsent: event.currentTarget.value as Participant["recordingConsent"] })}><option value="unknown">Unknown</option><option value="pending">Pending</option><option value="granted">Granted</option><option value="declined">Declined</option><option value="not_required">Not required</option></select></label>
          <button type="button" className={styles.removeButton} onClick={() => patch({ participants: draft.participants.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /> Remove</button>
        </div>)}</div>
        <button type="button" className={styles.addButton} onClick={addParticipant}><Plus size={14} /> Add participant</button>
      </fieldset>

      <fieldset className={styles.formSection}><legend>Calendar, media, and source permissions</legend><p className={styles.fieldHelp}>Choose from your governed Library. Exact calendar/source revisions are retained; captured items are re-digested on save.</p>
        <div className={styles.picker}><select value={sourceSelection} onChange={(event) => setSourceSelection(event.currentTarget.value)}><option value="">Choose a governed source…</option>{sourceOptions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.sourceLabel} · {item.kind}</option>)}</select><button type="button" onClick={addSource} disabled={!sourceSelection}><Link2 size={14} /> Link source</button></div>
        <div className={styles.chipList}>{draft.sourceLinks.map((source) => <span key={source.linkId}><strong>{source.label}</strong><small>{source.kind.replaceAll("_", " ")} · {source.mediaRole}</small><button type="button" onClick={() => patch({ sourceLinks: draft.sourceLinks.filter((item) => item.linkId !== source.linkId) })} aria-label={`Remove ${source.label}`}><X size={13} /></button></span>)}</div>
      </fieldset>

      <fieldset className={styles.formSection}><legend>Customer and account context</legend><div className={styles.picker}><select value={entitySelection} onChange={(event) => setEntitySelection(event.currentTarget.value)}><option value="">Choose an Entity Registry record…</option>{entities.filter((entity) => !draft.entityLinks.some((link) => link.entityId === entity.entityId)).map((entity) => <option key={entity.entityId} value={entity.entityId}>{entity.canonicalLabel} · {entity.entityTypeId}</option>)}</select><button type="button" onClick={addEntity} disabled={!entitySelection}><Plus size={14} /> Link entity</button></div><div className={styles.chipList}>{draft.entityLinks.map((entity) => <span key={entity.entityId}><strong>{entity.label}</strong><small>{entity.relationship} · {entity.entityType}</small><button type="button" onClick={() => patch({ entityLinks: draft.entityLinks.filter((item) => item.entityId !== entity.entityId) })} aria-label={`Remove ${entity.label}`}><X size={13} /></button></span>)}</div></fieldset>

      <div className={styles.editorFooter}><button type="button" className={styles.secondaryButton} onClick={onCancel}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={saving}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{editing ? "Publish revision" : "Create meeting"}</button></div>
    </form>
  );
}

function Metric({ value, label, detail, warning }: { value: number; label: string; detail: string; warning?: boolean }) { return <div data-warning={warning || undefined}><strong>{value}</strong><span>{label}</span><small>{detail}</small></div>; }
function Metadata({ icon, label, value, href }: { icon: React.ReactNode; label: string; value: string; href?: string }) { const content = <><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></>; return href ? <Link href={href} className={styles.metadata}>{content}</Link> : <div className={styles.metadata}>{content}</div>; }
function SectionHeading({ icon, eyebrow, title, count }: { icon: React.ReactNode; eyebrow: string; title: string; count: number }) { return <div className={styles.sectionHeading}><div>{icon}<span><small>{eyebrow}</small><h3>{title}</h3></span></div><strong>{count}</strong></div>; }
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
