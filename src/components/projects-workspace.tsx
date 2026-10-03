"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  AlertTriangle,
  ArrowLeft,
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
  projectExecutionIsLive,
  runProjectWrite,
  startProjectExecutionRefresh,
} from "@/lib/client/project-execution-refresh";
import {
  canonicalWorkItemCostLabel,
  canonicalWorkItemStatusLabel,
  parseCanonicalWorkItemSurface,
  type CanonicalWorkItemSurface,
} from "@/lib/workspaces/surface";
import styles from "./projects-workspace.module.css";

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
  const [hasLoaded, setHasLoaded] = useState(false);
  const [projectDetailOpen, setProjectDetailOpen] = useState(initialView !== "overview");
  const [artifactDetailOpen, setArtifactDetailOpen] = useState(false);
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
  const [announcement, setAnnouncement] = useState("");
  const [workspaceView, setWorkspaceView] = useState<"overview" | "execution" | "build">(initialView);
  const controllerRef = useRef<AbortController | null>(null);
  const projectListRef = useRef<HTMLElement>(null);
  const projectHeadingRef = useRef<HTMLHeadingElement>(null);
  const artifactListRef = useRef<HTMLUListElement>(null);
  const artifactHeadingRef = useRef<HTMLHeadingElement>(null);
  const projectListScrollRef = useRef(0);
  const artifactListScrollRef = useRef(0);
  const templateMutationKeysRef = useRef(new Map<string, string>());
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const selected = projects.find((project) => project.id === selectedId) || projects[0];
  const hasExecutionDraft = Boolean(executionDraft && selected && executionDraft.projectId === selected.id);
  const autonomyMode = hasExecutionDraft ? executionDraft!.autonomyMode : selected?.autonomyMode === "autonomous" ? "autonomous" : "supervised";
  const taskBudget = hasExecutionDraft ? executionDraft!.taskBudget : selected?.taskBudget || 12;
  const maxParallelTasks = hasExecutionDraft ? executionDraft!.maxParallelTasks : selected?.maxParallelTasks || 1;
  const requireApproval = hasExecutionDraft ? executionDraft!.requireApproval : selected?.requireApproval ?? true;
  const hasUnsavedExecutionDraft = hasExecutionDraft && Boolean(selected && (
    autonomyMode !== (selected.autonomyMode === "autonomous" ? "autonomous" : "supervised")
    || taskBudget !== (selected.taskBudget || 12)
    || maxParallelTasks !== (selected.maxParallelTasks || 1)
    || requireApproval !== (selected.requireApproval ?? true)
  ));
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
      setHasLoaded(true);
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
      if (!hasLoaded && requestedProjectId && next.some((item) => item.id === requestedProjectId)) setProjectDetailOpen(true);
      if (requestedArtifactId && next.some((item) =>
        item.artifacts.some((artifact) => artifact.id === requestedArtifactId)
      )) {
        setSelectedArtifactId(requestedArtifactId);
        if (!hasLoaded) {
          setProjectDetailOpen(true);
          setArtifactDetailOpen(true);
        }
      }
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
    if (!selected || !projectExecutionIsLive(selected.executionStatus)) return;
    const projectId = selected.id;
    return startProjectExecutionRefresh({
      projectId,
      onProject: (value) => setProjects((current) => withRefreshedProject(current, projectId, value)),
    });
    // The refresh follows only the durable selected project state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.executionStatus]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) return;
    setCreating(true);
    try {
      const payload = await readJson("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          title: title.trim(), objective: objective.trim(), status: "active",
          targetDate: targetDate ? new Date(`${targetDate}T23:59:00`).toISOString() : undefined,
        }),
      });
      const project = payload.project as Project;
      setProjects((current) => [project, ...current]);
      setSelectedId(project.id);
      setProjectDetailOpen(true);
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
      setProjectDetailOpen(true);
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
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}),
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
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
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
        method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ status }),
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
        method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ status }),
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

  async function executeProject(action: "configure" | "start" | "pause" | "resume" | "sync" | "approve" | "retry", taskId?: string) {
    if (!selected || executionBusy) return;
    setExecutionBusy(taskId || action);
    try {
      const body = action === "configure" || action === "start"
        ? { action, autonomyMode, taskBudget, maxParallelTasks, requireApproval }
        : action === "approve" || action === "retry"
          ? { action, taskId }
          : { action };
      const payload = await readJson(`/api/projects/${encodeURIComponent(selected.id)}/execution`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body),
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
      setAnnouncement(executionAnnouncement(action, payload.dispatchedTaskIds as string[] | undefined));
      setError(undefined);
    } catch (executionError) {
      setError(message(executionError));
    } finally {
      setExecutionBusy("");
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
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
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

  function selectProject(projectId: string) {
    projectListScrollRef.current = window.scrollY;
    setSelectedId(projectId);
    setPlanRationale("");
    setProjectDetailOpen(true);
    setArtifactDetailOpen(false);
    requestAnimationFrame(() => projectHeadingRef.current?.focus());
  }

  function returnToProjects() {
    setProjectDetailOpen(false);
    requestAnimationFrame(() => {
      projectListRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: projectListScrollRef.current, behavior: "instant" });
    });
  }

  function selectArtifact(artifactId: string) {
    artifactListScrollRef.current = window.scrollY;
    setSelectedArtifactId(artifactId);
    setArtifactDetailOpen(true);
    requestAnimationFrame(() => artifactHeadingRef.current?.focus());
  }

  function returnToOutputs() {
    setArtifactDetailOpen(false);
    requestAnimationFrame(() => {
      artifactListRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: artifactListScrollRef.current, behavior: "instant" });
    });
  }

  return (
    <div className={styles.shell}>
      <p className="sr-only" role="status" aria-live="polite">{loading ? hasLoaded ? "Refreshing projects." : "Loading projects." : announcement}</p>
      <header className={styles.header}>
        <div>
          <h1>Work</h1>
          <p>Projects, plans, and the outputs they produce.</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.button} onClick={() => void load()} disabled={loading}><RotateCw size={16} aria-hidden="true" /> {loading && hasLoaded ? "Refreshing…" : "Refresh"}</button>
          <button type="button" className={styles.button} onClick={() => setShowTemplates((value) => !value)} aria-expanded={showTemplates} aria-controls="project-templates"><LayoutTemplate size={16} aria-hidden="true" /> Templates{templates.length ? ` · ${templates.length}` : ""}</button>
          <button type="button" className={styles.primaryButton} onClick={() => setShowCreate((value) => !value)} aria-expanded={showCreate} aria-controls="project-create"><Plus size={16} aria-hidden="true" /> New project</button>
        </div>
      </header>

      <p className={styles.summary}>{hasLoaded ? <><span>{activeProjects.length} active project{activeProjects.length === 1 ? "" : "s"}</span><span>{allTasks.length} planned task{allTasks.length === 1 ? "" : "s"}</span><span>{closedTasks} closed task{closedTasks === 1 ? "" : "s"}</span>{error ? <span>Last loaded view</span> : null}</> : loading ? "Loading project overview…" : "Project overview unavailable."}</p>

      <nav className={styles.viewNavigation} aria-label="Project workspace views">
        <button type="button" aria-pressed={workspaceView === "overview"} onClick={() => setWorkspaceView("overview")}><FolderKanban size={16} aria-hidden="true" /> Plan & context</button>
        <button type="button" aria-pressed={workspaceView === "execution"} onClick={() => setWorkspaceView("execution")}><Bot size={16} aria-hidden="true" /> Execution</button>
        <button type="button" aria-pressed={workspaceView === "build"} onClick={() => setWorkspaceView("build")}><Code2 size={16} aria-hidden="true" /> Build</button>
        <Link href="/app/missions?legacy=1"><History size={16} aria-hidden="true" /> Legacy history</Link>
      </nav>

      {showTemplates ? <section id="project-templates" className={styles.templateDeck} aria-label="Workspace templates">
        <div className={styles.sectionHeading}>
          <div><h2>Templates & playbooks</h2><p>New projects receive a copy of the published version. Later edits leave active projects unchanged.</p></div>
          <span><ShieldCheck size={14} aria-hidden="true" /> {templates.filter((template) => template.playbook).length} typed playbook{templates.filter((template) => template.playbook).length === 1 ? "" : "s"}</span>
        </div>
        {selected ? <div className={styles.templatePublish}>
          <div><strong>Save “{selected.title}” as a template</strong><small>Copies its outcome, work items, assignments, and dependency graph.</small></div>
          <label><span>Template name</span><input value={templateName} onChange={(event) => setTemplateName(event.currentTarget.value)} maxLength={120} placeholder="e.g. Product release" /></label>
          <label><span>Description</span><input value={templateDescription} onChange={(event) => setTemplateDescription(event.currentTarget.value)} maxLength={1000} placeholder="When should this be used?" /></label>
          <button type="button" onClick={() => void publishSelectedProjectAsTemplate()} disabled={!templateName.trim() || Boolean(templateBusyId)}>{templateBusyId === "new-template" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} Publish</button>
        </div> : null}
        <div className={styles.templateList}>
          {templates.length ? templates.map((template) => <article key={template.templateVersionId} className={styles.templateRow}>
            <div className={styles.templateMeta}><span><LayoutTemplate size={14} aria-hidden="true" /> v{template.version}</span>{template.playbook ? <em><Zap size={12} aria-hidden="true" /> typed playbook</em> : <em>project blueprint</em>}</div>
            <h3>{template.name}</h3>
            <p>{template.description || template.project.objective}</p>
            <dl><div><dt>Work items</dt><dd>{template.project.tasks.length}</dd></div><div><dt>Default state</dt><dd>{template.project.status}</dd></div><div><dt>Procedure</dt><dd>{template.playbook?.aliases[0] || "Open-ended"}</dd></div></dl>
            <div className={styles.templateActions}>
              <button type="button" className={styles.primaryButton} onClick={() => void instantiateTemplate(template)} disabled={Boolean(templateBusyId)}>{templateBusyId === template.templateVersionId ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={13} aria-hidden="true" />} Use template</button>
              {selected ? <button type="button" onClick={() => void publishSelectedProjectAsTemplate(template)} disabled={Boolean(templateBusyId)}>{templateBusyId === template.templateId ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <History size={13} aria-hidden="true" />} Update from project</button> : null}
            </div>
          </article>) : <div className={styles.emptyRow}><LayoutTemplate size={22} aria-hidden="true" /><div><strong>{loading ? "Loading templates…" : !hasLoaded ? "Templates unavailable" : error ? "No templates in the last loaded view" : "No workspace templates yet"}</strong><p>{!hasLoaded ? "Published templates will appear when the workspace loads." : error ? "Retry to check for updates." : "Publish the selected project to create a reusable version."}</p></div></div>}
        </div>
      </section> : null}

      {showCreate ? <form id="project-create" className={styles.createForm} onSubmit={create} aria-label="New project">
        <div><label htmlFor="project-title">Project name</label><input id="project-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Launch the personal research system" maxLength={180} autoFocus /></div>
        <div className={styles.objectiveField}><label htmlFor="project-objective">Successful outcome</label><textarea id="project-objective" value={objective} onChange={(event) => setObjective(event.currentTarget.value)} placeholder="Describe what will be observably true when this project succeeds." maxLength={2000} rows={2} /></div>
        <div><label htmlFor="project-target">Target date</label><input id="project-target" type="date" value={targetDate} onChange={(event) => setTargetDate(event.currentTarget.value)} /></div>
        <button type="submit" disabled={creating || !title.trim() || !objective.trim()}>{creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />} Create</button>
      </form> : null}

      {error ? <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => { setError(undefined); void load(); }}>Retry</button></div> : null}

      <div className={styles.workspace} data-project-panel={projectDetailOpen ? "detail" : "list"}>
        <aside ref={projectListRef} tabIndex={-1} className={styles.projectList} aria-label="Project list" aria-busy={loading}>
          <div className={styles.listHeading}><h2>Projects</h2><span>{hasLoaded ? projects.length : "—"}</span></div>
          {projects.length ? projects.map((project) => {
            const closed = project.tasks.filter(taskIsClosed).length;
            return <button key={project.id} type="button" onClick={() => selectProject(project.id)} className={styles.projectItem} aria-pressed={selected?.id === project.id}>
              <span className={styles.statusMark} data-status={project.status} aria-hidden="true" />
              <span><strong>{project.title}</strong><small>{project.status} · {closed}/{project.tasks.length} closed</small></span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>;
          }) : loading ? <div className={styles.listLoading} aria-hidden="true"><span /><span /><span /></div> : <div className={styles.emptyRow}><FolderKanban size={20} aria-hidden="true" /><p>{hasLoaded && !error ? "No projects in this workspace yet." : "The project list is unavailable. Retry to load your work."}</p></div>}
        </aside>

        <section className={styles.canvas} aria-label="Selected project">
          {selected ? <>
            <button type="button" className={clsx(styles.button, styles.backButton)} onClick={returnToProjects}><ArrowLeft size={16} aria-hidden="true" /> Back to projects</button>
            <div className={styles.canvasHeading}>
              <div className={styles.titleBlock}>
                <div className={styles.projectMeta}><span className={styles.status} data-status={selected.status}>{selected.status}</span>{selected.targetDate ? <span className={styles.target}><CalendarDays size={14} aria-hidden="true" /> Due {formatDate(selected.targetDate)}</span> : null}<span>Updated {formatTimestamp(selected.updatedAt)}</span></div>
                <h2 ref={projectHeadingRef} tabIndex={-1}>{selected.title}</h2>
                <p>{selected.objective}</p>
                <p className={styles.projectProgress}>{selectedClosed} of {selected.tasks.length} tasks closed{selected.tasks.length ? ` · ${Math.round(selectedProgress * 100)}%` : ""} · {canonicalWorkItemCostLabel(selectedCost)}</p>
              </div>
            </div>

            {workspaceView !== "build" ? <div className={styles.toolbar}>
              {selected.status === "active" ? <button type="button" className={styles.primaryButton} onClick={() => void generatePlan()} disabled={planning}><Sparkles size={14} aria-hidden="true" />{planning ? "Atlas is planning…" : selected.tasks.length ? "Extend plan" : "Plan with Atlas"}</button> : null}
              {selected.status === "active" ? <button type="button" onClick={() => void transitionProject("completed")} disabled={actingId === selected.id || (selected.tasks.length > 0 && selected.tasks.some((task) => task.status !== "done"))} title={selected.tasks.length > 0 && selected.tasks.some((task) => task.status !== "done") ? "Close every task first" : undefined}><Check size={14} aria-hidden="true" /> Complete project</button> : <button type="button" onClick={() => void transitionProject("active")} disabled={actingId === selected.id}><Play size={14} aria-hidden="true" /> Reopen project</button>}
              {selected.status !== "archived" ? <button type="button" onClick={() => void transitionProject("archived")} disabled={actingId === selected.id}><Archive size={14} aria-hidden="true" /> Archive</button> : null}
            </div> : null}
            {workspaceView !== "build" && selected.status === "active" && selected.tasks.some((task) => task.status !== "done") ? <p className={styles.helper}>Close every task before completing this project.</p> : null}

            {workspaceView === "execution" ? <section className={styles.executionDeck} aria-label="Autonomous project execution" data-status={selected.executionStatus}>
              <div className={styles.executionIntro}>
                <Bot size={20} aria-hidden="true" />
                <div>
                  <h3>{executionTitle(selected.executionStatus)}</h3>
                  <p>{executionDescription(selected.executionStatus, autonomyMode)}</p>
                  <p className={styles.executionSnapshot}>Project snapshot · recorded update {formatTimestamp(selected.updatedAt)}</p>
                </div>
              </div>
              <dl className={styles.executionMetrics}>
                <div><dt><Gauge size={16} aria-hidden="true" /> Task budget</dt><dd>{selected.tasksDispatched || 0} / {taskBudget}<small>tasks dispatched / {hasUnsavedExecutionDraft ? "draft" : "saved"} limit</small></dd></div>
                <div><dt><GitBranch size={16} aria-hidden="true" /> Parallel agents</dt><dd>{maxParallelTasks}<small>{hasUnsavedExecutionDraft ? "Draft" : "Saved"} lane limit</small></dd></div>
                <div><dt><CircleDollarSign size={16} aria-hidden="true" /> AI cost</dt><dd>{canonicalWorkItemCostLabel(selectedCost)}<small>{selectedCost.totalTokens.toLocaleString()} recorded tokens</small></dd></div>
                <div><dt><ShieldCheck size={16} aria-hidden="true" /> Guardrail</dt><dd>{autonomyMode === "supervised" || requireApproval ? "Approval" : "Policy"}<small>{autonomyMode === "autonomous" && !requireApproval ? "Risky tools still require policy checks" : "Before each workflow"}</small></dd></div>
              </dl>
              <div className={styles.executionControls}>
                <label><span>Operating mode</span><select value={autonomyMode} onChange={(event) => { const mode = event.currentTarget.value as Project["autonomyMode"]; updateExecutionDraft({ autonomyMode: mode, requireApproval: mode === "supervised" ? true : requireApproval }); }} disabled={["running", "waiting_approval"].includes(selected.executionStatus)} aria-describedby={["running", "waiting_approval"].includes(selected.executionStatus) ? "project-execution-settings-help" : "project-execution-draft-help"}><option value="supervised">Supervised</option><option value="autonomous">Autonomous</option></select></label>
                <label><span>Task budget</span><input type="number" min={1} max={50} value={taskBudget} onChange={(event) => updateExecutionDraft({ taskBudget: Math.min(50, Math.max(1, Number(event.currentTarget.value))) })} disabled={["running", "waiting_approval"].includes(selected.executionStatus)} aria-describedby={["running", "waiting_approval"].includes(selected.executionStatus) ? "project-execution-settings-help" : "project-execution-draft-help"} /></label>
                <label><span>Parallel agents</span><select value={maxParallelTasks} onChange={(event) => updateExecutionDraft({ maxParallelTasks: Number(event.currentTarget.value) })} disabled={["running", "waiting_approval"].includes(selected.executionStatus)} aria-describedby={["running", "waiting_approval"].includes(selected.executionStatus) ? "project-execution-settings-help" : "project-execution-draft-help"}><option value={1}>1 lane</option><option value={2}>2 lanes</option><option value={3}>3 lanes</option></select></label>
                <label className={styles.approvalSwitch}><input type="checkbox" checked={requireApproval} onChange={(event) => updateExecutionDraft({ requireApproval: event.currentTarget.checked })} disabled={autonomyMode === "supervised" || ["running", "waiting_approval"].includes(selected.executionStatus)} aria-describedby={autonomyMode === "supervised" ? "project-execution-approval-help" : ["running", "waiting_approval"].includes(selected.executionStatus) ? "project-execution-settings-help" : undefined} /><span>Approval gate</span></label>
              </div>
              <p id="project-execution-draft-help" className={styles.helper}>These settings are sent when you start agents. Resume continues with the saved settings.</p>
              {["running", "waiting_approval"].includes(selected.executionStatus) ? <p id="project-execution-settings-help" className={styles.helper}>Settings are locked while execution is running or waiting for approval.</p> : null}
              {autonomyMode === "supervised" ? <p id="project-execution-approval-help" className={styles.helper}>Supervised mode requires the approval gate.</p> : null}
              <div className={styles.executionActions}>
                {selected.executionStatus === "running" || selected.executionStatus === "waiting_approval" ? <button type="button" className={styles.button} onClick={() => void executeProject("pause")} disabled={Boolean(executionBusy)} aria-describedby={executionBusy ? "project-execution-busy-help" : undefined}><Pause size={16} aria-hidden="true" /> Pause</button> : selected.executionStatus === "paused" ? <button type="button" className={styles.primaryButton} onClick={() => void executeProject("resume")} disabled={Boolean(executionBusy)} aria-describedby={executionBusy ? "project-execution-busy-help" : undefined}><Play size={16} aria-hidden="true" /> Resume</button> : <button type="button" className={styles.primaryButton} onClick={() => void executeProject("start")} disabled={Boolean(executionBusy) || !selected.tasks.length} aria-describedby={executionBusy ? "project-execution-busy-help" : !selected.tasks.length ? "project-execution-empty-help" : undefined}><Zap size={16} aria-hidden="true" /> Start agents</button>}
                <button type="button" className={styles.button} onClick={() => void executeProject("sync")} disabled={Boolean(executionBusy)} aria-label="Synchronize workflow progress" aria-describedby={executionBusy ? "project-execution-busy-help" : undefined}><RotateCw size={16} className={executionBusy === "sync" ? styles.executionSpinner : undefined} aria-hidden="true" /> {executionBusy === "sync" ? "Syncing…" : "Sync progress"}</button>
              </div>
              {executionBusy ? <p id="project-execution-busy-help" className={styles.helper} role="status">An execution request is in progress. Wait for it to finish before sending another.</p> : null}
              {!selected.tasks.length ? <p id="project-execution-empty-help" className={styles.helper}>Add a task in Plan & context before starting agents.</p> : null}
            </section> : null}

            {planRationale ? <div className={styles.planNote}><Sparkles size={15} aria-hidden="true" /><div><strong>Atlas added a plan</strong><p>{planRationale}</p></div></div> : null}

            {workspaceView === "overview" ? <><div className={styles.sectionHeading}><h3>Tasks</h3><span>{selected.tasks.filter((task) => !taskIsClosed(task)).length} open · execution {selected.executionStatus.replace("_", " ")}</span></div>
            {selected.status !== "active" || ["running", "waiting_approval"].includes(selected.executionStatus) ? <p id="project-task-state-help" className={styles.helper}>{selected.status !== "active" ? "Reopen this project to change task status." : "Manual task status changes are unavailable while execution is running or awaiting approval."}</p> : null}
            <div className={styles.taskList} role="list" aria-label="Project tasks">
              {selected.tasks.length ? selected.tasks.map((task, index) => {
                const agent = agentFor(workItemAssignedAgent(task));
                const canonicalState = task.workItem.status.status;
                const workflowStatus = workItemWorkflowStatus(task);
                const dependencyNames = (task.dependsOn || []).map((id) => selected.tasks.find((item) => item.id === id)?.title).filter(Boolean);
                return <article key={task.id} className={styles.task} data-status={canonicalState} role="listitem">
                  <button type="button" className={styles.taskState} onClick={() => void moveTask(task)} disabled={actingId === task.id || selected.status !== "active" || ["running", "waiting_approval"].includes(selected.executionStatus)} aria-label={`${canonicalTaskAction(canonicalState)} ${task.title}`} aria-describedby={selected.status !== "active" || ["running", "waiting_approval"].includes(selected.executionStatus) ? "project-task-state-help" : undefined}>
                    {taskIsClosed(task) ? <Check size={14} aria-hidden="true" /> : canonicalState === "running" ? <Pause size={13} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
                  </button>
                  <span className={styles.taskIndex}>{String(index + 1).padStart(2, "0")}</span>
                  <div className={styles.taskCopy}><div><strong>{task.title}</strong><span className={styles.priority} data-priority={task.priority}>{task.priority}</span>{workflowStatus ? <span className={styles.workflowStatus} data-status={workflowStatus}>{workflowLabel(workflowStatus)}</span> : null}</div>{task.detail ? <p>{task.detail}</p> : null}<small>{workItemStatusLabel(task, dependencyNames)} · {task.workItem.artifacts.count} artifact{task.workItem.artifacts.count === 1 ? "" : "s"} · {canonicalWorkItemCostLabel(task.workItem.cost)}{task.dueAt ? ` · due ${formatDate(task.dueAt)}` : ""}</small>{task.executionError ? <em className={styles.taskError}><AlertTriangle size={11} aria-hidden="true" /> {task.executionError}</em> : null}</div>
                  <div className={styles.agent}><span>{agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><small>{agent.role}</small></div></div>
                  {workflowStatus === "waiting_approval" ? <button type="button" className={styles.button} onClick={() => void executeProject("approve", task.id)} disabled={Boolean(executionBusy)} aria-label={`Approve ${task.title}`}>Approve</button> : workflowStatus === "failed" ? <button type="button" className={styles.button} onClick={() => void executeProject("retry", task.id)} disabled={Boolean(executionBusy)} aria-label={`Retry ${task.title}`}>Retry</button> : task.workItem.execution.workflowRunId ? <span className={styles.taskLive}>{workflowStatus ? workflowLabel(workflowStatus) : "Workflow status unavailable"}</span> : <Link className={styles.button} href={commandHref(selected, task)} aria-label={`Assign ${task.title} to ${agent.name}`}>Run <ArrowRight size={13} aria-hidden="true" /></Link>}
                </article>;
              }) : <div className={styles.emptyState} role="listitem"><Target size={22} aria-hidden="true" /><h3>No plan yet</h3><p>Let Atlas decompose the outcome or add the first task yourself.</p></div>}
            </div>

            {selected.status === "active" ? <form className={styles.addTask} onSubmit={addTask}><label htmlFor="project-task-title">Add project task</label><div><input id="project-task-title" value={taskTitle} onChange={(event) => setTaskTitle(event.currentTarget.value)} placeholder="Describe the next task" maxLength={240} /><button type="submit" className={styles.button} disabled={addingTask || !taskTitle.trim()}>{addingTask ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} {addingTask ? "Adding…" : "Add task"}</button></div></form> : null}</> : workspaceView === "execution" ? <ProjectExecutionBoard project={selected} actingId={actingId} executionBusy={executionBusy} onMoveTask={moveTask} onExecute={executeProject} /> : <AppBuilderStudio key={selected.id} project={selected} />}

            {workspaceView === "overview" ? <><section className={styles.artifactLedger} aria-label="Project outputs and reviewed outcomes">
              <div className={styles.sectionHeading}><h3>Outputs & evidence</h3><span>{canonicalArtifactCount} artifact{canonicalArtifactCount === 1 ? "" : "s"} linked to work items</span></div>
              {canonicalArtifacts.length ? <div className={styles.artifactLayout} data-artifact-panel={artifactDetailOpen ? "detail" : "list"}>
                <ul ref={artifactListRef} tabIndex={-1} className={styles.artifactList} aria-label="Project outputs">{canonicalArtifacts.map((artifact) => {
                  const artifactAgent = agentFor(artifact.agentId);
                  return <li key={artifact.id}><button type="button" className={styles.artifactItem} aria-pressed={selectedArtifact?.id === artifact.id} onClick={() => selectArtifact(artifact.id)}><span><strong>{artifact.title}</strong><small>{artifactAgent.name} · {formatTimestamp(artifact.createdAt)}</small></span><span className={styles.status} data-status={artifact.status}>{artifact.status}</span></button></li>;
                })}</ul>
                {selectedArtifact ? <article key={selectedArtifact.id} className={styles.artifactDetail}>
                  <button type="button" className={clsx(styles.button, styles.backButton)} onClick={returnToOutputs}><ArrowLeft size={16} aria-hidden="true" /> Back to outputs</button>
                  <div className={styles.artifactMeta}><span className={styles.status} data-status={selectedArtifact.status}><FileCheck2 size={14} aria-hidden="true" /> {selectedArtifact.status}</span>{selectedArtifact.memoryId ? <Link href="/app/memory"><Brain size={13} aria-hidden="true" /> Retained in memory</Link> : null}</div>
                  <h4 id="project-output-title" ref={artifactHeadingRef} tabIndex={-1}>{selectedArtifact.title}</h4>
                  <pre tabIndex={0} role="region" aria-labelledby="project-output-title">{selectedArtifact.content}</pre>
                  <div className={styles.reflection}>
                    <div><span>Your review</span><small>{selectedArtifact.reviewedAt ? `Last reviewed ${formatTimestamp(selectedArtifact.reviewedAt)}` : "Record what should be repeated or changed."}</small></div>
                    <div className={styles.verdict} role="group" aria-label="Outcome rating"><button type="button" className={styles.button} aria-pressed={selectedVerdict === "useful"} onClick={() => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: "useful", lesson: selectedLesson }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }}><ThumbsUp size={13} aria-hidden="true" /> Useful</button><button type="button" className={styles.button} aria-pressed={selectedVerdict === "needs_work"} onClick={() => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: "needs_work", lesson: selectedLesson }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }}><ThumbsDown size={13} aria-hidden="true" /> Needs work</button></div>
                    <label><span>Outcome note for future Agent work</span><textarea value={selectedLesson} onChange={(event) => { setReflectionDraft({ artifactId: selectedArtifact.id, verdict: selectedVerdict, lesson: event.currentTarget.value }); setReflectionState({ artifactId: selectedArtifact.id, status: "idle" }); }} placeholder="What should this Agent repeat or change next time?" maxLength={1200} rows={2} aria-describedby="project-reflection-help" /></label>
                    <p id="project-reflection-help" className={styles.helper}>Choose a rating and add at least 3 characters before saving.</p>
                    <button type="button" className={styles.primaryButton} onClick={() => void saveReflection()} disabled={!selectedVerdict || selectedLesson.trim().length < 3 || selectedReflectionState === "submitting"}>{selectedReflectionState === "submitting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />} {selectedReflectionState === "saved" ? "Recorded" : "Save outcome note"}</button>
                  </div>
                  <footer><span>Provenance</span><div>{selectedArtifact.evidenceRefs.map((reference) => <code key={reference}>{reference}</code>)}</div></footer>
                </article> : null}
              </div> : <div className={styles.emptyRow}><FileCheck2 size={20} aria-hidden="true" /><div><strong>No linked outputs available</strong><p>Outputs linked to this project’s work items will appear here with their recorded status and evidence.</p></div></div>}
            </section>

            <WorkspaceLibrary
              title={`${selected.title} library`}
              description="Assets linked to this project keep their source scope, version, and citation beside the work that produced or uses them."
              kinds={PROJECT_LIBRARY_KINDS}
              projectId={selected.id}
              compact
              limit={12}
              refreshKey={`${selected.updatedAt}:${selected.artifacts?.length || 0}`}
              className={styles.library}
            />
            <div className={styles.sharedMemory}><ProjectSharedMemory
              projectId={selected.id}
              projectTitle={selected.title}
            /></div>
            </> : null}
          </> : loading ? <div className={styles.loading} aria-hidden="true"><span /><span /><span /></div> : error || !hasLoaded ? <div className={styles.emptyState}><AlertTriangle size={24} aria-hidden="true" /><h2>Projects unavailable</h2><p>Retry the workspace read to load your projects and their plans.</p><button type="button" className={styles.button} onClick={() => void load()}>Retry</button></div> : <div className={styles.emptyState}><FolderKanban size={24} aria-hidden="true" /><h2>Create your first project</h2><p>Add an outcome to begin planning tasks and keeping their outputs together.</p><button type="button" className={styles.primaryButton} onClick={() => setShowCreate(true)}><Plus size={16} aria-hidden="true" /> New project</button></div>}
        </section>
      </div>
    </div>
  );
}

const PROJECT_BOARD_COLUMNS = [
  { id: "ready", label: "Ready", detail: "No active workflow state available" },
  { id: "working", label: "Working", detail: "Queued, running, or paused" },
  { id: "attention", label: "Needs you", detail: "Approval or intervention" },
  { id: "closed", label: "Closed", detail: "Recorded terminal outcomes" },
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
  onExecute: (action: "configure" | "start" | "pause" | "resume" | "sync" | "approve" | "retry", taskId?: string) => Promise<void>;
}) {
  const boardRef = useRef<HTMLElement>(null);
  const moveButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const taskCardsRef = useRef(new Map<string, HTMLElement>());
  const grouped = new Map(PROJECT_BOARD_COLUMNS.map((column) => [column.id, [] as ProjectTask[]]));
  for (const task of project.tasks) grouped.get(projectBoardColumn(task))!.push(task);
  const moveBlocked = project.status !== "active"
    ? "Reopen this project to change task status."
    : ["running", "waiting_approval"].includes(project.executionStatus)
      ? "Manual task status changes are unavailable while execution is running or waiting for approval."
      : undefined;

  async function moveBoardTask(task: ProjectTask, trigger: HTMLButtonElement) {
    const restoreFocus = document.activeElement === trigger;
    const projectId = project.id;
    await onMoveTask(task);
    // Moving across columns remounts the task. Only the initiating action may
    // restore its focus; passive refreshes and later user navigation must not.
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      if (boardRef.current?.dataset.projectId !== projectId) return;
      if (document.activeElement !== trigger && document.activeElement !== document.body && document.activeElement !== null) return;
      const nextButton = moveButtonsRef.current.get(task.id);
      if (nextButton && !nextButton.disabled) nextButton.focus();
      else taskCardsRef.current.get(task.id)?.focus();
    });
  }

  return <section ref={boardRef} className={styles.executionBoard} data-project-id={project.id} aria-labelledby="project-board-title">
    <div className={styles.boardHeading}>
      <div><h3 id="project-board-title">Execution board</h3><p>The latest loaded task states and workflow status.</p></div>
      <span>Snapshot · project updated {formatTimestamp(project.updatedAt)}</span>
    </div>
    {moveBlocked ? <p id="project-board-move-help" className={styles.helper}>{moveBlocked}</p> : null}
    {executionBusy ? <p id="project-board-execution-help" className={styles.helper}>An execution request is in progress. Approval and retry are unavailable until it finishes.</p> : null}
    <div className={styles.boardColumns}>
      {PROJECT_BOARD_COLUMNS.map((column) => <section key={column.id} className={styles.boardColumn} data-column={column.id} aria-labelledby={`project-column-${column.id}`}>
        <header><div><h4 id={`project-column-${column.id}`}>{column.label}</h4><p>{column.detail}</p></div><strong>{grouped.get(column.id)!.length}</strong></header>
        <div className={styles.boardTasks}>
          {grouped.get(column.id)!.length ? grouped.get(column.id)!.map((task) => {
            const agent = agentFor(workItemAssignedAgent(task));
            const workflowStatus = workItemWorkflowStatus(task);
            const taskDomId = `project-board-${encodeURIComponent(project.id)}-${encodeURIComponent(task.id)}`;
            return <article
              key={task.id}
              ref={(node) => { if (node) taskCardsRef.current.set(task.id, node); else taskCardsRef.current.delete(task.id); }}
              tabIndex={-1}
              className={styles.boardTask}
              data-status={task.workItem.status.status}
              aria-labelledby={`${taskDomId}-title`}
            >
              <div className={styles.boardTaskMeta}><span className={styles.priority} data-priority={task.priority}>{task.priority} priority</span><span>{canonicalWorkItemStatusLabel(task.workItem.status.status)}</span></div>
              <h5 id={`${taskDomId}-title`}>{task.title}</h5>
              {task.detail ? <p className={styles.boardTaskDetail}>{task.detail}</p> : null}
              {task.executionError ? <p className={styles.taskError}><AlertTriangle size={16} aria-hidden="true" /><span>{task.executionError}</span></p> : null}
              <dl className={styles.boardFacts}>
                <div><dt>Agent</dt><dd>{agent.name}</dd></div>
                <div><dt>Evidence</dt><dd>{task.workItem.artifacts.count} artifact{task.workItem.artifacts.count === 1 ? "" : "s"}</dd></div>
                <div><dt>Cost</dt><dd>{canonicalWorkItemCostLabel(task.workItem.cost)}</dd></div>
              </dl>
              <footer className={styles.boardTaskActions}>
                {workflowStatus === "waiting_approval" ? <button type="button" className={styles.primaryButton} onClick={() => void onExecute("approve", task.id)} disabled={Boolean(executionBusy)} aria-label={`Approve ${task.title}`} aria-describedby={executionBusy ? "project-board-execution-help" : undefined}>Approve</button> : workflowStatus === "failed" ? <button type="button" className={styles.button} onClick={() => void onExecute("retry", task.id)} disabled={Boolean(executionBusy)} aria-label={`Retry ${task.title}`} aria-describedby={executionBusy ? "project-board-execution-help" : undefined}>Retry</button> : task.workItem.execution.workflowRunId ? <span className={styles.boardWorkflow}>{workflowStatus ? workflowLabel(workflowStatus) : "Workflow status unavailable"}</span> : <Link className={styles.button} href={commandHref(project, task)} aria-label={`Open ${task.title} in Command`}>Open in Command <ArrowRight size={16} aria-hidden="true" /></Link>}
                <button
                  type="button"
                  ref={(node) => { if (node) moveButtonsRef.current.set(task.id, node); else moveButtonsRef.current.delete(task.id); }}
                  className={styles.button}
                  onClick={(event) => void moveBoardTask(task, event.currentTarget)}
                  disabled={actingId === task.id || project.status !== "active" || ["running", "waiting_approval"].includes(project.executionStatus)}
                  aria-label={`${taskIsClosed(task) ? "Reopen" : "Advance"} ${task.title}`}
                  aria-describedby={actingId === task.id ? `${taskDomId}-moving` : moveBlocked ? "project-board-move-help" : undefined}
                >{taskIsClosed(task) ? "Reopen" : "Advance"}</button>
              </footer>
              {actingId === task.id ? <p id={`${taskDomId}-moving`} className={styles.helper}>Updating this task…</p> : null}
            </article>;
          }) : <div className={styles.boardEmpty}><Circle size={16} aria-hidden="true" /><span>No tasks in this state.</span></div>}
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
  return ({ idle: "Execution is idle", running: "Project execution is running", paused: "Project execution is paused", waiting_approval: "Execution needs approval", completed: "Execution is marked completed", failed: "Execution needs attention" })[status];
}
function executionDescription(status: Project["executionStatus"], mode: Project["autonomyMode"]) {
  if (status === "waiting_approval") return "Review the highlighted workflow before the agent team continues.";
  if (status === "failed") return "Inspect the failed task, retry it, or take over in Command.";
  if (status === "completed") return "Review each task’s recorded outcome in the snapshot below.";
  if (status === "paused") return "Resume to continue with the saved execution settings.";
  if (status === "running") return `${mode === "autonomous" ? "Autonomous" : "Supervised"} execution respects dependencies, budget, and tool policies.`;
  return "Set the operating limits, then start eligible tasks through governed workflows.";
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
/**
 * The projects with one of them read again. The read replaces its fields, and
 * any task or artifact it left out stays: the route returns a bounded page of
 * each, and neither is ever deleted.
 */
export function withRefreshedProject(projects: Project[], projectId: string, value: unknown) {
  const refreshed = normalizeProjects([value])?.[0];
  if (!refreshed || refreshed.id !== projectId) return projects;
  return projects.map((project) => project.id === projectId
    ? {
        ...project,
        ...refreshed,
        tasks: withUnreadKept(refreshed.tasks, project.tasks),
        artifacts: withUnreadKept(refreshed.artifacts, project.artifacts),
      }
    : project);
}
function withUnreadKept<T extends { id: string }>(read: T[], known: T[]) {
  const readIds = new Set(read.map((item) => item.id));
  return [...read, ...known.filter((item) => !readIds.has(item.id))];
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
async function readJson(path: string, init?: RequestInit) {
  const read = async () => {
    const response = await fetch(path, { cache: "no-store", ...init });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload.message || payload.error || `${path} returned ${response.status}`));
    return payload as Record<string, unknown>;
  };
  // A write is counted, so a refresh read meanwhile cannot undo it.
  return init?.method && init.method !== "GET" ? runProjectWrite(read) : read();
}
function message(error: unknown) { return error instanceof Error ? error.message : "Projects could not be updated."; }
