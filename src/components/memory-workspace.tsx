"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  CircleDot,
  Database,
  GitMerge,
  Loader2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
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
import styles from "@/components/memory-workspace.module.css";

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "saved" | "error";
type PositionedNode = MemoryGraphNode & { x: number; y: number };
type ForgetState = "idle" | "previewing" | "ready" | "deleting";
type MemoryDeletionPreview = {
  expectedReceiptManifestSha256: string;
  guarantee: "rollback_proof_barrier" | "best_effort";
  descendantMemories: Array<{
    id: string;
    title: string;
    type: MemoryType;
  }>;
  impact: {
    rootMemoryCount: 1;
    descendantMemoryCount: number;
    retrievalTraceCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
    pendingAgentRunCount: number;
    pendingWorkflowRunCount: number;
  };
};
type MemoryDeletionResult = {
  deletionGuarantee: "scope_bound_receipt" | "legacy_unattributed_receipt" | "best_effort";
  invalidatedAgentRunCount: number;
  invalidatedWorkflowRunCount: number;
  deletionReceipt: {
    id: string;
    memoryId: string;
    forgottenAt: string;
    descendantMemoryCount: number;
    retrievalTraceCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
    receiptSha256: string | null;
  } | null;
};

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
  const [indexCollapsed, setIndexCollapsed] = useState(false);
  const [forgetState, setForgetState] = useState<ForgetState>("idle");
  const [forgetPreview, setForgetPreview] = useState<MemoryDeletionPreview>();
  const [deletionResult, setDeletionResult] = useState<MemoryDeletionResult>();
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
    setForgetState("idle");
    setForgetPreview(undefined);
    setDeletionResult(undefined);
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

  async function requestForgetPreview() {
    if (!selectedMemory) return;
    setForgetState("previewing");
    setError(undefined);
    try {
      const response = await fetch(
        `/api/memory/${encodeURIComponent(selectedMemory.id)}?view=deletion-preview`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "Deletion preview failed.");
      }
      setForgetPreview(payload.preview as MemoryDeletionPreview);
      setForgetState("ready");
      setAnnouncement("Deletion preview ready. Review every affected memory and projection before confirming.");
    } catch (previewError) {
      setForgetState("idle");
      setError(message(previewError));
    }
  }

  async function forgetSelected() {
    if (!selectedMemory || !forgetPreview || forgetState !== "ready") return;
    setForgetState("deleting");
    setSaveState("saving");
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(selectedMemory.id)}`, {
        method: "DELETE",
        headers: {
          "x-asael-deletion-preview": forgetPreview.expectedReceiptManifestSha256,
        },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || "Forget request failed.");
      setDeletionResult(payload as MemoryDeletionResult);
      setMemories((current) => current.filter((item) => item.id !== selectedMemory.id));
      setSelectedMemoryId(undefined);
      setDraft(undefined);
      setForgetState("idle");
      setForgetPreview(undefined);
      setSaveState("idle");
      setAnnouncement("Memory deletion committed. Its receipt and affected projection counts are available.");
      void refreshGraph();
    } catch (forgetError) {
      setForgetState("ready");
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
    <main className={clsx("memory-studio workspace-enter", styles.shell)} aria-busy={loadState === "loading"}>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <header className={clsx("memory-studio-header", styles.header)}>
        <div className={styles.headerIntro}>
          <span className={styles.headerIcon}><Brain size={19} aria-hidden="true" /></span>
          <div><p>Knowledge workspace</p><h1>Memory</h1><span>Review what agents can recall, trace every source, and correct outdated knowledge.</span></div>
        </div>
        <div className={clsx("memory-studio-stats", styles.stats)}>
          <div className={styles.stat}><Database size={14} aria-hidden="true" /><span><strong>{memories.length}</strong><small>Memories</small></span></div>
          <div className={styles.stat}><Brain size={14} aria-hidden="true" /><span><strong>{stats?.nodes || 0}</strong><small>Concepts</small></span></div>
          <div className={styles.stat}><Network size={14} aria-hidden="true" /><span><strong>{stats?.edges || 0}</strong><small>Links</small></span></div>
          <button type="button" onClick={() => setShowCreate(true)}><Plus size={14} aria-hidden="true" /> Add memory</button>
        </div>
      </header>

      {error ? <div className={clsx("memory-studio-error", styles.error)} role="alert"><span>{error}</span><button type="button" onClick={() => { setError(undefined); void load(); }}>Retry</button></div> : null}

      <div className={clsx("memory-studio-layout", styles.layout, indexCollapsed && styles.layoutCollapsed)}>
        <aside className={clsx("memory-index", styles.index, indexCollapsed && styles.indexCollapsed)} aria-label="Memory library">
          <div className={styles.indexHeader}>
            <div><p>Memory library</p><span>{filtered.length} of {memories.length}</span></div>
            <button type="button" onClick={() => setIndexCollapsed((current) => !current)} aria-label={indexCollapsed ? "Expand memory library" : "Collapse memory library"} title={indexCollapsed ? "Expand library" : "Collapse library"}>{indexCollapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}</button>
          </div>
          <div className={styles.indexBody}>
            <div className="memory-search"><Search size={14} aria-hidden="true" /><label className="sr-only" htmlFor="memory-search">Search memory</label><input id="memory-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search memories" /></div>
            <div className="memory-type-filter" aria-label="Memory type filter"><button type="button" className={clsx(typeFilter === "all" && "is-selected")} onClick={() => setTypeFilter("all")}>All</button>{memoryTypes.map((type) => <button type="button" key={type} className={clsx(typeFilter === type && "is-selected")} onClick={() => setTypeFilter(type)}>{type}</button>)}</div>
            <div className="memory-index-list">
              {loadState === "loading" ? <div className="memory-index-empty"><Loader2 className="animate-spin" size={18} aria-hidden="true" /> Loading memory…</div> : filtered.length ? filtered.map((memory) => <button key={memory.id} type="button" className={clsx(selectedMemoryId === memory.id && "is-selected", `is-${memory.claimStatus || "active"}`)} onClick={() => selectMemory(memory)}><i /><span><strong>{memory.title}</strong><small>{memory.type} · {memory.source}</small><em>{Math.round((memory.confidence ?? .7) * 100)}% confidence</em></span></button>) : <div className="memory-index-empty"><Brain size={18} aria-hidden="true" /> No memories match this view.</div>}
            </div>
          </div>
        </aside>

        <section className={clsx("memory-graph", styles.graph)} aria-label="Knowledge graph">
          <div className="memory-graph-toolbar"><div className={styles.graphTitle}><span><GitMerge size={14} aria-hidden="true" /> Knowledge graph</span><small>{positionedNodes.length} visible concepts · {visibleEdges.length} relationships</small></div><button type="button" onClick={() => void refreshGraph()}><RefreshCw size={13} aria-hidden="true" /> Rebuild</button></div>
          <svg viewBox="0 0 760 560" role="img" aria-label={`${positionedNodes.length} memory concepts connected by ${visibleEdges.length} visible relationships`}>
            <g className="memory-graph-edges">{visibleEdges.map((edge) => { const source = positionedNodes.find((node) => node.id === edge.sourceNodeId); const target = positionedNodes.find((node) => node.id === edge.targetNodeId); return source && target ? <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} style={{ opacity: Math.min(.18 + edge.weight * .12, .65) }} /> : null; })}</g>
            <g className="memory-graph-nodes">{positionedNodes.map((node) => <g key={node.id} role="button" tabIndex={0} aria-label={`${node.label}, ${node.kind}`} className={clsx(selectedNodeId === node.id && "is-selected", node.memoryIds.some((id) => id === selectedMemoryId) && "is-related", `kind-${node.kind}`)} transform={`translate(${node.x} ${node.y})`} onClick={() => selectNode(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectNode(node); }}><circle r={Math.min(8 + node.weight * 1.8, 20)} /><text y={Math.min(8 + node.weight * 1.8, 20) + 13} textAnchor="middle">{truncate(node.label, 22)}</text></g>)}</g>
          </svg>
          <div className="memory-graph-legend"><span><i className="kind-memory" /> Memory</span><span><i className="kind-concept" /> Concept</span><span><i className="kind-system" /> System</span><span><i className="kind-workflow" /> Workflow</span></div>
        </section>

        <aside className={clsx("memory-inspector", styles.inspector)} aria-label="Memory details">
          {selectedMemory && draft ? <>
            <div className="memory-inspector-heading"><div><p>{selectedMemory.type}</p><h2>{selectedMemory.title}</h2></div><span className={clsx(`is-${selectedMemory.claimStatus || "active"}`)}>{selectedMemory.claimStatus || "active"}</span></div>
            <label>Title<input value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }); setSaveState("idle"); }} /></label>
            <label>Claim<textarea rows={9} value={draft.content} onChange={(event) => { setDraft({ ...draft, content: event.currentTarget.value }); setSaveState("idle"); }} /></label>
            <label>Confidence <span>{Math.round(draft.confidence * 100)}%</span><input type="range" min="0" max="1" step=".01" value={draft.confidence} onChange={(event) => { setDraft({ ...draft, confidence: Number(event.currentTarget.value) }); setSaveState("idle"); }} /></label>
            <div className="memory-provenance"><p><ShieldCheck size={13} aria-hidden="true" /> Provenance</p><dl><dt>Asserted by</dt><dd>{selectedMemory.assertedBy || "unknown"}</dd><dt>Source</dt><dd>{selectedMemory.source}</dd><dt>Scope</dt><dd>{selectedMemory.scope}</dd><dt>Updated</dt><dd>{formatDate(selectedMemory.updatedAt)}</dd></dl>{selectedMemory.evidenceRefs?.length ? <div>{selectedMemory.evidenceRefs.map((reference) => <code key={reference}>{reference}</code>)}</div> : null}</div>
            {forgetPreview ? <DeletionPreview preview={forgetPreview} /> : null}
            <div className="memory-inspector-actions"><button type="button" className="memory-save" disabled={saveState === "saving" || !draft.title.trim() || !draft.content.trim()} onClick={() => void saveCorrection()}>{saveState === "saving" && forgetState !== "deleting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : saveState === "saved" ? <Check size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}{saveState === "saved" ? "Corrected" : "Save correction"}</button><button type="button" className={clsx("memory-forget", forgetState === "ready" && "is-confirming")} disabled={forgetState === "previewing" || forgetState === "deleting"} onClick={() => forgetState === "ready" ? void forgetSelected() : void requestForgetPreview()}>{forgetState === "previewing" || forgetState === "deleting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}{forgetState === "previewing" ? "Checking impact" : forgetState === "deleting" ? "Committing deletion" : forgetState === "ready" ? "Forget permanently" : "Review forget impact"}</button>{forgetState === "ready" ? <button type="button" className="memory-cancel" onClick={() => { setForgetState("idle"); setForgetPreview(undefined); }}><X size={13} aria-hidden="true" /> Cancel</button> : null}</div>
          </> : deletionResult ? <DeletionReceipt result={deletionResult} onClose={() => setDeletionResult(undefined)} /> : selectedNode ? <div className="memory-node-inspector"><CircleDot size={22} aria-hidden="true" /><p>{selectedNode.kind}</p><h2>{selectedNode.label}</h2><span>{selectedNode.summary}</span><dl><dt>Sources</dt><dd>{selectedNode.sourceCount}</dd><dt>Weight</dt><dd>{selectedNode.weight.toFixed(1)}</dd><dt>Memories</dt><dd>{selectedNode.memoryIds.length}</dd></dl></div> : <div className="memory-inspector-empty"><Brain size={26} aria-hidden="true" /><h2>Select a memory</h2><p>Inspect provenance, correct a claim, or forget information that should no longer influence your agents.</p></div>}
        </aside>
      </div>
      {showCreate ? <CreateMemoryDialog onClose={() => setShowCreate(false)} onCreated={(memory) => { setShowCreate(false); setMemories((current) => [memory, ...current]); selectMemory(memory); setAnnouncement("Memory added."); void refreshGraph(); }} /> : null}
    </main>
  );
}

function DeletionPreview({ preview }: { preview: MemoryDeletionPreview }) {
  const impact = preview.impact;
  return <section className={styles.deletionPreview} aria-label="Permanent deletion preview"><header><AlertTriangle size={15} aria-hidden="true" /><div><strong>Permanent deletion preview</strong><span>{preview.guarantee === "rollback_proof_barrier" ? "A rollback-proof barrier will block recall immediately." : "Local development provides a best-effort deletion only."}</span></div></header><dl><dt>Memories</dt><dd>{impact.rootMemoryCount + impact.descendantMemoryCount}</dd><dt>Retrieval traces</dt><dd>{impact.retrievalTraceCount}</dd><dt>Graph projections</dt><dd>{impact.graphNodeCount + impact.graphEdgeCount}</dd><dt>Pending runs canceled</dt><dd>{impact.pendingAgentRunCount + impact.pendingWorkflowRunCount}</dd></dl>{preview.descendantMemories.length ? <div className={styles.deletionDescendants}><span>Descendant memories also blocked</span><ul>{preview.descendantMemories.map((memory) => <li key={memory.id}><strong>{memory.title}</strong><small>{memory.type}</small></li>)}</ul></div> : null}<p>This removes the claim from search, context, graph views, and future exports. This action cannot be undone.</p></section>;
}

function DeletionReceipt({ result, onClose }: { result: MemoryDeletionResult; onClose: () => void }) {
  const receipt = result.deletionReceipt;
  return <div className={styles.deletionReceipt}><ShieldCheck size={25} aria-hidden="true" /><p>Deletion committed</p><h2>{receipt ? "Receipt verified" : "Best-effort local deletion"}</h2><span>{receipt ? `The permanent barrier was recorded ${formatDate(receipt.forgottenAt)}.` : "The memory was removed from the local development store."}</span>{receipt ? <><dl><dt>Descendant memories</dt><dd>{receipt.descendantMemoryCount}</dd><dt>Retrieval traces</dt><dd>{receipt.retrievalTraceCount}</dd><dt>Graph projections</dt><dd>{receipt.graphNodeCount + receipt.graphEdgeCount}</dd><dt>Runs canceled</dt><dd>{result.invalidatedAgentRunCount + result.invalidatedWorkflowRunCount}</dd></dl><code title={receipt.receiptSha256 || receipt.id}>{receipt.receiptSha256 || receipt.id}</code></> : null}<button type="button" onClick={onClose}>Back to memory</button></div>;
}

function CreateMemoryDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (memory: MemoryRecord) => void }) {
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [type, setType] = useState<MemoryType>("knowledge"); const [saving, setSaving] = useState(false); const [error, setError] = useState<string>();
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); try { const response = await fetch("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, content, type, importance: .75, confidence: .95 }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message || payload.error || "Memory could not be saved."); onCreated(payload.record as MemoryRecord); } catch (submitError) { setError(message(submitError)); setSaving(false); } }
  return <div className={clsx("memory-dialog-backdrop", styles.dialogBackdrop)} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className={clsx("memory-dialog", styles.dialog)} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-memory-title"><header><div><p>Direct knowledge</p><h2 id="new-memory-title">Add a memory</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>{error ? <p className="memory-dialog-error">{error}</p> : null}<label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} required /></label><label>Type<select value={type} onChange={(event) => setType(event.currentTarget.value as MemoryType)}>{memoryTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>What should your agents know?<textarea rows={8} value={content} onChange={(event) => setContent(event.currentTarget.value)} maxLength={200000} required /></label><footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving || !title.trim() || !content.trim()}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Brain size={13} />} Save memory</button></footer></form></div>;
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
