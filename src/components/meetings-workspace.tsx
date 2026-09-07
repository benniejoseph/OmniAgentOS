"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  FileAudio,
  FileText,
  Link2,
  ListChecks,
  Loader2,
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
  segments: Array<{ segmentIndex: number; mimeType: string; durationMs: number }>;
};
type WorkspaceContext = { workspaceId: string; accessLevel: string; canWrite: boolean };
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
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editor, setEditor] = useState<MeetingDraft>();
  const [editingMeetingId, setEditingMeetingId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Meetings are ready.");
  const controllerRef = useRef<AbortController | null>(null);
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
      }
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function loadDetail(meetingId: string, signal?: AbortSignal) {
    setDetailLoading(true);
    try {
      const payload = await readJson(`/api/meetings/${encodeURIComponent(meetingId)}`, { signal });
      setSelected(payload.meeting as Meeting);
      setLinkedSources((payload.linkedSources || []) as LinkedSource[]);
      setWorkspaceContext(payload.context as WorkspaceContext);
    } finally {
      setDetailLoading(false);
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
          <Link href="/app/capture" className={styles.secondaryButton}><FileAudio size={16} /> Open Capture</Link>
          {workspaceContext?.canWrite !== false ? (
            <button type="button" className={styles.primaryButton} onClick={openCreate}>
              <Plus size={16} /> New meeting
            </button>
          ) : null}
        </div>
      </header>

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
                project={projects.find((project) => project.id === selected.projectId)}
                canWrite={workspaceContext?.canWrite ?? false}
                onEdit={openEdit}
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
  project,
  canWrite,
  onEdit,
}: {
  meeting: Meeting;
  linkedSources: LinkedSource[];
  project?: ProjectOption;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const transcriptSources = linkedSources.filter((source) => source.transcript);
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
          </article>
        ))}</div> : <EmptyLine>No calendar, recording, transcript, or asset is linked.</EmptyLine>}
      </section>

      <section className={styles.section}>
        <SectionHeading icon={<MessageSquareText size={17} />} eyebrow="Conversation record" title="Transcript" count={transcriptSources.length} />
        {transcriptSources.length ? transcriptSources.map((source) => (
          <article key={source.linkId} className={styles.transcript}>
            <div><strong>{source.label}</strong><span>{source.transcriptTruncated ? "First 500,000 characters" : "Exact linked revision"}</span></div>
            <p>{source.transcript}</p>
          </article>
        )) : <EmptyLine>An exact recording transcript will appear here. Changed or unavailable revisions are never substituted silently.</EmptyLine>}
      </section>

      <div className={styles.twoColumn}>
        <RecordSection icon={<Sparkles size={17} />} eyebrow="Outcome" title="Decisions" records={meeting.decisions.map((decision) => ({ id: decision.decisionId, title: decision.summary, meta: participantName(meeting, decision.ownerParticipantId) }))} empty="No decisions recorded." />
        <RecordSection icon={<CircleUserRound size={17} />} eyebrow="Ownership" title="Commitments" records={meeting.commitments.map((commitment) => ({ id: commitment.commitmentId, title: commitment.summary, meta: [participantName(meeting, commitment.ownerParticipantId), commitment.dueAt ? `Due ${formatCompactDate(commitment.dueAt)}` : ""].filter(Boolean).join(" · ") }))} empty="No commitments recorded." />
      </div>

      <section className={styles.section}>
        <SectionHeading icon={<ListChecks size={17} />} eyebrow="Execution bridge" title="Follow-up" count={meeting.followUps.length} />
        {meeting.followUps.length ? <div className={styles.followUpList}>{meeting.followUps.map((followUp) => (
          <div key={followUp.followUpId}><span data-status={followUp.status} /><div><strong>{followUp.label}</strong><p>{followUp.workItemId ? `Work item ${followUp.workItemId}` : followUp.draftId ? `Draft ${followUp.draftId}` : "Not converted yet"}</p></div><em>{followUp.status}</em></div>
        ))}</div> : <EmptyLine>Accepted commitments can become WorkItems or communication drafts in the next meeting workflow phase.</EmptyLine>}
      </section>

      {meeting.entityLinks.length ? <section className={styles.section}>
        <SectionHeading icon={<CircleUserRound size={17} />} eyebrow="Customer context" title="Linked accounts and entities" count={meeting.entityLinks.length} />
        <div className={styles.entityList}>{meeting.entityLinks.map((entity) => <span key={entity.entityId}><strong>{entity.label}</strong><small>{entity.relationship} · {entity.entityType}</small></span>)}</div>
      </section> : null}
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
function formatDuration(ms: number) { const minutes = Math.round(ms / 60_000); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`; }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function toLocalInput(value: string) { const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function fromLocalInput(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); }
async function readJson(path: string, init?: RequestInit) { const response = await fetch(path, { cache: "no-store", ...init }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(String(payload.error || payload.message || `${path} returned ${response.status}`)); return payload as Record<string, unknown>; }
function message(error: unknown) { return error instanceof Error ? error.message : "Meetings could not be updated."; }
