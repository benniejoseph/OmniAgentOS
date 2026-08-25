"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BrainCircuit,
  Check,
  Eye,
  Hammer,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { clsx } from "clsx";
import { arsenalAgents, type ArsenalAgent } from "@/lib/agents/arsenal";
import type { AgentPerformance } from "@/lib/agents/performance";

const agentIcons = { atlas: Sparkles, scout: Search, forge: Hammer, sentinel: ShieldCheck, mnemosyne: BrainCircuit };

export function AgentArsenalWorkspace() {
  const [selectedId, setSelectedId] = useState("atlas");
  const [performance, setPerformance] = useState<AgentPerformance[]>([]);
  const [performanceState, setPerformanceState] = useState<"loading" | "ready" | "unavailable">("loading");
  const selected = useMemo(() => arsenalAgents.find((agent) => agent.id === selectedId) || arsenalAgents[0], [selectedId]);
  const selectedPerformance = performance.find((item) => item.agentId === selected.id);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/agents/performance", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Agent performance is unavailable");
          return response.json() as Promise<{ agents?: AgentPerformance[] }>;
        })
        .then((payload) => {
          setPerformance(payload.agents || []);
          setPerformanceState("ready");
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setPerformanceState("unavailable");
        });
    }, 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return (
    <div className="arsenal-shell workspace-enter">
      <header className="arsenal-header">
        <div><p className="arsenal-kicker">Agent Arsenal</p><h1>Your working intelligence.</h1><p>Specialists coordinate through Atlas, learn from outcomes, and remain bounded by your approvals.</p></div>
        <Link href={`/app/command?agent=${selected.id}`} className="primary-button">Assign work to {selected.name}<ArrowRight size={15} aria-hidden="true" /></Link>
      </header>

      <div className="arsenal-layout">
        <nav className="arsenal-roster" aria-label="Agent roster">
          <p className="arsenal-section-label">Five active agents</p>
          {arsenalAgents.map((agent) => {
            const Icon = agentIcons[agent.id as keyof typeof agentIcons];
            return <button key={agent.id} type="button" onClick={() => setSelectedId(agent.id)} className={clsx("arsenal-roster-item", `agent-${agent.accent}`, selected.id === agent.id && "is-selected")} aria-pressed={selected.id === agent.id}><span className="agent-glyph"><Icon size={18} aria-hidden="true" /></span><span><strong>{agent.name}</strong><small>{agent.role}</small></span><span className={clsx("agent-status-dot", `status-${agent.status}`)} aria-label={agent.status} /></button>;
          })}
        </nav>

        <section className="arsenal-map" aria-label="Agent delegation map">
          <div className="arsenal-map-grid" aria-hidden="true" />
          <svg className="arsenal-links" viewBox="0 0 700 560" preserveAspectRatio="none" aria-hidden="true">
            <path d="M350 280 L130 120 M350 280 L570 120 M350 280 L130 440 M350 280 L570 440" />
            <circle cx="350" cy="280" r="122" />
            <circle cx="350" cy="280" r="205" />
          </svg>
          <AgentNode agent={arsenalAgents[0]} selected={selected.id === "atlas"} onSelect={setSelectedId} className="node-atlas" />
          <AgentNode agent={arsenalAgents[1]} selected={selected.id === "scout"} onSelect={setSelectedId} className="node-scout" />
          <AgentNode agent={arsenalAgents[2]} selected={selected.id === "forge"} onSelect={setSelectedId} className="node-forge" />
          <AgentNode agent={arsenalAgents[3]} selected={selected.id === "sentinel"} onSelect={setSelectedId} className="node-sentinel" />
          <AgentNode agent={arsenalAgents[4]} selected={selected.id === "mnemosyne"} onSelect={setSelectedId} className="node-memory" />
          <div className="arsenal-map-legend"><Network size={14} aria-hidden="true" /><span>Atlas delegates. Sentinel verifies. Mnemosyne retains approved learning.</span></div>
        </section>

        <aside className={clsx("arsenal-inspector", `agent-${selected.accent}`)} aria-live="polite">
          <div className="inspector-identity"><span className="agent-glyph large">{(() => { const Icon = agentIcons[selected.id as keyof typeof agentIcons]; return <Icon size={24} aria-hidden="true" />; })()}</span><div><p>{selected.role}</p><h2>{selected.name}</h2></div><span className={clsx("agent-status-chip", `status-${selected.status}`)}>{selected.status}</span></div>
          <p className="inspector-description">{selected.description}</p>
          <AgentPerformancePanel performance={selectedPerformance} state={performanceState} />
          <InspectorList title="Capabilities" items={selected.capabilities} icon="check" />
          <InspectorList title="Connected tools" items={selected.tools} icon="eye" />
          <InspectorList title="Learns from" items={selected.learningSignals} icon="spark" />
          <div className="autonomy-note"><strong>Autonomy boundary</strong><p>{selected.autonomy}</p></div>
        </aside>
      </div>
    </div>
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
        <span>{state === "loading" ? "Syncing" : state === "unavailable" ? "Offline" : "Live"}</span>
      </div>
      <div className="agent-performance-grid">
        <PerformanceMetric
          label="Assignments"
          value={state === "loading" ? "..." : String(performance?.primaryAssignments || 0)}
        />
        <PerformanceMetric
          label="Completion"
          value={
            state === "loading"
              ? "..."
              : completionRate === null || completionRate === undefined
                ? "New"
                : `${Math.round(completionRate * 100)}%`
          }
        />
        <PerformanceMetric
          label="Verified"
          value={state === "loading" ? "..." : String(performance?.verifiedAnswers || 0)}
        />
        <PerformanceMetric
          label="Approval"
          value={
            state === "loading"
              ? "..."
              : performance?.userApprovalRate === null || performance?.userApprovalRate === undefined
                ? "New"
                : `${Math.round(performance.userApprovalRate * 100)}%`
          }
        />
      </div>
      {performance && (performance.collaborations > 0 || performance.memoriesLearned > 0) ? (
        <p>
          {performance.collaborations} collaboration{performance.collaborations === 1 ? "" : "s"}
          {" · "}
          {performance.memoriesLearned} memor{performance.memoriesLearned === 1 ? "y" : "ies"} learned
          {performance.projectAssignments ? ` · ${performance.projectAssignments} project output${performance.projectAssignments === 1 ? "" : "s"}` : ""}
        </p>
      ) : null}
      {performance?.latestLessons?.length ? (
        <div className="agent-latest-lessons">
          <strong><BrainCircuit size={13} aria-hidden="true" /> Recent learning</strong>
          <ul>{performance.latestLessons.map((lesson) => <li key={lesson}>{lesson}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

function PerformanceMetric({ label, value }: { label: string; value: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function AgentNode({ agent, selected, onSelect, className }: { agent: ArsenalAgent; selected: boolean; onSelect: (id: string) => void; className: string }) {
  const Icon = agentIcons[agent.id as keyof typeof agentIcons];
  return <button type="button" onClick={() => onSelect(agent.id)} className={clsx("arsenal-node", `agent-${agent.accent}`, className, selected && "is-selected")} aria-label={`${agent.name}, ${agent.role}, ${agent.status}`}><span className="node-signal" aria-hidden="true" /><span className="agent-glyph"><Icon size={agent.id === "atlas" ? 25 : 18} aria-hidden="true" /></span><strong>{agent.name}</strong><small>{agent.role}</small></button>;
}

function InspectorList({ title, items, icon }: { title: string; items: string[]; icon: "check" | "eye" | "spark" }) {
  const Icon = icon === "check" ? Check : icon === "eye" ? Eye : Sparkles;
  return <section className="inspector-list"><h3>{title}</h3><ul>{items.map((item) => <li key={item}><Icon size={13} aria-hidden="true" />{item}</li>)}</ul></section>;
}
