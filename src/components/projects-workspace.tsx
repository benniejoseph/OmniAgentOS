"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  AlertTriangle,
  ArrowRight,
  Bot,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  FileCheck2,
  FolderKanban,
  Gauge,
  GitBranch,
  History,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCw,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Target,
  Zap,
} from "lucide-react";
import { clsx } from "clsx";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { useWorkspaceSession } from "@/components/app-shell/session-context";

type AgentId = "atlas" | "scout" | "forge" | "sentinel" | "mnemosyne";
type ProjectStatus = "draft" | "active" | "completed" | "archived";
type ProjectTask = {
  id: string;
  title: string;
  detail: string;
  status: "open" | "doing" | "done";
  priority: "low" | "medium" | "high";
  agentId: AgentId;
  origin: "manual" | "agent";
  position: number;
  dueAt?: string;
  dependsOn: string[];
  workflowRunId?: string;
  workflowStatus?: "dispatching" | "queued" | "running" | "waiting_approval" | "paused" | "completed" | "failed" | "canceled";
  executionError?: string;
  dispatchAttempt: number;
};
type ProjectArtifact = {
  id: string;
  taskId: string;
  workflowRunId: string;
  agentId: AgentId;
  status: "verified" | "failed";
  title: string;
  content: string;
  memoryId?: string;
  sourceMemoryId?: string;
  verdict?: "useful" | "needs_work";
  lesson?: string;
  reflectionMemoryId?: string;
  reviewedAt?: string;
  evidenceRefs: string[];
  createdAt: string;
};
type Project = {
  id: string;
  title: string;
  objective: string;
  status: ProjectStatus;
  autonomyMode: "manual" | "supervised" | "autonomous";
  executionStatus: "idle" | "running" | "paused" | "waiting_approval" | "completed" | "failed";
  taskBudget: number;
  tasksDispatched: number;
  maxParallelTasks: number;
  requireApproval: boolean;
  targetDate?: string;
  updatedAt: string;
  tasks: ProjectTask[];
  artifacts: ProjectArtifact[];
};

export function ProjectsWorkspace() {
  const { session, status: sessionStatus } = useWorkspaceSession();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [actingId, setActingId] = useState("");
  const [executionBusy, setExecutionBusy] = useState("");
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [reflectionDraft, setReflectionDraft] = useState<{ artifactId: string; verdict?: ProjectArtifact["verdict"]; lesson: string }>();
  const [reflectionState, setReflectionState] = useState<{ artifactId: string; status: "idle" | "submitting" | "saved" | "error" }>();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [planRationale, setPlanRationale] = useState("");
  const [executionDraft, setExecutionDraft] = useState<{
    projectId: string;
    autonomyMode: Project["autonomyMode"];
    taskBudget: number;
    maxParallelTasks: number;
    requireApproval: boolean;
  }>();
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Projects are ready.");
  const controllerRef = useRef<AbortController | null>(null);
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const selected = projects.find((project) => project.id === selectedId) || projects[0];
  const hasExecutionDraft = Boolean(executionDraft && selected && executionDraft.projectId === selected.id);
  const autonomyMode = hasExecutionDraft ? executionDraft!.autonomyMode : selected?.autonomyMode === "autonomous" ? "autonomous" : "supervised";
  const taskBudget = hasExecutionDraft ? executionDraft!.taskBudget : selected?.taskBudget || 12;
  const maxParallelTasks = hasExecutionDraft ? executionDraft!.maxParallelTasks : selected?.maxParallelTasks || 1;
  const requireApproval = hasExecutionDraft ? executionDraft!.requireApproval : selected?.requireApproval ?? true;
  const activeProjects = projects.filter((project) => project.status === "active");
  const allTasks = projects.flatMap((project) => project.tasks);
  const completedTasks = allTasks.filter((task) => task.status === "done").length;

  async function load() {
    if (!available || sessionStatus !== "ready") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const payload = await readJson("/api/projects", { signal: controller.signal });
      if (controller.signal.aborted) return;
      const next = payload.projects as Project[];
      setProjects(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id || "");
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); controllerRef.current?.abort(); };
    // Session identity controls the data boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, session]);

  useEffect(() => {
    if (!selected || !["running", "waiting_approval"].includes(selected.executionStatus)) return;
    const timer = window.setInterval(() => void executeProject("sync", undefined, true), 12_000);
    return () => window.clearInterval(timer);
    // Execution polling follows only the durable selected project state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.executionStatus]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) return;
    setCreating(true);
    try {
      const payload = await readJson("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(), objective: objective.trim(), status: "active",
          targetDate: targetDate ? new Date(`${targetDate}T23:59:00`).toISOString() : undefined,
        }),
      });
      const project = payload.project as Project;
      setProjects((current) => [project, ...current]);
      setSelectedId(project.id);
      setTitle(""); setObjective(""); setTargetDate(""); setShowCreate(false);
      setAnnouncement("Project created and activated.");
    } catch (createError) { setError(message(createError)); }
    finally { setCreating(false); }
  }

  async function generatePlan() {
    if (!selected) return;
    setPlanning(true); setPlanRationale("");
    try {
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/plan`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const plan = payload.plan as { rationale: string; tasks: ProjectTask[]; generatedBy: string };
      setProjects((current) => current.map((project) => project.id === selected.id
        ? { ...project, tasks: [...project.tasks, ...plan.tasks] }
        : project));
      setPlanRationale(plan.rationale);
      setAnnouncement(`${plan.tasks.length} project tasks added by Atlas.`);
    } catch (planError) { setError(message(planError)); }
    finally { setPlanning(false); }
  }

  async function addTask(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !taskTitle.trim()) return;
    setAddingTask(true);
    try {
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/tasks`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: taskTitle.trim(), agentId: "atlas" }),
      });
      const task = payload.task as ProjectTask;
      setProjects((current) => current.map((project) => project.id === selected.id ? { ...project, tasks: [...project.tasks, task] } : project));
      setTaskTitle(""); setAnnouncement("Task added to the project.");
    } catch (taskError) { setError(message(taskError)); }
    finally { setAddingTask(false); }
  }

  async function moveTask(task: ProjectTask) {
    if (!selected) return;
    const status = task.status === "open" ? "doing" : task.status === "doing" ? "done" : "open";
    setActingId(task.id);
    try {
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
      });
      const updated = payload.task as ProjectTask;
      setProjects((current) => current.map((project) => project.id === selected.id
        ? { ...project, tasks: project.tasks.map((item) => item.id === task.id ? updated : item) }
        : project));
      setAnnouncement(status === "done" ? "Task completed." : status === "doing" ? "Task is now in progress." : "Task reopened.");
    } catch (taskError) { setError(message(taskError)); }
    finally { setActingId(""); }
  }

  async function transitionProject(status: ProjectStatus) {
    if (!selected) return;
    setActingId(selected.id);
    try {
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
      });
      const updated = payload.project as Project;
      setProjects((current) => current.map((project) => project.id === selected.id ? { ...project, ...updated } : project));
      setAnnouncement(status === "completed" ? "Project completed." : status === "active" ? "Project activated." : "Project archived.");
    } catch (projectError) { setError(message(projectError)); }
    finally { setActingId(""); }
  }

  function updateExecutionDraft(patch: Partial<Omit<NonNullable<typeof executionDraft>, "projectId">>) {
    if (!selected) return;
    setExecutionDraft({ projectId: selected.id, autonomyMode, taskBudget, maxParallelTasks, requireApproval, ...patch });
  }

  async function executeProject(action: "configure" | "start" | "pause" | "resume" | "sync" | "approve" | "retry", taskId?: string, silent = false) {
    if (!selected || executionBusy) return;
    if (!silent) setExecutionBusy(taskId || action);
    try {
      const body = action === "configure" || action === "start"
        ? { action, autonomyMode, taskBudget, maxParallelTasks, requireApproval }
        : action === "approve" || action === "retry"
          ? { action, taskId }
          : { action };
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/execution`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const project = payload.project as Project | undefined;
      const tasks = payload.tasks as ProjectTask[] | undefined;
      const artifacts = payload.artifacts as ProjectArtifact[] | undefined;
      if (project) {
        setProjects((current) => current.map((item) => item.id === selected.id ? { ...item, ...project, tasks: tasks || item.tasks, artifacts: artifacts || item.artifacts } : item));
      }
      if (!silent) setAnnouncement(executionAnnouncement(action, payload.dispatchedTaskIds as string[] | undefined));
      setError(undefined);
    } catch (executionError) {
      if (!silent) setError(message(executionError));
    } finally {
      if (!silent) setExecutionBusy("");
    }
  }

  async function saveReflection() {
    if (!selected || !selectedArtifact) return;
    const verdict = reflectionDraft?.artifactId === selectedArtifact.id ? reflectionDraft.verdict : selectedArtifact.verdict;
    const lesson = reflectionDraft?.artifactId === selectedArtifact.id ? reflectionDraft.lesson : selectedArtifact.lesson || "";
    if (!verdict || lesson.trim().length < 3) return;
    setReflectionState({ artifactId: selectedArtifact.id, status: "submitting" });
    try {
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/artifacts/${encodeURIComponent(selectedArtifact.id)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict, lesson: lesson.trim() }),
      });
      const artifact = payload.artifact as ProjectArtifact;
      setProjects((current) => current.map((project) => project.id === selected.id
        ? { ...project, artifacts: project.artifacts.map((item) => item.id === artifact.id ? artifact : item) }
        : project));
      setReflectionDraft(undefined);
      setReflectionState({ artifactId: artifact.id, status: "saved" });
      setAnnouncement("Reflection saved. Future agent planning will use this lesson.");
    } catch (reflectionError) {
      setReflectionState({ artifactId: selectedArtifact.id, status: "error" });
      setError(message(reflectionError));
    }
  }

  const selectedDone = selected?.tasks.filter((task) => task.status === "done").length || 0;
  const selectedProgress = selected?.tasks.length ? selectedDone / selected.tasks.length : 0;
  const selectedArtifact = selected?.artifacts?.find((artifact) => artifact.id === selectedArtifactId) || selected?.artifacts?.[0];
  const selectedReflectionDraft = reflectionDraft?.artifactId === selectedArtifact?.id ? reflectionDraft : undefined;
  const selectedVerdict = selectedReflectionDraft?.verdict || selectedArtifact?.verdict;
  const selectedLesson = selectedReflectionDraft?.lesson ?? selectedArtifact?.lesson ?? "";
  const selectedReflectionState = reflectionState && reflectionState.artifactId === selectedArtifact?.id ? reflectionState.status : "idle";

  return (
    <main className="projects-shell workspace-enter" aria-busy={loading}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className="projects-header">
        <div>
          <p className="projects-kicker">Personal operating system</p>
          <h1>Projects</h1>
          <p>Turn outcomes into durable plans your agents can advance with you.</p>
        </div>
        <button type="button" className="projects-create-button" onClick={() => setShowCreate((value) => !value)}><Plus size={15} aria-hidden="true" /> New project</button>
      </header>

      <div className="projects-stats" aria-label="Project overview">
        <div><strong>{activeProjects.length}</strong><span>active projects</span></div>
        <div><strong>{allTasks.length}</strong><span>planned tasks</span></div>
        <div><strong>{allTasks.length ? `${Math.round(completedTasks / allTasks.length * 100)}%` : "—"}</strong><span>overall progress</span></div>
      </div>

      {showCreate ? <form className="projects-create-form" onSubmit={create}>
        <div><label htmlFor="project-title">Project name</label><input id="project-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Launch the personal research system" maxLength={180} autoFocus /></div>
        <div className="project-objective-field"><label htmlFor="project-objective">Successful outcome</label><textarea id="project-objective" value={objective} onChange={(event) => setObjective(event.currentTarget.value)} placeholder="Describe what will be observably true when this project succeeds." maxLength={2000} rows={2} /></div>
        <div><label htmlFor="project-target">Target date</label><input id="project-target" type="date" value={targetDate} onChange={(event) => setTargetDate(event.currentTarget.value)} /></div>
        <button type="submit" disabled={creating || !title.trim() || !objective.trim()}>{creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />} Create</button>
      </form> : null}

      {error ? <div className="projects-error" role="alert"><span>{error}</span><button type="button" onClick={() => { setError(undefined); void load(); }}>Retry</button></div> : null}

      <div className="projects-workspace">
        <aside className="projects-rail" aria-label="Project list">
          <div className="projects-rail-heading"><span>Portfolio</span><strong>{projects.length}</strong></div>
          {projects.length ? projects.map((project) => {
            const done = project.tasks.filter((task) => task.status === "done").length;
            const progress = project.tasks.length ? done / project.tasks.length : 0;
            return <button key={project.id} type="button" onClick={() => { setSelectedId(project.id); setPlanRationale(""); }} className={clsx("projects-rail-item", selected?.id === project.id && "is-selected")}>
              <span className={clsx("projects-status-mark", `is-${project.status}`)} />
              <span><strong>{project.title}</strong><small>{project.status} · {done}/{project.tasks.length} tasks</small><i><b style={{ width: `${progress * 100}%` }} /></i></span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>;
          }) : <div className="projects-rail-empty"><FolderKanban size={20} aria-hidden="true" /><p>Your project portfolio is empty.</p></div>}
        </aside>

        <section className="project-canvas" aria-live="polite">
          {selected ? <>
            <div className="project-canvas-head">
              <div className="project-title-block">
                <div><span className={clsx("project-status", `is-${selected.status}`)}>{selected.status}</span>{selected.targetDate ? <span className="project-target"><CalendarDays size={12} aria-hidden="true" /> {formatDate(selected.targetDate)}</span> : null}</div>
                <h2>{selected.title}</h2>
                <p>{selected.objective}</p>
              </div>
              <div className="project-progress-orbit" aria-label={`${selectedDone} of ${selected.tasks.length} tasks completed`} style={{ "--project-progress": `${selectedProgress * 360}deg` } as React.CSSProperties}><div><strong>{selected.tasks.length ? `${Math.round(selectedProgress * 100)}%` : "—"}</strong><span>complete</span></div></div>
            </div>

            <div className="project-toolbar">
              {selected.status === "active" ? <button type="button" className="project-plan-button" onClick={() => void generatePlan()} disabled={planning}><Sparkles size={14} aria-hidden="true" />{planning ? "Atlas is planning…" : selected.tasks.length ? "Extend plan" : "Plan with Atlas"}</button> : null}
              {selected.status === "active" ? <button type="button" onClick={() => void transitionProject("completed")} disabled={actingId === selected.id || (selected.tasks.length > 0 && selectedDone !== selected.tasks.length)} title={selected.tasks.length > 0 && selectedDone !== selected.tasks.length ? "Complete every task first" : undefined}><Check size={14} aria-hidden="true" /> Complete project</button> : <button type="button" onClick={() => void transitionProject("active")} disabled={actingId === selected.id}><Play size={14} aria-hidden="true" /> Reopen project</button>}
              {selected.status !== "archived" ? <button type="button" onClick={() => void transitionProject("archived")} disabled={actingId === selected.id}><Archive size={14} aria-hidden="true" /> Archive</button> : null}
            </div>

            <section className={clsx("project-execution-deck", `is-${selected.executionStatus}`)} aria-label="Autonomous project execution">
              <div className="project-execution-intro">
                <span className="project-execution-icon"><Bot size={18} aria-hidden="true" /></span>
                <div><p className="projects-kicker">Agent execution</p><h3>{executionTitle(selected.executionStatus)}</h3><p>{executionDescription(selected.executionStatus, autonomyMode)}</p></div>
              </div>
              <div className="project-execution-metrics">
                <div><span><Gauge size={13} aria-hidden="true" /> Budget</span><strong>{selected.tasksDispatched || 0}<small> / {taskBudget}</small></strong><i><b style={{ width: `${Math.min(100, ((selected.tasksDispatched || 0) / taskBudget) * 100)}%` }} /></i></div>
                <div><span><GitBranch size={13} aria-hidden="true" /> Parallel</span><strong>{maxParallelTasks}</strong><small>agent lane{maxParallelTasks > 1 ? "s" : ""}</small></div>
                <div><span><ShieldCheck size={13} aria-hidden="true" /> Guardrail</span><strong>{autonomyMode === "supervised" || requireApproval ? "Approval" : "Policy"}</strong><small>{autonomyMode === "autonomous" && !requireApproval ? "risky tools still gated" : "before each workflow"}</small></div>
              </div>
              <div className="project-execution-controls">
                <label><span>Operating mode</span><select value={autonomyMode} onChange={(event) => { const mode = event.currentTarget.value as Project["autonomyMode"]; updateExecutionDraft({ autonomyMode: mode, requireApproval: mode === "supervised" ? true : requireApproval }); }} disabled={["running", "waiting_approval"].includes(selected.executionStatus)}><option value="supervised">Supervised</option><option value="autonomous">Autonomous</option></select></label>
                <label><span>Task budget</span><input type="number" min={1} max={50} value={taskBudget} onChange={(event) => updateExecutionDraft({ taskBudget: Math.min(50, Math.max(1, Number(event.currentTarget.value))) })} disabled={["running", "waiting_approval"].includes(selected.executionStatus)} /></label>
                <label><span>Parallel agents</span><select value={maxParallelTasks} onChange={(event) => updateExecutionDraft({ maxParallelTasks: Number(event.currentTarget.value) })} disabled={["running", "waiting_approval"].includes(selected.executionStatus)}><option value={1}>1 lane</option><option value={2}>2 lanes</option><option value={3}>3 lanes</option></select></label>
                <label className="project-approval-switch"><input type="checkbox" checked={requireApproval} onChange={(event) => updateExecutionDraft({ requireApproval: event.currentTarget.checked })} disabled={autonomyMode === "supervised" || ["running", "waiting_approval"].includes(selected.executionStatus)} /><span>Approval gate</span></label>
                <div className="project-execution-actions">
                  {selected.executionStatus === "running" || selected.executionStatus === "waiting_approval" ? <button type="button" onClick={() => void executeProject("pause")} disabled={Boolean(executionBusy)}><Pause size={14} aria-hidden="true" /> Pause</button> : selected.executionStatus === "paused" ? <button type="button" className="is-primary" onClick={() => void executeProject("resume")} disabled={Boolean(executionBusy)}><Play size={14} aria-hidden="true" /> Resume</button> : <button type="button" className="is-primary" onClick={() => void executeProject("start")} disabled={Boolean(executionBusy) || !selected.tasks.length}><Zap size={14} aria-hidden="true" /> Start agents</button>}
                  <button type="button" onClick={() => void executeProject("sync")} disabled={Boolean(executionBusy)} aria-label="Synchronize workflow progress"><RotateCw size={14} className={executionBusy === "sync" ? "animate-spin" : undefined} aria-hidden="true" /></button>
                </div>
              </div>
            </section>

            {planRationale ? <div className="project-plan-note"><Sparkles size={15} aria-hidden="true" /><div><strong>Atlas added a plan</strong><p>{planRationale}</p></div></div> : null}

            <div className="project-task-heading"><div><p className="projects-kicker">Execution plan</p><h3>Next moves</h3></div><span>{selected.tasks.filter((task) => task.status !== "done").length} remaining</span></div>
            <div className="project-task-list">
              {selected.tasks.length ? selected.tasks.map((task, index) => {
                const agent = agentFor(task.agentId);
                const dependencyNames = (task.dependsOn || []).map((id) => selected.tasks.find((item) => item.id === id)?.title).filter(Boolean);
                return <article key={task.id} className={clsx("project-task", `is-${task.status}`)} style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
                  <button type="button" className="project-task-state" onClick={() => void moveTask(task)} disabled={actingId === task.id || selected.status !== "active" || ["running", "waiting_approval"].includes(selected.executionStatus)} aria-label={`${task.status === "done" ? "Reopen" : task.status === "doing" ? "Complete" : "Start"} ${task.title}`}>
                    {task.status === "done" ? <Check size={14} aria-hidden="true" /> : task.status === "doing" ? <Pause size={13} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
                  </button>
                  <span className="project-task-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="project-task-copy"><div><strong>{task.title}</strong><span className={clsx("project-task-priority", `is-${task.priority}`)}>{task.priority}</span>{task.workflowStatus ? <span className={clsx("project-workflow-badge", `is-${task.workflowStatus}`)}>{workflowLabel(task.workflowStatus)}</span> : null}</div>{task.detail ? <p>{task.detail}</p> : null}<small>{task.status === "doing" ? "In progress" : task.status === "done" ? "Completed" : dependencyNames.length ? `After ${dependencyNames.join(", ")}` : "Ready"}{task.dueAt ? ` · due ${formatDate(task.dueAt)}` : ""}</small>{task.executionError ? <em className="project-task-error"><AlertTriangle size={11} aria-hidden="true" /> {task.executionError}</em> : null}</div>
                  <div className={clsx("project-agent", `agent-${agent.accent}`)}><span>{agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><small>{agent.role}</small></div></div>
                  {task.workflowStatus === "waiting_approval" ? <button type="button" className="project-task-action" onClick={() => void executeProject("approve", task.id)} disabled={Boolean(executionBusy)}>Approve</button> : task.workflowStatus === "failed" ? <button type="button" className="project-task-action is-danger" onClick={() => void executeProject("retry", task.id)} disabled={Boolean(executionBusy)}>Retry</button> : task.workflowRunId ? <span className="project-task-live"><i /> {workflowLabel(task.workflowStatus || "queued")}</span> : <Link href={commandHref(selected, task)} aria-label={`Assign ${task.title} to ${agent.name}`}>Run <ArrowRight size={13} aria-hidden="true" /></Link>}
                </article>;
              }) : <div className="project-task-empty"><Target size={22} aria-hidden="true" /><h3>No plan yet</h3><p>Let Atlas decompose the outcome or add the first task yourself.</p></div>}
            </div>

            {selected.status === "active" ? <form className="project-add-task" onSubmit={addTask}><Plus size={15} aria-hidden="true" /><label className="sr-only" htmlFor="project-task-title">Add project task</label><input id="project-task-title" value={taskTitle} onChange={(event) => setTaskTitle(event.currentTarget.value)} placeholder="Add a task to this plan…" maxLength={240} /><button type="submit" disabled={addingTask || !taskTitle.trim()}>{addingTask ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : "Add task"}</button></form> : null}

            <section className="project-artifact-ledger" aria-label="Project outputs and learning">
              <div className="project-artifact-heading"><div><p className="projects-kicker">Output ledger</p><h3>Verified work becomes memory</h3></div><span><History size={13} aria-hidden="true" /> {selected.artifacts?.length || 0} artifact{selected.artifacts?.length === 1 ? "" : "s"}</span></div>
              {selected.artifacts?.length ? <div className="project-artifact-layout">
                <div className="project-artifact-timeline" role="list" aria-label="Artifact timeline">{selected.artifacts.map((artifact, index) => {
                  const artifactAgent = agentFor(artifact.agentId);
                  return <button key={artifact.id} type="button" role="listitem" className={clsx(selectedArtifact?.id === artifact.id && "is-selected", `is-${artifact.status}`)} onClick={() => setSelectedArtifactId(artifact.id)} style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}><i /><span><strong>{artifact.title}</strong><small>{artifactAgent.name} · {formatTimestamp(artifact.createdAt)}</small></span><em>{artifact.status}</em></button>;
                })}</div>
                {selectedArtifact ? <article key={selectedArtifact.id} className="project-artifact-detail">
                  <div className="project-artifact-detail-head"><span className={clsx(`is-${selectedArtifact.status}`)}><FileCheck2 size={14} aria-hidden="true" /> {selectedArtifact.status}</span>{selectedArtifact.memoryId ? <Link href="/app/memory"><Brain size={13} aria-hidden="true" /> Learned</Link> : null}</div>
                  <h4>{selectedArtifact.title}</h4>
                  <pre>{selectedArtifact.content}</pre>
                  <div className="project-artifact-reflection">
                    <div><span>Your reflection</span><small>{selectedArtifact.reviewedAt ? `Last taught ${formatTimestamp(selectedArtifact.reviewedAt)}` : "Teach the arsenal what to repeat or change."}</small></div>
                    <div className="project-reflection-verdict" role="group" aria-label="Outcome rating"><button type="button" className={clsx(selectedVerdict === "useful" && "is-selected")} onClick={() => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: "useful", lesson: selectedLesson }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }}><ThumbsUp size={13} aria-hidden="true" /> Useful</button><button type="button" className={clsx(selectedVerdict === "needs_work" && "is-selected", "is-needs-work")} onClick={() => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: "needs_work", lesson: selectedLesson }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }}><ThumbsDown size={13} aria-hidden="true" /> Needs work</button></div>
                    <label><span className="sr-only">Lesson for future agent work</span><textarea value={selectedLesson} onChange={(event) => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: selectedVerdict, lesson: event.currentTarget.value }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }} placeholder="What should this agent repeat or change next time?" maxLength={1200} rows={2} /></label>
                    <button type="button" className="project-reflection-save" onClick={() => void saveReflection()} disabled={!selectedVerdict || selectedLesson.trim().length < 3 || selectedReflectionState === "submitting"}>{selectedReflectionState === "submitting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />} {selectedReflectionState === "saved" ? "Learned" : "Save lesson"}</button>
                  </div>
                  <footer><span>Provenance</span><div>{selectedArtifact.evidenceRefs.map((reference) => <code key={reference}>{reference}</code>)}</div></footer>
                </article> : null}
              </div> : <div className="project-artifact-empty"><FileCheck2 size={20} aria-hidden="true" /><div><strong>No verified outputs yet</strong><p>Completed agent workflows will appear here with their report, provenance, and linked project memory.</p></div></div>}
            </section>
          </> : <div className="project-canvas-empty"><FolderKanban size={30} aria-hidden="true" /><h2>Create your first project</h2><p>Give an outcome a durable home, then let your agent team turn it into executable work.</p><button type="button" onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> New project</button></div>}
        </section>
      </div>
    </main>
  );
}

function agentFor(id: AgentId) { return arsenalAgents.find((agent) => agent.id === id) || arsenalAgents[0]; }
function commandHref(project: Project, task: ProjectTask) { const prompt = `Project: ${project.title}\nObjective: ${project.objective}\nAssigned task: ${task.title}\n${task.detail}\nComplete this bounded task, verify the outcome, and report evidence plus the next recommended project state.`; return `/app/command?agent=${task.agentId}&prompt=${encodeURIComponent(prompt)}`; }
function executionTitle(status: Project["executionStatus"]) {
  return ({ idle: "Ready for deployment", running: "Agents are advancing this project", paused: "Execution is safely paused", waiting_approval: "Your approval is needed", completed: "Execution plan completed", failed: "An agent needs intervention" })[status];
}
function executionDescription(status: Project["executionStatus"], mode: Project["autonomyMode"]) {
  if (status === "waiting_approval") return "Review the highlighted workflow before the agent team continues.";
  if (status === "failed") return "Inspect the failed task, retry it, or take over in Command.";
  if (status === "completed") return "Every planned task has synchronized back into the project ledger.";
  if (status === "running") return `${mode === "autonomous" ? "Autonomous" : "Supervised"} execution respects dependencies, budget, and tool policies.`;
  return "Choose the operating envelope, then dispatch dependency-ready work into governed workflows.";
}
function workflowLabel(status: NonNullable<ProjectTask["workflowStatus"]>) { return status.replace("_", " "); }
function executionAnnouncement(action: string, dispatched?: string[]) {
  if (action === "start") return dispatched?.length ? `${dispatched.length} agent task${dispatched.length === 1 ? "" : "s"} dispatched.` : "Project execution started.";
  if (action === "pause") return "Project execution and active workflows paused.";
  if (action === "resume") return "Project execution resumed.";
  if (action === "approve") return "Workflow approved and resumed.";
  if (action === "retry") return "Failed workflow queued for retry.";
  return "Project execution synchronized.";
}
function formatDate(value: string) { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(value).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }); }
function formatTimestamp(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
async function readJson(path: string, init?: RequestInit) { const response = await fetch(path, { cache: "no-store", ...init }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(String(payload.message || payload.error || `${path} returned ${response.status}`)); return payload as Record<string, unknown>; }
function message(error: unknown) { return error instanceof Error ? error.message : "Projects could not be updated."; }
