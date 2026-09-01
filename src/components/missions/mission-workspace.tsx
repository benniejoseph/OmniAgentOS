"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Columns3,
  FileText,
  GitBranch,
  Inbox,
  LayoutList,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SquareKanban,
  TriangleAlert,
  UserRound,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import type { CapabilityDescriptor } from "@/lib/capabilities/types";
import type { MissionDetailView, MissionSummaryView } from "@/lib/missions/public";
import type { MissionStatus } from "@/lib/missions/types";
import styles from "@/components/missions/mission-workspace.module.css";

type ViewMode = "board" | "canvas" | "list";
type BoardColumnId = "inbox" | "waiting" | "ready" | "working" | "needs-you" | "review" | "done";
type TaskFilter = "all" | "open" | "attention" | "done";
type AgentOption = { id: string; name: string; role?: string };
type BoardComment = { id: string; body: string; authorName?: string; createdAt: string; taskId?: string };

type BaseTask = MissionDetailView["tasks"][number];
type BoardTask = Omit<BaseTask, "status"> & {
  status: string;
  metadata?: Record<string, unknown>;
  assigneeId?: string;
  assigneeName?: string;
  reviewRequired?: boolean;
  scheduledFor?: string;
  blockerReason?: string;
  retryCount?: number;
  maxAttempts?: number;
  comments?: BoardComment[];
};

type BaseArtifact = MissionDetailView["artifacts"][number];
type BoardArtifact = BaseArtifact & {
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
  preview?: string;
};

type BoardMissionDetail = Omit<MissionDetailView, "tasks" | "artifacts"> & {
  tasks: BoardTask[];
  artifacts: BoardArtifact[];
  comments?: BoardComment[];
};

type BoardColumn = { id: BoardColumnId; title: string; description: string };

const BOARD_COLUMNS: BoardColumn[] = [
  { id: "inbox", title: "Inbox", description: "Needs shaping" },
  { id: "waiting", title: "Waiting", description: "Dependency or schedule" },
  { id: "ready", title: "Ready", description: "Clear to start" },
  { id: "working", title: "Working", description: "Work in progress" },
  { id: "needs-you", title: "Needs you", description: "Input required" },
  { id: "review", title: "Review", description: "Evidence ready" },
  { id: "done", title: "Done", description: "Terminal work" },
];

export function MissionWorkspace({
  initialMissionId = "",
  initialMissions,
  initialCapabilities,
  initialDetail,
  initialEventCursor = 0,
  initialAsOf = 0,
}: {
  initialMissionId?: string;
  initialMissions?: MissionSummaryView[];
  initialCapabilities?: CapabilityDescriptor[];
  initialDetail?: MissionDetailView;
  initialEventCursor?: number;
  initialAsOf?: number;
}) {
  const pathname = usePathname();
  const { session, status: sessionStatus, refresh: refreshSession } = useWorkspaceSession();
  const hasInitialWorkspace = initialMissions !== undefined && initialCapabilities !== undefined;
  const [missions, setMissions] = useState<MissionSummaryView[]>(initialMissions || []);
  const [details, setDetails] = useState<Record<string, BoardMissionDetail>>(
    initialDetail ? { [initialDetail.mission.id]: initialDetail as BoardMissionDetail } : {},
  );
  const detailsRef = useRef(details);
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>(initialCapabilities || []);
  const initialSelectionId = initialMissionId || initialDetail?.mission.id || initialMissions?.[0]?.id || "";
  const baseSelectionRef = useRef(initialDetail?.mission.id || initialMissions?.[0]?.id || "");
  const [selectedId, setSelectedId] = useState(initialSelectionId);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(!hasInitialWorkspace);
  const [showLoading, setShowLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState<MissionSummaryView["priority"]>("normal");
  const [view, setView] = useState<ViewMode>("board");
  const [search, setSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [mobileColumn, setMobileColumn] = useState<BoardColumnId>("ready");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string>();
  const [taskActionError, setTaskActionError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Mission board is ready.");
  const [asOf, setAsOf] = useState(initialAsOf);
  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const selectedDetail = selectedId ? details[selectedId] : undefined;
  const selectedMission = missions.find((mission) => mission.id === selectedId) || selectedDetail?.mission;
  const selectedMissionStatus = selectedMission?.status;
  const selectedTask = selectedDetail?.tasks.find((task) => task.id === selectedTaskId);
  const sessionProblem = sessionStatus === "error"
    ? "We could not verify your session. Try reconnecting."
    : sessionStatus === "ready" && !available ? "Sign in to open Missions." : undefined;
  const displayError = error || sessionProblem;
  const workspaceLoading = loading && !sessionProblem;

  useEffect(() => { detailsRef.current = details; }, [details]);

  useEffect(() => {
    const routeMissionId = missionIdFromPath(pathname);
    const nextId = routeMissionId || (pathname === "/app/missions" ? baseSelectionRef.current || missions[0]?.id || "" : "");
    if (!nextId) return;
    setSelectedId((current) => current === nextId ? current : nextId);
    setError(undefined);
  }, [missions, pathname]);

  useEffect(() => {
    const tick = () => setAsOf(Date.now());
    const timer = window.setInterval(tick, 60_000);
    tick();
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setShowLoading(true), 350);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (hasInitialWorkspace || !available || sessionStatus !== "ready") return;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    async function loadWorkspace() {
      setShowLoading(false);
      setLoading(true);
      try {
        const [missionPayload, capabilityPayload] = await Promise.all([
          readJson("/api/missions?limit=50", { signal: controller.signal }),
          readJson("/api/capabilities?view=catalog&limit=50", { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        const nextMissions = (missionPayload.missions || []) as MissionSummaryView[];
        setMissions(nextMissions);
        setCapabilities((capabilityPayload.capabilities || []) as CapabilityDescriptor[]);
        setSelectedId((current) => current || nextMissions[0]?.id || "");
        setError(undefined);
      } catch (loadError) {
        if (!controller.signal.aborted) setError(friendlyMessage(loadError, "load"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadWorkspace();
    return () => controller.abort();
  }, [available, hasInitialWorkspace, sessionStatus]);

  useEffect(() => {
    if (!available || sessionStatus !== "ready") return;
    const controller = new AbortController();
    async function loadAgents() {
      try {
        const payload = await readJson("/api/agents", { signal: controller.signal });
        if (!controller.signal.aborted) setAgents(agentOptions(payload));
      } catch {
        // Assignment remains optional when the agent catalog is unavailable.
      }
    }
    void loadAgents();
    return () => controller.abort();
  }, [available, sessionStatus]);

  useEffect(() => {
    if (!available || sessionStatus !== "ready" || !selectedId || details[selectedId]) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const detail = await readJson(`/api/missions/${encodeURIComponent(selectedId)}`, { signal: controller.signal }) as BoardMissionDetail;
        if (!controller.signal.aborted) updateDetail(detail);
      } catch (loadError) {
        if (!controller.signal.aborted) setError(friendlyMessage(loadError, "load"));
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }
    void loadDetail();
    return () => controller.abort();
  }, [available, details, selectedId, sessionStatus]);

  useEffect(() => {
    if (!available || sessionStatus !== "ready" || !selectedId || !selectedMissionStatus || !["queued", "running", "waiting"].includes(selectedMissionStatus)) return;
    let stopped = false;
    let inFlight = false;
    let cursor = initialDetail?.mission.id === selectedId ? initialEventCursor : 0;
    let visibleStatus = detailsRef.current[selectedId]?.mission.status;
    let visibleUpdatedAt = detailsRef.current[selectedId]?.mission.updatedAt;
    let consecutiveFailures = 0;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void pollMissionEvents(), missionEventPollDelay(consecutiveFailures));
    };
    const pollMissionEvents = async () => {
      timer = undefined;
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      controller = new AbortController();
      try {
        const payload = await readJson(`/api/missions/${encodeURIComponent(selectedId)}/events?afterSeq=${cursor}&limit=25`, { signal: controller.signal });
        const events = Array.isArray(payload.events) ? payload.events : [];
        const nextCursor = missionEventCursor(payload.cursor, cursor);
        const projection = missionEventProjection(payload.mission);
        const changed = Boolean(projection && (!visibleStatus || projection.status !== visibleStatus || projection.updatedAt !== visibleUpdatedAt));
        if (events.length > 0 || changed) {
          const detail = await readJson(`/api/missions/${encodeURIComponent(selectedId)}`, { signal: controller.signal }) as BoardMissionDetail;
          if (stopped) return;
          updateDetail(detail);
          visibleStatus = detail.mission.status;
          visibleUpdatedAt = detail.mission.updatedAt;
        }
        cursor = nextCursor;
        consecutiveFailures = 0;
      } catch {
        if (!controller.signal.aborted) consecutiveFailures += 1;
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const wake = () => {
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void pollMissionEvents();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        return;
      }
      wake();
    };
    wake();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [available, initialDetail?.mission.id, initialEventCursor, selectedId, selectedMissionStatus, sessionStatus]);

  const visibleMissions = useMemo(() => missions.filter((mission) => showArchived || mission.status !== "archived"), [missions, showArchived]);
  const tasks = useMemo(() => selectedDetail?.tasks || [], [selectedDetail]);
  const agentNameMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const column = boardColumnForTask(task, tasks);
    const query = search.trim().toLowerCase();
    if (query && !`${task.title} ${task.instructions} ${task.definitionOfDone}`.toLowerCase().includes(query)) return false;
    if (assigneeFilter !== "all" && taskAssigneeId(task) !== assigneeFilter) return false;
    if (taskFilter === "open" && column === "done") return false;
    if (taskFilter === "attention" && !["needs-you", "review", "waiting"].includes(column)) return false;
    if (taskFilter === "done" && column !== "done") return false;
    return true;
  }), [assigneeFilter, search, taskFilter, tasks]);
  const groupedTasks = useMemo(() => new Map(BOARD_COLUMNS.map((column) => [column.id, filteredTasks.filter((task) => boardColumnForTask(task, tasks) === column.id)])), [filteredTasks, tasks]);
  const workingCount = tasks.filter((task) => boardColumnForTask(task, tasks) === "working").length;
  const attentionCount = tasks.filter((task) => ["needs-you", "review", "waiting"].includes(boardColumnForTask(task, tasks))).length;
  const doneCount = tasks.filter((task) => boardColumnForTask(task, tasks) === "done").length;

  function updateDetail(detail: BoardMissionDetail) {
    setDetails((current) => ({ ...current, [detail.mission.id]: detail }));
    setMissions((current) => current.some((mission) => mission.id === detail.mission.id)
      ? current.map((mission) => mission.id === detail.mission.id ? detail.mission : mission)
      : [detail.mission, ...current]);
  }

  async function refreshDetail(missionId = selectedId) {
    if (!missionId) return undefined;
    const detail = await readJson(`/api/missions/${encodeURIComponent(missionId)}`) as BoardMissionDetail;
    updateDetail(detail);
    return detail;
  }

  function selectMission(id: string) {
    setSelectedTaskId("");
    setTaskActionError(undefined);
    setShowTaskCreate(false);
    setSelectedId(id);
    setError(undefined);
    pushMissionHistory(id);
  }

  async function createMission(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) return;
    setCreating(true);
    setError(undefined);
    try {
      const payload = await readJson("/api/missions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: title.trim(), objective: objective.trim(), priority }),
      });
      const mission = payload.mission as MissionSummaryView;
      setMissions((current) => [mission, ...current.filter((item) => item.id !== mission.id)]);
      setSelectedTaskId("");
      setTaskActionError(undefined);
      setShowTaskCreate(false);
      setSelectedId(mission.id);
      setTitle(""); setObjective(""); setPriority("normal"); setShowCreate(false);
      setAnnouncement(`${mission.title} was created as a draft mission.`);
      pushMissionHistory(mission.id);
    } catch (createError) {
      setError(friendlyMessage(createError, "create"));
    } finally { setCreating(false); }
  }

  async function createTask(input: NewTaskInput) {
    if (!selectedId) return;
    setCreatingTask(true); setTaskActionError(undefined);
    try {
      const payload = await readJson(`/api/missions/${encodeURIComponent(selectedId)}/tasks`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: input.title, instructions: input.instructions, definitionOfDone: input.definitionOfDone, priority: input.priority, status: input.boardStage === "inbox" ? "triage" : "pending", assigneeId: input.assigneeId || undefined, reviewRequired: input.reviewRequired }),
      });
      const detail = await refreshDetail();
      const taskId = taskIdFromMutation(payload);
      if (taskId && detail?.tasks.some((task) => task.id === taskId)) setSelectedTaskId(taskId);
      setShowTaskCreate(false);
      setAnnouncement(`${input.title} was added to ${input.boardStage === "inbox" ? "Inbox" : "Ready"}.`);
    } catch (createError) { setTaskActionError(friendlyMessage(createError, "create")); }
    finally { setCreatingTask(false); }
  }

  async function patchTask(taskId: string, input: Record<string, unknown>, successMessage: string) {
    if (!selectedId) return;
    setMutatingTaskId(taskId); setTaskActionError(undefined);
    try {
      await readJson(`/api/missions/${encodeURIComponent(selectedId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      await refreshDetail();
      setAnnouncement(successMessage);
    } catch (mutationError) { setTaskActionError(friendlyMessage(mutationError, "update")); }
    finally { setMutatingTaskId(""); }
  }

  async function addComment(taskId: string, body: string) {
    if (!selectedId || !body.trim()) return false;
    setMutatingTaskId(taskId); setTaskActionError(undefined);
    try {
      await readJson(`/api/missions/${encodeURIComponent(selectedId)}/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: body.trim() }),
      });
      await refreshDetail();
      setAnnouncement("Comment added to the task.");
      return true;
    } catch (commentError) { setTaskActionError(friendlyMessage(commentError, "update")); return false; }
    finally { setMutatingTaskId(""); }
  }

  async function reviewTask(taskId: string, action: ReviewAction, note = "") {
    if (!selectedId) return;
    setMutatingTaskId(taskId); setTaskActionError(undefined);
    try {
      await readJson(`/api/missions/${encodeURIComponent(selectedId)}/tasks/${encodeURIComponent(taskId)}/review`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "request_changes" ? { reason: note.trim() } : note.trim() ? { summary: note.trim() } : {}),
        }),
      });
      await refreshDetail();
      setAnnouncement(reviewActionLabel(action));
    } catch (reviewError) { setTaskActionError(friendlyMessage(reviewError, "update")); }
    finally { setMutatingTaskId(""); }
  }

  return (
    <section className={styles.shell} aria-busy={workspaceLoading || detailLoading}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <div className={styles.titleLine}><span className={styles.titleIcon}><SquareKanban size={18} aria-hidden="true" /></span><div className={styles.titleCopy}><span className={styles.eyebrow}>Connected work</span><h1>Missions</h1></div></div>
          <p>Move durable outcomes through linked tasks, agents, decisions, and evidence.</p>
        </div>
        <div className={styles.headerActions}>
          <Link href="/app/connectors" title="Manage connected capabilities"><Zap size={14} aria-hidden="true" /> {capabilities.length} tools</Link>
          <button type="button" className={styles.secondaryButton} onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> Mission</button>
          <button type="button" className={styles.primaryButton} onClick={() => setShowTaskCreate(true)} disabled={!selectedMission}><Plus size={14} aria-hidden="true" /> Task</button>
        </div>
      </header>

      {displayError ? <div className={styles.error} role="alert"><TriangleAlert size={15} aria-hidden="true" /><span>{displayError}</span>{sessionStatus === "ready" && !available ? <Link href="/login">Sign in</Link> : <button type="button" onClick={() => sessionStatus === "error" ? void refreshSession() : window.location.reload()}>Try again</button>}</div> : null}

      <div className={clsx(styles.workspace, railCollapsed && styles.workspaceRailCollapsed)}>
        <aside className={clsx(styles.rail, railCollapsed && styles.railCollapsed)} aria-label="Mission selector">
          <div className={styles.railHeading}>
            <span className={styles.railLabel}>{railCollapsed ? "" : <><b>Mission library</b><small>{visibleMissions.length}</small></>}</span>
            <button type="button" onClick={() => setRailCollapsed((current) => !current)} aria-label={railCollapsed ? "Expand mission selector" : "Collapse mission selector"} title={railCollapsed ? "Expand missions" : "Collapse missions"}>
              {railCollapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
            </button>
          </div>
          <div className={styles.railList}>
            {workspaceLoading ? (showLoading ? <MissionListSkeleton /> : <div className={styles.loadingReserve} aria-hidden="true" />) : visibleMissions.length ? visibleMissions.map((mission) => (
              <button key={mission.id} type="button" aria-pressed={selectedId === mission.id} aria-label={railCollapsed ? `${mission.title}, ${missionStatusLabel(mission.status)}` : undefined} title={railCollapsed ? mission.title : undefined} className={clsx(styles.missionItem, selectedId === mission.id && styles.missionItemSelected)} onClick={() => selectMission(mission.id)}>
                <span className={clsx(styles.statusDot, statusToneClass(mission.status))} aria-hidden="true" />
                <span className={styles.missionItemCopy}><strong>{mission.title}</strong><small>{missionStatusLabel(mission.status)} · {relativeTime(mission.updatedAt, asOf)}</small></span>
                <ChevronRight className={styles.missionChevron} size={14} aria-hidden="true" />
              </button>
            )) : <div className={styles.emptyRail}><Inbox size={18} aria-hidden="true" />{!railCollapsed ? <><p>No missions yet.</p><button type="button" onClick={() => setShowCreate(true)}>Create one</button></> : null}</div>}
          </div>
          <label className={styles.archiveToggle} title="Include archived missions"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.currentTarget.checked)} /><Archive size={13} aria-hidden="true" />{!railCollapsed ? <span>Show archived</span> : null}</label>
        </aside>

        <main className={styles.main}>
          {selectedMission ? <>
            <section className={styles.missionHeader} aria-labelledby="mission-title">
              <div className={styles.missionIdentity}>
                <div className={styles.missionMeta}><span className={clsx(styles.missionStatus, statusToneClass(selectedMission.status))}>{missionStatusLabel(selectedMission.status)}</span><span>{selectedMission.priority} priority</span><span>Updated {relativeTime(selectedMission.updatedAt, asOf)}</span></div>
                <h2 id="mission-title">{selectedMission.title}</h2><p>{selectedMission.objective}</p>
              </div>
              <div className={styles.missionLinks}><Link href={talkHref(selectedMission)}><Bot size={14} aria-hidden="true" /> Continue in Command</Link><Link href="/app/approvals"><ShieldCheck size={14} aria-hidden="true" /> Approvals</Link></div>
            </section>
            <div className={styles.metrics} aria-label="Mission task overview"><span><strong>{tasks.length}</strong> tasks</span><span><strong>{workingCount}</strong> working</span><span><strong>{attentionCount}</strong> need attention</span><span><strong>{doneCount}</strong> done</span><span className={styles.ledgerSignal}><i aria-hidden="true" /> Ledger live</span></div>
            <div className={styles.toolbar}>
              <label className={styles.searchField}><span className="sr-only">Search tasks</span><Search size={14} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search tasks" />{search ? <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X size={13} aria-hidden="true" /></button> : null}</label>
              <label className={styles.filterField}><UserRound size={13} aria-hidden="true" /><span className="sr-only">Filter by assignee</span><select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.currentTarget.value)}><option value="all">All agents</option><option value="unassigned">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
              <label className={styles.filterField}><CircleDot size={13} aria-hidden="true" /><span className="sr-only">Filter by task state</span><select value={taskFilter} onChange={(event) => setTaskFilter(event.currentTarget.value as TaskFilter)}><option value="all">All states</option><option value="open">Open work</option><option value="attention">Needs attention</option><option value="done">Done</option></select></label>
              <div className={styles.viewSwitch} role="group" aria-label="Mission view"><ViewButton active={view === "board"} label="Board" onClick={() => setView("board")} icon={<Columns3 size={14} />} /><ViewButton active={view === "canvas"} label="Canvas" onClick={() => setView("canvas")} icon={<GitBranch size={14} />} /><ViewButton active={view === "list"} label="List" onClick={() => setView("list")} icon={<LayoutList size={14} />} /></div>
              <button type="button" className={styles.toolbarAdd} onClick={() => setShowTaskCreate(true)}><Plus size={14} aria-hidden="true" /> New task</button>
            </div>
            {detailLoading && !selectedDetail ? <CanvasSkeleton /> : <div className={styles.viewFrame} key={view}>
              {view === "board" ? <TaskBoard columns={BOARD_COLUMNS} groupedTasks={groupedTasks} allTasks={tasks} detail={selectedDetail} agents={agentNameMap} asOf={asOf} mobileColumn={mobileColumn} onMobileColumnChange={setMobileColumn} onSelectTask={(task) => setSelectedTaskId(task.id)} onCreateTask={() => setShowTaskCreate(true)} />
                : view === "canvas" ? <TaskCanvas tasks={filteredTasks} allTasks={tasks} agents={agentNameMap} onSelectTask={(task) => setSelectedTaskId(task.id)} />
                  : <TaskList tasks={filteredTasks} allTasks={tasks} detail={selectedDetail} agents={agentNameMap} asOf={asOf} onSelectTask={(task) => setSelectedTaskId(task.id)} />}
            </div>}
          </> : workspaceLoading ? (showLoading ? <CanvasSkeleton /> : <div className={styles.loadingReserve} aria-hidden="true" />) : <div className={styles.emptyCanvas}><Workflow size={28} aria-hidden="true" /><h2>Create a mission to organize durable work</h2><p>Each mission keeps tasks, agent attempts, approvals, and evidence connected.</p><button type="button" onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> New mission</button></div>}
        </main>
      </div>

      {showCreate ? <MissionCreateDialog title={title} objective={objective} priority={priority} creating={creating} error={error} onTitleChange={setTitle} onObjectiveChange={setObjective} onPriorityChange={setPriority} onClose={() => setShowCreate(false)} onSubmit={createMission} /> : null}
      {showTaskCreate && selectedMission ? <TaskCreateDialog missionTitle={selectedMission.title} agents={agents} creating={creatingTask} error={taskActionError} onClose={() => { setShowTaskCreate(false); setTaskActionError(undefined); }} onCreate={createTask} /> : null}
      {selectedTask && selectedDetail ? <TaskDrawer key={`${selectedTask.id}:${selectedTask.updatedAt}`} task={selectedTask} allTasks={tasks} detail={selectedDetail} agents={agents} agentNames={agentNameMap} asOf={asOf} busy={mutatingTaskId === selectedTask.id} error={taskActionError} onClose={() => { setSelectedTaskId(""); setTaskActionError(undefined); }} onSave={(input) => patchTask(selectedTask.id, { expectedUpdatedAt: selectedTask.updatedAt, ...input }, "Task details saved.")} onAction={(action) => patchTask(selectedTask.id, { expectedUpdatedAt: selectedTask.updatedAt, ...taskActionPatch(action, selectedTask) }, taskActionLabel(action))} onReview={(action, note) => reviewTask(selectedTask.id, action, note)} onComment={(body) => addComment(selectedTask.id, body)} /> : null}
    </section>
  );
}

function ViewButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button type="button" className={active ? styles.viewButtonActive : undefined} aria-pressed={active} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function TaskBoard({ columns, groupedTasks, allTasks, detail, agents, asOf, mobileColumn, onMobileColumnChange, onSelectTask, onCreateTask }: {
  columns: BoardColumn[]; groupedTasks: Map<BoardColumnId, BoardTask[]>; allTasks: BoardTask[]; detail?: BoardMissionDetail; agents: Map<string, string>; asOf: number; mobileColumn: BoardColumnId; onMobileColumnChange: (column: BoardColumnId) => void; onSelectTask: (task: BoardTask) => void; onCreateTask: () => void;
}) {
  return <section className={styles.boardRegion} aria-label="Task board">
    <label className={styles.mobileColumnPicker}><span>Board column</span><select value={mobileColumn} onChange={(event) => onMobileColumnChange(event.currentTarget.value as BoardColumnId)}>{columns.map((column) => <option key={column.id} value={column.id}>{column.title} ({groupedTasks.get(column.id)?.length || 0})</option>)}</select></label>
    <div className={styles.board}>{columns.map((column) => {
      const columnTasks = groupedTasks.get(column.id) || [];
      return <section key={column.id} className={styles.boardColumn} data-mobile-visible={column.id === mobileColumn} aria-labelledby={`column-${column.id}`}>
        <header className={styles.columnHeader}><span className={clsx(styles.columnMark, columnToneClass(column.id))} aria-hidden="true" /><div><h3 id={`column-${column.id}`}>{column.title}</h3><p>{column.description}</p></div><strong>{columnTasks.length}</strong></header>
        <div className={styles.columnTasks}>{columnTasks.map((task) => <TaskCard key={task.id} task={task} allTasks={allTasks} detail={detail} agents={agents} asOf={asOf} onSelect={() => onSelectTask(task)} />)}
          {!columnTasks.length ? <div className={styles.columnEmpty}><span>{column.id === "inbox" ? "Drop a rough task here to shape it." : `No tasks in ${column.title.toLowerCase()}.`}</span>{column.id === "inbox" ? <button type="button" onClick={onCreateTask}><Plus size={12} aria-hidden="true" /> Add task</button> : null}</div> : null}
        </div>
      </section>;
    })}</div>
  </section>;
}

function TaskCard({ task, allTasks, detail, agents, asOf, onSelect }: { task: BoardTask; allTasks: BoardTask[]; detail?: BoardMissionDetail; agents: Map<string, string>; asOf: number; onSelect: () => void }) {
  const dependency = dependencyProgress(task, allTasks);
  const attempts = attemptsForTask(detail, task.id);
  const comments = commentsForTask(detail, task);
  const evidence = artifactsForTask(detail, task.id).filter((artifact) => !isCommentArtifact(artifact));
  const assignee = taskAssigneeLabel(task, agents);
  const column = boardColumnForTask(task, allTasks);
  const retries = taskRetryCount(task, attempts.length);
  return <button type="button" className={styles.taskCard} onClick={onSelect} aria-label={`Open ${task.title}`}>
    <span className={styles.cardTopline}><span className={clsx(styles.priority, priorityClass(task.priority))}>{task.priority}</span><span className={styles.cardAge}>{relativeTime(task.updatedAt, asOf)}</span></span>
    <strong className={styles.cardTitle}>{task.title}</strong>
    {taskCue(task, column) ? <span className={clsx(styles.taskCue, cueClass(column))}>{taskCue(task, column)}</span> : null}
    <span className={styles.assignee}><span aria-hidden="true">{initials(assignee)}</span><b>{assignee}</b></span>
    <span className={styles.cardFooter}>{dependency.total ? <span title="Completed dependencies"><GitBranch size={12} aria-hidden="true" /> {dependency.done}/{dependency.total}</span> : null}{attempts.length ? <span title={`${attempts.length} attempts, ${retries} retries`}><RefreshCw size={12} aria-hidden="true" /> {attempts.length}a · {retries}r</span> : null}{comments.length ? <span title="Comments"><MessageSquare size={12} aria-hidden="true" /> {comments.length}</span> : null}{evidence.length ? <span title="Evidence"><Paperclip size={12} aria-hidden="true" /> {evidence.length}</span> : null}</span>
  </button>;
}

function TaskCanvas({ tasks, allTasks, agents, onSelectTask }: { tasks: BoardTask[]; allTasks: BoardTask[]; agents: Map<string, string>; onSelectTask: (task: BoardTask) => void }) {
  if (!tasks.length) return <FilteredEmpty icon={<GitBranch size={22} />} title="No tasks to map" body="Change the filters or add a task to build the dependency canvas." />;
  const graph = buildTaskGraph(tasks, allTasks);
  return <section className={styles.graphViewport} aria-label="Task dependency canvas">
    <div className={styles.graphLegend}><span><i /> Parent or dependency link</span><span>Left to right execution order</span></div>
    <div className={styles.graph} style={{ width: graph.width, height: graph.height }}>
      <svg className={styles.graphEdges} width={graph.width} height={graph.height} aria-hidden="true"><defs><marker id="mission-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" /></marker></defs>{graph.edges.map((edge) => <path key={`${edge.from}-${edge.to}`} d={edge.path} markerEnd="url(#mission-arrow)" />)}</svg>
      {graph.nodes.map((node) => { const assignee = taskAssigneeLabel(node.task, agents); const column = boardColumnForTask(node.task, allTasks); return <button key={node.task.id} type="button" className={styles.graphNode} style={{ left: node.x, top: node.y }} onClick={() => onSelectTask(node.task)}><span><i className={columnToneClass(column)} aria-hidden="true" />{boardColumnLabel(column)}</span><strong>{node.task.title}</strong><small>{assignee} · {node.task.priority}</small></button>; })}
    </div>
  </section>;
}

function TaskList({ tasks, allTasks, detail, agents, asOf, onSelectTask }: { tasks: BoardTask[]; allTasks: BoardTask[]; detail?: BoardMissionDetail; agents: Map<string, string>; asOf: number; onSelectTask: (task: BoardTask) => void }) {
  if (!tasks.length) return <FilteredEmpty icon={<LayoutList size={22} />} title="No matching tasks" body="Change the filters or add a task to this mission." />;
  return <div className={styles.listViewport}><table className={styles.taskTable}><thead><tr><th>Task</th><th>State</th><th>Assignee</th><th>Dependencies</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>{tasks.map((task) => {
    const dependency = dependencyProgress(task, allTasks); const attempts = attemptsForTask(detail, task.id); const column = boardColumnForTask(task, allTasks);
    return <tr key={task.id}><td><button type="button" onClick={() => onSelectTask(task)}><strong>{task.title}</strong><small>{task.definitionOfDone || task.instructions || "Outcome not defined"}</small></button></td><td><span className={styles.tableState}><i className={columnToneClass(column)} aria-hidden="true" />{boardColumnLabel(column)}</span></td><td>{taskAssigneeLabel(task, agents)}</td><td>{dependency.total ? `${dependency.done} / ${dependency.total}` : "—"}</td><td>{attempts.length}</td><td>{relativeTime(task.updatedAt, asOf)}</td></tr>;
  })}</tbody></table></div>;
}

function FilteredEmpty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className={styles.filteredEmpty}>{icon}<strong>{title}</strong><p>{body}</p></div>;
}

function MissionCreateDialog({ title, objective, priority, creating, error, onTitleChange, onObjectiveChange, onPriorityChange, onClose, onSubmit }: {
  title: string; objective: string; priority: MissionSummaryView["priority"]; creating: boolean; error?: string; onTitleChange: (value: string) => void; onObjectiveChange: (value: string) => void; onPriorityChange: (value: MissionSummaryView["priority"]) => void; onClose: () => void; onSubmit: (event: React.FormEvent) => void;
}) {
  const closeRef = useDialogFocus(onClose);
  return <div className={styles.dialogBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="new-mission-title" onSubmit={onSubmit}>
    <header><div><p>Durable outcome</p><h2 id="new-mission-title">New mission</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
    <label>Mission title<input value={title} onChange={(event) => onTitleChange(event.currentTarget.value)} maxLength={240} placeholder="Prepare the quarterly strategy" autoFocus /></label>
    <label>Observable outcome<textarea value={objective} onChange={(event) => onObjectiveChange(event.currentTarget.value)} maxLength={4000} rows={4} placeholder="Describe what must be true when the mission is done." /></label>
    <label>Priority<select value={priority} onChange={(event) => onPriorityChange(event.currentTarget.value as MissionSummaryView["priority"])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
    {error ? <p className={styles.dialogError} role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={creating || !title.trim() || !objective.trim()}>{creating ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} Create draft</button></footer>
  </form></div>;
}

type NewTaskInput = { title: string; instructions: string; definitionOfDone: string; priority: MissionSummaryView["priority"]; assigneeId: string; reviewRequired: boolean; boardStage: "inbox" | "ready" };

function TaskCreateDialog({ missionTitle, agents, creating, error, onClose, onCreate }: { missionTitle: string; agents: AgentOption[]; creating: boolean; error?: string; onClose: () => void; onCreate: (input: NewTaskInput) => void }) {
  const closeRef = useDialogFocus(onClose);
  const [title, setTitle] = useState(""); const [instructions, setInstructions] = useState(""); const [definitionOfDone, setDefinitionOfDone] = useState("");
  const [priority, setPriority] = useState<MissionSummaryView["priority"]>("normal"); const [assigneeId, setAssigneeId] = useState(""); const [reviewRequired, setReviewRequired] = useState(true); const [boardStage, setBoardStage] = useState<"inbox" | "ready">("inbox");
  return <div className={styles.dialogBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className={clsx(styles.dialog, styles.taskCreateDialog)} role="dialog" aria-modal="true" aria-labelledby="new-task-title" onSubmit={(event) => { event.preventDefault(); void onCreate({ title: title.trim(), instructions: instructions.trim(), definitionOfDone: definitionOfDone.trim(), priority, assigneeId, reviewRequired, boardStage }); }}>
    <header><div><p>{missionTitle}</p><h2 id="new-task-title">New task</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
    <label>Task title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} placeholder="What needs to happen?" autoFocus /></label>
    <label>Working instructions<textarea value={instructions} onChange={(event) => setInstructions(event.currentTarget.value)} maxLength={8000} rows={4} placeholder="Useful context, constraints, and boundaries." /></label>
    <label>Definition of done<textarea value={definitionOfDone} onChange={(event) => setDefinitionOfDone(event.currentTarget.value)} maxLength={2000} rows={3} placeholder="The observable outcome and required evidence." /></label>
    <div className={styles.formGrid}><label>Start in<select value={boardStage} onChange={(event) => setBoardStage(event.currentTarget.value as "inbox" | "ready")}><option value="inbox">Inbox — shape first</option><option value="ready">Ready — clear to start</option></select></label><label>Priority<select value={priority} onChange={(event) => setPriority(event.currentTarget.value as MissionSummaryView["priority"])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Assignee<select value={assigneeId} onChange={(event) => setAssigneeId(event.currentTarget.value)}><option value="">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` · ${agent.role}` : ""}</option>)}</select></label></div>
    <label className={styles.checkLabel}><input type="checkbox" checked={reviewRequired} onChange={(event) => setReviewRequired(event.currentTarget.checked)} /><span><strong>Require review</strong><small>Move to Review before this task can be accepted.</small></span></label>
    {error ? <p className={styles.dialogError} role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={creating || !title.trim() || !definitionOfDone.trim()}>{creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add task</button></footer>
  </form></div>;
}

type ReviewAction = "request_review" | "approve" | "request_changes";

function TaskDrawer({ task, allTasks, detail, agents, agentNames, asOf, busy, error, onClose, onSave, onAction, onReview, onComment }: {
  task: BoardTask; allTasks: BoardTask[]; detail: BoardMissionDetail; agents: AgentOption[]; agentNames: Map<string, string>; asOf: number; busy: boolean; error?: string; onClose: () => void; onSave: (input: Record<string, unknown>) => void; onAction: (action: TaskAction) => void; onReview: (action: ReviewAction, note: string) => void; onComment: (body: string) => Promise<boolean>;
}) {
  const closeRef = useDialogFocus(onClose);
  const [title, setTitle] = useState(task.title); const [instructions, setInstructions] = useState(task.instructions); const [definitionOfDone, setDefinitionOfDone] = useState(task.definitionOfDone); const [priority, setPriority] = useState(task.priority);
  const [assigneeId, setAssigneeId] = useState(taskAssigneeId(task) === "unassigned" ? "" : taskAssigneeId(task)); const [reviewRequired, setReviewRequired] = useState(taskReviewRequired(task)); const [blockerReason, setBlockerReason] = useState(taskBlockerReason(task)); const [dependencyIds, setDependencyIds] = useState(task.dependencyIds); const [comment, setComment] = useState(""); const [reviewNote, setReviewNote] = useState("");
  const column = boardColumnForTask(task, allTasks); const attempts = attemptsForTask(detail, task.id); const comments = commentsForTask(detail, task); const artifacts = artifactsForTask(detail, task.id).filter((artifact) => !isCommentArtifact(artifact));
  function save(event: React.FormEvent) { event.preventDefault(); onSave({ title: title.trim(), instructions: instructions.trim(), definitionOfDone: definitionOfDone.trim(), priority, assigneeId: assigneeId || null, reviewRequired, blocker: blockerReason.trim() ? { kind: "needs_input", reason: blockerReason.trim() } : null, dependencyIds }); }
  function toggleDependency(id: string) { setDependencyIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }
  return <div className={styles.drawerBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="task-drawer-title">
    <header className={styles.drawerHeader}><div><p>Task details</p><h2 id="task-drawer-title">{task.title}</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close task details"><X size={17} /></button></header>
    <div className={styles.drawerStatus}><span><i className={columnToneClass(column)} aria-hidden="true" />{boardColumnLabel(column)}</span><span>{taskAssigneeLabel(task, agentNames)}</span><span>Updated {relativeTime(task.updatedAt, asOf)}</span></div>
    {error ? <div className={styles.drawerError} role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{error}</span></div> : null}
    <form className={styles.taskForm} onSubmit={save}>
      <label>Title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} /></label>
      <label>Working instructions<textarea value={instructions} onChange={(event) => setInstructions(event.currentTarget.value)} rows={5} maxLength={8000} /></label>
      <label>Definition of done<textarea value={definitionOfDone} onChange={(event) => setDefinitionOfDone(event.currentTarget.value)} rows={4} maxLength={2000} /></label>
      <div className={styles.formGrid}><label>Priority<select value={priority} onChange={(event) => setPriority(event.currentTarget.value as BoardTask["priority"])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Assignee<select value={assigneeId} onChange={(event) => setAssigneeId(event.currentTarget.value)}><option value="">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label></div>
      <label className={styles.checkLabel}><input type="checkbox" checked={reviewRequired} onChange={(event) => setReviewRequired(event.currentTarget.checked)} /><span><strong>Review required</strong><small>Require evidence acceptance before completion.</small></span></label>
      <label>Blocker or requested input<textarea value={blockerReason} onChange={(event) => setBlockerReason(event.currentTarget.value)} rows={2} maxLength={2000} placeholder="Describe exactly what is needed to continue." /></label>
      <details className={styles.drawerDisclosure} open><summary><span><GitBranch size={14} aria-hidden="true" /> Dependencies</span><b>{dependencyIds.length}</b></summary><div className={styles.dependencyEditor}>{allTasks.filter((candidate) => candidate.id !== task.id).length ? allTasks.filter((candidate) => candidate.id !== task.id).map((candidate) => <label key={candidate.id}><input type="checkbox" checked={dependencyIds.includes(candidate.id)} onChange={() => toggleDependency(candidate.id)} /><span><strong>{candidate.title}</strong><small>{boardColumnLabel(boardColumnForTask(candidate, allTasks))}</small></span></label>) : <p>No other tasks can be linked yet.</p>}</div></details>
      <button className={styles.saveTask} type="submit" disabled={busy || !title.trim()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save changes</button>
    </form>
    <section className={styles.taskActions} aria-labelledby="task-actions-title"><header><div><p>State controls</p><h3 id="task-actions-title">Move work forward</h3></div>{busy ? <Loader2 size={15} className="animate-spin" aria-label="Saving" /> : null}</header>{column === "review" ? <label className={styles.reviewNote}>Review note<textarea value={reviewNote} onChange={(event) => setReviewNote(event.currentTarget.value)} rows={2} maxLength={4000} placeholder="Add acceptance notes or explain the requested changes." /></label> : null}<div>{taskActionsFor(column, task).map((action) => action.kind === "review" ? <button key={action.action} type="button" disabled={busy || (action.action === "request_changes" && !reviewNote.trim())} className={action.tone === "primary" ? styles.actionPrimary : action.tone === "danger" ? styles.actionDanger : undefined} onClick={() => onReview(action.action as ReviewAction, reviewNote)}>{actionIcon(action.action)} {action.label}</button> : <button key={action.action} type="button" disabled={busy} className={action.tone === "primary" ? styles.actionPrimary : action.tone === "danger" ? styles.actionDanger : undefined} onClick={() => onAction(action.action as TaskAction)}>{actionIcon(action.action)} {action.label}</button>)}</div></section>
    <section className={styles.drawerSection} aria-labelledby="comments-title"><header><div><p>Collaboration</p><h3 id="comments-title">Comments</h3></div><span>{comments.length}</span></header><div className={styles.commentList}>{comments.length ? comments.map((item) => <article key={item.id}><span>{initials(item.authorName || "You")}</span><div><strong>{item.authorName || "You"}<small>{relativeTime(item.createdAt, asOf)}</small></strong><p>{item.body}</p></div></article>) : <p>No comments yet. Add context without interrupting the task history.</p>}</div><form className={styles.commentForm} onSubmit={(event) => { event.preventDefault(); if (!comment.trim()) return; void onComment(comment).then((saved) => { if (saved) setComment(""); }); }}><label className="sr-only" htmlFor={`comment-${task.id}`}>Add a comment</label><textarea id={`comment-${task.id}`} value={comment} onChange={(event) => setComment(event.currentTarget.value)} rows={2} placeholder="Add context or an instruction…" /><button type="submit" disabled={busy || !comment.trim()}><Send size={13} aria-hidden="true" /> Comment</button></form></section>
    <section className={styles.drawerSection} aria-labelledby="attempts-title"><header><div><p>Execution</p><h3 id="attempts-title">Attempt history</h3></div><span>{attempts.length}</span></header><div className={styles.timeline}>{attempts.length ? attempts.map((attempt) => <article key={attempt.id}><i className={statusToneClass(attempt.status)} aria-hidden="true" /><div><strong>{attempt.executorType.replaceAll("_", " ")}</strong><p>{attemptStatusCopy(attempt.status)}</p><small>{relativeTime(attempt.updatedAt, asOf)}</small></div></article>) : <p>No agent attempt has been attached to this task.</p>}</div></section>
    <section className={styles.drawerSection} aria-labelledby="evidence-title"><header><div><p>Proof</p><h3 id="evidence-title">Evidence & handoffs</h3></div><span>{artifacts.length}</span></header><div className={styles.evidenceList}>{artifacts.length ? artifacts.map((artifact) => <article key={artifact.id}><span>{isHandoffArtifact(artifact) ? <CheckCircle2 size={15} /> : <FileText size={15} />}</span><div><strong>{artifact.title}</strong><p>{artifactPreview(artifact) || `${artifact.kind.replaceAll("_", " ")} recorded for this task.`}</p><small>{relativeTime(artifact.createdAt, asOf)}</small></div></article>) : <p>Receipts, files, and structured handoffs will appear here.</p>}</div></section>
  </aside></div>;
}

type TaskAction = "promote" | "start" | "block" | "unblock" | "complete" | "cancel";

function taskActionsFor(column: BoardColumnId, task: BoardTask) {
  if (column === "inbox") return [{ kind: "task", action: "promote", label: "Move to Ready", tone: "primary" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "waiting") return [{ kind: "task", action: "block", label: "Mark blocked", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "ready") return [{ kind: "task", action: "start", label: "Mark in progress", tone: "primary" }, { kind: "task", action: "block", label: "Block", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "working") return [...(taskReviewRequired(task) ? [{ kind: "review", action: "request_review", label: "Request review", tone: "primary" }] : [{ kind: "task", action: "complete", label: "Complete", tone: "primary" }]), { kind: "task", action: "block", label: "Block", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "needs-you") return [{ kind: "task", action: "unblock", label: "Unblock", tone: "primary" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  if (column === "review") return [{ kind: "review", action: "approve", label: "Approve", tone: "primary" }, { kind: "review", action: "request_changes", label: "Request changes", tone: "default" }, { kind: "task", action: "cancel", label: "Cancel", tone: "danger" }];
  return [];
}

function taskActionPatch(action: TaskAction, task: BoardTask): Record<string, unknown> {
  if (action === "promote" || action === "unblock") return { status: "pending", blocker: null };
  if (action === "start") return { status: "running" };
  if (action === "complete") return { status: "succeeded" };
  if (action === "cancel") return { status: "canceled" };
  return {
    status: "blocked",
    blocker: {
      kind: "needs_input",
      reason: taskBlockerReason(task) || "Human input is required before this task can continue.",
    },
  };
}

function actionIcon(action: string) {
  if (["promote", "start", "unblock"].includes(action)) return <Play size={13} aria-hidden="true" />;
  if (["complete", "approve"].includes(action)) return <Check size={13} aria-hidden="true" />;
  if (action === "request_review") return <ShieldCheck size={13} aria-hidden="true" />;
  if (action === "request_changes") return <RefreshCw size={13} aria-hidden="true" />;
  if (action === "block") return <CircleAlert size={13} aria-hidden="true" />;
  return <X size={13} aria-hidden="true" />;
}

function useDialogFocus(onClose: () => void) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [onClose]);
  return closeRef;
}

function MissionListSkeleton() { return <div className={styles.listSkeleton} aria-hidden="true">{[0, 1, 2, 3].map((item) => <i key={item} />)}</div>; }
function CanvasSkeleton() { return <div className={styles.canvasSkeleton} aria-hidden="true"><i /><i /><i /><i /></div>; }

function missionIdFromPath(pathname: string) { const match = pathname.match(/^\/app\/missions\/([^/]+)\/?$/); if (!match) return ""; try { return decodeURIComponent(match[1]); } catch { return ""; } }
function pushMissionHistory(id: string) { const nextPath = `/app/missions/${encodeURIComponent(id)}`; if (window.location.pathname !== nextPath) window.history.pushState(null, "", nextPath); }
function missionStatusLabel(status: MissionStatus) { return ({ draft: "Draft", queued: "Queued", running: "Running", waiting: "Needs attention", succeeded: "Completed", failed: "Failed", canceled: "Canceled", archived: "Archived" })[status]; }
function statusToneClass(status: string) { if (["running", "succeeded", "completed", "approved"].includes(status)) return styles.toneGood; if (["waiting", "blocked", "queued", "review"].includes(status)) return styles.toneAttention; if (["failed", "canceled"].includes(status)) return styles.toneDanger; return styles.toneNeutral; }
function columnToneClass(column: BoardColumnId) { if (["working", "done"].includes(column)) return styles.toneGood; if (["waiting", "needs-you", "review"].includes(column)) return styles.toneAttention; if (column === "ready") return styles.toneReady; return styles.toneNeutral; }
function priorityClass(priority: string) { if (priority === "urgent") return styles.priorityUrgent; if (priority === "high") return styles.priorityHigh; if (priority === "low") return styles.priorityLow; return styles.priorityNormal; }
function cueClass(column: BoardColumnId) { if (["needs-you", "review", "waiting"].includes(column)) return styles.cueAttention; if (column === "done") return styles.cueDone; return styles.cueNeutral; }
function boardColumnLabel(column: BoardColumnId) { return BOARD_COLUMNS.find((item) => item.id === column)?.title || "Inbox"; }

function boardColumnForTask(task: BoardTask, allTasks: BoardTask[]): BoardColumnId {
  const meta = taskMeta(task);
  const explicit = stringValue(meta.boardStage, meta.column, meta.stage)?.toLowerCase().replaceAll("_", "-");
  if (explicit && BOARD_COLUMNS.some((column) => column.id === explicit)) return explicit as BoardColumnId;
  if (["review", "in-review", "review-requested"].includes(explicit || "")) return "review";
  const reviewStatus = stringValue(meta.reviewStatus, meta.reviewState)?.toLowerCase();
  if (["requested", "pending", "in_review", "in-review"].includes(reviewStatus || "")) return "review";
  if (["succeeded", "failed", "canceled", "completed"].includes(task.status)) return "done";
  if (task.status === "review") return "review";
  if (task.status === "blocked") return "needs-you";
  if (task.status === "running") return "working";
  if (task.status === "triage" || explicit === "inbox" || boolValue(meta.triage, meta.needsTriage)) return "inbox";
  const progress = dependencyProgress(task, allTasks);
  if (isFutureTask(task) || progress.done < progress.total) return "waiting";
  return "ready";
}

function taskCue(task: BoardTask, column: BoardColumnId) { const changesRequested = stringValue(taskMeta(task).changesRequestedReason); if (column === "needs-you") return taskBlockerReason(task) || "Input required"; if (column === "review") return "Review requested"; if (changesRequested && !["review", "done"].includes(column)) return "Changes requested"; if (column === "waiting" && isFutureTask(task)) return "Scheduled"; if (column === "waiting") return "Waiting on dependencies"; if (column === "done" && task.status !== "succeeded") return task.status === "failed" ? "Failed" : "Canceled"; return ""; }
function taskMeta(task: BoardTask) { const direct = record(task.metadata); const input = record((task as unknown as Record<string, unknown>).input); const board = record(direct.board); return { ...input, ...direct, ...board }; }
function taskAssigneeId(task: BoardTask) { const meta = taskMeta(task); const direct = task as unknown as Record<string, unknown>; const assignee = record(meta.assignee); return stringValue(task.assigneeId, direct.assigneeId, meta.assigneeId, meta.assigneeKey, meta.agentId, assignee.id) || "unassigned"; }
function taskAssigneeLabel(task: BoardTask, agents: Map<string, string>) { const meta = taskMeta(task); const assignee = record(meta.assignee); const id = taskAssigneeId(task); return task.assigneeName || stringValue(meta.assigneeName, meta.agentName, assignee.name) || agents.get(id) || "Unassigned"; }
function taskReviewRequired(task: BoardTask) { const meta = taskMeta(task); return boolValue(task.reviewRequired, meta.reviewRequired, meta.requiresReview) ?? false; }
function taskBlockerReason(task: BoardTask) { const meta = taskMeta(task); const blocker = record(meta.blocker); return task.blockerReason || stringValue(meta.blockerReason, meta.blockReason, meta.requestedInput, blocker.reason) || ""; }
function taskRetryCount(task: BoardTask, attemptCount: number) { const meta = taskMeta(task); return numberValue(task.retryCount, meta.retryCount, meta.retries) ?? Math.max(0, attemptCount - 1); }
function taskScheduledFor(task: BoardTask) { const meta = taskMeta(task); return task.scheduledFor || stringValue(meta.scheduledFor, meta.scheduledAt, meta.runAt, meta.scheduleAt); }
function isFutureTask(task: BoardTask) { const scheduledFor = taskScheduledFor(task); if (!scheduledFor) return false; const timestamp = Date.parse(scheduledFor); return Number.isFinite(timestamp) && timestamp > Date.now(); }
function dependencyProgress(task: BoardTask, tasks: BoardTask[]) { const dependencies = task.dependencyIds || []; const done = dependencies.filter((id) => tasks.find((candidate) => candidate.id === id)?.status === "succeeded").length; return { done, total: dependencies.length }; }
function attemptsForTask(detail: BoardMissionDetail | undefined, taskId: string) { return (detail?.attempts || []).filter((attempt) => attempt.taskId === taskId).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)); }
function artifactsForTask(detail: BoardMissionDetail | undefined, taskId: string) { return (detail?.artifacts || []).filter((artifact) => artifact.taskId === taskId).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)); }

function commentsForTask(detail: BoardMissionDetail | undefined, task: BoardTask): BoardComment[] {
  const taskComments = Array.isArray(task.comments) ? task.comments : [];
  const rootComments = Array.isArray(detail?.comments) ? detail.comments.filter((comment) => comment.taskId === task.id) : [];
  const artifactComments = artifactsForTask(detail, task.id).filter(isCommentArtifact).map((artifact) => ({ id: artifact.id, body: artifactPreview(artifact) || artifact.title, authorName: stringValue(record(artifact.metadata).authorName, record(artifact.data).authorName), createdAt: artifact.createdAt }));
  return [...taskComments, ...rootComments, ...artifactComments].filter((comment, index, items) => items.findIndex((item) => item.id === comment.id) === index).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function isCommentArtifact(artifact: BoardArtifact) { return artifact.kind.toLowerCase().includes("comment"); }
function isHandoffArtifact(artifact: BoardArtifact) { return artifact.kind.toLowerCase().includes("handoff"); }
function artifactPreview(artifact: BoardArtifact) { const metadata = record(artifact.metadata); const data = record(artifact.data); return artifact.preview || stringValue(metadata.preview, metadata.summary, metadata.body, data.preview, data.summary, data.body); }

function agentOptions(payload: Record<string, unknown>): AgentOption[] {
  const combined = [...(Array.isArray(payload.builtIns) ? payload.builtIns : []), ...(Array.isArray(payload.agents) ? payload.agents : [])];
  return combined.flatMap((value) => { const item = record(value); const id = stringValue(item.id, item.slug); const name = stringValue(item.name); return id && name ? [{ id, name, role: stringValue(item.role) }] : []; }).filter((agent, index, items) => items.findIndex((item) => item.id === agent.id) === index);
}

function buildTaskGraph(tasks: BoardTask[], allTasks: BoardTask[]) {
  const visibleIds = new Set(tasks.map((task) => task.id)); const byId = new Map(allTasks.map((task) => [task.id, task])); const depthMemo = new Map<string, number>();
  const depthFor = (task: BoardTask, visiting = new Set<string>()): number => {
    const cached = depthMemo.get(task.id); if (cached !== undefined) return cached; if (visiting.has(task.id)) return 0;
    const nextVisiting = new Set(visiting).add(task.id);
    const parents = [...(task.parentTaskId ? [task.parentTaskId] : []), ...(task.dependencyIds || [])].map((id) => byId.get(id)).filter((item): item is BoardTask => Boolean(item));
    const depth = parents.length ? Math.min(5, 1 + Math.max(...parents.map((parent) => depthFor(parent, nextVisiting)))) : 0; depthMemo.set(task.id, depth); return depth;
  };
  const levels = new Map<number, BoardTask[]>(); tasks.forEach((task) => { const depth = depthFor(task); levels.set(depth, [...(levels.get(depth) || []), task]); });
  const maxDepth = Math.max(...levels.keys(), 0); const maxRows = Math.max(...[...levels.values()].map((items) => items.length), 1); const width = Math.max(760, 80 + (maxDepth + 1) * 292); const height = Math.max(420, 90 + maxRows * 126);
  const nodes = [...levels.entries()].flatMap(([depth, levelTasks]) => levelTasks.map((task, row) => ({ task, x: 42 + depth * 292, y: 68 + row * 126 }))); const nodeById = new Map(nodes.map((node) => [node.task.id, node])); const edgeKeys = new Set<string>();
  const edges = tasks.flatMap((task) => { const target = nodeById.get(task.id); if (!target) return []; const sources = [...(task.parentTaskId ? [task.parentTaskId] : []), ...(task.dependencyIds || [])]; return sources.flatMap((sourceId) => { if (!visibleIds.has(sourceId)) return []; const source = nodeById.get(sourceId); const key = `${sourceId}-${task.id}`; if (!source || edgeKeys.has(key)) return []; edgeKeys.add(key); const x1 = source.x + 218; const y1 = source.y + 40; const x2 = target.x - 9; const y2 = target.y + 40; const bend = Math.max(24, (x2 - x1) / 2); return [{ from: sourceId, to: task.id, path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` }]; }); });
  return { width, height, nodes, edges };
}

function initials(value: string) { const parts = value.trim().split(/\s+/).filter(Boolean); return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "—").toUpperCase(); }
function talkHref(mission: MissionSummaryView) { const prompt = "Continue this mission. Review its durable task board, advance only ready work within governed authority, preserve evidence, and surface blockers."; return `/app/command?mission=${encodeURIComponent(mission.id)}&prompt=${encodeURIComponent(prompt)}`; }
function relativeTime(value: string, asOf: number) { if (!asOf) return "recently"; const delta = asOf - Date.parse(value); if (!Number.isFinite(delta) || delta < 0) return "just now"; const minutes = Math.floor(delta / 60_000); if (minutes < 1) return "just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`; }
function attemptStatusCopy(status: string) { if (status === "running") return "Agent is actively working."; if (["waiting", "waiting_approval"].includes(status)) return "Paused for an external decision."; if (status === "succeeded") return "Attempt completed and returned evidence."; if (status === "failed") return "Attempt stopped before completion."; if (status === "canceled") return "Attempt was canceled."; return "Waiting for an available worker."; }
function taskActionLabel(action: TaskAction) { return ({ promote: "Task moved to Ready.", start: "Task started.", block: "Task marked as blocked.", unblock: "Task returned to Ready.", complete: "Task completed.", cancel: "Task canceled." })[action]; }
function reviewActionLabel(action: ReviewAction) { return ({ request_review: "Task sent for review.", approve: "Task review approved.", request_changes: "Task returned for changes." })[action]; }
function taskIdFromMutation(payload: Record<string, unknown>) { const task = record(payload.task); return stringValue(task.id, payload.id); }
function missionEventCursor(value: unknown, fallback: number) { return typeof value === "number" && Number.isSafeInteger(value) && value >= fallback ? value : fallback; }
function missionEventProjection(value: unknown) { if (!value || typeof value !== "object") return undefined; const candidate = value as { status?: unknown; updatedAt?: unknown }; const statuses: MissionStatus[] = ["draft", "queued", "running", "waiting", "succeeded", "failed", "canceled", "archived"]; if (typeof candidate.status !== "string" || !statuses.includes(candidate.status as MissionStatus) || typeof candidate.updatedAt !== "string") return undefined; return { status: candidate.status as MissionStatus, updatedAt: candidate.updatedAt }; }
function missionEventPollDelay(consecutiveFailures: number) { const failureCount = Math.min(Math.max(consecutiveFailures, 0), 4); return Math.min(2_500 * (2 ** failureCount), 30_000); }

class ApiRequestError extends Error { constructor(readonly status: number) { super("Request failed"); } }
async function readJson(path: string, init?: RequestInit) { const response = await fetch(path, { cache: "no-store", ...init }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new ApiRequestError(response.status); return payload as Record<string, unknown>; }
function friendlyMessage(error: unknown, operation: "load" | "create" | "update") { if (error instanceof ApiRequestError) { if (error.status === 401) return "Your session has ended. Sign in and try again."; if (error.status === 403) return "You do not have permission to make this change."; if (error.status === 404) return "This mission or task is no longer available."; if (error.status === 409) return "The task changed elsewhere. Refresh it before trying again."; if (error.status === 429) return "The workspace is busy. Wait a moment and try again."; if (error.status >= 500) return "The mission service is temporarily unavailable. Your existing board is still safe."; } if (operation === "load") return "Missions could not be loaded. Check your connection and try again."; if (operation === "create") return "That item could not be created. Review the details and try again."; return "That change could not be saved. Refresh the task and try again."; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(...values: unknown[]) { return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim(); }
function boolValue(...values: unknown[]) { return values.find((value): value is boolean => typeof value === "boolean"); }
function numberValue(...values: unknown[]) { return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)); }
