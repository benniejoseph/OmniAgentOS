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
  CircleDollarSign,
  Code2,
  FileCheck2,
  FolderKanban,
  Gauge,
  GitBranch,
  History,
  LayoutTemplate,
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
import { WorkspaceLibrary } from "@/components/workspace-library";
import { ProjectSharedMemory } from "@/components/project-shared-memory";
import { AppBuilderStudio } from "@/components/app-builder-studio";
import {
  canonicalWorkItemCostLabel,
  canonicalWorkItemStatusLabel,
  parseCanonicalWorkItemSurface,
  type CanonicalWorkItemSurface,
} from "@/lib/workspaces/surface";
import styles from "./daybook-workspaces.module.css";

const PROJECT_LIBRARY_KINDS = [
  "generated_artifact",
  "document",
  "spreadsheet",
  "presentation",
  "file",
  "image",
  "audio",
  "video",
  "recording",
  "transcript",
  "email",
  "meeting",
] as const;

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
  workItemStatus: {
    authority: "canonical_work_item_v1";
    persistence: "postgres" | "local_projection";
    status: "preview" | "running" | "waiting" | "blocked" | "partial" | "unverified" | "failed" | "canceled" | "succeeded";
    sourceStatus: string;
    statusRevision: number;
  };
  workItem: CanonicalWorkItemSurface;
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
type WorkspaceTemplate = {
  schemaVersion: 1;
  templateId: string;
  templateVersionId: string;
  templateSha256: string;
  version: number;
  active: boolean;
  activeVersion: number;
  name: string;
  description: string;
  project: {
    title: string;
    objective: string;
    status: "draft" | "active";
    tasks: Array<{
      key: string;
      title: string;
      detail: string;
      priority: "low" | "medium" | "high";
      agentId: AgentId;
      dependsOnKeys: string[];
    }>;
  };
  playbook: null | {
    aliases: string[];
    mode: "orchestrate" | "research" | "execute" | "learn";
    toolBindings: Array<{ toolId: string; input: Record<string, unknown> }>;
    acceptanceCriteria: string[];
  };
};

export function ProjectsWorkspace({ initialView = "overview" }: { initialView?: "overview" | "execution" | "build" }) {
  const { session, status: sessionStatus } = useWorkspaceSession();
  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<WorkspaceTemplate[]>([]);
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
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateBusyId, setTemplateBusyId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
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
  const [workspaceView, setWorkspaceView] = useState<"overview" | "execution" | "build">(initialView);
  const controllerRef = useRef<AbortController | null>(null);
  const templateMutationKeysRef = useRef(new Map<string, string>());
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const selected = projects.find((project) => project.id === selectedId) || projects[0];
  const hasExecutionDraft = Boolean(executionDraft && selected && executionDraft.projectId === selected.id);
  const autonomyMode = hasExecutionDraft ? executionDraft!.autonomyMode : selected?.autonomyMode === "autonomous" ? "autonomous" : "supervised";
  const taskBudget = hasExecutionDraft ? executionDraft!.taskBudget : selected?.taskBudget || 12;
  const maxParallelTasks = hasExecutionDraft ? executionDraft!.maxParallelTasks : selected?.maxParallelTasks || 1;
  const requireApproval = hasExecutionDraft ? executionDraft!.requireApproval : selected?.requireApproval ?? true;
  const activeProjects = projects.filter((project) => project.status === "active");
  const allTasks = projects.flatMap((project) => project.tasks);
  const closedTasks = allTasks.filter(taskIsClosed).length;

  async function load() {
    if (!available || sessionStatus !== "ready") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const [payload, templatePayload] = await Promise.all([
        readJson("/api/projects", { signal: controller.signal }),
        readJson("/api/workspace-templates", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const next = normalizeProjects(payload.projects);
      if (!next) throw new Error("Projects returned an invalid canonical WorkItem projection.");
      setProjects(next);
      setTemplates(templatePayload.templates as WorkspaceTemplate[]);
      const requestedProjectId = new URL(window.location.href).searchParams.get("project") || "";
      const requestedArtifactId = new URL(window.location.href).searchParams.get("artifact") || "";
      setSelectedId((current) =>
        requestedProjectId && next.some((item) => item.id === requestedProjectId)
          ? requestedProjectId
          : current && next.some((item) => item.id === current)
            ? current
            : next[0]?.id || "",
      );
      if (requestedArtifactId && next.some((item) =>
        item.artifacts.some((artifact) => artifact.id === requestedArtifactId)
      )) setSelectedArtifactId(requestedArtifactId);
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

  async function publishSelectedProjectAsTemplate(
    existing?: WorkspaceTemplate,
  ) {
    if (!selected) return;
    const name = existing?.name || templateName.trim();
    if (!name) return;
    const actionId = existing?.templateId || "new-template";
    setTemplateBusyId(actionId);
    try {
      const key = templateMutationKey(
        templateMutationKeysRef.current,
        `publish:${actionId}`,
      );
      const payload = await readJson("/api/workspace-templates", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          templateId: existing?.templateId,
          name,
          description: existing?.description || templateDescription.trim(),
          project: projectTemplateBlueprint(selected),
          playbook: existing?.playbook || null,
        }),
      });
      const template = payload.template as WorkspaceTemplate;
      setTemplates((current) => [
        template,
        ...current.filter((item) => item.templateId !== template.templateId),
      ].sort((left, right) => left.name.localeCompare(right.name)));
      templateMutationKeysRef.current.delete(`publish:${actionId}`);
      if (!existing) {
        setTemplateName("");
        setTemplateDescription("");
      }
      setAnnouncement(existing
        ? `${template.name} version ${template.version} is active. Existing projects were not changed.`
        : `${template.name} was published as a reusable workspace template.`);
      setError(undefined);
    } catch (templateError) {
      setError(message(templateError));
    } finally {
      setTemplateBusyId("");
    }
  }

  async function instantiateTemplate(template: WorkspaceTemplate) {
    setTemplateBusyId(template.templateVersionId);
    try {
      const keyName = `instantiate:${template.templateVersionId}`;
      const key = templateMutationKey(templateMutationKeysRef.current, keyName);
      const payload = await readJson(
        `/api/workspace-templates/${encodeURIComponent(template.templateId)}/instantiate`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ templateVersionId: template.templateVersionId }),
        },
      );
      const project = payload.project as Project;
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setSelectedId(project.id);
      templateMutationKeysRef.current.delete(keyName);
      setAnnouncement(`${project.title} was created from ${template.name} version ${template.version}.`);
      setError(undefined);
    } catch (templateError) {
      setError(message(templateError));
    } finally {
      setTemplateBusyId("");
    }
  }

  async function generatePlan() {
    if (!selected) return;
    setPlanning(true); setPlanRationale("");
    try {
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/plan`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      });
      const rawPlan = payload.plan as { rationale?: unknown; tasks?: unknown; generatedBy?: unknown };
      const planTasks = normalizeProjectTasks(rawPlan.tasks, selected.id);
      if (!planTasks || typeof rawPlan.rationale !== "string") {
        throw new Error("The project plan returned invalid WorkItems.");
      }
      const plan = { ...rawPlan, rationale: rawPlan.rationale, tasks: planTasks };
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
      const task = normalizeProjectTask(payload.task, selected.id);
      if (!task) throw new Error("The project task returned an invalid canonical WorkItem.");
      setProjects((current) => current.map((project) => project.id === selected.id ? { ...project, tasks: [...project.tasks, task] } : project));
      setTaskTitle(""); setAnnouncement("Task added to the project.");
    } catch (taskError) { setError(message(taskError)); }
    finally { setAddingTask(false); }
  }

  async function moveTask(task: ProjectTask) {
    if (!selected) return;
    const status = nextProjectTaskStatus(task);
    setActingId(task.id);
    try {
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
      });
      const updated = normalizeProjectTask(payload.task, selected.id);
      if (!updated) throw new Error("The project task returned an invalid canonical WorkItem.");
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
      const tasks = payload.tasks === undefined
        ? undefined
        : normalizeProjectTasks(payload.tasks, selected.id);
      const artifacts = payload.artifacts as ProjectArtifact[] | undefined;
      if (payload.tasks !== undefined && !tasks) {
        throw new Error("Execution returned invalid canonical WorkItems.");
      }
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

  const selectedClosed = selected?.tasks.filter(taskIsClosed).length || 0;
  const selectedProgress = selected?.tasks.length ? selectedClosed / selected.tasks.length : 0;
  const canonicalArtifactIds = new Set(
    selected?.tasks.flatMap((task) => task.workItem.artifacts.items.map((item) => item.artifactId)) || [],
  );
  const canonicalArtifacts = selected?.artifacts?.filter((artifact) =>
    canonicalArtifactIds.has(artifact.id)
  ) || [];
  const canonicalArtifactCount = selected?.tasks.reduce(
    (total, task) => total + task.workItem.artifacts.count,
    0,
  ) || 0;
  const selectedCost = summarizeWorkItemCost(selected?.tasks || []);
  const selectedArtifact = canonicalArtifacts.find((artifact) => artifact.id === selectedArtifactId) || canonicalArtifacts[0];
  const selectedReflectionDraft = reflectionDraft?.artifactId === selectedArtifact?.id ? reflectionDraft : undefined;
  const selectedVerdict = selectedReflectionDraft?.verdict || selectedArtifact?.verdict;
  const selectedLesson = selectedReflectionDraft?.lesson ?? selectedArtifact?.lesson ?? "";
  const selectedReflectionState = reflectionState && reflectionState.artifactId === selectedArtifact?.id ? reflectionState.status : "idle";

  return (
    <main className={clsx("projects-shell workspace-enter", styles.daybook, styles.projects)} aria-busy={loading}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className="projects-header" data-daybook="hero">
        <div>
          <p className="projects-kicker">Personal operating system</p>
          <h1>Projects</h1>
          <p>Turn outcomes into durable plans your agents can advance with you.</p>
        </div>
        <div className="projects-header-actions">
          <button type="button" className="projects-template-button" onClick={() => setShowTemplates((value) => !value)} aria-expanded={showTemplates}><LayoutTemplate size={15} aria-hidden="true" /> Templates{templates.length ? ` · ${templates.length}` : ""}</button>
          <button type="button" className="projects-create-button" onClick={() => setShowCreate((value) => !value)}><Plus size={15} aria-hidden="true" /> New project</button>
        </div>
      </header>

      <div className="projects-stats" aria-label="Project overview" data-daybook="metrics">
        <div><strong>{activeProjects.length}</strong><span>active projects</span></div>
        <div><strong>{allTasks.length}</strong><span>planned tasks</span></div>
        <div><strong>{allTasks.length ? `${Math.round(closedTasks / allTasks.length * 100)}%` : "—"}</strong><span>work closed</span></div>
      </div>

      <nav className="projects-view-tabs" aria-label="Project workspace views">
        <button type="button" className={workspaceView === "overview" ? "is-selected" : undefined} aria-current={workspaceView === "overview" ? "page" : undefined} onClick={() => setWorkspaceView("overview")}><FolderKanban size={14} aria-hidden="true" /><span><strong>Plan & context</strong><small>Tasks, outputs, library, and memory</small></span></button>
        <button type="button" className={workspaceView === "build" ? "is-selected" : undefined} aria-current={workspaceView === "build" ? "page" : undefined} onClick={() => setWorkspaceView("build")}><Code2 size={14} aria-hidden="true" /><span><strong>Build</strong><small>Forge, code, checks, and live preview</small></span></button>
        <button type="button" className={workspaceView === "execution" ? "is-selected" : undefined} aria-current={workspaceView === "execution" ? "page" : undefined} onClick={() => setWorkspaceView("execution")}><Bot size={14} aria-hidden="true" /><span><strong>Execution</strong><small>Agent lanes, approvals, and blockers</small></span></button>
        <Link href="/app/missions?legacy=1"><History size={14} aria-hidden="true" /><span><strong>Legacy history</strong><small>Earlier Mission runs</small></span></Link>
      </nav>

      {showTemplates ? <section className="projects-template-deck" aria-label="Workspace templates">
        <div className="projects-template-heading">
          <div><p className="projects-kicker">Versioned workspace library</p><h2>Templates & deterministic playbooks</h2><p>Each published version is immutable. New projects receive a copy, so later template changes never rewrite active work.</p></div>
          <span><ShieldCheck size={14} aria-hidden="true" /> {templates.filter((template) => template.playbook).length} typed playbook{templates.filter((template) => template.playbook).length === 1 ? "" : "s"}</span>
        </div>
        {selected ? <div className="projects-template-publish">
          <div><strong>Save “{selected.title}” as a template</strong><small>Copies its outcome, work items, assignments, and dependency graph.</small></div>
          <label><span>Template name</span><input value={templateName} onChange={(event) => setTemplateName(event.currentTarget.value)} maxLength={120} placeholder="e.g. Product release" /></label>
          <label><span>Description</span><input value={templateDescription} onChange={(event) => setTemplateDescription(event.currentTarget.value)} maxLength={1000} placeholder="When should this be used?" /></label>
          <button type="button" onClick={() => void publishSelectedProjectAsTemplate()} disabled={!templateName.trim() || Boolean(templateBusyId)}>{templateBusyId === "new-template" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} Publish</button>
        </div> : null}
        <div className="projects-template-grid">
          {templates.length ? templates.map((template) => <article key={template.templateVersionId} className="projects-template-card">
            <div className="projects-template-card-head"><span><LayoutTemplate size={14} aria-hidden="true" /> v{template.version}</span>{template.playbook ? <em><Zap size={12} aria-hidden="true" /> typed playbook</em> : <em>project blueprint</em>}</div>
            <h3>{template.name}</h3>
            <p>{template.description || template.project.objective}</p>
            <dl><div><dt>Work items</dt><dd>{template.project.tasks.length}</dd></div><div><dt>Default state</dt><dd>{template.project.status}</dd></div><div><dt>Procedure</dt><dd>{template.playbook?.aliases[0] || "Open-ended"}</dd></div></dl>
            <div className="projects-template-card-actions">
              <button type="button" className="is-primary" onClick={() => void instantiateTemplate(template)} disabled={Boolean(templateBusyId)}>{templateBusyId === template.templateVersionId ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={13} aria-hidden="true" />} Use template</button>
              {selected ? <button type="button" onClick={() => void publishSelectedProjectAsTemplate(template)} disabled={Boolean(templateBusyId)}>{templateBusyId === template.templateId ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <History size={13} aria-hidden="true" />} Update from project</button> : null}
            </div>
          </article>) : <div className="projects-template-empty"><LayoutTemplate size={22} aria-hidden="true" /><div><strong>No workspace templates yet</strong><p>Publish the selected project to create an immutable reusable version.</p></div></div>}
        </div>
      </section> : null}

      {showCreate ? <form className="projects-create-form" onSubmit={create}>
        <div><label htmlFor="project-title">Project name</label><input id="project-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Launch the personal research system" maxLength={180} autoFocus /></div>
        <div className="project-objective-field"><label htmlFor="project-objective">Successful outcome</label><textarea id="project-objective" value={objective} onChange={(event) => setObjective(event.currentTarget.value)} placeholder="Describe what will be observably true when this project succeeds." maxLength={2000} rows={2} /></div>
        <div><label htmlFor="project-target">Target date</label><input id="project-target" type="date" value={targetDate} onChange={(event) => setTargetDate(event.currentTarget.value)} /></div>
        <button type="submit" disabled={creating || !title.trim() || !objective.trim()}>{creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />} Create</button>
      </form> : null}

      {error ? <div className="projects-error" role="alert"><span>{error}</span><button type="button" onClick={() => { setError(undefined); void load(); }}>Retry</button></div> : null}

      <div className="projects-workspace" data-daybook="spread">
        <aside className="projects-rail" aria-label="Project list">
          <div className="projects-rail-heading"><span>Portfolio</span><strong>{projects.length}</strong></div>
          {projects.length ? projects.map((project) => {
            const closed = project.tasks.filter(taskIsClosed).length;
            const progress = project.tasks.length ? closed / project.tasks.length : 0;
            return <button key={project.id} type="button" onClick={() => { setSelectedId(project.id); setPlanRationale(""); }} className={clsx("projects-rail-item", selected?.id === project.id && "is-selected")}>
              <span className={clsx("projects-status-mark", `is-${project.status}`)} />
              <span><strong>{project.title}</strong><small>{project.status} · {closed}/{project.tasks.length} closed</small><i><b style={{ width: `${progress * 100}%` }} /></i></span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>;
          }) : <div className="projects-rail-empty"><FolderKanban size={20} aria-hidden="true" /><p>Your project portfolio is empty.</p></div>}
        </aside>

        <section className="project-canvas" aria-live="polite" data-daybook="canvas">
          {selected ? <>
            <div className="project-canvas-head">
              <div className="project-title-block">
                <div><span className={clsx("project-status", `is-${selected.status}`)}>{selected.status}</span>{selected.targetDate ? <span className="project-target"><CalendarDays size={12} aria-hidden="true" /> {formatDate(selected.targetDate)}</span> : null}</div>
                <h2>{selected.title}</h2>
                <p>{selected.objective}</p>
              </div>
              <div className="project-progress-orbit" aria-label={`${selectedClosed} of ${selected.tasks.length} work items closed`} style={{ "--project-progress": `${selectedProgress * 360}deg` } as React.CSSProperties}><div><strong>{selected.tasks.length ? `${Math.round(selectedProgress * 100)}%` : "—"}</strong><span>closed</span></div></div>
            </div>

            {workspaceView !== "build" ? <div className="project-toolbar">
              {selected.status === "active" ? <button type="button" className="project-plan-button" onClick={() => void generatePlan()} disabled={planning}><Sparkles size={14} aria-hidden="true" />{planning ? "Atlas is planning…" : selected.tasks.length ? "Extend plan" : "Plan with Atlas"}</button> : null}
              {selected.status === "active" ? <button type="button" onClick={() => void transitionProject("completed")} disabled={actingId === selected.id || (selected.tasks.length > 0 && selected.tasks.some((task) => task.status !== "done"))} title={selected.tasks.length > 0 && selected.tasks.some((task) => task.status !== "done") ? "Close every task first" : undefined}><Check size={14} aria-hidden="true" /> Complete project</button> : <button type="button" onClick={() => void transitionProject("active")} disabled={actingId === selected.id}><Play size={14} aria-hidden="true" /> Reopen project</button>}
              {selected.status !== "archived" ? <button type="button" onClick={() => void transitionProject("archived")} disabled={actingId === selected.id}><Archive size={14} aria-hidden="true" /> Archive</button> : null}
            </div> : null}

            {workspaceView === "execution" ? <section className={clsx("project-execution-deck", `is-${selected.executionStatus}`)} aria-label="Autonomous project execution">
              <div className="project-execution-intro">
                <span className="project-execution-icon"><Bot size={18} aria-hidden="true" /></span>
                <div><p className="projects-kicker">Agent execution</p><h3>{executionTitle(selected.executionStatus)}</h3><p>{executionDescription(selected.executionStatus, autonomyMode)}</p></div>
              </div>
              <div className="project-execution-metrics">
                <div><span><Gauge size={13} aria-hidden="true" /> Budget</span><strong>{selected.tasksDispatched || 0}<small> / {taskBudget}</small></strong><i><b style={{ width: `${Math.min(100, ((selected.tasksDispatched || 0) / taskBudget) * 100)}%` }} /></i></div>
                <div><span><GitBranch size={13} aria-hidden="true" /> Parallel</span><strong>{maxParallelTasks}</strong><small>agent lane{maxParallelTasks > 1 ? "s" : ""}</small></div>
                <div><span><CircleDollarSign size={13} aria-hidden="true" /> AI cost</span><strong>{canonicalWorkItemCostLabel(selectedCost)}</strong><small>{selectedCost.totalTokens.toLocaleString()} recorded tokens</small></div>
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
            </section> : null}

            {planRationale ? <div className="project-plan-note"><Sparkles size={15} aria-hidden="true" /><div><strong>Atlas added a plan</strong><p>{planRationale}</p></div></div> : null}

            {workspaceView === "overview" ? <><div className="project-task-heading"><div><p className="projects-kicker">Execution plan</p><h3>Next moves</h3></div><span>{selected.tasks.filter((task) => !taskIsClosed(task)).length} open</span></div>
            <div className="project-task-list">
              {selected.tasks.length ? selected.tasks.map((task, index) => {
                const agent = agentFor(workItemAssignedAgent(task));
                const canonicalState = task.workItem.status.status;
                const workflowStatus = workItemWorkflowStatus(task);
                const dependencyNames = (task.dependsOn || []).map((id) => selected.tasks.find((item) => item.id === id)?.title).filter(Boolean);
                return <article key={task.id} className={clsx("project-task", `is-${canonicalState}`)} style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
                  <button type="button" className="project-task-state" onClick={() => void moveTask(task)} disabled={actingId === task.id || selected.status !== "active" || ["running", "waiting_approval"].includes(selected.executionStatus)} aria-label={`${canonicalTaskAction(canonicalState)} ${task.title}`}>
                    {taskIsClosed(task) ? <Check size={14} aria-hidden="true" /> : canonicalState === "running" ? <Pause size={13} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
                  </button>
                  <span className="project-task-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="project-task-copy"><div><strong>{task.title}</strong><span className={clsx("project-task-priority", `is-${task.priority}`)}>{task.priority}</span>{workflowStatus ? <span className={clsx("project-workflow-badge", `is-${workflowStatus}`)}>{workflowLabel(workflowStatus)}</span> : null}</div>{task.detail ? <p>{task.detail}</p> : null}<small>{workItemStatusLabel(task, dependencyNames)} · {task.workItem.artifacts.count} artifact{task.workItem.artifacts.count === 1 ? "" : "s"} · {canonicalWorkItemCostLabel(task.workItem.cost)}{task.dueAt ? ` · due ${formatDate(task.dueAt)}` : ""}</small>{task.executionError ? <em className="project-task-error"><AlertTriangle size={11} aria-hidden="true" /> {task.executionError}</em> : null}</div>
                  <div className={clsx("project-agent", `agent-${agent.accent}`)}><span>{agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><small>{agent.role}</small></div></div>
                  {workflowStatus === "waiting_approval" ? <button type="button" className="project-task-action" onClick={() => void executeProject("approve", task.id)} disabled={Boolean(executionBusy)}>Approve</button> : workflowStatus === "failed" ? <button type="button" className="project-task-action is-danger" onClick={() => void executeProject("retry", task.id)} disabled={Boolean(executionBusy)}>Retry</button> : task.workItem.execution.workflowRunId ? <span className="project-task-live"><i /> {workflowLabel(workflowStatus || "queued")}</span> : <Link href={commandHref(selected, task)} aria-label={`Assign ${task.title} to ${agent.name}`}>Run <ArrowRight size={13} aria-hidden="true" /></Link>}
                </article>;
              }) : <div className="project-task-empty"><Target size={22} aria-hidden="true" /><h3>No plan yet</h3><p>Let Atlas decompose the outcome or add the first task yourself.</p></div>}
            </div>

            {selected.status === "active" ? <form className="project-add-task" onSubmit={addTask}><Plus size={15} aria-hidden="true" /><label className="sr-only" htmlFor="project-task-title">Add project task</label><input id="project-task-title" value={taskTitle} onChange={(event) => setTaskTitle(event.currentTarget.value)} placeholder="Add a task to this plan…" maxLength={240} /><button type="submit" disabled={addingTask || !taskTitle.trim()}>{addingTask ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : "Add task"}</button></form> : null}</> : workspaceView === "execution" ? <ProjectExecutionBoard project={selected} actingId={actingId} executionBusy={executionBusy} onMoveTask={moveTask} onExecute={executeProject} /> : <AppBuilderStudio key={selected.id} project={selected} />}

            {workspaceView === "overview" ? <><section className="project-artifact-ledger" aria-label="Project outputs and reviewed outcomes">
              <div className="project-artifact-heading"><div><p className="projects-kicker">Output ledger</p><h3>Verified work becomes memory</h3></div><span><History size={13} aria-hidden="true" /> {canonicalArtifactCount} canonical artifact{canonicalArtifactCount === 1 ? "" : "s"}</span></div>
              {canonicalArtifacts.length ? <div className="project-artifact-layout">
                <div className="project-artifact-timeline" role="list" aria-label="Artifact timeline">{canonicalArtifacts.map((artifact, index) => {
                  const artifactAgent = agentFor(artifact.agentId);
                  return <button key={artifact.id} type="button" role="listitem" className={clsx(selectedArtifact?.id === artifact.id && "is-selected", `is-${artifact.status}`)} onClick={() => setSelectedArtifactId(artifact.id)} style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}><i /><span><strong>{artifact.title}</strong><small>{artifactAgent.name} · {formatTimestamp(artifact.createdAt)}</small></span><em>{artifact.status}</em></button>;
                })}</div>
                {selectedArtifact ? <article key={selectedArtifact.id} className="project-artifact-detail">
                  <div className="project-artifact-detail-head"><span className={clsx(`is-${selectedArtifact.status}`)}><FileCheck2 size={14} aria-hidden="true" /> {selectedArtifact.status}</span>{selectedArtifact.memoryId ? <Link href="/app/memory"><Brain size={13} aria-hidden="true" /> Retained</Link> : null}</div>
                  <h4>{selectedArtifact.title}</h4>
                  <pre>{selectedArtifact.content}</pre>
                  <div className="project-artifact-reflection">
                    <div><span>Your review</span><small>{selectedArtifact.reviewedAt ? `Last reviewed ${formatTimestamp(selectedArtifact.reviewedAt)}` : "Record what should be repeated or changed."}</small></div>
                    <div className="project-reflection-verdict" role="group" aria-label="Outcome rating"><button type="button" className={clsx(selectedVerdict === "useful" && "is-selected")} onClick={() => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: "useful", lesson: selectedLesson }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }}><ThumbsUp size={13} aria-hidden="true" /> Useful</button><button type="button" className={clsx(selectedVerdict === "needs_work" && "is-selected", "is-needs-work")} onClick={() => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: "needs_work", lesson: selectedLesson }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }}><ThumbsDown size={13} aria-hidden="true" /> Needs work</button></div>
                    <label><span className="sr-only">Outcome note for future Agent work</span><textarea value={selectedLesson} onChange={(event) => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: selectedVerdict, lesson: event.currentTarget.value }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }} placeholder="What should this Agent repeat or change next time?" maxLength={1200} rows={2} /></label>
                    <button type="button" className="project-reflection-save" onClick={() => void saveReflection()} disabled={!selectedVerdict || selectedLesson.trim().length < 3 || selectedReflectionState === "submitting"}>{selectedReflectionState === "submitting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />} {selectedReflectionState === "saved" ? "Recorded" : "Save outcome note"}</button>
                  </div>
                  <footer><span>Provenance</span><div>{selectedArtifact.evidenceRefs.map((reference) => <code key={reference}>{reference}</code>)}</div></footer>
                </article> : null}
              </div> : <div className="project-artifact-empty"><FileCheck2 size={20} aria-hidden="true" /><div><strong>No verified outputs yet</strong><p>Completed agent workflows will appear here with their report, provenance, and linked project memory.</p></div></div>}
            </section>

            <WorkspaceLibrary
              title={`${selected.title} library`}
              description="Assets linked to this project keep their source scope, version, and citation beside the work that produced or uses them."
              kinds={PROJECT_LIBRARY_KINDS}
              projectId={selected.id}
              compact
              limit={12}
              refreshKey={`${selected.updatedAt}:${selected.artifacts?.length || 0}`}
              className="project-artifact-ledger"
            />
            <ProjectSharedMemory
              projectId={selected.id}
              projectTitle={selected.title}
            />
            </> : null}
          </> : <div className="project-canvas-empty"><FolderKanban size={30} aria-hidden="true" /><h2>Create your first project</h2><p>Give an outcome a durable home, then let your agent team turn it into executable work.</p><button type="button" onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> New project</button></div>}
        </section>
      </div>
    </main>
  );
}

const PROJECT_BOARD_COLUMNS = [
  { id: "ready", label: "Ready", detail: "Clear to begin" },
  { id: "working", label: "Working", detail: "Agents in motion" },
  { id: "attention", label: "Needs you", detail: "Approval or intervention" },
  { id: "closed", label: "Closed", detail: "Finished with a recorded outcome" },
] as const;

function ProjectExecutionBoard({
  project,
  actingId,
  executionBusy,
  onMoveTask,
  onExecute,
}: {
  project: Project;
  actingId: string;
  executionBusy: string;
  onMoveTask: (task: ProjectTask) => Promise<void>;
  onExecute: (action: "configure" | "start" | "pause" | "resume" | "sync" | "approve" | "retry", taskId?: string, silent?: boolean) => Promise<void>;
}) {
  const grouped = new Map(PROJECT_BOARD_COLUMNS.map((column) => [column.id, [] as ProjectTask[]]));
  for (const task of project.tasks) grouped.get(projectBoardColumn(task))!.push(task);

  return <section className="project-board" aria-labelledby="project-board-title">
    <div className="project-board-heading"><div><p className="projects-kicker">Live work</p><h3 id="project-board-title">Execution board</h3><p>One view of what agents can start, what is moving, and where you are needed.</p></div><span><i /> synchronized from canonical work items</span></div>
    <div className="project-board-columns">
      {PROJECT_BOARD_COLUMNS.map((column) => <section key={column.id} className={clsx("project-board-column", `is-${column.id}`)} aria-labelledby={`project-column-${column.id}`}>
        <header><div><h4 id={`project-column-${column.id}`}>{column.label}</h4><p>{column.detail}</p></div><strong>{grouped.get(column.id)!.length}</strong></header>
        <div className="project-board-cards">
          {grouped.get(column.id)!.length ? grouped.get(column.id)!.map((task) => {
            const agent = agentFor(workItemAssignedAgent(task));
            const workflowStatus = workItemWorkflowStatus(task);
            return <article key={task.id} className={clsx("project-board-card", `is-${task.workItem.status.status}`)}>
              <div className="project-board-card-meta"><span className={clsx("project-task-priority", `is-${task.priority}`)}>{task.priority}</span><small>{canonicalWorkItemStatusLabel(task.workItem.status.status)}</small></div>
              <h5>{task.title}</h5>
              {task.detail ? <p>{task.detail}</p> : null}
              {task.executionError ? <em><AlertTriangle size={11} aria-hidden="true" /> {task.executionError}</em> : null}
              <dl><div><dt>Agent</dt><dd>{agent.name}</dd></div><div><dt>Evidence</dt><dd>{task.workItem.artifacts.count}</dd></div><div><dt>Cost</dt><dd>{canonicalWorkItemCostLabel(task.workItem.cost)}</dd></div></dl>
              <footer>
                {workflowStatus === "waiting_approval" ? <button type="button" className="is-primary" onClick={() => void onExecute("approve", task.id)} disabled={Boolean(executionBusy)}>Approve</button> : workflowStatus === "failed" ? <button type="button" className="is-danger" onClick={() => void onExecute("retry", task.id)} disabled={Boolean(executionBusy)}>Retry</button> : task.workItem.execution.workflowRunId ? <span className="project-task-live"><i /> {workflowLabel(workflowStatus || "queued")}</span> : <Link href={commandHref(project, task)}>Open in Command <ArrowRight size={12} aria-hidden="true" /></Link>}
                <button type="button" onClick={() => void onMoveTask(task)} disabled={actingId === task.id || project.status !== "active" || ["running", "waiting_approval"].includes(project.executionStatus)}>{taskIsClosed(task) ? "Reopen" : "Advance"}</button>
              </footer>
            </article>;
          }) : <div className="project-board-empty"><Circle size={13} aria-hidden="true" /><span>Nothing here</span></div>}
        </div>
      </section>)}
    </div>
  </section>;
}

function projectBoardColumn(task: ProjectTask): typeof PROJECT_BOARD_COLUMNS[number]["id"] {
  const workflowStatus = workItemWorkflowStatus(task);
  const status = task.workItem.status.status;
  if (taskIsClosed(task)) return "closed";
  if (workflowStatus === "waiting_approval" || workflowStatus === "failed" || ["blocked", "partial"].includes(status)) return "attention";
  if (["dispatching", "queued", "running", "paused"].includes(workflowStatus || "") || status === "running") return "working";
  return "ready";
}

function agentFor(id: string) {
  return arsenalAgents.find((agent) => agent.id === id) || {
    ...arsenalAgents[0],
    id,
    name: id || "Unassigned",
    role: id ? "Assigned Agent" : "No Agent assigned",
  };
}
function projectTemplateBlueprint(project: Project): WorkspaceTemplate["project"] {
  const keyByTaskId = new Map(project.tasks.map((task, index) => [task.id, `step-${index + 1}`]));
  return {
    title: project.title,
    objective: project.objective,
    status: project.status === "active" ? "active" : "draft",
    tasks: project.tasks.map((task, index) => ({
      key: `step-${index + 1}`,
      title: task.title,
      detail: task.detail,
      priority: task.priority,
      agentId: task.agentId,
      dependsOnKeys: task.dependsOn.flatMap((id) => {
        const key = keyByTaskId.get(id);
        return key ? [key] : [];
      }),
    })),
  };
}
function templateMutationKey(keys: Map<string, string>, name: string) {
  const existing = keys.get(name);
  if (existing) return existing;
  const key = `workspace-template:${crypto.randomUUID()}`;
  keys.set(name, key);
  return key;
}
function commandHref(project: Project, task: ProjectTask) { const prompt = `Project: ${project.title}\nObjective: ${project.objective}\nAssigned task: ${task.title}\n${task.detail}\nComplete this bounded task, verify the outcome, and report evidence plus the next recommended project state.`; return `/app/command?agent=${encodeURIComponent(workItemAssignedAgent(task))}&project=${encodeURIComponent(project.id)}&context=project&prompt=${encodeURIComponent(prompt)}`; }
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
function taskIsClosed(task: ProjectTask) {
  return ["unverified", "failed", "canceled", "succeeded"].includes(task.workItem.status.status);
}
export function nextProjectTaskStatus(task: Pick<ProjectTask, "status" | "workItem">): ProjectTask["status"] {
  if (["unverified", "failed", "canceled", "succeeded"].includes(task.workItem.status.status)) return "open";
  if (["running", "partial"].includes(task.workItem.status.status) || task.status === "doing") return "done";
  return "doing";
}
function workItemStatusLabel(task: ProjectTask, dependencyNames: (string | undefined)[]) {
  const status = task.workItem.status.status;
  if (status === "waiting") {
    return dependencyNames.length ? `After ${dependencyNames.join(", ")}` : "Ready";
  }
  return canonicalWorkItemStatusLabel(status);
}
function workItemAssignedAgent(task: ProjectTask) {
  return task.workItem.assignment.agents[0]?.agentId || "";
}
function workItemWorkflowStatus(task: ProjectTask) {
  return task.workItem.execution.availability === "current"
    ? task.workItem.execution.sourceStatus || undefined
    : undefined;
}
function canonicalTaskAction(status: CanonicalWorkItemSurface["status"]["status"]) {
  if (["unverified", "failed", "canceled", "succeeded"].includes(status)) return "Reopen";
  return status === "running" || status === "partial" ? "Complete" : "Start";
}
function summarizeWorkItemCost(tasks: readonly ProjectTask[]): CanonicalWorkItemSurface["cost"] {
  const costs = [...new Map(tasks.map((task) => [
    task.workItem.execution.workflowRunId || task.workItem.status.workItemId,
    task.workItem.cost,
  ])).values()];
  const usageReceiptCount = costs.reduce((total, cost) => total + cost.usageReceiptCount, 0);
  const unknownCostReceiptCount = costs.reduce((total, cost) => total + cost.unknownCostReceiptCount, 0);
  const state = usageReceiptCount === 0
    ? "not_recorded"
    : unknownCostReceiptCount === usageReceiptCount
      ? "unknown"
      : unknownCostReceiptCount > 0
        ? "partial"
        : "known";
  return {
    authority: "ai_usage_ledger_v1",
    state,
    usageReceiptCount,
    unknownCostReceiptCount,
    totalTokens: costs.reduce((total, cost) => total + cost.totalTokens, 0),
    knownEstimatedCostMicrousd: costs.reduce(
      (total, cost) => total + cost.knownEstimatedCostMicrousd,
      0,
    ),
  };
}
export function normalizeProjects(value: unknown): Project[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const projects: Project[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const project = item as Record<string, unknown>;
    if (typeof project.id !== "string" || !Array.isArray(project.tasks) || !Array.isArray(project.artifacts)) {
      return undefined;
    }
    const tasks = normalizeProjectTasks(project.tasks, project.id);
    if (!tasks) return undefined;
    projects.push({ ...project, tasks } as Project);
  }
  return projects;
}
function normalizeProjectTasks(value: unknown, projectId: string) {
  if (!Array.isArray(value) || value.length > 500) return undefined;
  const tasks = value.map((task) => normalizeProjectTask(task, projectId));
  if (tasks.some((task) => !task)) return undefined;
  const normalized = tasks as ProjectTask[];
  return new Set(normalized.map((task) => task.id)).size === normalized.length
    ? normalized
    : undefined;
}
function normalizeProjectTask(value: unknown, projectId: string): ProjectTask | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const task = value as Record<string, unknown>;
  const workItem = parseCanonicalWorkItemSurface(task.workItem);
  if (
    typeof task.id !== "string" ||
    !workItem ||
    workItem.status.sourceAuthority !== "legacy_project_task" ||
    workItem.status.sourceId !== task.id ||
    workItem.status.workItemId !== task.id ||
    workItem.status.projectId !== projectId ||
    JSON.stringify(task.workItemStatus) !== JSON.stringify(workItem.status)
  ) return undefined;
  return { ...task, workItemStatus: workItem.status, workItem } as unknown as ProjectTask;
}
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
