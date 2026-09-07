"use client";

import { useMemo, useRef, useState } from "react";
import {
  Bot,
  Boxes,
  FileText,
  FolderKanban,
  GitFork,
  Loader2,
  MessageSquareText,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { clsx } from "clsx";

import type {
  ConversationCanvasEdgeKind,
  ConversationCanvasNodeKind,
} from "@/lib/conversations/canvas";

type CanvasNode = {
  id: string;
  kind: ConversationCanvasNodeKind;
  entityId: string;
  title: string;
  detail: string;
  status: string;
  occurredAt: string;
  threadId: string | null;
  runId: string | null;
  projectId: string | null;
  contextAccess: {
    state: "granted" | "none" | "not_established";
    grantCount: number | null;
    detail: string;
  };
};

type CanvasEdge = {
  id: string;
  kind: ConversationCanvasEdgeKind;
  from: string;
  to: string;
  label: string;
  authority: string;
  relationshipId: string;
};

type CanvasProjection = {
  version: "p11.3-conversation-canvas:1";
  generatedAt: string;
  digest: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  memoryBoundary: {
    mode: "explicit_grants_only";
    grantedRunCount: number;
    detail: string;
  };
  truncated: boolean;
};

type PositionedNode = CanvasNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PositionedEdge = CanvasEdge & {
  fromNode: PositionedNode;
  toNode: PositionedNode;
};

const NODE_KINDS = new Set<ConversationCanvasNodeKind>([
  "conversation",
  "run",
  "project",
  "delegation",
  "artifact",
]);

const EDGE_KINDS = new Set<ConversationCanvasEdgeKind>([
  "conversation_run",
  "run_fork",
  "conversation_project",
  "project_artifact",
  "run_delegation",
  "delegation_parent",
  "delegation_artifact_produced",
  "delegation_artifact_shared",
]);

export function ConversationCanvas({
  projection: rawProjection,
  state,
  error,
  activeThreadId,
  onSelectThread,
  onSelectRun,
  onNew,
  onRefresh,
}: {
  projection?: unknown;
  state: "idle" | "loading" | "ready" | "error";
  error?: string;
  activeThreadId?: string;
  onSelectThread: (id: string) => void;
  onSelectRun: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | undefined>(undefined);
  const [view, setView] = useState({ x: 28, y: 114, scale: 0.86 });
  const projection = useMemo(
    () => parseConversationCanvasProjection(rawProjection),
    [rawProjection],
  );
  const layout = useMemo(() => buildCanvasLayout(projection), [projection]);

  function zoom(delta: number) {
    setView((current) => ({
      ...current,
      scale: clamp(current.scale + delta, 0.5, 1.25),
    }));
  }

  function resetView() {
    setView({ x: 28, y: 114, scale: 0.86 });
  }

  return (
    <section
      className="relative min-h-[38rem] overflow-hidden bg-[#f4f1e9] text-[#26241f] dark:bg-[#171713] dark:text-[#f3f0e8]"
      aria-label="Canonical Conversation lineage canvas"
    >
      <div className="absolute left-3 right-3 top-3 z-20 rounded-2xl border border-black/10 bg-white/92 px-4 py-3 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#23231e]/92 sm:left-4 sm:right-auto sm:max-w-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">Canonical Conversation map</p>
            <p className="mt-1 text-xs leading-5 text-black/55 dark:text-white/55">
              Only persisted run, fork, delegation, Project, and artifact relationships are linked.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={state === "loading"}
            className="grid size-9 shrink-0 place-items-center rounded-full text-black/55 hover:bg-black/5 disabled:opacity-50 dark:text-white/55 dark:hover:bg-white/10"
            aria-label="Refresh Conversation map"
          >
            <RefreshCw size={14} className={state === "loading" ? "animate-spin" : undefined} aria-hidden="true" />
          </button>
        </div>
        {projection ? (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-black/45 dark:text-white/45">
            <span>{projection.nodes.length} nodes</span>
            <span aria-hidden="true">·</span>
            <span>{projection.edges.length} canonical links</span>
            <span aria-hidden="true">·</span>
            <span>{projection.memoryBoundary.grantedRunCount} runs with context grants</span>
          </div>
        ) : null}
      </div>

      <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-full border border-black/10 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#23231e]/90 sm:bottom-auto sm:top-4">
        <button type="button" onClick={() => zoom(-0.1)} className="grid size-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10" aria-label="Zoom out">
          <Minus size={15} aria-hidden="true" />
        </button>
        <span className="min-w-11 text-center text-[11px] font-semibold tabular-nums">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoom(0.1)} className="grid size-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10" aria-label="Zoom in">
          <Plus size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={resetView} className="grid size-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10" aria-label="Reset canvas view">
          <RotateCcw size={14} aria-hidden="true" />
        </button>
      </div>

      {state === "loading" && !projection ? (
        <CanvasMessage icon={<Loader2 size={20} className="animate-spin" />} title="Loading canonical relationships" detail="Reading this Conversation's durable lineage." />
      ) : state === "error" && !projection ? (
        <CanvasMessage icon={<RefreshCw size={20} />} title="Conversation map unavailable" detail={error || "Refresh to retry the owner-scoped read."} action={onRefresh} actionLabel="Retry" />
      ) : projection && !projection.nodes.length ? (
        <CanvasMessage icon={<MessageSquareText size={20} />} title="No durable relationships yet" detail="Start a conversation to create the first canonical run relationship." action={onNew} actionLabel="New conversation" />
      ) : !projection ? (
        <CanvasMessage icon={<GitFork size={20} />} title="Open the map to load lineage" detail="The map is read only and does not create execution or memory authority." action={onRefresh} actionLabel="Load map" />
      ) : (
        <div
          ref={surfaceRef}
          className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
          style={{
            backgroundImage: "radial-gradient(circle, color-mix(in srgb, currentColor 14%, transparent) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button, a")) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              originX: view.x,
              originY: view.y,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setView((current) => ({
              ...current,
              x: drag.originX + event.clientX - drag.x,
              y: drag.originY + event.clientY - drag.y,
            }));
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) dragRef.current = undefined;
          }}
          onPointerCancel={() => { dragRef.current = undefined; }}
        >
          <div
            className="absolute left-0 top-0"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true">
              {layout.edges.map((edge) => {
                const x1 = edge.fromNode.x + edge.fromNode.width;
                const y1 = edge.fromNode.y + edge.fromNode.height / 2;
                const x2 = edge.toNode.x;
                const y2 = edge.toNode.y + edge.toNode.height / 2;
                const direction = x2 >= x1 ? 1 : -1;
                const bend = Math.max(62, Math.abs(x2 - x1) / 2);
                const labelX = (x1 + x2) / 2;
                const labelY = (y1 + y2) / 2 - 8;
                return (
                  <g key={edge.id}>
                    <path
                      d={`M ${x1} ${y1} C ${x1 + direction * bend} ${y1}, ${x2 - direction * bend} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity="0.24"
                      strokeWidth={edge.kind === "run_fork" ? 2.5 : 1.5}
                      strokeDasharray={edge.kind === "delegation_artifact_shared" ? "5 4" : undefined}
                    />
                    <text x={labelX} y={labelY} textAnchor="middle" fill="currentColor" fillOpacity="0.48" fontSize="10" fontWeight="600">
                      {edge.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {layout.nodes.map((node) => (
              <CanvasNodeCard
                key={node.id}
                node={node}
                active={node.kind === "conversation" && node.threadId === activeThreadId}
                onSelectThread={onSelectThread}
                onSelectRun={onSelectRun}
              />
            ))}
          </div>
        </div>
      )}

      {projection ? (
        <div className="absolute bottom-4 left-4 z-20 max-w-md rounded-xl border border-black/10 bg-white/90 px-3 py-2 text-[11px] leading-5 text-black/55 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#23231e]/90 dark:text-white/55">
          <span className="inline-flex items-center gap-1 font-semibold text-[#8b6825] dark:text-[#d9b86e]"><ShieldCheck size={12} aria-hidden="true" /> Context boundary</span>
          <span className="ml-2">{projection.memoryBoundary.detail}</span>
          {projection.truncated ? <span className="ml-2 font-semibold">This bounded view has more retained history.</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function CanvasNodeCard({
  node,
  active,
  onSelectThread,
  onSelectRun,
}: {
  node: PositionedNode;
  active: boolean;
  onSelectThread: (id: string) => void;
  onSelectRun: (id: string) => void;
}) {
  const className = clsx(
    "absolute rounded-2xl border p-3.5 text-left shadow-[0_16px_44px_-34px_rgba(0,0,0,0.5)] transition hover:-translate-y-0.5 hover:shadow-md",
    active
      ? "border-[#b88c35] bg-[#2d2b26] text-white ring-4 ring-[#c9a45c]/15 dark:bg-[#eee8d9] dark:text-[#22211d]"
      : nodeTone(node.kind),
  );
  const content = (
    <>
      <span className="flex items-start justify-between gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-black/[0.045] text-[#9a762c] dark:bg-white/[0.07] dark:text-[#d9b86e]">{nodeIcon(node.kind)}</span>
        <span className={clsx("rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]", active ? "bg-white/10 text-white/70 dark:bg-black/10 dark:text-black/60" : "bg-black/[0.045] text-black/50 dark:bg-white/[0.07] dark:text-white/55")}>{node.status.replaceAll("_", " ")}</span>
      </span>
      <span className="mt-3 block line-clamp-2 text-sm font-semibold leading-5">{node.title}</span>
      <span className={clsx("mt-1 block line-clamp-2 text-[11px] leading-4", active ? "text-white/60 dark:text-black/55" : "text-black/50 dark:text-white/50")}>{node.detail}</span>
      <span className={clsx("mt-2 block text-[10px]", active ? "text-white/50 dark:text-black/45" : "text-black/40 dark:text-white/40")}>{nodeKindLabel(node.kind)} · {formatDate(node.occurredAt)}</span>
      {node.kind === "run" ? (
        <span className={clsx("mt-2 inline-flex rounded-full px-2 py-0.5 text-[9px] font-semibold", node.contextAccess.state === "granted" ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-black/[0.045] text-black/45 dark:bg-white/[0.07] dark:text-white/45")} title={node.contextAccess.detail}>
          {node.contextAccess.state === "granted"
            ? `${node.contextAccess.grantCount} context grant${node.contextAccess.grantCount === 1 ? "" : "s"}`
            : node.contextAccess.state === "none" ? "No context grants" : "Scope receipt unavailable"}
        </span>
      ) : null}
    </>
  );
  const style = { left: node.x, top: node.y, width: node.width, minHeight: node.height };

  if (node.kind === "conversation" && node.threadId) {
    return <button type="button" className={className} style={style} onClick={() => onSelectThread(node.threadId!)} aria-current={active ? "page" : undefined}>{content}</button>;
  }
  if (node.kind === "run" && node.runId) {
    return <button type="button" className={className} style={style} onClick={() => onSelectRun(node.runId!)} aria-label={`Open activity for ${node.title}`}>{content}</button>;
  }
  if (node.kind === "project" && node.projectId) {
    return <a className={className} style={style} href={`/app/projects?project=${encodeURIComponent(node.projectId)}`}>{content}</a>;
  }
  if (node.kind === "artifact" && node.projectId) {
    return <a className={className} style={style} href={`/app/projects?project=${encodeURIComponent(node.projectId)}&artifact=${encodeURIComponent(node.entityId)}`}>{content}</a>;
  }
  return <div className={className} style={style}>{content}</div>;
}

function CanvasMessage({ icon, title, detail, action, actionLabel }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center px-6 pt-20">
      <div className="max-w-sm rounded-2xl border border-black/10 bg-white/80 p-6 text-center shadow-sm dark:border-white/10 dark:bg-[#23231e]/80">
        <span className="mx-auto grid size-10 place-items-center rounded-full bg-[#c9a45c]/15 text-[#997326]">{icon}</span>
        <p className="mt-3 text-sm font-semibold">{title}</p>
        <p className="mt-1 text-xs leading-5 text-black/50 dark:text-white/50">{detail}</p>
        {action && actionLabel ? <button type="button" onClick={action} className="mt-4 rounded-full bg-[#2d2b26] px-4 py-2 text-xs font-semibold text-white dark:bg-[#f2eee3] dark:text-[#22211d]">{actionLabel}</button> : null}
      </div>
    </div>
  );
}

export function parseConversationCanvasProjection(value: unknown): CanvasProjection | undefined {
  const root = asRecord(value);
  if (root.version !== "p11.3-conversation-canvas:1") return undefined;
  const rawNodes = Array.isArray(root.nodes) ? root.nodes.slice(0, 600) : [];
  const nodes = rawNodes.flatMap((item) => parseNode(item));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const rawEdges = Array.isArray(root.edges) ? root.edges.slice(0, 1_200) : [];
  const edges = rawEdges.flatMap((item) => parseEdge(item)).filter((edge) =>
    nodeIds.has(edge.from) && nodeIds.has(edge.to)
  );
  const memory = asRecord(root.memoryBoundary);
  const truncatedRecord = asRecord(root.truncated);
  return {
    version: "p11.3-conversation-canvas:1",
    generatedAt: text(root.generatedAt) || new Date(0).toISOString(),
    digest: text(root.digest),
    nodes,
    edges,
    memoryBoundary: {
      mode: "explicit_grants_only",
      grantedRunCount: integer(memory.grantedRunCount),
      detail: text(memory.detail) || "Relationships do not grant shared memory.",
    },
    truncated: Object.values(truncatedRecord).some((item) => item === true),
  };
}

function parseNode(value: unknown): CanvasNode[] {
  const item = asRecord(value);
  const kind = text(item.kind) as ConversationCanvasNodeKind;
  const access = asRecord(item.contextAccess);
  const accessState = text(access.state);
  if (
    !NODE_KINDS.has(kind) ||
    !text(item.id) ||
    !text(item.entityId) ||
    !text(item.title) ||
    !["granted", "none", "not_established"].includes(accessState)
  ) return [];
  return [{
    id: text(item.id),
    kind,
    entityId: text(item.entityId),
    title: text(item.title),
    detail: text(item.detail),
    status: text(item.status) || "unknown",
    occurredAt: text(item.occurredAt),
    threadId: nullableText(item.threadId),
    runId: nullableText(item.runId),
    projectId: nullableText(item.projectId),
    contextAccess: {
      state: accessState as CanvasNode["contextAccess"]["state"],
      grantCount: access.grantCount === null ? null : integer(access.grantCount),
      detail: text(access.detail),
    },
  }];
}

function parseEdge(value: unknown): CanvasEdge[] {
  const item = asRecord(value);
  const kind = text(item.kind) as ConversationCanvasEdgeKind;
  const access = asRecord(item.contextAccess);
  if (
    !EDGE_KINDS.has(kind) ||
    !text(item.id) ||
    !text(item.from) ||
    !text(item.to) ||
    !text(item.authority) ||
    !text(item.relationshipId) ||
    access.state !== "not_implied"
  ) return [];
  return [{
    id: text(item.id),
    kind,
    from: text(item.from),
    to: text(item.to),
    label: text(item.label),
    authority: text(item.authority),
    relationshipId: text(item.relationshipId),
  }];
}

function buildCanvasLayout(projection?: CanvasProjection) {
  if (!projection) return { nodes: [] as PositionedNode[], edges: [] as PositionedEdge[], width: 960, height: 640 };
  const runDepth = relationshipDepth(projection.nodes, projection.edges, "run", "run_fork");
  const delegationDepth = relationshipDepth(projection.nodes, projection.edges, "delegation", "delegation_parent");
  const maxRunDepth = Math.max(0, ...runDepth.values());
  const maxDelegationDepth = Math.max(0, ...delegationDepth.values());
  const layers = new Map<number, CanvasNode[]>();
  for (const node of projection.nodes) {
    const layer = node.kind === "conversation" ? 0
      : node.kind === "project" ? 1
      : node.kind === "run" ? 1 + (runDepth.get(node.id) || 0)
      : node.kind === "delegation" ? 2 + maxRunDepth + (delegationDepth.get(node.id) || 0)
      : 3 + maxRunDepth + maxDelegationDepth;
    layers.set(layer, [...(layers.get(layer) || []), node]);
  }
  const positioned: PositionedNode[] = [];
  for (const [layer, layerNodes] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    layerNodes.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    layerNodes.forEach((node, index) => positioned.push({
      ...node,
      x: 30 + layer * 310,
      y: 50 + index * 132,
      width: 238,
      height: 112,
    }));
  }
  const byId = new Map(positioned.map((node) => [node.id, node]));
  const edges = projection.edges.flatMap((edge) => {
    const fromNode = byId.get(edge.from);
    const toNode = byId.get(edge.to);
    return fromNode && toNode ? [{ ...edge, fromNode, toNode }] : [];
  });
  return {
    nodes: positioned,
    edges,
    width: Math.max(960, ...positioned.map((node) => node.x + node.width + 80)),
    height: Math.max(640, ...positioned.map((node) => node.y + node.height + 110)),
  };
}

function relationshipDepth(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  kind: ConversationCanvasNodeKind,
  edgeKind: ConversationCanvasEdgeKind,
) {
  const ids = new Set(nodes.filter((node) => node.kind === kind).map((node) => node.id));
  const depth = new Map([...ids].map((id) => [id, 0]));
  for (let pass = 0; pass < ids.size; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (edge.kind !== edgeKind || !ids.has(edge.from) || !ids.has(edge.to)) continue;
      const next = Math.min(ids.size, (depth.get(edge.from) || 0) + 1);
      if (next > (depth.get(edge.to) || 0)) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

function nodeIcon(kind: ConversationCanvasNodeKind) {
  if (kind === "conversation") return <MessageSquareText size={15} aria-hidden="true" />;
  if (kind === "run") return <Bot size={15} aria-hidden="true" />;
  if (kind === "project") return <FolderKanban size={15} aria-hidden="true" />;
  if (kind === "delegation") return <Boxes size={15} aria-hidden="true" />;
  return <FileText size={15} aria-hidden="true" />;
}

function nodeKindLabel(kind: ConversationCanvasNodeKind) {
  if (kind === "conversation") return "Conversation";
  if (kind === "run") return "Run";
  if (kind === "project") return "Project";
  if (kind === "delegation") return "Delegation";
  return "Artifact";
}

function nodeTone(kind: ConversationCanvasNodeKind) {
  if (kind === "conversation") return "border-[#c9a45c]/45 bg-[#fffaf0] dark:bg-[#2a271f]";
  if (kind === "run") return "border-blue-500/20 bg-white/92 dark:border-blue-300/15 dark:bg-[#21242a]/95";
  if (kind === "project") return "border-emerald-500/20 bg-white/92 dark:border-emerald-300/15 dark:bg-[#202620]/95";
  if (kind === "delegation") return "border-violet-500/20 bg-white/92 dark:border-violet-300/15 dark:bg-[#252129]/95";
  return "border-amber-500/20 bg-white/92 dark:border-amber-300/15 dark:bg-[#28241d]/95";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 2_048) : "";
}

function nullableText(value: unknown) {
  const valueText = text(value);
  return valueText || null;
}

function integer(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
