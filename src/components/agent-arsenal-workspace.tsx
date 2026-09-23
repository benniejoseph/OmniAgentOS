"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  ClipboardCheck,
  Eye,
  Layers3,
  Loader2,
  Network,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import {
  AgentMascot,
  getAgentMascotIdentity,
} from "@/components/agents/agent-mascot";
import { AgentGrantEditor } from "@/components/agents/agent-grant-editor";
import { AgentAdaptationEditor } from "@/components/agents/agent-adaptation-editor";
import { AgentReleaseEditor } from "@/components/agents/agent-release-editor";
import { CouncilExecutionMap } from "@/components/agents/council-execution-map";
import { MoltbookAgentPanel } from "@/components/moltbook/moltbook-agent-panel";
import { upsertById } from "@/lib/agents/client-state";
import { arsenalAgents, type ArsenalAgent } from "@/lib/agents/arsenal";
import {
  safeParseAgentCouncilMap,
  type AgentCouncilMap,
} from "@/lib/agents/council-map-contract";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import type { AgentPerformance } from "@/lib/agents/performance";
import type {
  AgentSkill,
  CustomAgentDefinition,
  RequestCustomAgentDefinition,
} from "@/lib/skills/types";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";
import { isExactMoltbookAgentCapabilityBoundary } from "@/lib/moltbook/contracts";
import styles from "@/components/agent-arsenal-workspace.module.css";
import type { TrashActionPreviewV1 } from "@/lib/trash/contracts";

type ToolOption = {
  id: string;
  name: string;
  riskLevel: number;
  category: string;
};
type AgentView = ArsenalAgent & { custom?: RequestCustomAgentDefinition };
type EditorState = { kind: "agent" | "skill"; id?: string };
type WorkspaceView = "live" | "roster" | "skills" | "outcomes";
type BuilderSaveResult =
  | {
      kind: "agent";
      agent: RequestCustomAgentDefinition;
      message: string;
    }
  | { kind: "skill"; skill: AgentSkill; message: string };

export function AgentArsenalWorkspace({
  initialView,
  initialRunId,
  initialTaskId,
}: {
  initialView?: string;
  initialRunId?: string;
  initialTaskId?: string;
}) {
  const [activeView, setActiveView] = useState<WorkspaceView>(
    isWorkspaceView(initialView) ? initialView : "live",
  );
  const [selectedId, setSelectedId] = useState("atlas");
  const [customAgents, setCustomAgents] = useState<RequestCustomAgentDefinition[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [performance, setPerformance] = useState<AgentPerformance[]>([]);
  const [councilMap, setCouncilMap] = useState<AgentCouncilMap>();
  const [councilState, setCouncilState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [state, setState] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const [editor, setEditor] = useState<EditorState>();
  const [message, setMessage] = useState<string>();
  const loadController = useRef<AbortController | null>(null);
  const loadVersion = useRef(0);

  const agents = useMemo<AgentView[]>(
    () => [
      ...arsenalAgents,
      ...customAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        persona: agent.persona,
        status: agent.status === "ready" ? "ready" as const : "watching" as const,
        accent: agent.accent,
        capabilities: agent.skillIds
          .map((id) => skills.find((skill) => skill.id === id)?.name)
          .filter((value): value is string => Boolean(value)),
        tools: agent.toolIds.map(
          (id) => tools.find((tool) => tool.id === id)?.name || id,
        ),
        adaptationSignals: ["Run outcomes", "Your feedback", "Skill performance"],
        autonomy: `${agent.autonomy} · ${agent.approvalPolicy.replaceAll("_", " ")} approvals · ${agent.memoryScope} memory`,
        custom: agent,
      })),
    ],
    [customAgents, skills, tools],
  );
  const selected = agents.find((agent) => agent.id === selectedId) || agents[0];
  const selectedPerformance = performance.find(
    (item) => item.agentId === selected.id,
  );
  const selectedIdentity = getAgentMascotIdentity(selected.id);
  const selectedIsExactMoltbook = Boolean(
    selected.custom && isExactMoltbookAgentCapabilityBoundary(selected.custom),
  );

  async function load(saved?: BuilderSaveResult) {
    const version = ++loadVersion.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    try {
      const [agentPayload, skillPayload, toolPayload, performancePayload] =
        await Promise.all([
          readJson<{ agents?: RequestCustomAgentDefinition[] }>(
            "/api/agents?ownerScope=readable",
            { signal: controller.signal },
          ),
          readJson<{ skills?: AgentSkill[] }>("/api/skills", {
            signal: controller.signal,
          }),
          readJson<{ tools?: ToolOption[] }>("/api/tools", {
            signal: controller.signal,
          }),
          readJson<{ agents?: AgentPerformance[] }>(
            "/api/agents/performance",
            { signal: controller.signal },
          ),
        ]);
      if (controller.signal.aborted || version !== loadVersion.current) return;
      const nextAgents = agentPayload.agents || [];
      const nextSkills = skillPayload.skills || [];
      setCustomAgents(
        saved?.kind === "agent"
          ? upsertById(nextAgents, saved.agent)
          : nextAgents,
      );
      setSkills(
        saved?.kind === "skill"
          ? upsertById(nextSkills, saved.skill)
          : nextSkills,
      );
      setTools(toolPayload.tools || []);
      setPerformance(performancePayload.agents || []);
      setState("ready");
    } catch {
      if (controller.signal.aborted || version !== loadVersion.current) return;
      setState("unavailable");
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      loadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (activeView !== "live") return;
    let controller: AbortController | undefined;
    let timer: number | undefined;
    let disposed = false;
    const loadCouncil = async () => {
      if (document.hidden) return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const payload = await readJson<{ map?: unknown }>("/api/agents/council?limit=60", {
          signal: requestController.signal,
        });
        if (disposed || requestController.signal.aborted) return;
        const parsed = safeParseAgentCouncilMap(payload.map);
        if (!parsed) throw new Error("Agent Council response is invalid.");
        setCouncilMap(parsed);
        setCouncilState("ready");
      } catch {
        if (disposed || requestController.signal.aborted) return;
        setCouncilMap(undefined);
        setCouncilState("unavailable");
      } finally {
        if (
          !disposed &&
          !document.hidden &&
          controller === requestController
        ) {
          timer = window.setTimeout(() => void loadCouncil(), 12_000);
        }
      }
    };
    const onVisibilityChange = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else void loadCouncil();
    };
    timer = window.setTimeout(() => void loadCouncil(), 0);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controller?.abort();
    };
  }, [activeView]);

  function changeView(view: WorkspaceView) {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    if (view !== "live") {
      url.searchParams.delete("run");
      url.searchParams.delete("task");
    }
    window.history.replaceState(window.history.state, "", url);
  }

  async function removeSelectedAgent() {
    if (
      !selected.custom ||
      selected.custom.manageable !== true
    )
      return;
    const prepared = await readJson<{
      preview?: TrashActionPreviewV1;
      compensation?: string | null;
    }>(`/api/agents/${encodeURIComponent(selected.id)}?mode=trash-preview`);
    if (!prepared.preview) throw new Error("Agent trash preview was not returned.");
    if (!window.confirm(
      `${prepared.preview.effectSummary}\n\nExisting run history remains. Recovery is available in Settings → Data & privacy → Trash.`,
    )) return;
    await mutate(`/api/agents/${encodeURIComponent(selected.id)}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ preview: prepared.preview }),
    });
    setSelectedId("atlas");
    setMessage(`${selected.name} moved to Trash. Undo is available for 30 days.`);
    await load();
  }
  async function removeSkill(skill: AgentSkill) {
    if (!skill.manageable) return;
    const prepared = await readJson<{ preview?: TrashActionPreviewV1 }>(
      `/api/skills/${encodeURIComponent(skill.id)}?mode=trash-preview`,
    );
    if (!prepared.preview) throw new Error("Skill trash preview was not returned.");
    if (!window.confirm(
      `${prepared.preview.effectSummary}\n\nRecovery is available in Settings → Data & privacy → Trash.`,
    )) return;
    await mutate(`/api/skills/${encodeURIComponent(skill.id)}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ preview: prepared.preview }),
    });
    setMessage(`${skill.name} moved to Trash. Undo is available for 30 days.`);
    await load();
  }

  return (
    <div className={clsx("arsenal-shell workspace-enter", styles.shell)}>
      <header className="arsenal-header">
        <div className={styles.headerCopy}>
          <p className="arsenal-kicker">Living intelligence</p>
          <h1>
            Your <span>Agents</span>
          </h1>
          <p>
            Meet the specialists who help with your work. Each one has a clear
            purpose, a recognizable personality, and boundaries you control.
          </p>
          <div className="arsenal-header-meta" aria-label="Agent workspace summary">
            <span><strong>{agents.length}</strong> agents</span>
            <span><strong>{skills.length}</strong> skills</span>
            <span><strong>{tools.length}</strong> available actions</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditor({ kind: "skill" })}
            className="action-button"
          >
            <Layers3 size={15} aria-hidden="true" />
            New skill
          </button>
          <button
            type="button"
            onClick={() => setEditor({ kind: "agent" })}
            className="primary-button"
          >
            <Plus size={15} aria-hidden="true" />
            Create agent
          </button>
        </div>
      </header>
      {message ? (
        <p
          className="mx-4 mt-3 rounded-md border border-primary/25 bg-primary/8 px-3 py-2 text-sm text-primary"
          role="status"
        >
          {message}
        </p>
      ) : null}
      <WorkspaceTabs activeView={activeView} onChange={changeView} />
      {activeView === "live" ? (
        <CouncilExecutionMap
          map={councilMap}
          state={councilState}
          initialRunId={initialRunId}
          initialTaskId={initialTaskId}
          onTaskCanceled={(task) => setCouncilMap((current) =>
            current ? applyCouncilTaskCancellation(current, task) : current
          )}
        />
      ) : null}
      {activeView === "roster" ? (
        <div className="arsenal-layout">
        <nav className="arsenal-roster" aria-label="Agent roster">
          <div className={styles.rosterHeading}>
            <p className="arsenal-section-label">The companions</p>
            <span>{agents.filter((agent) => agent.status === "ready").length} ready now</span>
          </div>
          {agents.map((agent) => (
            <RosterButton
              key={agent.id}
              agent={agent}
              selected={selected.id === agent.id}
              onSelect={setSelectedId}
            />
          ))}
        </nav>
        <section className="arsenal-map" aria-label="Living agent constellation">
          <div className={styles.mapGlow} aria-hidden="true" />
          <div className={styles.mapStars} aria-hidden="true" />
          <div className="arsenal-map-heading">
            <div>
              <strong>Living constellation</strong>
              <span>Select a companion to reveal its craft and boundaries.</span>
            </div>
            <span><Network size={13} aria-hidden="true" />Atlas holds the center</span>
          </div>
          <div className="arsenal-map-grid" aria-hidden="true" />
          <svg
            className="arsenal-links"
            viewBox="0 0 700 560"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M350 280 L130 120 M350 280 L570 120 M350 280 L130 440 M350 280 L570 440" />
            <circle cx="350" cy="280" r="122" />
            <circle cx="350" cy="280" r="205" />
          </svg>
          {arsenalAgents.map((agent, index) => (
            <AgentNode
              key={agent.id}
              agent={agent}
              selected={selected.id === agent.id}
              onSelect={setSelectedId}
              className={
                [
                  "node-atlas",
                  "node-scout",
                  "node-forge",
                  "node-sentinel",
                  "node-memory",
                ][index]
              }
            />
          ))}
          {customAgents.length ? (
            <div className="agent-custom-orbit" aria-label="Custom agents">
              {customAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedId(agent.id)}
                  className={clsx(
                    `agent-${agent.accent}`,
                    selected.id === agent.id && "is-selected",
                  )}
                  aria-pressed={selected.id === agent.id}
                  aria-label={`${agent.name}, custom agent`}
                >
                  <AgentMascot
                    agentId={agent.id}
                    agentName={agent.name}
                    size="small"
                    decorative
                  />
                  <span>{agent.name}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="arsenal-map-legend">
            <Network size={14} aria-hidden="true" />
            <span>
              Intent travels through Atlas. Every action stays within your permissions.
            </span>
          </div>
        </section>
        <aside
          className={clsx("arsenal-inspector", `agent-${selected.accent}`)}
          aria-live="polite"
        >
          <p className="arsenal-inspector-label">Selected agent</p>
          <div className={styles.inspectorPortrait}>
            <AgentMascot
              agentId={selected.id}
              agentName={selected.name}
              size="hero"
            />
            <div>
              <span>{selectedIdentity.theme}</span>
              <strong>{selectedIdentity.companion}</strong>
              <q>{selectedIdentity.motto}</q>
            </div>
          </div>
          <div className="inspector-identity">
            <div>
              <p>{selected.role}</p>
              <h2>{selected.name}</h2>
            </div>
            <span
              className={clsx("agent-status-chip", `status-${selected.status}`)}
            >
              {statusDisplayLabel(selected.status)}
            </span>
          </div>
          <p className="inspector-description">{selected.description}</p>
          <section className={styles.personaCard} aria-label={`${selected.name} behavioral identity`}>
            <p>Charter</p>
            <strong>{selected.persona.charter}</strong>
            <div className={styles.personaGrid}>
              <div><span>Operating style</span><p>{selected.persona.operatingStyle}</p></div>
              <div><span>Voice</span><p>{selected.persona.voice}</p></div>
              <div><span>Visual identity</span><p>{selected.persona.visualIdentity}</p></div>
              <div><span>Escalation</span><p>{selected.persona.escalationBehavior}</p></div>
            </div>
            <div className={styles.personaDomains} aria-label="Allowed subject domains">
              {selected.persona.allowedDomains.map((domain) => <span key={domain}>{domain}</span>)}
            </div>
            <details>
              <summary>Success measures</summary>
              <ul>{selected.persona.successMeasures.map((measure) => <li key={measure}>{measure}</li>)}</ul>
            </details>
          </section>
          <AgentPerformancePanel
            performance={selectedPerformance}
            state={state}
          />
          {selectedIsExactMoltbook ? (
            <MoltbookAgentPanel
              key={selected.id}
              agentId={selected.id}
              agentName={selected.name}
            />
          ) : null}
          {!selectedIsExactMoltbook && (!selected.custom || (
            selected.custom.manageable === true &&
            selected.custom.releaseState !== "retired"
          )) ? (
            <div className="mt-4">
              <AgentAdaptationEditor
                agentId={selected.id}
                agentName={selected.name}
                compact
              />
            </div>
          ) : null}
          <InspectorList
            title="Skills"
            items={
              selected.capabilities.length
                ? selected.capabilities
                : ["No reusable skills assigned"]
            }
            icon="check"
          />
          <InspectorList
            title="What this Agent can do"
            items={
              selected.tools.length ? selected.tools : ["No actions assigned"]
            }
            icon="eye"
          />
          {selected.custom?.manageable === true && !selectedIsExactMoltbook ? (
            <div className="mt-4 grid gap-4">
              <AgentReleaseEditor
                agentId={selected.id}
                agentName={selected.name}
                compact
              />
              <AgentGrantEditor
                agentId={selected.id}
                agentName={selected.name}
                compact
              />
            </div>
          ) : selected.custom?.releaseState === "retired" ? (
            <div className="mt-4">
              <AgentReleaseEditor
                agentId={selected.id}
                agentName={selected.name}
                compact
              />
            </div>
          ) : (
            <div className="autonomy-note mt-4">
              <strong>Context and capability grants</strong>
              <p>
                {selected.custom
                  ? "This compatibility profile is read only. Its explicit authority cannot be changed here."
                  : "Built-in Agent authority is reviewed server policy. It has no user-authored explicit grant IDs."}
              </p>
            </div>
          )}
          <InspectorList
            title="Adaptation evidence"
            items={selected.adaptationSignals}
            icon="spark"
          />
          <div className="autonomy-note">
            <strong>Autonomy boundary</strong>
            <p>{selected.autonomy}</p>
          </div>
          <div className="mt-4 grid gap-2">
            {!selected.custom || selected.custom.selectable === true ? (
              <Link
                href={`/app/command?agent=${encodeURIComponent(selected.id)}`}
                className="primary-button justify-center"
              >
                Assign work to {selected.name}
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            ) : (
              <p className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-center text-sm text-muted-foreground">
                Read-only compatibility profile
              </p>
            )}
          {selected.custom?.manageable === true && !selectedIsExactMoltbook ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setEditor({ kind: "agent", id: selected.id })}
                  className="action-button justify-center"
                >
                  <Pencil size={14} aria-hidden="true" />
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void removeSelectedAgent()}
                  className="action-button justify-center text-danger"
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Delete
                </button>
              </div>
            ) : null}
            {selected.custom?.manageable === true && selectedIsExactMoltbook ? (
              <div className="autonomy-note">
                <strong>Isolated Moltbook identity</strong>
                <p>
                  Its exact actions and lifecycle are locked while its private
                  connection and append-only activity history are retained.
                  Pause or resume the connection from the Moltbook console.
                </p>
              </div>
            ) : null}
          </div>
        </aside>
        </div>
      ) : null}
      {activeView === "skills" ? (
        <section className="skill-studio" aria-labelledby="skill-studio-title">
        <div className="skill-studio-heading">
          <div>
            <p>Reusable behavior</p>
            <h2 id="skill-studio-title">Skills</h2>
            <span>
              Reusable instructions, actions, and knowledge conventions that can be
              composed across agents.
            </span>
          </div>
          <button
            type="button"
            className="action-button"
            onClick={() => setEditor({ kind: "skill" })}
          >
            <Plus size={15} aria-hidden="true" />
            Create skill
          </button>
        </div>
        <div className="skill-studio-list">
          {skills.map((skill) => (
            <article key={skill.id}>
              <div className="skill-studio-mark">
                <Wrench size={16} aria-hidden="true" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3>{skill.name}</h3>
                  <span>
                    {skill.builtIn ? "Asael core" : `v${skill.version}`}
                  </span>
                  <span>{skill.status}</span>
                </div>
                <p>{skill.description}</p>
                <small>
                  {skill.category} · {skill.toolIds.length} actions ·{" "}
                  {skill.tags.join(" · ") || "untagged"}
                </small>
              </div>
              <div className="skill-studio-actions">
                {skill.manageable ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditor({ kind: "skill", id: skill.id })}
                      aria-label={`Edit ${skill.name}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeSkill(skill)}
                      aria-label={`Delete ${skill.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : skill.builtIn ? (
                  <Check size={15} aria-label="Built in" />
                ) : null}
              </div>
            </article>
          ))}
        </div>
        </section>
      ) : null}
      {activeView === "outcomes" ? (
        <AgentOutcomes
          agents={agents}
          performance={performance}
          state={state}
        />
      ) : null}
      {editor ? (
        <BuilderDialog
          editor={editor}
          agents={customAgents}
          skills={skills}
          tools={tools}
          onClose={() => setEditor(undefined)}
          onSaved={async (result) => {
            setEditor(undefined);
            setMessage(result.message);
            if (result.kind === "agent") {
              setCustomAgents((current) => upsertById(current, result.agent));
              setSelectedId(result.agent.id);
            } else {
              setSkills((current) => upsertById(current, result.skill));
            }
            await load(result);
          }}
        />
      ) : null}
    </div>
  );
}

function applyCouncilTaskCancellation(
  map: AgentCouncilMap,
  task: {
    executionId: string;
    state: "canceled";
    lifecycleRevision: number;
    canCancel: false;
    updatedAt: string;
  },
) {
  const executions = map.executions.map((execution) => {
    const members = execution.members.map((member) => member.taskId === task.executionId
      ? {
          ...member,
          state: task.state,
          lifecycleRevision: task.lifecycleRevision,
          canCancel: false,
          updatedAt: task.updatedAt,
        }
      : member);
    return {
      ...execution,
      members,
      updatedAt: members.reduce(
        (latest, member) => member.updatedAt > latest ? member.updatedAt : latest,
        execution.updatedAt,
      ),
    };
  });
  const members = executions.flatMap((execution) => execution.members);
  const activeStates = new Set([
    "proposed",
    "accepted",
    "working",
    "waiting",
    "challenged",
    "completed_proposed",
  ]);
  return safeParseAgentCouncilMap({
    ...map,
    executions,
    summary: {
      ...map.summary,
      activeMemberCount: members.filter((member) => activeStates.has(member.state)).length,
      waitingMemberCount: members.filter((member) => member.state === "waiting").length,
      acceptedMemberCount: members.filter((member) => member.state === "result_accepted").length,
    },
  }) || map;
}

function WorkspaceTabs({
  activeView,
  onChange,
}: {
  activeView: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}) {
  const items: Array<{
    id: WorkspaceView;
    label: string;
    description: string;
    icon: typeof Activity;
  }> = [
    { id: "live", label: "Live work", description: "Executions and delegated teams", icon: Activity },
    { id: "roster", label: "Roster", description: "People, roles, and boundaries", icon: Users },
    { id: "skills", label: "Skills", description: "Reusable ways of working", icon: Layers3 },
    { id: "outcomes", label: "Outcomes", description: "Delivery and feedback evidence", icon: BarChart3 },
  ];
  return (
    <nav className={styles.workspaceTabs} aria-label="Agent workspace views">
      <div>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={activeView === item.id}
              className={activeView === item.id ? styles.activeTab : undefined}
              onClick={() => onChange(item.id)}
            >
              <Icon size={17} aria-hidden="true" />
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function AgentOutcomes({
  agents,
  performance,
  state,
}: {
  agents: AgentView[];
  performance: AgentPerformance[];
  state: "loading" | "ready" | "unavailable";
}) {
  if (state === "loading") {
    return (
      <section className={styles.outcomeNotice} aria-live="polite">
        <Loader2 size={20} className="animate-spin" aria-hidden="true" />
        <div><h2>Loading outcomes</h2><p>Reading verified delivery and feedback evidence.</p></div>
      </section>
    );
  }
  if (state === "unavailable") {
    return (
      <section className={styles.outcomeNotice} role="status">
        <ClipboardCheck size={20} aria-hidden="true" />
        <div><h2>Outcomes unavailable</h2><p>No delivery result was inferred while the performance projection is unavailable.</p></div>
      </section>
    );
  }

  const totals = performance.reduce(
    (result, item) => ({
      assignments: result.assignments + item.primaryAssignments,
      completed: result.completed + item.completed,
      verified: result.verified + item.verifiedAnswers,
      useful: result.useful + item.usefulOutcomes,
      needsWork: result.needsWork + item.needsWorkOutcomes,
    }),
    { assignments: 0, completed: 0, verified: 0, useful: 0, needsWork: 0 },
  );
  const reviewed = totals.useful + totals.needsWork;

  return (
    <section className={styles.outcomes} aria-labelledby="agent-outcomes-title">
      <header className={styles.outcomesHeader}>
        <div>
          <p>Evidence, not impressions</p>
          <h2 id="agent-outcomes-title">Agent outcomes</h2>
          <span>Verified deliveries and your recorded feedback, without invented rankings.</span>
        </div>
        <Link href="/app/results" className="action-button">Open Results <ArrowRight size={15} aria-hidden="true" /></Link>
      </header>
      <div className={styles.outcomeSummary} aria-label="Outcome summary">
        <OutcomeMetric label="Assignments" value={totals.assignments.toLocaleString()} />
        <OutcomeMetric label="Completed" value={totals.completed.toLocaleString()} />
        <OutcomeMetric label="Verified answers" value={totals.verified.toLocaleString()} />
        <OutcomeMetric label="Useful feedback" value={reviewed ? `${Math.round((totals.useful / reviewed) * 100)}%` : "No reviews"} />
      </div>
      <div className={styles.outcomeList}>
        {agents.map((agent) => {
          const item = performance.find((entry) => entry.agentId === agent.id);
          return (
            <article key={agent.id}>
              <AgentMascot agentId={agent.id} agentName={agent.name} size="small" decorative />
              <div className={styles.outcomeIdentity}>
                <span>{agent.role}</span>
                <strong>{agent.name}</strong>
                <small>{item?.lastActiveAt ? `Last active ${formatAgentTime(item.lastActiveAt)}` : "No recorded activity"}</small>
              </div>
              <OutcomeMetric label="Assignments" value={(item?.primaryAssignments || 0).toLocaleString()} />
              <OutcomeMetric label="Completion" value={item?.completionRate === null || item?.completionRate === undefined ? "No terminal runs" : `${Math.round(item.completionRate * 100)}%`} />
              <OutcomeMetric label="Verified" value={(item?.verifiedAnswers || 0).toLocaleString()} />
              <OutcomeMetric label="User approval" value={item?.userApprovalRate === null || item?.userApprovalRate === undefined ? "No reviews" : `${Math.round(item.userApprovalRate * 100)}%`} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function OutcomeMetric({ label, value }: { label: string; value: string }) {
  return <div className={styles.outcomeMetric}><span>{label}</span><strong>{value}</strong></div>;
}

function formatAgentTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isWorkspaceView(value: string | null | undefined): value is WorkspaceView {
  return value === "live" || value === "roster" || value === "skills" || value === "outcomes";
}

function BuilderDialog({
  editor,
  agents,
  skills,
  tools,
  onClose,
  onSaved,
}: {
  editor: EditorState;
  agents: RequestCustomAgentDefinition[];
  skills: AgentSkill[];
  tools: ToolOption[];
  onClose: () => void;
  onSaved: (result: BuilderSaveResult) => Promise<void>;
}) {
  const existingAgent =
    editor.kind === "agent"
      ? agents.find((item) => item.id === editor.id)
      : undefined;
  const existingSkill =
    editor.kind === "skill"
      ? skills.find((item) => item.id === editor.id)
      : undefined;
  const dialogRef = useRef<HTMLElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState(
    existingAgent?.name || existingSkill?.name || "",
  );
  const [role, setRole] = useState(existingAgent?.role || "Specialist");
  const [description, setDescription] = useState(
    existingAgent?.description || existingSkill?.description || "",
  );
  const [instructions, setInstructions] = useState(
    existingAgent?.instructions || existingSkill?.instructions || "",
  );
  const persona = existingAgent?.persona || DEFAULT_CUSTOM_AGENT_PERSONA;
  const [charter, setCharter] = useState(persona.charter);
  const [operatingStyle, setOperatingStyle] = useState(persona.operatingStyle);
  const [voice, setVoice] = useState(persona.voice);
  const [visualIdentity, setVisualIdentity] = useState(persona.visualIdentity);
  const [allowedDomains, setAllowedDomains] = useState(
    persona.allowedDomains.join(", "),
  );
  const [escalationBehavior, setEscalationBehavior] = useState(
    persona.escalationBehavior,
  );
  const [successMeasures, setSuccessMeasures] = useState(
    persona.successMeasures.join("\n"),
  );
  const [selectedSkills, setSelectedSkills] = useState(
    (existingAgent?.skillIds || []).filter((id) =>
      skills.some((skill) => skill.id === id && skill.selectable),
    ),
  );
  const assignedSkillLimitReached =
    selectedSkills.length >= MAX_ASSIGNED_SKILLS;
  const [selectedTools, setSelectedTools] = useState(
    existingAgent?.toolIds || existingSkill?.toolIds || [],
  );
  const [accent, setAccent] = useState(existingAgent?.accent || "emerald");
  const [modelPolicy, setModelPolicy] = useState(
    existingAgent?.modelPolicy || "auto",
  );
  const [autonomy, setAutonomy] = useState(
    existingAgent?.autonomy || "governed",
  );
  const [approvalPolicy, setApprovalPolicy] = useState(
    existingAgent?.approvalPolicy || "risk_based",
  );
  const [memoryScope, setMemoryScope] = useState(
    existingAgent?.memoryScope || "all",
  );
  const [category, setCategory] = useState(
    existingSkill?.category || "personal",
  );
  const [tags, setTags] = useState(existingSkill?.tags.join(", ") || "");
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    dialogRef.current
      ?.querySelector<HTMLElement>("input, select, textarea, button")
      ?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]",
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [onClose]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const body =
        editor.kind === "agent"
          ? {
              name,
              role,
              description,
              instructions,
              persona: {
                schemaVersion: 1,
                charter,
                operatingStyle,
                voice,
                visualIdentity,
                allowedDomains: splitList(allowedDomains, ","),
                escalationBehavior,
                successMeasures: splitList(successMeasures, "\n"),
              },
              status: existingAgent?.status || "ready",
              accent,
              modelPolicy,
              autonomy,
              approvalPolicy,
              memoryScope,
              skillIds: selectedSkills,
              toolIds: selectedTools,
            }
          : {
              name,
              description,
              instructions,
              category,
              status: existingSkill?.status || "active",
              toolIds: selectedTools,
              tags: tags
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              knowledgeTags: existingSkill?.knowledgeTags || [],
            };
      const base = editor.kind === "agent" ? "/api/agents" : "/api/skills";
      const request = {
        method: editor.id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
      const message = `${name} ${editor.id ? "updated" : "created"}.`;
      if (editor.kind === "agent") {
        const payload = await mutate<{ agent?: CustomAgentDefinition }>(
          editor.id ? `${base}/${encodeURIComponent(editor.id)}` : base,
          request,
        );
        if (!payload.agent) throw new Error("The saved agent was not returned.");
        await onSaved({
          kind: "agent",
          agent: agentAfterExactWrite(payload.agent),
          message,
        });
      } else {
        const payload = await mutate<{ skill?: AgentSkill }>(
          editor.id ? `${base}/${encodeURIComponent(editor.id)}` : base,
          request,
        );
        if (!payload.skill) throw new Error("The saved skill was not returned.");
        await onSaved({
          kind: "skill",
          skill: skillAfterExactWrite(payload.skill),
          message,
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
      setSaving(false);
    }
  }
  return (
    <div
      className="builder-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="builder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="builder-dialog-title"
      >
        <header>
          <div>
            <p>{editor.id ? "Edit" : "Create"}</p>
            <h2 id="builder-dialog-title">
              {editor.kind === "agent" ? "Agent" : "Skill"}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close builder">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Name
            <input
              required
              minLength={2}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder={
                editor.kind === "agent" ? "e.g. Ledger" : "e.g. Weekly review"
              }
            />
          </label>
          {editor.kind === "agent" ? (
            <label>
              Role
              <input
                required
                minLength={2}
                maxLength={120}
                value={role}
                onChange={(event) => setRole(event.currentTarget.value)}
                placeholder="Finance analyst"
              />
            </label>
          ) : (
            <label>
              Category
              <select
                value={category}
                onChange={(event) =>
                  setCategory(event.currentTarget.value as typeof category)
                }
              >
                {[
                  "research",
                  "creation",
                  "analysis",
                  "memory",
                  "automation",
                  "personal",
                ].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          )}
          <label className="full">
            Description
            <textarea
              required
              minLength={2}
              maxLength={700}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              rows={2}
              placeholder="What this intelligence is for."
            />
          </label>
          {editor.kind === "agent" ? (
            <>
              <p className={clsx("full", styles.personaNotice)}>
                Behavioral identity shapes how this Agent works and appears. It never grants actions, context, budgets, or approval authority.
              </p>
              <label className="full">
                Charter
                <textarea required minLength={2} maxLength={2000} value={charter} onChange={(event) => setCharter(event.currentTarget.value)} rows={2} placeholder="The durable purpose this Agent serves." />
              </label>
              <label className="full">
                Operating style
                <textarea required minLength={2} maxLength={2000} value={operatingStyle} onChange={(event) => setOperatingStyle(event.currentTarget.value)} rows={3} placeholder="How it approaches work, evidence, and verification." />
              </label>
              <label>
                Voice
                <textarea required minLength={2} maxLength={500} value={voice} onChange={(event) => setVoice(event.currentTarget.value)} rows={3} placeholder="Direct, warm, analytical…" />
              </label>
              <label>
                Visual identity
                <textarea required minLength={2} maxLength={500} value={visualIdentity} onChange={(event) => setVisualIdentity(event.currentTarget.value)} rows={3} placeholder="The visual motif carried across workspaces." />
              </label>
              <label className="full">
                Allowed subject domains
                <input required value={allowedDomains} onChange={(event) => setAllowedDomains(event.currentTarget.value)} placeholder="Research, finance, customer operations" />
              </label>
              <label className="full">
                Escalation behavior
                <textarea required minLength={2} maxLength={1000} value={escalationBehavior} onChange={(event) => setEscalationBehavior(event.currentTarget.value)} rows={3} placeholder="When and how this Agent asks for review or authority." />
              </label>
              <label className="full">
                Success measures
                <textarea required minLength={2} maxLength={4019} value={successMeasures} onChange={(event) => setSuccessMeasures(event.currentTarget.value)} rows={4} placeholder={"One measurable outcome per line\nEvidence is complete\nAcceptance criteria pass"} />
              </label>
            </>
          ) : null}
          <label className="full">
            Operating instructions
            <textarea
              required
              minLength={10}
              maxLength={12000}
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
              rows={6}
              placeholder="Define process, quality bar, boundaries, and expected output."
            />
          </label>
          {editor.kind === "agent" ? (
            <>
              <label>
                Model
                <select
                  value={modelPolicy}
                  onChange={(event) =>
                    setModelPolicy(
                      event.currentTarget.value as typeof modelPolicy,
                    )
                  }
                >
                  <option value="auto">Automatic routing</option>
                  <option value="openai_fast">OpenAI fast</option>
                  <option value="openai_reasoning">OpenAI reasoning</option>
                  <option value="gemini_fast">Gemini fast</option>
                  <option value="anthropic_fast">Claude fast</option>
                  <option value="anthropic_reasoning">Claude reasoning</option>
                </select>
              </label>
              <label>
                Memory
                <select
                  value={memoryScope}
                  onChange={(event) =>
                    setMemoryScope(
                      event.currentTarget.value as typeof memoryScope,
                    )
                  }
                >
                  <option value="all">All approved memory</option>
                  <option value="project">Project-aware (isolated until authorized)</option>
                  <option value="session">Session only</option>
                </select>
              </label>
              <label>
                Autonomy
                <select
                  value={autonomy}
                  onChange={(event) =>
                    setAutonomy(event.currentTarget.value as typeof autonomy)
                  }
                >
                  <option value="assist">Assist · read only</option>
                  <option value="governed">Governed execution</option>
                  <option value="execute">Execute within policy</option>
                </select>
              </label>
              <label>
                Approvals
                <select
                  value={approvalPolicy}
                  onChange={(event) =>
                    setApprovalPolicy(
                      event.currentTarget.value as typeof approvalPolicy,
                    )
                  }
                >
                  <option value="risk_based">Risk based</option>
                  <option value="always">Always for writes</option>
                  <option value="read_only">Read only</option>
                </select>
              </label>
              <label>
                Accent
                <select
                  value={accent}
                  onChange={(event) =>
                    setAccent(event.currentTarget.value as typeof accent)
                  }
                >
                  {["emerald", "blue", "amber", "violet", "rose"].map(
                    (item) => (
                      <option key={item}>{item}</option>
                    ),
                  )}
                </select>
              </label>
              <fieldset className="full">
                <legend>
                  Skills · {selectedSkills.length}/{MAX_ASSIGNED_SKILLS}
                </legend>
                <p className="builder-field-note" aria-live="polite">
                  Choose up to {MAX_ASSIGNED_SKILLS} focused playbooks. This
                  keeps every assigned Skill visible to the Agent as well as
                  available through its approved actions.
                </p>
                <div className="builder-choice-grid">
                  {skills
                    .filter((skill) =>
                      skill.status === "active" && skill.selectable
                    )
                    .map((skill) => (
                      <Choice
                        key={skill.id}
                        checked={selectedSkills.includes(skill.id)}
                        label={skill.name}
                        meta={skill.builtIn ? "core" : `v${skill.version}`}
                        disabled={
                          assignedSkillLimitReached &&
                          !selectedSkills.includes(skill.id)
                        }
                        onChange={() =>
                          setSelectedSkills(toggle(selectedSkills, skill.id))
                        }
                      />
                    ))}
                </div>
              </fieldset>
            </>
          ) : (
            <label>
              Tags
              <input
                value={tags}
                onChange={(event) => setTags(event.currentTarget.value)}
                placeholder="planning, personal, review"
              />
            </label>
          )}
          <fieldset className="full">
            <legend>Actions this {editor.kind === "agent" ? "Agent" : "Skill"} may use</legend>
            <p className="builder-field-note">
              Choose only the actions this {editor.kind === "agent" ? "Agent" : "Skill"} needs.
              Asael still applies your connection permissions and asks for approval when an action has consequences.
            </p>
            <div className="builder-choice-grid">
              {tools.map((tool) => (
                <Choice
                  key={tool.id}
                  checked={selectedTools.includes(tool.id)}
                  label={tool.name}
                  meta={`${actionSafetyLabel(tool.riskLevel)} · ${friendlyActionCategory(tool.category)}`}
                  onChange={() =>
                    setSelectedTools(toggle(selectedTools, tool.id))
                  }
                />
              ))}
            </div>
          </fieldset>
          {error ? (
            <p className="builder-error full" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="full">
            <button type="button" onClick={onClose} className="action-button">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="primary-button">
              {saving ? <Loader2 size={15} className="animate-spin" /> : null}
              {saving
                ? "Saving…"
                : editor.id
                  ? "Save changes"
                  : `Create ${editor.kind}`}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function Choice({
  checked,
  disabled = false,
  label,
  meta,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  meta: string;
  onChange: () => void;
}) {
  return (
    <label
      className={clsx(
        "builder-choice",
        checked && "is-selected",
        disabled && "is-disabled",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span>
        <strong>{label}</strong>
        <small>{meta}</small>
      </span>
    </label>
  );
}
function toggle(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}
function splitList(value: string, separator: string) {
  return [...new Set(value.split(separator).map((item) => item.trim()).filter(Boolean))];
}
function skillAfterExactWrite(skill: AgentSkill): AgentSkill {
  return { ...skill, selectable: true, manageable: true };
}
function agentAfterExactWrite(
  agent: CustomAgentDefinition,
): RequestCustomAgentDefinition {
  return { ...agent, selectable: true, manageable: true };
}
function statusDisplayLabel(status: ArsenalAgent["status"]) {
  return status === "ready" ? "Ready" : "Observing";
}
function RosterButton({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const identity = getAgentMascotIdentity(agent.id);
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      className={clsx(
        "arsenal-roster-item",
        `agent-${agent.accent}`,
        selected && "is-selected",
      )}
      aria-pressed={selected}
      aria-label={`${agent.name}, ${agent.role}, ${identity.companion}, ${agent.status}`}
    >
      <span className={styles.rosterMascot}>
        <AgentMascot
          agentId={agent.id}
          agentName={agent.name}
          size="small"
          decorative
        />
      </span>
      <span>
        <strong>{agent.name}</strong>
        <small>{agent.role}</small>
        <em>{identity.companion}</em>
      </span>
      <span
        className={clsx("agent-status-dot", `status-${agent.status}`)}
        aria-label={agent.status}
      />
    </button>
  );
}
function AgentNode({
  agent,
  selected,
  onSelect,
  className,
}: {
  agent: ArsenalAgent;
  selected: boolean;
  onSelect: (id: string) => void;
  className: string;
}) {
  const identity = getAgentMascotIdentity(agent.id);
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      className={clsx(
        "arsenal-node",
        `agent-${agent.accent}`,
        className,
        selected && "is-selected",
      )}
      aria-pressed={selected}
      aria-label={`${agent.name}, ${agent.role}, ${identity.companion}, ${agent.status}`}
    >
      <span className="node-signal" aria-hidden="true" />
      <AgentMascot
        agentId={agent.id}
        agentName={agent.name}
        size={agent.id === "atlas" ? "hero" : "large"}
        decorative
      />
      <span className={styles.nodeTheme}>{identity.theme}</span>
      <strong>{agent.name}</strong>
      <small>{identity.companion}</small>
    </button>
  );
}
function AgentPerformancePanel({
  performance,
  state,
}: {
  performance?: AgentPerformance;
  state: "loading" | "ready" | "unavailable";
}) {
  const completionRate = performance?.completionRate;
  return (
    <section className="agent-performance" aria-label="Agent performance">
      <div className="agent-performance-heading">
        <h3>Performance</h3>
        <span>
          {state === "loading"
            ? "Syncing"
            : state === "unavailable"
              ? "Offline"
              : "Live"}
        </span>
      </div>
      <div className="agent-performance-grid">
        <PerformanceMetric
          label="Assignments"
          value={
            state === "loading"
              ? "..."
              : String(performance?.primaryAssignments || 0)
          }
        />
        <PerformanceMetric
          label="Completion"
          value={
            state === "loading"
              ? "..."
              : completionRate == null
                ? "New"
                : `${Math.round(completionRate * 100)}%`
          }
        />
        <PerformanceMetric
          label="Verified"
          value={
            state === "loading"
              ? "..."
              : String(performance?.verifiedAnswers || 0)
          }
        />
        <PerformanceMetric
          label="Approval"
          value={
            state === "loading"
              ? "..."
              : performance?.userApprovalRate == null
                ? "New"
                : `${Math.round(performance.userApprovalRate * 100)}%`
          }
        />
      </div>
      {performance?.latestOutcomeNotes?.length ? (
        <div className="agent-latest-lessons">
          <strong>
            <ClipboardCheck size={13} /> Reviewed outcome notes
          </strong>
          <ul>
            {performance.latestOutcomeNotes.map((lesson) => (
              <li key={lesson}>{lesson}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
function PerformanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function InspectorList({
  title,
  items,
  icon,
}: {
  title: string;
  items: string[];
  icon: "check" | "eye" | "spark";
}) {
  const Icon = icon === "check" ? Check : icon === "eye" ? Eye : Sparkles;
  return (
    <section className="inspector-list">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <Icon size={13} aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function actionSafetyLabel(riskLevel: number) {
  if (riskLevel >= 3) return "Two-step approval";
  if (riskLevel >= 2) return "Asks before acting";
  if (riskLevel === 1) return "Low-impact action";
  return "Read only";
}

function friendlyActionCategory(category: string) {
  const normalized = category.trim().replaceAll(/[._-]+/g, " ");
  if (!normalized) return "Asael";
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok)
    throw new Error(payload.message || payload.error || "Request failed.");
  return payload;
}
async function mutate<T = unknown>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  if (!response.ok)
    throw new Error(payload.message || payload.error || "Request failed.");
  return payload as T;
}
