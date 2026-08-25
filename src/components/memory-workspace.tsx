"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Brain,
  Check,
  CircleDot,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphStats, MemoryRecord, MemoryType } from "@/lib/memory/types";

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "saved" | "error";
type PositionedNode = MemoryGraphNode & { x: number; y: number };

const memoryTypes: MemoryType[] = ["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"];

export function MemoryWorkspace() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [nodes, setNodes] = useState<MemoryGraphNode[]>([]);
  const [edges, setEdges] = useState<MemoryGraphEdge[]>([]);
  const [stats, setStats] = useState<MemoryGraphStats>();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<MemoryType | "all">("all");
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [draft, setDraft] = useState<{ title: string; content: string; confidence: number }>();
  const [showCreate, setShowCreate] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [memoryResponse, graphResponse] = await Promise.all([
        fetch("/api/memory?limit=100", { cache: "no-store" }),
        fetch("/api/memory/graph?limit=100", { cache: "no-store" }),
      ]);
      if (!memoryResponse.ok || !graphResponse.ok) throw new Error("Memory workspace could not be loaded.");
      const memoryPayload = await memoryResponse.json() as { memories?: MemoryRecord[] };
      const graphPayload = await graphResponse.json() as { nodes?: MemoryGraphNode[]; edges?: MemoryGraphEdge[]; stats?: MemoryGraphStats };
      setMemories(memoryPayload.memories || []);
      setNodes(graphPayload.nodes || []);
      setEdges(graphPayload.edges || []);
      setStats(graphPayload.stats);
      setLoadState("ready");
      setError(undefined);
    } catch (loadError) {
      setLoadState("error");
      setError(message(loadError));
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return memories.filter((memory) => {
      if (typeFilter !== "all" && memory.type !== typeFilter) return false;
      if (!terms.length) return true;
      const haystack = `${memory.title} ${memory.content} ${memory.tags.join(" ")} ${memory.source}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [memories, query, typeFilter]);
  const selectedMemory = memories.find((memory) => memory.id === selectedMemoryId);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const positionedNodes = useMemo(() => positionGraphNodes(nodes.slice(0, 42)), [nodes]);
  const visibleNodeIds = useMemo(() => new Set(positionedNodes.map((node) => node.id)), [positionedNodes]);
  const visibleEdges = edges.filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)).slice(0, 90);

  function selectMemory(memory: MemoryRecord) {
    setSelectedMemoryId(memory.id);
    setSelectedNodeId(undefined);
    setDraft({ title: memory.title, content: memory.content, confidence: memory.confidence ?? 0.7 });
    setConfirmForget(false);
    setSaveState("idle");
  }

  function selectNode(node: MemoryGraphNode) {
    const linkedMemory = memories.find((memory) => node.memoryIds.includes(memory.id));
    if (linkedMemory) selectMemory(linkedMemory);
    else {
      setSelectedNodeId(node.id);
      setSelectedMemoryId(undefined);
      setDraft(undefined);
    }
  }

  async function saveCorrection() {
    if (!selectedMemory || !draft) return;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(selectedMemory.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title, content: draft.content, confidence: draft.confidence }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || "Correction failed.");
      const corrected = payload.corrected as MemoryRecord;
      setMemories((current) => [corrected, ...current.map((item) => item.id === selectedMemory.id ? { ...item, claimStatus: "superseded" as const } : item)]);
      setSelectedMemoryId(corrected.id);
      setDraft({ title: corrected.title, content: corrected.content, confidence: corrected.confidence ?? 0.7 });
      setSaveState("saved");
      setAnnouncement("Memory corrected. The previous claim remains in its provenance lineage.");
      void refreshGraph();
    } catch (saveError) {
      setSaveState("error");
      setError(message(saveError));
    }
  }

  async function forgetSelected() {
    if (!selectedMemory || !confirmForget) return;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(selectedMemory.id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || "Forget request failed.");
      setMemories((current) => current.filter((item) => item.id !== selectedMemory.id));
      setSelectedMemoryId(undefined);
      setDraft(undefined);
      setConfirmForget(false);
      setSaveState("idle");
      setAnnouncement("Memory forgotten and removed from recall.");
      void refreshGraph();
    } catch (forgetError) {
      setSaveState("error");
      setError(message(forgetError));
    }
  }

  async function refreshGraph() {
    try {
      const response = await fetch("/api/memory/graph", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "memory-workspace" }) });
      if (!response.ok) throw new Error("Graph rebuild failed.");
      const graphResponse = await fetch("/api/memory/graph?limit=100", { cache: "no-store" });
      const payload = await graphResponse.json() as { nodes?: MemoryGraphNode[]; edges?: MemoryGraphEdge[]; stats?: MemoryGraphStats };
      setNodes(payload.nodes || []); setEdges(payload.edges || []); setStats(payload.stats);
    } catch (graphError) { setError(message(graphError)); }
  }

  return (
    <main className="memory-studio workspace-enter" aria-busy={loadState === "loading"}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className="memory-studio-header">
        <div><p>Personal knowledge system</p><h1>Memory</h1><span>Inspect what your agents know, why they know it, and what should change.</span></div>
        <div className="memory-studio-stats"><strong>{stats?.nodes || 0}</strong><span>concepts</span><strong>{stats?.edges || 0}</strong><span>links</span><button type="button" onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> Add memory</button></div>
      </header>

      {error ? <div className="memory-studio-error"><span>{error}</span><button type="button" onClick={() => { setError(undefined); void load(); }}>Retry</button></div> : null}

      <div className="memory-studio-layout">
        <aside className="memory-index">
          <div className="memory-search"><Search size={14} aria-hidden="true" /><label className="sr-only" htmlFor="memory-search">Search memory</label><input id="memory-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search everything…" /></div>
          <div className="memory-type-filter" aria-label="Memory type filter"><button type="button" className={clsx(typeFilter === "all" && "is-selected")} onClick={() => setTypeFilter("all")}>All</button>{memoryTypes.map((type) => <button type="button" key={type} className={clsx(typeFilter === type && "is-selected")} onClick={() => setTypeFilter(type)}>{type}</button>)}</div>
          <div className="memory-index-list">
            {loadState === "loading" ? <div className="memory-index-empty"><Loader2 className="animate-spin" size={18} aria-hidden="true" /> Loading memory…</div> : filtered.length ? filtered.map((memory) => <button key={memory.id} type="button" className={clsx(selectedMemoryId === memory.id && "is-selected", `is-${memory.claimStatus || "active"}`)} onClick={() => selectMemory(memory)}><i /><span><strong>{memory.title}</strong><small>{memory.type} · {memory.source}</small><em>{Math.round((memory.confidence ?? .7) * 100)}%</em></span></button>) : <div className="memory-index-empty"><Brain size={18} aria-hidden="true" /> No memories match this view.</div>}
          </div>
        </aside>

        <section className="memory-graph" aria-label="Knowledge graph">
          <div className="memory-graph-toolbar"><span><GitMerge size={14} aria-hidden="true" /> Knowledge graph</span><button type="button" onClick={() => void refreshGraph()}><RefreshCw size={13} aria-hidden="true" /> Rebuild</button></div>
          <svg viewBox="0 0 760 560" role="img" aria-label={`${positionedNodes.length} memory concepts connected by ${visibleEdges.length} visible relationships`}>
            <g className="memory-graph-edges">{visibleEdges.map((edge) => { const source = positionedNodes.find((node) => node.id === edge.sourceNodeId); const target = positionedNodes.find((node) => node.id === edge.targetNodeId); return source && target ? <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} style={{ opacity: Math.min(.18 + edge.weight * .12, .65) }} /> : null; })}</g>
            <g className="memory-graph-nodes">{positionedNodes.map((node) => <g key={node.id} role="button" tabIndex={0} aria-label={`${node.label}, ${node.kind}`} className={clsx(selectedNodeId === node.id && "is-selected", node.memoryIds.some((id) => id === selectedMemoryId) && "is-related", `kind-${node.kind}`)} transform={`translate(${node.x} ${node.y})`} onClick={() => selectNode(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectNode(node); }}><circle r={Math.min(8 + node.weight * 1.8, 20)} /><text y={Math.min(8 + node.weight * 1.8, 20) + 13} textAnchor="middle">{truncate(node.label, 22)}</text></g>)}</g>
          </svg>
          <div className="memory-graph-legend"><span><i className="kind-memory" /> Memory</span><span><i className="kind-concept" /> Concept</span><span><i className="kind-system" /> System</span><span><i className="kind-workflow" /> Workflow</span></div>
        </section>

        <aside className="memory-inspector">
          {selectedMemory && draft ? <>
            <div className="memory-inspector-heading"><div><p>{selectedMemory.type}</p><h2>{selectedMemory.title}</h2></div><span className={clsx(`is-${selectedMemory.claimStatus || "active"}`)}>{selectedMemory.claimStatus || "active"}</span></div>
            <label>Title<input value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }); setSaveState("idle"); }} /></label>
            <label>Claim<textarea rows={9} value={draft.content} onChange={(event) => { setDraft({ ...draft, content: event.currentTarget.value }); setSaveState("idle"); }} /></label>
            <label>Confidence <span>{Math.round(draft.confidence * 100)}%</span><input type="range" min="0" max="1" step=".01" value={draft.confidence} onChange={(event) => { setDraft({ ...draft, confidence: Number(event.currentTarget.value) }); setSaveState("idle"); }} /></label>
            <div className="memory-provenance"><p><ShieldCheck size={13} aria-hidden="true" /> Provenance</p><dl><dt>Asserted by</dt><dd>{selectedMemory.assertedBy || "unknown"}</dd><dt>Source</dt><dd>{selectedMemory.source}</dd><dt>Scope</dt><dd>{selectedMemory.scope}</dd><dt>Updated</dt><dd>{formatDate(selectedMemory.updatedAt)}</dd></dl>{selectedMemory.evidenceRefs?.length ? <div>{selectedMemory.evidenceRefs.map((reference) => <code key={reference}>{reference}</code>)}</div> : null}</div>
            <div className="memory-inspector-actions"><button type="button" className="memory-save" disabled={saveState === "saving" || !draft.title.trim() || !draft.content.trim()} onClick={() => void saveCorrection()}>{saveState === "saving" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : saveState === "saved" ? <Check size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}{saveState === "saved" ? "Corrected" : "Save correction"}</button><button type="button" className={clsx("memory-forget", confirmForget && "is-confirming")} onClick={() => confirmForget ? void forgetSelected() : setConfirmForget(true)}><Trash2 size={13} aria-hidden="true" />{confirmForget ? "Confirm forget" : "Forget"}</button>{confirmForget ? <button type="button" className="memory-cancel" onClick={() => setConfirmForget(false)}><X size={13} aria-hidden="true" /> Cancel</button> : null}</div>
          </> : selectedNode ? <div className="memory-node-inspector"><CircleDot size={22} aria-hidden="true" /><p>{selectedNode.kind}</p><h2>{selectedNode.label}</h2><span>{selectedNode.summary}</span><dl><dt>Sources</dt><dd>{selectedNode.sourceCount}</dd><dt>Weight</dt><dd>{selectedNode.weight.toFixed(1)}</dd><dt>Memories</dt><dd>{selectedNode.memoryIds.length}</dd></dl></div> : <div className="memory-inspector-empty"><Brain size={26} aria-hidden="true" /><h2>Select a memory</h2><p>Inspect provenance, correct a claim, or forget information that should no longer influence your agents.</p></div>}
        </aside>
      </div>
      {showCreate ? <CreateMemoryDialog onClose={() => setShowCreate(false)} onCreated={(memory) => { setShowCreate(false); setMemories((current) => [memory, ...current]); selectMemory(memory); setAnnouncement("Memory added."); void refreshGraph(); }} /> : null}
    </main>
  );
}

function CreateMemoryDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (memory: MemoryRecord) => void }) {
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [type, setType] = useState<MemoryType>("knowledge"); const [saving, setSaving] = useState(false); const [error, setError] = useState<string>();
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); try { const response = await fetch("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, content, type, importance: .75, confidence: .95 }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message || payload.error || "Memory could not be saved."); onCreated(payload.record as MemoryRecord); } catch (submitError) { setError(message(submitError)); setSaving(false); } }
  return <div className="memory-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="memory-dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-memory-title"><header><div><p>Direct knowledge</p><h2 id="new-memory-title">Add a memory</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>{error ? <p className="memory-dialog-error">{error}</p> : null}<label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} required /></label><label>Type<select value={type} onChange={(event) => setType(event.currentTarget.value as MemoryType)}>{memoryTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>What should your agents know?<textarea rows={8} value={content} onChange={(event) => setContent(event.currentTarget.value)} maxLength={200000} required /></label><footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving || !title.trim() || !content.trim()}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Brain size={13} />} Save memory</button></footer></form></div>;
}

function positionGraphNodes(nodes: MemoryGraphNode[]): PositionedNode[] {
  const sorted = [...nodes].sort((left, right) => right.weight - left.weight);
  return sorted.map((node, index) => {
    if (index === 0) return { ...node, x: 380, y: 280 };
    const ring = index < 9 ? 1 : index < 24 ? 2 : 3;
    const membersBefore = ring === 1 ? 1 : ring === 2 ? 9 : 24;
    const membersInRing = ring === 1 ? 8 : ring === 2 ? 15 : Math.max(sorted.length - 24, 1);
    const angle = ((index - membersBefore) / membersInRing) * Math.PI * 2 - Math.PI / 2;
    const radiusX = ring * 105; const radiusY = ring * 72;
    return { ...node, x: 380 + Math.cos(angle) * radiusX, y: 280 + Math.sin(angle) * radiusY };
  });
}

function truncate(value: string, max: number) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong."; }
