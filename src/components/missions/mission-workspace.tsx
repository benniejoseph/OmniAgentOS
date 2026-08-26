"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowRight,
  Bot,
  Box,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCode2,
  FolderOutput,
  Globe2,
  Loader2,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TriangleAlert,
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

type CapabilitySurface = {
  id: "terminal" | "files" | "browser";
  title: string;
  eyebrow: string;
  description: string;
  status: "ready" | "connected" | "planned";
  authority: string;
  href: string;
  capability?: CapabilityDescriptor;
};

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
  const {
    session,
    status: sessionStatus,
    error: sessionError,
    refresh: refreshSession,
  } = useWorkspaceSession();
  const hasInitialWorkspace = initialMissions !== undefined && initialCapabilities !== undefined;
  const [missions, setMissions] = useState<MissionSummaryView[]>(initialMissions || []);
  const [details, setDetails] = useState<Record<string, MissionDetailView>>(
    initialDetail ? { [initialDetail.mission.id]: initialDetail } : {},
  );
  const detailsRef = useRef(details);
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>(initialCapabilities || []);
  const initialSelectionId = initialMissionId || initialDetail?.mission.id || initialMissions?.[0]?.id || "";
  const baseSelectionRef = useRef(initialDetail?.mission.id || initialMissions?.[0]?.id || "");
  const [selectedId, setSelectedId] = useState(initialSelectionId);
  const [loading, setLoading] = useState(!hasInitialWorkspace);
  const [showLoading, setShowLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState<MissionSummaryView["priority"]>("normal");
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("Mission control is ready.");
  const [asOf, setAsOf] = useState(initialAsOf);
  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const available = Boolean(session && (!session.authEnabled || session.authenticated));
  const selectedDetail = selectedId ? details[selectedId] : undefined;
  const selectedMission = missions.find((mission) => mission.id === selectedId) || selectedDetail?.mission;
  const selectedMissionStatus = selectedMission?.status;
  const sessionProblem = sessionStatus === "error"
    ? sessionError || "Your Asael session could not be verified."
    : sessionStatus === "ready" && !available
      ? "Sign in to open Mission control."
      : undefined;
  const displayError = error || sessionProblem;
  const workspaceLoading = loading && !sessionProblem;

  useEffect(() => {
    detailsRef.current = details;
  }, [details]);

  useEffect(() => {
    const routeMissionId = missionIdFromPath(pathname);
    const nextId = routeMissionId || (
      pathname === "/app/missions"
        ? baseSelectionRef.current || missions[0]?.id || ""
        : ""
    );
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
    if (hasInitialWorkspace) return;
    if (!available || sessionStatus !== "ready") return;
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
        const nextMissions = missionPayload.missions as MissionSummaryView[];
        setMissions(nextMissions);
        setCapabilities((capabilityPayload.capabilities || []) as CapabilityDescriptor[]);
        setSelectedId((current) => current || nextMissions[0]?.id || "");
        setError(undefined);
      } catch (loadError) {
        if (!controller.signal.aborted) setError(message(loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadWorkspace();
    return () => controller.abort();
  }, [available, hasInitialWorkspace, sessionStatus]);

  useEffect(() => {
    if (!available || sessionStatus !== "ready" || !selectedId || details[selectedId]) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const detail = await readJson(`/api/missions/${encodeURIComponent(selectedId)}`, {
          signal: controller.signal,
        }) as MissionDetailView;
        if (!controller.signal.aborted) {
          setDetails((current) => ({ ...current, [selectedId]: detail }));
          setMissions((current) => current.some((mission) => mission.id === detail.mission.id)
            ? current.map((mission) => mission.id === detail.mission.id ? detail.mission : mission)
            : [detail.mission, ...current]);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) setError(message(loadError));
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }
    void loadDetail();
    return () => controller.abort();
  }, [available, details, selectedId, sessionStatus]);

  useEffect(() => {
    if (
      !available ||
      sessionStatus !== "ready" ||
      !selectedId ||
      !selectedMissionStatus ||
      !["queued", "running", "waiting"].includes(selectedMissionStatus)
    ) return;
    let stopped = false;
    let inFlight = false;
    let cursor = initialDetail?.mission.id === selectedId
      ? initialEventCursor
      : 0;
    let visibleStatus = detailsRef.current[selectedId]?.mission.status;
    let visibleUpdatedAt = detailsRef.current[selectedId]?.mission.updatedAt;
    let consecutiveFailures = 0;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(
        () => void pollMissionEvents(),
        missionEventPollDelay(consecutiveFailures),
      );
    };

    const pollMissionEvents = async () => {
      timer = undefined;
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      controller = new AbortController();
      try {
        const payload = await readJson(
          `/api/missions/${encodeURIComponent(selectedId)}/events?afterSeq=${cursor}&limit=25`,
          { signal: controller.signal },
        );
        const events = Array.isArray(payload.events) ? payload.events : [];
        const nextCursor = missionEventCursor(payload.cursor, cursor);
        const missionProjection = missionEventProjection(payload.mission);
        const projectionChanged = Boolean(
          missionProjection &&
          (!visibleStatus ||
            missionProjection.status !== visibleStatus ||
            missionProjection.updatedAt !== visibleUpdatedAt),
        );
        if (events.length > 0 || projectionChanged) {
          const detail = await readJson(`/api/missions/${encodeURIComponent(selectedId)}`, {
            signal: controller.signal,
          }) as MissionDetailView;
          if (stopped) return;
          setDetails((current) => ({ ...current, [selectedId]: detail }));
          setMissions((current) => current.map((mission) =>
            mission.id === detail.mission.id ? detail.mission : mission
          ));
          visibleStatus = detail.mission.status;
          visibleUpdatedAt = detail.mission.updatedAt;
        }
        cursor = nextCursor;
        consecutiveFailures = 0;
      } catch {
        if (!controller.signal.aborted) consecutiveFailures += 1;
        // Keep the durable projection visible and retry with bounded backoff.
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

  const surfaces = useMemo(() => capabilitySurfaces(capabilities), [capabilities]);
  const activeCount = missions.filter((mission) =>
    ["queued", "running", "waiting"].includes(mission.status)
  ).length;
  const completedCount = missions.filter((mission) => mission.status === "succeeded").length;

  function selectMission(id: string) {
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
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), objective: objective.trim(), priority }),
      });
      const mission = payload.mission as MissionSummaryView;
      setMissions((current) => [mission, ...current.filter((item) => item.id !== mission.id)]);
      setSelectedId(mission.id);
      setTitle("");
      setObjective("");
      setPriority("normal");
      setShowCreate(false);
      setAnnouncement(`${mission.title} was created as a draft mission.`);
      pushMissionHistory(mission.id);
    } catch (createError) {
      setError(message(createError));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className={styles.shell} aria-busy={workspaceLoading || detailLoading}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}><Radio size={12} aria-hidden="true" /> Autonomous workbench</p>
          <h1>Missions</h1>
          <p>Outcomes Asael can plan, advance, verify, and learn from over time.</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.signal} title="Mission state is stored in the durable ledger">
            <i /> Mission ledger active
          </div>
          <button type="button" onClick={() => setShowCreate((current) => !current)}>
            {showCreate ? <X size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
            {showCreate ? "Close" : "New mission"}
          </button>
        </div>
      </header>

      <div className={styles.metrics} aria-label="Mission overview">
        <span><strong>{activeCount}</strong> active</span>
        <span><strong>{missions.length}</strong> total</span>
        <span><strong>{completedCount}</strong> completed outcomes</span>
        <span><strong>{capabilities.length}</strong> discoverable capabilities</span>
      </div>

      {showCreate ? (
        <form className={styles.createForm} onSubmit={createMission}>
          <div>
            <label htmlFor="mission-title">Mission</label>
            <input id="mission-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} placeholder="Prepare the quarterly strategy" autoFocus />
          </div>
          <div className={styles.objectiveField}>
            <label htmlFor="mission-objective">Observable outcome</label>
            <textarea id="mission-objective" value={objective} onChange={(event) => setObjective(event.currentTarget.value)} maxLength={4000} rows={2} placeholder="Describe what must be true when Asael is done." />
          </div>
          <div>
            <label htmlFor="mission-priority">Priority</label>
            <select id="mission-priority" value={priority} onChange={(event) => setPriority(event.currentTarget.value as MissionSummaryView["priority"])}>
              <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
            </select>
          </div>
          <button type="submit" disabled={creating || !title.trim() || !objective.trim()}>
            {creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />}
            Create draft
          </button>
        </form>
      ) : null}

      {displayError ? (
        <div className={styles.error} role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{displayError}</span>
          {sessionStatus === "ready" && !available
            ? <Link href="/login">Sign in</Link>
            : <button type="button" onClick={() => sessionStatus === "error" ? void refreshSession() : window.location.reload()}>Retry</button>}
        </div>
      ) : null}

      <div className={styles.workspace}>
        <aside className={styles.rail} aria-label="Mission list">
          <div className={styles.railHeading}><span>Mission queue</span><strong>{missions.length}</strong></div>
          {workspaceLoading ? (showLoading ? <MissionListSkeleton /> : <div className={styles.loadingReserve} aria-hidden="true" />) : missions.length ? missions.map((mission) => (
            <button key={mission.id} type="button" aria-pressed={selectedId === mission.id} className={clsx(styles.missionItem, selectedId === mission.id && styles.missionItemSelected)} onClick={() => selectMission(mission.id)}>
              <span className={clsx(styles.statusDot, statusTone(mission.status, styles))} />
              <span>
                <strong>{mission.title}</strong>
                <small>{statusLabel(mission.status)} · {relativeTime(mission.updatedAt, asOf)}</small>
              </span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )) : (
            <div className={styles.emptyRail}>
              <BrainCircuit size={21} aria-hidden="true" />
              <p>No missions yet.</p>
              <button type="button" onClick={() => setShowCreate(true)}>Create the first</button>
            </div>
          )}
        </aside>

        <div className={styles.canvas}>
          {selectedMission ? (
            <>
              <div className={styles.outcomeHeader}>
                <div>
                  <div className={styles.outcomeMeta}>
                    <span className={clsx(styles.statusPill, statusTone(selectedMission.status, styles))}>{statusLabel(selectedMission.status)}</span>
                    <span>{selectedMission.priority} priority</span>
                    <span>{selectedMission.source}</span>
                  </div>
                  <h2>{selectedMission.title}</h2>
                  <p>{selectedMission.objective}</p>
                </div>
                <div className={styles.outcomeMark} aria-hidden="true"><Sparkles size={22} /></div>
              </div>

              <div className={styles.missionActions}>
                {isTerminalMission(selectedMission.status)
                  ? <Link href="/app/command"><Zap size={14} aria-hidden="true" /> Start a follow-up mission</Link>
                  : <Link href={talkHref(selectedMission)}><Zap size={14} aria-hidden="true" /> Continue with Asael</Link>}
                <Link href="/app/approvals"><ShieldCheck size={14} aria-hidden="true" /> Review attention</Link>
                {selectedMission.status === "draft" ? <span>Drafts begin only when you hand them to Asael.</span> : <span>Every state change is written to the mission ledger.</span>}
              </div>

              <section className={styles.taskSection} aria-label="Mission plan">
                <div className={styles.sectionHeading}>
                  <div><p>Durable delegation</p><h3>Task and attempt graph</h3></div>
                  <span>{selectedDetail?.tasks.length || 0} tasks · {selectedDetail?.attempts.length || 0} attempts</span>
                </div>
                {detailLoading && !selectedDetail ? <CanvasSkeleton /> : selectedDetail?.tasks.length ? (
                  <div className={styles.taskList}>
                    {selectedDetail.tasks.slice(0, 30).map((task, index) => {
                      const attempts = selectedDetail.attempts.filter((attempt) => attempt.taskId === task.id);
                      return (
                        <article key={task.id} className={styles.task}>
                          <span className={styles.taskIndex}>{String(index + 1).padStart(2, "0")}</span>
                          <span className={clsx(styles.taskState, statusTone(task.status, styles))}>
                            {task.status === "succeeded" ? <Check size={13} aria-hidden="true" /> : <CircleDot size={13} aria-hidden="true" />}
                            <span className="sr-only">{task.status}</span>
                          </span>
                          <div><strong>{task.title}</strong><p>{task.definitionOfDone || task.instructions || "Completion contract will be attached before execution."}</p></div>
                          <small>{attempts.length} attempt{attempts.length === 1 ? "" : "s"}</small>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className={styles.emptyPlan}>
                    <Bot size={24} aria-hidden="true" />
                    <div><strong>No delegated tasks yet</strong><p>Continue in Talk and Asael will compile the outcome into durable work.</p></div>
                    <Link href={talkHref(selectedMission)}>Build the plan <ArrowRight size={13} aria-hidden="true" /></Link>
                  </div>
                )}
              </section>

              <section className={styles.capabilitySection} aria-label="Execution surfaces">
                <div className={styles.sectionHeading}>
                  <div><p>Progressive capability discovery</p><h3>Live work surfaces</h3></div>
                  <Link href="/app/connectors">Manage capabilities <ArrowRight size={13} aria-hidden="true" /></Link>
                </div>
                <div className={styles.capabilityGrid}>
                  {surfaces.map((surface) => <CapabilityCard key={surface.id} surface={surface} />)}
                </div>
              </section>
            </>
          ) : workspaceLoading ? (showLoading ? <CanvasSkeleton /> : <div className={styles.loadingReserve} aria-hidden="true" />) : (
            <div className={styles.emptyCanvas}>
              <Box size={30} aria-hidden="true" />
              <h2>Give an outcome a durable home</h2>
              <p>A mission is the long-running contract between you and Asael—not a disposable chat turn.</p>
              <button type="button" onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> New mission</button>
            </div>
          )}
        </div>

        <aside className={styles.inspector} aria-label="Mission proof and attention">
          <div className={styles.inspectorHeading}><span>Attention & proof</span><ShieldCheck size={15} aria-hidden="true" /></div>
          <InspectorBlock icon={<Clock3 size={14} />} label="Current state" value={selectedMission ? statusLabel(selectedMission.status) : "Idle"} detail={selectedMission?.startedAt ? `Started ${relativeTime(selectedMission.startedAt, asOf)}` : "No executor lease active"} />
          <InspectorBlock icon={<Bot size={14} />} label="Attempts" value={String(selectedDetail?.attempts.length || 0)} detail={attemptDetail(selectedDetail)} />
          <InspectorBlock icon={<FolderOutput size={14} />} label="Evidence" value={String(selectedDetail?.artifacts.length || 0)} detail={selectedDetail?.artifacts[0]?.title || "No artifacts recorded"} />
          <div className={styles.proofList}>
            <p>Recent evidence</p>
            {selectedDetail?.artifacts.length ? selectedDetail.artifacts.slice(0, 5).map((artifact) => (
              <div key={artifact.id}><FileCode2 size={13} aria-hidden="true" /><span><strong>{artifact.title}</strong><small>{artifact.kind} · {relativeTime(artifact.createdAt, asOf)}</small></span></div>
            )) : <span>Completed outputs, receipts, and files will appear here.</span>}
          </div>
        </aside>
      </div>
    </section>
  );
}

function CapabilityCard({ surface }: { surface: CapabilitySurface }) {
  const Icon = surface.id === "terminal" ? TerminalSquare : surface.id === "files" ? FileCode2 : Globe2;
  return (
    <article className={clsx(styles.capabilityCard, surface.status === "planned" && styles.capabilityPlanned)}>
      <header>
        <span><Icon size={16} aria-hidden="true" /></span>
        <div><p>{surface.eyebrow}</p><h4>{surface.title}</h4></div>
        <em><i /> {surface.status === "planned" ? "setup needed" : "registered"}</em>
      </header>
      <p>{surface.description}</p>
      <div><span>Authority</span><strong>{surface.authority}</strong></div>
      <footer>
        <code>{surface.capability?.id || "adapter.not_connected"}</code>
        <Link href={surface.href}>{surface.status === "planned" ? "Connect" : "Open"} <ArrowRight size={12} aria-hidden="true" /></Link>
      </footer>
    </article>
  );
}

function InspectorBlock({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <div className={styles.inspectorBlock}><span>{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></div>;
}

function MissionListSkeleton() {
  return <div className={styles.listSkeleton} aria-hidden="true">{[0, 1, 2, 3].map((item) => <i key={item} />)}</div>;
}

function CanvasSkeleton() {
  return <div className={styles.canvasSkeleton} aria-hidden="true"><i /><i /><i /><i /></div>;
}

function capabilitySurfaces(capabilities: CapabilityDescriptor[]): CapabilitySurface[] {
  const browser = capabilities.find((item) => item.id === "web.search" || /browser|web\.search/i.test(`${item.id} ${item.name}`));
  const files = capabilities.find((item) => item.id === "knowledge.ingest" || /file|drive|knowledge\.ingest/i.test(`${item.id} ${item.name}`));
  const terminal = capabilities.find((item) => /terminal|shell|command\.exec/i.test(`${item.id} ${item.name}`));
  return [
    {
      id: "terminal", title: "Terminal", eyebrow: "Machine execution",
      description: terminal ? "A governed command surface is available to assigned agents." : "Command execution needs a local or remote terminal adapter before Asael can use it.",
      status: terminal ? "connected" : "planned", authority: terminal ? authorityLabel(terminal) : "No lease", href: "/app/connectors", capability: terminal,
    },
    {
      id: "files", title: "Files", eyebrow: "Artifact workspace",
      description: files ? "Capture, ingest, and retrieve file-backed knowledge with durable provenance." : "Connect a file source or use Capture to create the first artifact.",
      status: files ? "ready" : "planned", authority: files ? authorityLabel(files) : "Capture only", href: "/app/capture", capability: files,
    },
    {
      id: "browser", title: "Browser", eyebrow: "Live research",
      description: browser ? "Current web evidence is discoverable without loading every tool schema into the model." : "Live browser research is waiting for a governed search capability.",
      status: browser ? "ready" : "planned", authority: browser ? authorityLabel(browser) : "No lease", href: browser ? "/app/command" : "/app/connectors", capability: browser,
    },
  ];
}

function missionIdFromPath(pathname: string) {
  const match = pathname.match(/^\/app\/missions\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function pushMissionHistory(id: string) {
  const nextPath = `/app/missions/${encodeURIComponent(id)}`;
  if (window.location.pathname === nextPath) return;
  window.history.pushState(null, "", nextPath);
}

function authorityLabel(capability: CapabilityDescriptor) {
  return capability.approvalRequired ? `Approval · risk ${capability.riskLevel}` : `Policy · risk ${capability.riskLevel}`;
}

function statusTone(status: string, sheet: typeof styles) {
  if (["running", "succeeded"].includes(status)) return sheet.statusGood;
  if (["waiting", "blocked", "queued"].includes(status)) return sheet.statusWaiting;
  if (["failed", "canceled"].includes(status)) return sheet.statusDanger;
  return sheet.statusNeutral;
}

function statusLabel(status: MissionStatus) {
  return ({ draft: "Draft", queued: "Queued", running: "Running", waiting: "Needs attention", succeeded: "Completed", failed: "Failed", canceled: "Canceled", archived: "Archived" })[status];
}

function talkHref(mission: MissionSummaryView) {
  const prompt = "Continue this mission. Compile the next durable tasks, work only within governed authority, preserve evidence, and tell me about blockers.";
  return `/app/command?mission=${encodeURIComponent(mission.id)}&prompt=${encodeURIComponent(prompt)}`;
}

function isTerminalMission(status: MissionStatus) {
  return ["succeeded", "failed", "canceled", "archived"].includes(status);
}

function attemptDetail(detail?: MissionDetailView) {
  const latest = detail?.attempts[0];
  return latest ? `${latest.executorType} · ${latest.status}` : "No delegated execution yet";
}

function relativeTime(value: string, asOf: number) {
  if (!asOf) return "recently";
  const delta = asOf - Date.parse(value);
  if (!Number.isFinite(delta) || delta < 0) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function missionEventCursor(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= fallback
    ? value
    : fallback;
}

function missionEventProjection(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { status?: unknown; updatedAt?: unknown };
  const statuses: MissionStatus[] = [
    "draft", "queued", "running", "waiting", "succeeded", "failed", "canceled", "archived",
  ];
  if (
    typeof candidate.status !== "string" ||
    !statuses.includes(candidate.status as MissionStatus) ||
    typeof candidate.updatedAt !== "string"
  ) return undefined;
  return {
    status: candidate.status as MissionStatus,
    updatedAt: candidate.updatedAt,
  };
}

function missionEventPollDelay(consecutiveFailures: number) {
  const failureCount = Math.min(Math.max(consecutiveFailures, 0), 4);
  return Math.min(2_500 * (2 ** failureCount), 30_000);
}

async function readJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.message || payload.error || `${path} returned ${response.status}`));
  return payload as Record<string, unknown>;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Mission control could not complete the request.";
}
