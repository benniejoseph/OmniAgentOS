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
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import {
  AgentIdentityMark,
} from "@/components/agents/agent-identity-mark";
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
import { customAgentInputSchema, skillInputSchema } from "@/lib/skills/schema";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import type { AgentPerformance } from "@/lib/agents/performance";
import type { AgentDailyLearningStatusV1 } from "@/lib/agents/learning-contracts";
import type {
  AgentSkill,
  RequestCustomAgentDefinition,
} from "@/lib/skills/types";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";
import { isExactMoltbookAgentCapabilityBoundary } from "@/lib/moltbook/contracts";
import styles from "@/components/agent-arsenal-workspace.module.css";
import { AgentsLifecycleBoundary, useAgentRead, useAgentsLifecycle } from "@/components/agents/agents-workspace-lifecycle";
import { agentsActionRequest, agentsRead, agentTrashPreview, agentTrashReceipt, builderReceipt, learningRead, performanceRead, readAgentsJson, sameAgentJson, skillsRead, toolsRead } from "@/components/agents-workspace-state";

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

export function AgentArsenalWorkspace(props: { initialView?: string; initialRunId?: string; initialTaskId?: string }) {
  return <AgentsLifecycleBoundary scope={JSON.stringify([props.initialView, props.initialRunId, props.initialTaskId])}><ArsenalWorkspace {...props} /></AgentsLifecycleBoundary>;
}
function ArsenalWorkspace({ initialView, initialRunId, initialTaskId }: { initialView?: string; initialRunId?: string; initialTaskId?: string }) {
  const { gate, busy, reason, session } = useAgentsLifecycle();
  const [activeView, setActiveView] = useState<WorkspaceView>(isWorkspaceView(initialView) ? initialView : "live");
  const [selectedId, setSelectedId] = useState("atlas");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [editor, setEditor] = useState<EditorState>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [visibleSkills, setVisibleSkills] = useState(30);
  const [visibleAgents, setVisibleAgents] = useState(30);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const rosterButtons = useRef(new Map<string, HTMLButtonElement>());
  const canceled = useRef(new Map<string, number>());
  const savedAgents = useRef(new Map<string, RequestCustomAgentDefinition>());
  const savedSkills = useRef(new Map<string, AgentSkill>());
  const trashed = useRef(new Map<string, string>());
  const agentRead = useAgentRead("/api/agents?ownerScope=readable", (payload) => {
    const rows = agentsRead(payload, session?.context?.tenantId);
    if (rows.some((row) => (trashed.current.has(`agent:${row.id}`) && Date.parse(row.updatedAt) <= Date.parse(trashed.current.get(`agent:${row.id}`)!))) || [...savedAgents.current.values()].some((old) => { const next = rows.find((row) => row.id === old.id); return Boolean(next && Date.parse(next.updatedAt) < Date.parse(old.updatedAt)); })) throw new Error("The Agent read predates a confirmed change. Last confirmed profiles are retained.");
    return rows;
  });
  const skillRead = useAgentRead("/api/skills", (payload) => {
    const rows = skillsRead(payload, session?.context?.tenantId);
    if (rows.some((row) => (trashed.current.has(`skill:${row.id}`) && Date.parse(row.updatedAt) <= Date.parse(trashed.current.get(`skill:${row.id}`)!))) || [...savedSkills.current.values()].some((old) => { const next = rows.find((row) => row.id === old.id); return Boolean(next && next.version < old.version); })) throw new Error("The Skill read predates a confirmed change. Last confirmed Skills are retained.");
    return rows;
  });
  const toolRead = useAgentRead("/api/tools", toolsRead);
  const outcomeRead = useAgentRead("/api/agents/performance", performanceRead);
  const councilRead = useAgentRead("/api/agents/council?limit=60", (payload) => {
    const map = safeParseAgentCouncilMap(payload.map);
    if (!map) throw new Error("The live work projection is unavailable.");
    if (map.executions.some((execution) => execution.members.some((member) => (canceled.current.get(member.taskId) || 0) > member.lifecycleRevision))) throw new Error("The live read predates a confirmed cancellation. Last confirmed details are retained.");
    return map;
  });
  const customAgents = useMemo(() => agentRead.data ?? [], [agentRead.data]);
  const skills = useMemo(() => skillRead.data ?? [], [skillRead.data]);
  const tools = useMemo(() => toolRead.data ?? [], [toolRead.data]);
  const performance = outcomeRead.data || [];
  const agents = useMemo<AgentView[]>(() => [...arsenalAgents, ...customAgents.map((agent) => ({
    id: agent.id, name: agent.name, role: agent.role, description: agent.description, persona: agent.persona,
    status: agent.status === "ready" ? "ready" as const : "watching" as const, accent: agent.accent,
    capabilities: agent.skillIds.map((id) => `${skills.find((skill) => skill.id === id)?.name || "Unavailable skill"} · ${id}`),
    tools: agent.toolIds.map((id) => `${tools.find((tool) => tool.id === id)?.name || "Unavailable action"} · ${id}`),
    adaptationSignals: ["Run outcomes", "Your feedback", "Skill performance"],
    autonomy: `${agent.autonomy} · ${agent.approvalPolicy.replaceAll("_", " ")} approvals · ${agent.memoryScope} memory`, custom: agent,
  }))], [customAgents, skills, tools]);
  const selected = agents.find((agent) => agent.id === selectedId);
  const learningReadState = useAgentRead(`/api/agents/${encodeURIComponent(selectedId)}/learning`, (payload) => learningRead(payload, selectedId));
  const selectedMoltbook = Boolean(selected?.custom && isExactMoltbookAgentCapabilityBoundary(selected.custom));
  const managementReady = !reason && agentRead.current && skillRead.current && toolRead.current;
  const filteredAgents = agents.filter((agent) => `${agent.name} ${agent.role} ${agent.id}`.toLowerCase().includes(query.toLowerCase()));
  const filteredSkills = skills.filter((skill) => `${skill.name} ${skill.id} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));
  const refreshCouncil = councilRead.refresh;
  const refreshLearning = learningReadState.refresh;
  useEffect(() => {
    if (activeView !== "live" && activeView !== "roster") return;
    const timer = window.setInterval(() => { if (!document.hidden && !gate.busy()) void (activeView === "live" ? refreshCouncil() : refreshLearning()); }, activeView === "live" ? 12_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [activeView, gate, refreshCouncil, refreshLearning]);
  function refreshAll() { if (gate.busy()) return; void agentRead.refresh(); void skillRead.refresh(); void toolRead.refresh(); void outcomeRead.refresh(); void councilRead.refresh(); void learningReadState.refresh(); }
  function changeView(view: WorkspaceView) {
    if (gate.busy()) return;
    setActiveView(view);
    const url = new URL(window.location.href); url.searchParams.set("view", view);
    if (view !== "live") { url.searchParams.delete("run"); url.searchParams.delete("task"); }
    window.history.replaceState(window.history.state, "", url);
  }
  function chooseAgent(id: string) {
    if (gate.busy()) return;
    setSelectedId(id); setMobileDetail(true);
    requestAnimationFrame(() => detailHeading.current?.focus());
  }
  async function remove(kind: "agent" | "skill", item: RequestCustomAgentDefinition | AgentSkill) {
    if (!managementReady || gate.busy() || !item.manageable) return;
    const path = `/api/${kind === "agent" ? "agents" : "skills"}/${encodeURIComponent(item.id)}`;
    // Preview owns the same synchronous slot as the effect, so selection cannot drift between them.
    const preparation = gate.begin(`${path}?mode=trash-preview`, "GET", undefined, `Review removal of ${item.name}`);
    if (!preparation) return;
    setError(undefined);
    try {
      const prepared = await readAgentsJson(preparation.path);
      if (!gate.current(preparation)) return;
      const preview = agentTrashPreview(prepared.preview, item.id, kind);
      if (!window.confirm(`${preview.effectSummary}\n\nExact ${kind} ID: ${item.id}\nRecovery is available in Settings → Data & privacy → Trash.`)) return;
      gate.finish(preparation, true);
      const token = gate.begin(path, "DELETE", { preview }, `Removing ${item.name}`, { id: item.id, updatedAt: item.updatedAt });
      if (!token) return;
      try {
        const payload = await agentsActionRequest(token);
        if (!gate.current(token)) return;
        const until = agentTrashReceipt(payload, preview);
        trashed.current.set(`${kind}:${item.id}`, item.updatedAt); savedAgents.current.delete(item.id); savedSkills.current.delete(item.id);
        if (kind === "agent") { agentRead.accept((current) => current?.filter((row) => row.id !== item.id)); setSelectedId("atlas"); }
        else skillRead.accept((current) => current?.filter((row) => row.id !== item.id));
        setMessage(`${item.name} moved to Trash. Recovery is available until ${until}.`);
        gate.finish(token, true);
      } catch (caught) { if (gate.current(token)) setError(caught instanceof Error ? caught.message : "Removal was not confirmed."); }
      finally { gate.finish(token, false); }
    } catch (caught) { if (gate.current(preparation)) setError(caught instanceof Error ? caught.message : "The removal preview is unavailable."); }
    finally { gate.finish(preparation, false); }
  }
  return <div className={styles.shell} data-testid="agents-workspace">
    <header className={styles.header}>
      <div><h1>Agents</h1><p>Follow the executing Agent, inspect its evidence, and manage its exact boundaries.</p></div>
      <div className={styles.actions}>
        <button className="secondary-button" disabled={Boolean(busy)} onClick={refreshAll}>Refresh Agents</button>
        <button className="secondary-button" disabled={Boolean(busy) || !managementReady} onClick={() => setEditor({ kind: "skill" })}><Layers3 size={16} aria-hidden="true" />New skill</button>
        <button className="primary-button" disabled={Boolean(busy) || !managementReady} onClick={() => setEditor({ kind: "agent" })}><Plus size={16} aria-hidden="true" />Create agent</button>
      </div>
    </header>
    <dl className={styles.readStates} aria-label="Agent source availability">
      <div><dt>Custom Agents</dt><dd>{agentRead.label}{agentRead.data ? ` · ${agentRead.data.length}` : ""}</dd></div>
      <div><dt>Skills</dt><dd>{skillRead.label}{skillRead.data ? ` · ${skillRead.data.length}` : ""}</dd></div>
      <div><dt>Actions</dt><dd>{toolRead.label}{toolRead.data ? ` · ${toolRead.data.length}` : ""}</dd></div>
      <div><dt>Outcomes</dt><dd>{outcomeRead.label}</dd></div>
    </dl>
    {reason ? <p className={styles.notice}>{reason}</p> : null}
    {!managementReady && !reason ? <p className={styles.notice}>Creation and profile changes require current Agent, Skill and action lists. Refresh unavailable sources to continue.</p> : null}
    {[agentRead.error, skillRead.error, toolRead.error, outcomeRead.error].filter(Boolean).length ? <details className={styles.notice}><summary>Source read details</summary>{[["Custom Agents",agentRead.error],["Skills",skillRead.error],["Actions",toolRead.error],["Outcomes",outcomeRead.error]].map(([label,value]) => value ? <p key={label}>{label}: {value}</p> : null)}</details> : null}
    <p role="status" className={styles.status}>{busy ? `Pending: ${busy}. The reviewed target is fixed until the response returns.` : message}</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <WorkspaceTabs activeView={activeView} onChange={changeView} disabled={Boolean(busy)} />
    {activeView === "live" ? <>
      <p className={styles.sourceStatus} role="status">{councilRead.label} · Bounded live work window.</p>
      {councilRead.error ? <p className={styles.error} role="alert">{councilRead.error}</p> : null}
      <CouncilExecutionMap map={councilRead.data} state={councilRead.loading ? "loading" : councilRead.error ? "unavailable" : "ready"} initialRunId={initialRunId} initialTaskId={initialTaskId} onTaskCanceled={(task) => { canceled.current.set(task.executionId, task.lifecycleRevision); councilRead.accept((current) => current ? applyCouncilTaskCancellation(current, task) : current); }} />
    </> : null}
    {/* Keep the selected inspector mounted across workspace views so local authority drafts survive. */}
    <div hidden={activeView !== "roster"} className={styles.rosterWorkspace} data-detail={mobileDetail}>
      <nav className={styles.roster} aria-label="Agent roster">
        <h2>Roster</h2><p>{arsenalAgents.length} built-in Agents · custom profiles {agentRead.label.toLowerCase()}.</p>
        <label>Search roster<input value={query} onChange={(event) => { setQuery(event.currentTarget.value); setVisibleAgents(30); }} type="search" /></label>
        {filteredAgents.slice(0, visibleAgents).map((agent) => <button ref={(node) => { if (node) rosterButtons.current.set(agent.id, node); else rosterButtons.current.delete(agent.id); }} key={agent.id} disabled={Boolean(busy)} onClick={() => chooseAgent(agent.id)} aria-pressed={selectedId === agent.id} className={styles.rosterRow}><AgentIdentityMark agentId={agent.id} agentName={agent.name} size="small" decorative /><span><strong>{agent.name}</strong><span>{agent.role}</span><small>{agent.id}</small><small>{agent.custom?.status || statusDisplayLabel(agent.status)}{agent.custom?.releaseState === "retired" ? " · retired" : ""}</small></span></button>)}
        {!filteredAgents.length ? <p>No loaded Agent matches this search.</p> : null}
        {filteredAgents.length > visibleAgents ? <button className="secondary-button" onClick={() => setVisibleAgents((count) => count + 30)}>Show more Agents</button> : null}
      </nav>
      <section className={styles.inspector} aria-label="Selected Agent">
        <button className={`${styles.back} secondary-button`} disabled={Boolean(busy)} onClick={() => { setMobileDetail(false); requestAnimationFrame(() => rosterButtons.current.get(selectedId)?.focus()); }}>Back to roster</button>
        {selected ? <>
          <div className={styles.identity}><AgentIdentityMark agentId={selected.id} agentName={selected.name} size="small" decorative /><div><p>{selected.role}</p><h2 ref={detailHeading} tabIndex={-1}>{selected.name}</h2><p>Agent ID: {selected.id}</p></div></div>
          <p>{selected.description}</p>
          {selected.custom ? <details><summary>Stored profile instructions and routing</summary><p className={styles.exactText}>{selected.custom.instructions}</p><p>Model policy: {selected.custom.modelPolicy} · memory scope: {selected.custom.memoryScope} · approval policy: {selected.custom.approvalPolicy}</p></details> : null}
          <dl className={styles.metadata}><div><dt>Status</dt><dd>{selected.custom?.status || statusDisplayLabel(selected.status)}</dd></div>{selected.custom ? <><div><dt>Owner actor</dt><dd>{selected.custom.actorId}</dd></div><div><dt>Tenant</dt><dd>{selected.custom.tenantId}</dd></div><div><dt>Profile updated</dt><dd>{selected.custom.updatedAt}</dd></div><div><dt>Active / latest release</dt><dd>{selected.custom.activeDefinitionVersion ?? "Unavailable"} / {selected.custom.latestDefinitionVersion ?? "Unavailable"}</dd></div></> : <div><dt>Identity</dt><dd>Built-in Agent · version pins appear on each execution.</dd></div>}</dl>
          <section className={styles.personaCard} aria-label={`${selected.name} behavioral identity`}><h3>Charter</h3><p>{selected.persona.charter}</p><dl className={styles.metadata}><div><dt>Operating style</dt><dd>{selected.persona.operatingStyle}</dd></div><div><dt>Voice</dt><dd>{selected.persona.voice}</dd></div><div><dt>Visual identity</dt><dd>{selected.persona.visualIdentity}</dd></div><div><dt>Escalation</dt><dd>{selected.persona.escalationBehavior}</dd></div></dl><p>Subject domains: {selected.persona.allowedDomains.join(", ")}</p><details><summary>Success measures</summary><ul>{selected.persona.successMeasures.map((measure) => <li key={measure}>{measure}</li>)}</ul></details></section>
          <AgentPerformancePanel performance={performance.find((item) => item.agentId === selectedId)} state={outcomeRead.error ? "unavailable" : outcomeRead.loading ? "loading" : "ready"} />
          <p className={styles.sourceStatus}>{learningReadState.label}</p><DailyLearningCard status={learningReadState.data?.agentId === selectedId ? learningReadState.data : undefined} state={learningReadState.loading ? "loading" : learningReadState.error ? "unavailable" : "ready"} />
          {selectedMoltbook ? <MoltbookAgentPanel key={selected.id} agentId={selected.id} agentName={selected.name} /> : null}
          <InspectorList title="Assigned Skills" items={selected.capabilities.length ? selected.capabilities : ["No reusable Skills assigned in this profile."]} icon="check" />
          <InspectorList title="Configured actions" items={selected.tools.length ? selected.tools : ["No actions assigned in this profile."]} icon="eye" />
          <p className={styles.notice}>Behavioral instructions and action labels do not create authority. {selected.autonomy}</p>
          {!selectedMoltbook && (!selected.custom || (selected.custom.manageable && selected.custom.releaseState !== "retired")) ? <AgentAdaptationEditor agentId={selected.id} agentName={selected.name} compact /> : null}
          {selected.custom && !selectedMoltbook && (selected.custom.manageable || selected.custom.releaseState === "retired") ? <AgentReleaseEditor agentId={selected.id} agentName={selected.name} compact /> : null}
          {selected.custom?.manageable && !selectedMoltbook && selected.custom.releaseState !== "retired" ? <AgentGrantEditor agentId={selected.id} agentName={selected.name} compact /> : <p className={styles.notice}>{selectedMoltbook ? "Moltbook uses its existing restricted capability boundary." : selected.custom ? "This profile is read only. Its authority cannot be changed here." : "Built-in authority is reviewed server policy and cannot be widened here."}</p>}
          <div className={styles.actions}>{!selected.custom || selected.custom.selectable ? <Link className="primary-button" href={`/app/command?agent=${encodeURIComponent(selected.id)}`}>Work with {selected.name}<ArrowRight size={16} aria-hidden="true" /></Link> : null}
          {selected.custom?.manageable && !selectedMoltbook ? <><button className="secondary-button" disabled={Boolean(busy) || !managementReady} onClick={() => setEditor({ kind: "agent", id: selected.id })}><Pencil size={16} aria-hidden="true" />Edit profile</button><button className="secondary-button" disabled={Boolean(busy) || !managementReady} onClick={() => void remove("agent", selected.custom!)}><Trash2 size={16} aria-hidden="true" />Move Agent to Trash</button></> : null}</div>
        </> : <><h2 ref={detailHeading} tabIndex={-1}>Agent unavailable</h2><p>The selected ID is not in the current authorized list: {selectedId}. Select an available Agent or refresh.</p></>}
      </section>
    </div>
    {activeView === "skills" ? <section aria-labelledby="agent-skills-title"><header className={styles.sectionHeader}><div><h2 id="agent-skills-title">Skills</h2><p>{skillRead.label} · exact playbooks and versions.</p></div><label>Search Skills<input type="search" value={query} onChange={(event) => { setQuery(event.currentTarget.value); setVisibleSkills(30); }} /></label></header>
      {!skillRead.data ? <p>{skillRead.loading ? "Loading Skills…" : "Skills are unavailable. No empty count has been confirmed."}</p> : !filteredSkills.length ? <p>{skills.length ? "No loaded Skill matches this search." : "No Skills in this successful snapshot."}</p> : <div className={styles.skillList}>{filteredSkills.slice(0,visibleSkills).map((skill) => <article key={skill.id}><div><h3>{skill.name}</h3><p>{skill.description}</p><p>{skill.id} · v{skill.version} · {skill.status} · {skill.category}</p><details><summary>Instructions, provenance and actions</summary><p className={styles.exactText}>{skill.instructions}</p><p>Owner: {skill.actorId} · tenant: {skill.tenantId}</p><p>Updated: {skill.updatedAt}</p>{skill.sourcePluginInstallationId ? <dl className={styles.metadata}><div><dt>Plugin installation</dt><dd>{skill.sourcePluginInstallationId}</dd></div><div><dt>Plugin identity</dt><dd>{skill.sourcePluginId} · {skill.sourcePluginVersion} · {skill.sourcePluginSkillKey}</dd></div><div><dt>Manifest digest</dt><dd>{skill.sourcePluginManifestSha256}</dd></div><div><dt>Skill digest</dt><dd>{skill.sourcePluginSkillSha256}</dd></div></dl> : null}<ul>{skill.toolIds.map((id) => <li key={id}>{id}</li>)}</ul><p>Tags: {skill.tags.join(", ") || "None"}</p></details></div>{skill.manageable ? <div className={styles.actions}><button className="secondary-button" disabled={Boolean(busy) || !managementReady} onClick={() => setEditor({kind:"skill",id:skill.id})}>Edit {skill.name}</button><button className="secondary-button" disabled={Boolean(busy) || !managementReady} onClick={() => void remove("skill", skill)}>Move {skill.name} to Trash</button></div> : <p>Read only</p>}</article>)}</div>}
      {filteredSkills.length > visibleSkills ? <button className="secondary-button" onClick={() => setVisibleSkills((count) => count + 30)}>Show more Skills</button> : null}
    </section> : null}
    {activeView === "outcomes" ? <><p className={styles.sourceStatus}>{outcomeRead.label} · bounded source projection, not a lifetime total. Custom Agent outcomes may be absent from this projection.</p><AgentOutcomes agents={agents} performance={performance} state={outcomeRead.data ? "ready" : outcomeRead.loading ? "loading" : "unavailable"} /></> : null}
    {editor ? <BuilderDialog key={`${editor.kind}:${editor.id || "new"}`} editor={editor} agents={customAgents} skills={skills} tools={tools} sourcesCurrent={managementReady} onClose={() => { if (!gate.busy()) setEditor(undefined); }} onSaved={async (result) => { if (result.kind === "agent") { savedAgents.current.set(result.agent.id, result.agent); agentRead.accept((current) => upsertById(current || [], result.agent)); setSelectedId(result.agent.id); setMobileDetail(true); setActiveView("roster"); } else { savedSkills.current.set(result.skill.id, result.skill); skillRead.accept((current) => upsertById(current || [], result.skill)); setActiveView("skills"); } setMessage(result.message); setEditor(undefined); }} /> : null}
  </div>;
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
  disabled,
}: {
  disabled: boolean;
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
              disabled={disabled}
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
              <AgentIdentityMark agentId={agent.id} agentName={agent.name} size="small" decorative />
              <div className={styles.outcomeIdentity}>
                <span>{agent.role}</span>
                <strong>{agent.name}</strong>
                <small>{item?.lastActiveAt ? `Last active ${formatAgentTime(item.lastActiveAt)}` : item ? "No recorded activity" : "Not reported in this projection"}</small>
              </div>
              <OutcomeMetric label="Assignments" value={item ? item.primaryAssignments.toLocaleString() : "Not reported"} />
              <OutcomeMetric label="Completion" value={!item ? "Not reported" : item?.completionRate === null || item?.completionRate === undefined ? "No terminal runs" : `${Math.round(item.completionRate * 100)}%`} />
              <OutcomeMetric label="Verified" value={item ? item.verifiedAnswers.toLocaleString() : "Not reported"} />
              <OutcomeMetric label="User approval" value={!item ? "Not reported" : item?.userApprovalRate === null || item?.userApprovalRate === undefined ? "No reviews" : `${Math.round(item.userApprovalRate * 100)}%`} />
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
  sourcesCurrent,
  onClose,
  onSaved,
}: {
  editor: EditorState;
  agents: RequestCustomAgentDefinition[];
  skills: AgentSkill[];
  tools: ToolOption[];
  sourcesCurrent: boolean;
  onClose: () => void;
  onSaved: (result: BuilderSaveResult) => Promise<void>;
}) {
  const { gate, busy, reason, session } = useAgentsLifecycle();
  const latest = editor.kind === "agent" ? agents.find((item) => item.id === editor.id) : skills.find((item) => item.id === editor.id);
  const [baseline, setBaseline] = useState(latest);
  const existingAgent = editor.kind === "agent" ? baseline as RequestCustomAgentDefinition | undefined : undefined;
  const existingSkill = editor.kind === "skill" ? baseline as AgentSkill | undefined : undefined;
  const changed = Boolean(editor.id && (!latest || !sameAgentJson(latest, baseline)));
  const dialogRef = useRef<HTMLDialogElement>(null);
  const saving = Boolean(busy);
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
    existingAgent?.skillIds || [],
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
  const unavailableSkills = selectedSkills.filter((id) => !skills.some((skill) => skill.id === id && skill.selectable && skill.status === "active"));
  const unavailableTools = selectedTools.filter((id) => !tools.some((tool) => tool.id === id));
  const disabled = saving || Boolean(reason) || !sourcesCurrent || (Boolean(editor.id) && latest?.manageable !== true) || changed || unavailableSkills.length > 0 || unavailableTools.length > 0;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || gate.busy()) return;
    setError(undefined);
    try {
      const draft =
        editor.kind === "agent"
          ? {
              name: name.trim(),
              role: role.trim(),
              description: description.trim(),
              instructions: instructions.trim(),
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
              name: name.trim(),
              description: description.trim(),
              instructions: instructions.trim(),
              category,
              status: existingSkill?.status || "active",
              toolIds: selectedTools,
              tags: splitList(tags, ","),
              knowledgeTags: existingSkill?.knowledgeTags || [],
            };
      if (selectedTools.length > (editor.kind === "skill" ? 40 : 50)) throw new Error(`Choose at most ${editor.kind === "skill" ? 40 : 50} actions before saving.`);
      const body = editor.kind === "agent" ? customAgentInputSchema.parse(draft) : skillInputSchema.parse(draft);
      const base = editor.kind === "agent" ? "/api/agents" : "/api/skills";
      const token = gate.begin(editor.id ? `${base}/${encodeURIComponent(editor.id)}` : base, editor.id ? "PATCH" : "POST", body, `Saving ${name}`, baseline);
      if (!token) return;
      try {
        const payload = await agentsActionRequest(token);
        if (!gate.current(token)) return;
        const row = builderReceipt(payload[editor.kind], editor.kind, body, baseline, { tenantId: session?.context?.tenantId, actorId: session?.context?.actorId });
        const message = `${name} ${editor.id ? "updated" : "created"}. The exact stored receipt was confirmed.`;
        gate.finish(token, true);
        await onSaved(editor.kind === "agent" ? { kind: "agent", agent: row as RequestCustomAgentDefinition, message } : { kind: "skill", skill: row as AgentSkill, message });
      } catch (caught) { if (gate.current(token)) setError(caught instanceof Error ? caught.message : "The saved record was not confirmed."); }
      finally { gate.finish(token, false); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Save failed."); }
  }
  return (
    <dialog ref={dialogRef} className={styles.builderDialog} aria-labelledby="builder-dialog-title" onCancel={(event) => { event.preventDefault(); if (!gate.busy()) onClose(); }}>
        <header>
          <div>
            <p>{editor.id ? "Edit" : "Create"}</p>
            <h2 id="builder-dialog-title">
              {editor.kind === "agent" ? "Agent" : "Skill"}
            </h2>
          </div>
          <button type="button" disabled={saving} onClick={onClose} aria-label="Close builder">
            <X size={18} />
          </button>
        </header>
        {baseline ? <p>Editing {baseline.id} · snapshot {baseline.updatedAt}</p> : null}
        {reason ? <p>{reason}</p> : null}
        {changed ? <div className={styles.notice}><p>The stored record changed. Your draft is retained. Review the current record before applying it.</p>{latest ? <><details><summary>Current stored record</summary><p>{latest.name}</p><p>{latest.description}</p><p className={styles.exactText}>{latest.instructions}</p><p>Updated: {latest.updatedAt}</p>{editor.kind === "agent" ? <p>Charter: {(latest as RequestCustomAgentDefinition).persona.charter}</p> : null}</details><button type="button" className="secondary-button" disabled={saving || !sourcesCurrent || latest.manageable !== true} onClick={() => setBaseline(latest)}>Use this current record as the reviewed baseline</button></> : <p>The record is no longer in the authorized list. Saving is unavailable.</p>}</div> : null}
        {editor.id && latest?.manageable !== true ? <p>This stored record is read only or unavailable. Your draft is retained; saving is disabled.</p> : null}
        {!sourcesCurrent ? <p>Agent, Skill and action sources must be current before saving. Your draft is retained.</p> : null}
        {unavailableSkills.map((id) => <p key={id} className={styles.notice}>Unavailable assigned Skill: {id}<button type="button" className="secondary-button" disabled={saving} onClick={() => setSelectedSkills((current) => current.filter((value) => value !== id))}>Remove unavailable Skill {id}</button></p>)}
        {unavailableTools.map((id) => <p key={id} className={styles.notice}>Unavailable assigned action: {id}<button type="button" className="secondary-button" disabled={saving} onClick={() => setSelectedTools((current) => current.filter((value) => value !== id))}>Remove unavailable action {id}</button></p>)}
        <form onSubmit={(event) => void submit(event)}><fieldset className={styles.builderFields} disabled={saving}>
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
            <button type="button" disabled={saving} onClick={onClose} className="action-button">
              Cancel
            </button>
            <button type="submit" disabled={disabled} className="primary-button">
              {saving ? <Loader2 size={15} className="animate-spin" /> : null}
              {saving
                ? "Saving…"
                : editor.id
                  ? "Save changes"
                  : `Create ${editor.kind}`}
            </button>
          </footer>
        </fieldset></form>
    </dialog>
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
function statusDisplayLabel(status: ArsenalAgent["status"]) {
  return status === "ready" ? "Ready" : "Observing";
}
function AgentPerformancePanel({
  performance,
  state,
}: {
  performance?: AgentPerformance;
  state: "loading" | "ready" | "unavailable";
}) {
  return <section className={styles.performance} aria-label="Agent performance"><h3>Performance</h3><p>{performance ? state === "ready" ? "Loaded evidence" : "Last loaded evidence · refresh unavailable or pending" : state === "loading" ? "Loading performance…" : "Performance is not reported for this Agent in the current projection."}</p>{performance ? <div className={styles.outcomeSummary}><PerformanceMetric label="Assignments" value={String(performance.primaryAssignments)} /><PerformanceMetric label="Completion" value={performance.completionRate === null ? "No terminal runs" : `${Math.round(performance.completionRate * 100)}%`} /><PerformanceMetric label="Verified answers" value={String(performance.verifiedAnswers)} /><PerformanceMetric label="User approval" value={performance.userApprovalRate === null ? "No reviews" : `${Math.round(performance.userApprovalRate * 100)}%`} /></div> : null}</section>;
}

function DailyLearningCard({
  status,
  state,
}: {
  status?: AgentDailyLearningStatusV1;
  state: "loading" | "ready" | "unavailable";
}) {
  const latest = status?.latestCompletedDay;
  const available = status?.availability === "ready";
  const pendingCount = status?.pendingReviewedAdaptationCount || 0;
  return (
    <section
      className={styles.learningCard}
      aria-label="Daily learning status"
      >
      <div className={styles.learningCardHeading}>
        <span><Sparkles size={14} aria-hidden="true" /></span>
        <div>
          <p>Daily learning</p>
          <strong>
            {!status && state === "loading"
              ? "Reading the latest learning receipt"
              : !available
                ? "Learning status is unavailable"
                : latest
                  ? `${formatLearningDate(latest.localDate)} completed`
                  : "Waiting for the first completed day"}
          </strong>
        </div>
        <span className={styles.learningFreshness}>
          {state === "loading" ? (
            <><Loader2 size={11} className="animate-spin" aria-hidden="true" /> Syncing</>
          ) : available ? state === "unavailable" ? "Last loaded" : "Loaded" : "Unavailable"}
        </span>
      </div>
      {!status && state === "loading" ? (
        <div className={styles.learningSkeleton} aria-hidden="true">
          <span /><span /><span />
        </div>
      ) : !available ? (
        <p className={styles.learningEmpty}>
          Asael could not verify the canonical learning record. No learning
          state is being inferred from cached or partial data.
        </p>
      ) : latest ? (
        <>
          <dl className={styles.learningMetrics}>
            <div>
              <dt>Work reviewed</dt>
              <dd>{latest.observationsReviewed.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Corrections</dt>
              <dd>{latest.explicitCorrectionCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Actionable</dt>
              <dd>{latest.actionableEvidenceCount.toLocaleString()}</dd>
            </div>
          </dl>
          <p className={styles.learningCycleScope}>
            Local day · {latest.timezone} · receipt completed {formatLearningTime(latest.completedAt)}
          </p>
        </>
      ) : (
        <p className={styles.learningEmpty}>
          No completed learning day yet. After a local day closes, Asael will
          summarize only the work and feedback tied to this exact Agent release.
        </p>
      )}
      {available ? (
        <div className={clsx(styles.learningReviewState, pendingCount > 0 && styles.learningReviewPending)}>
          <ClipboardCheck size={13} aria-hidden="true" />
          <span>
            {pendingCount > 0
              ? `${pendingCount} reviewed adaptation${pendingCount === 1 ? "" : "s"} waiting for activation`
              : "No reviewed adaptations are waiting"}
          </span>
        </div>
      ) : null}
      <p className={styles.learningPrivacy} title="Prompts, responses, correction text, and private reasoning are excluded.">
        <Eye size={12} aria-hidden="true" /> Counts and review state only. No private reasoning.
      </p>
      <Link href="/app/agents?view=outcomes" className={styles.learningCardLink}>
        Review learning evidence <ArrowRight size={13} aria-hidden="true" />
      </Link>
    </section>
  );
}

function formatLearningDate(localDate: string) {
  const date = new Date(`${localDate}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return localDate;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatLearningTime(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
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
