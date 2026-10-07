"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Focus,
  Search,
  GitBranch,
  Layers3,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  EntityRelationTypeId,
  EntityTypeId,
} from "@/lib/entities/ontology";
import type {
  MemoryGraphEdgeRelation,
  MemoryGraphNodeKind,
} from "@/lib/memory/types";
import { createUniverseSelectionGuard, universeDetailForSelection } from "@/components/memory-universe-selection";
import styles from "@/components/memory-universe.module.css";

type GraphMode = "evidence" | "verified";

type EvidenceNode = {
  id: string;
  kind: MemoryGraphNodeKind;
  weight: number;
  sourceCount: number;
  updatedAt: string;
};

type EvidenceEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: MemoryGraphEdgeRelation;
  weight: number;
  evidenceCount: number;
};

type VerifiedNode = {
  id: string;
  kind: EntityTypeId;
  degree: number;
  sourceCount: number;
  updatedAt: string;
};

type VerifiedEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: EntityRelationTypeId;
  epistemicKind: string;
  confidenceBasisPoints: number;
};

type GraphBuildHealth = {
  status: "completed" | "failed";
  source: string;
  nodeCount: number;
  edgeCount: number;
  latencyMs: number;
  createdAt: string;
};

type UniversePayload = {
  version: "memory-universe:2";
  generatedAt: string;
  disclosure: { labels: "explicit_node_selection"; summaries: "explicit_node_selection" };
  evidence: {
    nodes: EvidenceNode[];
    edges: EvidenceEdge[];
    stats: {
      nodes: number;
      edges: number;
      kinds: Record<string, number>;
      relations: Record<string, number>;
      latestUpdatedAt: string | null;
      latestBuild: GraphBuildHealth | null;
    };
  };
  verified: {
    nodes: VerifiedNode[];
    edges: VerifiedEdge[];
    stats: {
      nodes: number;
      edges: number;
      kinds: Record<string, number>;
      relations: Record<string, number>;
      relationLimitSaturated: boolean;
    };
  };
};

type SelectedDetail = {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  state?: string;
  sourceCount: number;
  weight?: number;
  updatedAt: string;
  tags?: string[];
};

type SceneNode = {
  id: string;
  kind: string;
  weight: number;
  sourceCount: number;
  updatedAt: string;
};

type SceneEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: string;
  weight: number;
};

const evidenceColors: Record<MemoryGraphNodeKind, string> = {
  concept: "--foreground",
  tag: "--accent",
  system: "--muted",
  workflow: "--line-strong",
  tool: "--foreground",
  memory: "--accent",
  trace: "--muted",
};

const evidenceLabels: Record<MemoryGraphNodeKind, string> = {
  concept: "Topics",
  tag: "Tags",
  system: "Systems",
  workflow: "Workflows",
  tool: "Tools",
  memory: "Memories",
  trace: "Recall traces",
};

const entityColors: Record<EntityTypeId, string> = {
  person: "--foreground",
  organization: "--muted",
  account: "--line-strong",
  project: "--accent",
  work_item: "--foreground",
  event: "--muted",
  meeting: "--accent",
  place: "--line-strong",
  asset: "--foreground",
  decision: "--accent",
  commitment: "--foreground",
  preference: "--muted",
  risk: "--line-strong",
  goal: "--accent",
  product: "--foreground",
  case: "--muted",
  opportunity: "--line-strong",
};

const entityLabels: Record<EntityTypeId, string> = {
  person: "People",
  organization: "Organizations",
  account: "Accounts",
  project: "Projects",
  work_item: "Work items",
  event: "Events",
  meeting: "Meetings",
  place: "Places",
  asset: "Assets",
  decision: "Decisions",
  commitment: "Commitments",
  preference: "Preferences",
  risk: "Risks",
  goal: "Goals",
  product: "Products",
  case: "Cases",
  opportunity: "Opportunities",
};

export function MemoryUniverse(props: { active: boolean; onAddConnectedFact?: () => void }) {
  const [payload, setPayload] = useState<UniversePayload>();
  const [mode, setMode] = useState<GraphMode>("evidence");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<SelectedDetail>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [local, setLocal] = useState(true);
  const [depth, setDepth] = useState(1);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [hoveredId, setHoveredId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [naming, setNaming] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [rebuilding, setRebuilding] = useState(false);
  const [reload, setReload] = useState(0);
  const [selectionGuard] = useState(createUniverseSelectionGuard);
  const namesRequest = useRef<AbortController | null>(null);
  const inspectorTitle = useRef<HTMLHeadingElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ x: number; y: number; cameraX: number; cameraY: number; moved: boolean } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/memory/graph?view=universe", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(body.error || "The relationship map could not be loaded.");
        if (body.version !== "memory-universe:2" || !Array.isArray(body.evidence?.nodes) || !Array.isArray(body.verified?.nodes)) throw new Error("The map returned an unsupported snapshot.");
        setPayload(body as UniversePayload);
        setError(undefined);
      }).catch((reason) => { if (!controller.signal.aborted) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => () => { selectionGuard.clear(); namesRequest.current?.abort(); }, [selectionGuard]);
  useEffect(() => {
    if (!props.active) { selectionGuard.clear(); namesRequest.current?.abort(); setNaming(false); setDetailLoading(false); }
  }, [props.active, selectionGuard]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !props.active) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? .92 : 1.08;
      setCamera((current) => ({ ...current, zoom: Math.max(.45, Math.min(3.5, current.zoom * factor)) }));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [props.active]);

  const graph = useMemo(() => {
    if (!payload) return { nodes: [] as SceneNode[], edges: [] as SceneEdge[] };
    return mode === "evidence" ? payload.evidence : {
      nodes: payload.verified.nodes.map((node) => ({ ...node, weight: 0.55 + Math.min(node.degree, 12) * .12 })),
      edges: payload.verified.edges.map((edge) => ({ ...edge, weight: edge.confidenceBasisPoints / 10000 })),
    };
  }, [payload, mode]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const neighbors = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (!nodeById.has(edge.sourceNodeId) || !nodeById.has(edge.targetNodeId)) continue;
      for (const [from, to] of [[edge.sourceNodeId, edge.targetNodeId], [edge.targetNodeId, edge.sourceNodeId]]) {
        if (!result.has(from)) result.set(from, new Set());
        result.get(from)!.add(to);
      }
    }
    return result;
  }, [graph.edges, nodeById]);
  const ordered = useMemo(() => [...graph.nodes].sort((a, b) =>
    (neighbors.get(b.id)?.size || 0) - (neighbors.get(a.id)?.size || 0) || b.weight - a.weight || a.id.localeCompare(b.id)
  ), [graph.nodes, neighbors]);
  const ordinals = useMemo(() => new Map(ordered.map((node, index) => [node.id, index + 1])), [ordered]);
  const label = (node: SceneNode) => names[node.id]
    ? readableGraphLabel(names[node.id], `Assistant task ${ordinals.get(node.id) || ""}`.trim())
    : `${singularKind(node.kind, mode)} ${ordinals.get(node.id) || ""}`.trim();
  const visible = useMemo(() => {
    let candidates = ordered;
    if (local && selectedId && nodeById.has(selectedId)) {
      const ids = new Set([selectedId]);
      let frontier = [selectedId];
      for (let hop = 0; hop < depth; hop++) {
        const next: string[] = [];
        for (const id of frontier) for (const neighbor of neighbors.get(id) || []) {
          if (!ids.has(neighbor) && ids.size < 240) { ids.add(neighbor); next.push(neighbor); }
        }
        frontier = next;
      }
      candidates = [nodeById.get(selectedId)!, ...ordered.filter((node) => node.id !== selectedId && ids.has(node.id))];
    }
    const normalized = query.trim().toLocaleLowerCase();
    return candidates.filter((node) => (kind === "all" || node.kind === kind) && (!normalized || `${names[node.id] || ""} ${labelForKind(node.kind, mode)}`.toLocaleLowerCase().includes(normalized)));
  }, [ordered, local, selectedId, depth, neighbors, nodeById, kind, query, names, mode]);
  const mapNodes = useMemo(() => visible.slice(0, local ? selectedId ? 48 : 24 : 80), [visible, local, selectedId]);
  const mapIds = useMemo(() => new Set(mapNodes.map((node) => node.id)), [mapNodes]);
  const mapEdges = useMemo(() => graph.edges.filter((edge) => mapIds.has(edge.sourceNodeId) && mapIds.has(edge.targetNodeId)).sort((a, b) => b.weight - a.weight).slice(0, 160), [graph.edges, mapIds]);
  // Names and pointer movement never participate in layout. Coordinates remain stable while inspecting.
  const layoutKey = mapNodes.map((node) => node.id).join("|");
  const positions = useMemo(() => layoutRelationshipMap(mapNodes, mapEdges), [layoutKey, graph.edges]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = [...new Set(ordered.map((node) => node.kind))];
  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const visibleSummary = readableGraphSummary(detail?.summary || "");
  const connections = selectedId ? [...(neighbors.get(selectedId) || [])].flatMap((id) => nodeById.get(id) ? [nodeById.get(id)!] : []) : [];

  function clearSelection() { selectionGuard.clear(); setSelectedId(undefined); setDetail(undefined); setDetailError(undefined); setDetailLoading(false); }
  function changeMode(next: GraphMode) {
    if (mode === next) return;
    namesRequest.current?.abort(); setNaming(false); clearSelection(); setMode(next); setNames({}); setQuery(""); setKind("all"); setNotice(""); setCamera({ x: 0, y: 0, zoom: 1 });
  }
  async function selectNode(id: string) {
    if (!nodeById.has(id)) return;
    const request = selectionGuard.begin(mode, id);
    setSelectedId(id); setDetail(undefined); setDetailError(undefined); setDetailLoading(true);
    try {
      const result = await readDetail(mode, id, request.controller.signal);
      if (!selectionGuard.isCurrent(request)) return;
      setDetail(result); setNames((current) => ({ ...current, [id]: result.label }));
    } catch (reason) { if (selectionGuard.isCurrent(request)) setDetailError(message(reason)); }
    finally { if (selectionGuard.isCurrent(request)) setDetailLoading(false); }
  }
  async function showNames() {
    namesRequest.current?.abort();
    const controller = new AbortController(); namesRequest.current = controller;
    const pending = mapNodes.filter((node) => !names[node.id]).slice(0, 24);
    setNaming(true); setNotice("");
    let loaded = 0, failed = 0;
    for (const node of pending) {
      if (controller.signal.aborted) break;
      try {
        const result = await readDetail(mode, node.id, controller.signal);
        if (controller.signal.aborted) break;
        setNames((current) => ({ ...current, [node.id]: result.label })); loaded++;
      } catch { if (!controller.signal.aborted) failed++; }
    }
    if (!controller.signal.aborted) {
      setNaming(false);
      setNotice(`${loaded} ${loaded === 1 ? "name" : "names"} loaded.${failed ? ` ${failed} could not be opened with your current access.` : ""} ${mapNodes.filter((node) => !names[node.id]).length > pending.length ? "Select Show names again for more." : ""}`.trim());
    }
  }
  function refresh() {
    selectionGuard.clear(); namesRequest.current?.abort(); setNaming(false); setNames({}); setDetail(undefined); setDetailLoading(false); setNotice(""); setLoading(true); setReload((value) => value + 1);
  }
  async function rebuild() {
    setRebuilding(true); setError(undefined);
    try {
      const response = await fetch("/api/memory/graph", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "memory-universe" }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The relationship map could not be updated.");
      refresh();
    } catch (reason) { setError(message(reason)); }
    finally { setRebuilding(false); }
  }
  function zoom(factor: number) { setCamera((current) => ({ ...current, zoom: Math.max(.45, Math.min(3.5, current.zoom * factor)) })); }
  const highlight = hoveredId || selectedId;

  return <section className={styles.shell} aria-labelledby="memory-universe-title">
    <header className={styles.header}>
      <div><h2 id="memory-universe-title">Relationship map</h2><p>Choose an item to explore its connections. Show names to open up to 24 visible items at a time.</p></div>
      <button type="button" onClick={refresh} disabled={loading}><RefreshCw size={16} /> Refresh</button>
    </header>
    {error ? <p className={styles.error} role="alert"><CircleAlert size={16} />{error}{payload ? " The previous map is still shown." : ""}</p> : null}
    <div className={styles.toolbar}>
      <div className={styles.modes} aria-label="Relationship type">
        <button type="button" aria-pressed={mode === "evidence"} onClick={() => changeMode("evidence")}><Layers3 size={16} />Related evidence</button>
        <button type="button" aria-pressed={mode === "verified"} onClick={() => changeMode("verified")}><ShieldCheck size={16} />Stated relationships</button>
      </div>
      <label className={styles.search}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter loaded names or types" aria-label="Filter loaded names or types" /></label>
      <label className={styles.typeFilter}><span className={styles.srOnly}>Item type</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All types</option>{kinds.map((value) => <option key={value} value={value}>{labelForKind(value, mode)}</option>)}</select></label>
    </div>
    <div className={styles.mapBar}>
      <p>{mode === "evidence" ? "Lines show shared context, not proven facts." : "Lines show claims stated in sources; claims may still need review."}</p>
      <button type="button" onClick={() => void showNames()} disabled={naming || !mapNodes.some((node) => !names[node.id])}>{naming ? "Opening names…" : "Show names"}</button>
    </div>
    {notice || loading ? <p className={styles.notice} role="status">{loading ? payload ? "Refreshing map…" : "Loading relationships…" : notice}</p> : null}
    <div className={styles.explorer}>
      <div className={styles.mapPane}>
        <div className={styles.stage}>
          <svg ref={svgRef} className={styles.canvas} viewBox="0 0 1000 620" role="img" aria-label="Relationship map. Select items in the accessible list beside the map." tabIndex={0}
            onKeyDown={(event) => {
              if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "+", "=", "-", "0"].includes(event.key)) event.preventDefault();
              if (event.key === "+" || event.key === "=") zoom(1.2);
              else if (event.key === "-") zoom(1 / 1.2);
              else if (event.key === "0") setCamera({ x: 0, y: 0, zoom: 1 });
              else if (event.key.startsWith("Arrow")) setCamera((current) => ({ ...current, x: current.x + (event.key === "ArrowLeft" ? 30 : event.key === "ArrowRight" ? -30 : 0), y: current.y + (event.key === "ArrowUp" ? 30 : event.key === "ArrowDown" ? -30 : 0) }));
            }}
            onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y, moved: false }; }}
            onPointerMove={(event) => { const drag = dragRef.current; if (!drag) return; const scale = 1 / (event.currentTarget.getScreenCTM()?.a || 1); const dx = event.clientX - drag.x, dy = event.clientY - drag.y; if (Math.hypot(dx, dy) > 4) drag.moved = true; if (drag.moved) setCamera((current) => ({ ...current, x: drag.cameraX + dx * scale, y: drag.cameraY + dy * scale })); }}
            onPointerUp={(event) => { const drag = dragRef.current; if (drag && !drag.moved) { const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return; const cursor = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); const x = cursor.x, y = cursor.y; const nearest = mapNodes.find((node) => { const p = positions.get(node.id)!; return Math.hypot(x - ((p.x - 500) * camera.zoom + 500 + camera.x), y - ((p.y - 310) * camera.zoom + 310 + camera.y)) < 16; }); if (nearest) void selectNode(nearest.id); } dragRef.current = null; }}
            onPointerCancel={() => { dragRef.current = null; }}>
            <g transform={`translate(${500 + camera.x} ${310 + camera.y}) scale(${camera.zoom}) translate(-500 -310)`}>
              {mapEdges.map((edge) => { const from = positions.get(edge.sourceNodeId)!, to = positions.get(edge.targetNodeId)!; const active = edge.sourceNodeId === highlight || edge.targetNodeId === highlight; return <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={active ? styles.activeLink : styles.link} opacity={highlight && !active ? .2 : undefined} />; })}
              {mapNodes.map((node) => { const point = positions.get(node.id)!; const active = node.id === selectedId; const showLabel = active || node.id === hoveredId || mapNodes.length <= 24 || (Boolean(names[node.id]) && camera.zoom > 1.25); return <g key={node.id} transform={`translate(${point.x} ${point.y})`} onPointerEnter={() => setHoveredId(node.id)} onPointerLeave={() => setHoveredId(undefined)}><title>{label(node)} · {node.sourceCount} sources</title><circle r={active ? 10 : 5 + Math.min(4, Math.sqrt(neighbors.get(node.id)?.size || 0))} className={active ? styles.selectedNode : styles.node} fill={colorForKind(node.kind, mode)} />{showLabel ? <text y={24} textAnchor="middle" className={styles.nodeLabel}>{shortLabel(label(node))}</text> : null}</g>; })}
            </g>
          </svg>
          {!loading && !mapNodes.length ? <div className={styles.empty}><strong>{query || kind !== "all" ? "No items match these filters" : "No relationships to show yet"}</strong><p>{query ? "Names can be searched after you open an item or choose Show names." : "Saved memories and processed sources will appear here when connected."}</p></div> : null}
        </div>
        <div className={styles.cameraBar}>
          <span>Drag to pan · Scroll or +/− to zoom</span>
          <div><button type="button" onClick={() => zoom(1.2)} aria-label="Zoom in"><ZoomIn size={16} /></button><button type="button" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out"><ZoomOut size={16} /></button><button type="button" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}><Focus size={16} />Fit</button></div>
        </div>
        <div className={styles.focusBar}>
          <label><input type="checkbox" checked={local} onChange={(event) => setLocal(event.target.checked)} />Focus on selected item</label>
          {local && selected ? <label>Connections <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}><option value="1">Direct</option><option value="2">Two steps</option></select></label> : null}
          <span>{mapNodes.length} items · {mapEdges.length} links{visible.length > mapNodes.length ? ` · ${visible.length - mapNodes.length} more match` : ""}</span>
        </div>
        <div className={styles.legend} aria-label="Map legend"><span><i />Item</span><span><i className={styles.legendSelected} />Selected</span><span><b />Connection in sources</span></div>
      </div>
      <aside className={styles.sidebar}>
        {selected ? <section className={styles.inspector}>
          <header><h3 ref={inspectorTitle} tabIndex={-1}>{label(selected)}</h3><button type="button" onClick={clearSelection} aria-label="Close selected item"><X size={16} /></button></header>
          {detailLoading ? <p role="status">Opening item…</p> : null}
          {detailError ? <p className={styles.error} role="alert">{detailError}<button type="button" onClick={() => void selectNode(selected.id)}>Retry</button></p> : null}
          {visibleSummary ? <p className={styles.summary}>{visibleSummary}</p> : null}
          <p className={styles.meta}>{singularKind(selected.kind, mode)} · {selected.sourceCount} {selected.sourceCount === 1 ? "source" : "sources"} · {connections.length} connections</p>
          {detail?.state ? <p className={styles.meta}>Status: {startCase(detail.state)}</p> : null}
          {connections.length ? <><h4>Connected items</h4><ul className={styles.pointList}>{connections.slice(0, 16).map((node) => <li key={node.id}><button type="button" onClick={() => void selectNode(node.id)}>{label(node)}<span>{singularKind(node.kind, mode)}</span></button></li>)}</ul>{connections.length > 16 ? <p className={styles.meta}>Showing 16 of {connections.length} connections.</p> : null}</> : null}
          <details className={styles.technical}><summary>Technical reference</summary><code>{selected.id}</code>{detail ? <>
            <p>Updated {formatDate(detail.updatedAt)}</p>
            {detail.label !== label(selected) ? <p>Original name: {detail.label}</p> : null}
            {detail.summary && visibleSummary !== detail.summary ? <><p>Original source summary</p><p className={styles.summary}>{detail.summary}</p></> : null}
          </> : null}</details>
        </section> : <section className={styles.entry}><h3>Start with an item</h3><p>Select a dot or a row below. Its direct connections will become the focus.</p></section>}
        <section className={styles.selector}><h3>{selected && local ? "In this neighborhood" : "Most connected items"}</h3><p className={styles.meta}>Open an item to read its name and source summary.</p><ul className={styles.pointList}>{mapNodes.map((node) => <li key={node.id}><button type="button" aria-pressed={selectedId === node.id} onClick={() => void selectNode(node.id)}><strong>{label(node)}</strong><span>{node.sourceCount} sources</span></button></li>)}</ul></section>
      </aside>
    </div>
    <details className={styles.mapDetails}><summary>Map coverage and maintenance</summary><p>This is a limited view of your available relationships. The map shows up to 80 items, or 48 in a neighborhood, and 160 links. Names load only when opened; searching filters loaded names and types.</p>{payload ? <p>Snapshot: {formatDate(payload.generatedAt)} · {graph.nodes.length.toLocaleString()} available items · {graph.edges.length.toLocaleString()} available links.</p> : null}{payload?.verified.stats.relationLimitSaturated && mode === "verified" ? <p>More stated relationships may exist outside this sample.</p> : null}{payload?.evidence.stats.latestBuild?.status === "failed" ? <p className={styles.error}>The latest map update failed. You can retry below.</p> : null}<button type="button" onClick={() => void rebuild()} disabled={rebuilding}><GitBranch size={16} />{rebuilding ? "Updating connections…" : "Update connections"}</button>{props.onAddConnectedFact ? <button type="button" onClick={props.onAddConnectedFact}><Plus size={16} />Add connected fact</button> : null}</details>
  </section>;
}

async function readDetail(mode: GraphMode, id: string, signal: AbortSignal) {
  const view = mode === "evidence" ? "universe_node" : "universe_entity";
  const response = await fetch(`/api/memory/graph?view=${view}&id=${encodeURIComponent(id)}`, { cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "This item could not be opened.");
  return universeDetailForSelection(body, { mode, id }) as SelectedDetail;
}

function layoutRelationshipMap(nodes: SceneNode[], edges: SceneEdge[]) {
  const points = new Map(nodes.map((node, index) => { const angle = index * 2.399963; const radius = 40 + Math.sqrt((index + 1) / Math.max(1, nodes.length)) * 230; return [node.id, { x: 500 + Math.cos(angle) * radius * 1.5, y: 310 + Math.sin(angle) * radius }]; }));
  for (let iteration = 0; iteration < 90; iteration++) {
    const movement = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const p = points.get(nodes[a].id)!, q = points.get(nodes[b].id)!;
      const dx = p.x - q.x, dy = p.y - q.y, distance = Math.max(16, Math.hypot(dx, dy));
      const force = Math.min(6, 1700 / (distance * distance));
      const m = movement.get(nodes[a].id)!, n = movement.get(nodes[b].id)!;
      m.x += dx / distance * force; m.y += dy / distance * force; n.x -= dx / distance * force; n.y -= dy / distance * force;
    }
    for (const edge of edges) {
      const p = points.get(edge.sourceNodeId), q = points.get(edge.targetNodeId);
      if (!p || !q) continue;
      const dx = q.x - p.x, dy = q.y - p.y, distance = Math.max(1, Math.hypot(dx, dy)), force = (distance - 110) * .012;
      const m = movement.get(edge.sourceNodeId)!, n = movement.get(edge.targetNodeId)!;
      m.x += dx / distance * force; m.y += dy / distance * force; n.x -= dx / distance * force; n.y -= dy / distance * force;
    }
    for (const node of nodes) { const p = points.get(node.id)!, m = movement.get(node.id)!; p.x = Math.max(55, Math.min(945, p.x + m.x + (500 - p.x) * .001)); p.y = Math.max(45, Math.min(570, p.y + m.y + (310 - p.y) * .001)); }
  }
  return points;
}
function colorForKind(kind: string, mode: GraphMode) { return `var(${mode === "evidence" ? evidenceColors[kind as MemoryGraphNodeKind] || "--foreground" : entityColors[kind as EntityTypeId] || "--foreground"})`; }
function labelForKind(kind: string, mode: GraphMode) { return (mode === "evidence" ? evidenceLabels[kind as MemoryGraphNodeKind] : entityLabels[kind as EntityTypeId]) || startCase(kind); }
function singularKind(kind: string, _mode: GraphMode) { if (kind === "concept") return "Topic"; if (kind === "person") return "Person"; if (kind === "memory") return "Memory"; if (kind === "trace") return "Recall"; return startCase(kind); }
// Historical run tags are technical provenance, never a useful topic name.
const generatedRunLabel = /^(?:source[\s_-]+)?run[\s:_-]+[a-f0-9]{8}(?:[\s-]+[a-f0-9]{1,12})*$/i;
function readableGraphLabel(value: string, fallback: string) {
  return generatedRunLabel.test(value.trim()) ? fallback : value;
}
function readableGraphSummary(value: string) {
  const tag = /^Tag signal:\s*(.+)$/i.exec(value.trim());
  if (tag && generatedRunLabel.test(tag[1])) return "Connects this item to a recorded assistant task.";
  // Only split the known machine footer. Ordinary prose and its source remain exact.
  const footer = /(?:^|\r?\n)[ \t]*Source run:[ \t]*[a-f0-9]{8}(?:-[a-f0-9]{1,12}){0,4}[ \t]*(?:\r?\n|$)/i.exec(value);
  return footer ? value.slice(0, footer.index).trimEnd() : value;
}
function shortLabel(value: string) { return value.length > 30 ? `${value.slice(0, 29)}…` : value; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date); }
function startCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function message(error: unknown) { return error instanceof Error ? error.message : "The map could not be updated."; }
