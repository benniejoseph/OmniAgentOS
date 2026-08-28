"use client";

import { useMemo, useRef, useState } from "react";
import {
  Brain,
  Hammer,
  Map,
  MessageSquareText,
  Minus,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { clsx } from "clsx";

type ConversationMode = "orchestrate" | "research" | "execute" | "learn";

export type ConversationCanvasThread = {
  id: string;
  title: string;
  updatedAt: string;
  mode: ConversationMode;
};

const modes: Array<{
  id: ConversationMode;
  label: string;
  description: string;
  icon: typeof Brain;
}> = [
  { id: "orchestrate", label: "General", description: "Everyday thinking and decisions", icon: Brain },
  { id: "research", label: "Research", description: "Questions and evidence", icon: Search },
  { id: "execute", label: "Tools", description: "Actions and execution", icon: Hammer },
  { id: "learn", label: "Knowledge", description: "Learning and retained context", icon: Map },
];

type CanvasNode = {
  id: string;
  kind: "root" | "mode" | "thread";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  description: string;
  mode?: ConversationMode;
  thread?: ConversationCanvasThread;
};

type CanvasEdge = {
  id: string;
  from: CanvasNode;
  to: CanvasNode;
};

export function ConversationCanvas({
  threads,
  activeThreadId,
  onSelect,
  onNew,
}: {
  threads: ConversationCanvasThread[];
  activeThreadId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | undefined>(undefined);
  const [view, setView] = useState({ x: 28, y: 36, scale: 0.9 });
  const layout = useMemo(() => buildCanvasLayout(threads), [threads]);

  function zoom(delta: number) {
    setView((current) => ({ ...current, scale: clamp(current.scale + delta, 0.55, 1.25) }));
  }

  function resetView() {
    setView({ x: 28, y: 36, scale: 0.9 });
  }

  return (
    <section className="relative min-h-[34rem] overflow-hidden bg-[#f4f1e9] text-[#26241f] dark:bg-[#171713] dark:text-[#f3f0e8]" aria-label="Conversation hierarchy canvas">
      <div className="absolute left-3 right-3 top-3 z-20 max-w-none rounded-2xl border border-black/10 bg-white/90 px-4 py-3 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#23231e]/90 sm:left-4 sm:right-auto sm:top-4 sm:max-w-sm">
        <p className="text-sm font-semibold">Conversation map</p>
        <p className="mt-1 text-xs leading-5 text-black/55 dark:text-white/55">
          Every conversation stays connected to the way it was run. Select a card to return to its chat.
        </p>
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

      <div
        ref={surfaceRef}
        className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        style={{
          backgroundImage: "radial-gradient(circle, color-mix(in srgb, currentColor 14%, transparent) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
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
              const x1 = edge.from.x + edge.from.width;
              const y1 = edge.from.y + edge.from.height / 2;
              const x2 = edge.to.x;
              const y2 = edge.to.y + edge.to.height / 2;
              const midpoint = x1 + Math.max(70, (x2 - x1) / 2);
              return (
                <path
                  key={edge.id}
                  d={`M ${x1} ${y1} C ${midpoint} ${y1}, ${midpoint} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.18"
                  strokeWidth="1.5"
                />
              );
            })}
          </svg>

          {layout.nodes.map((node) => {
            if (node.kind === "root") {
              return (
                <div key={node.id} className="absolute rounded-3xl border border-[#c9a45c]/45 bg-[#fffaf0] p-4 shadow-[0_18px_50px_-32px_rgba(53,42,19,0.45)] dark:bg-[#2a271f]" style={nodeStyle(node)}>
                  <span className="grid size-9 place-items-center rounded-full bg-[#c9a45c]/15 text-[#997326]"><MessageSquareText size={17} aria-hidden="true" /></span>
                  <p className="mt-4 text-base font-semibold">{node.label}</p>
                  <p className="mt-1 text-xs leading-5 text-black/50 dark:text-white/50">{node.description}</p>
                  <button type="button" onClick={onNew} className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[#2d2b26] px-3 text-xs font-semibold text-white dark:bg-[#f2eee3] dark:text-[#22211d]">
                    <Plus size={13} aria-hidden="true" /> New conversation
                  </button>
                </div>
              );
            }

            if (node.kind === "mode") {
              const definition = modes.find((mode) => mode.id === node.mode) || modes[0];
              const Icon = definition.icon;
              return (
                <div key={node.id} className="absolute rounded-2xl border border-black/10 bg-white/82 p-3 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#22221d]/90" style={nodeStyle(node)}>
                  <div className="flex items-center gap-2.5">
                    <span className="grid size-8 place-items-center rounded-xl bg-black/[0.045] text-[#9a762c] dark:bg-white/[0.07]"><Icon size={15} aria-hidden="true" /></span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{node.label}</p>
                      <p className="truncate text-[11px] text-black/45 dark:text-white/45">{node.description}</p>
                    </div>
                  </div>
                </div>
              );
            }

            const active = node.thread?.id === activeThreadId;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => node.thread && onSelect(node.thread.id)}
                className={clsx(
                  "absolute rounded-2xl border p-4 text-left shadow-[0_16px_44px_-34px_rgba(0,0,0,0.5)] transition hover:-translate-y-0.5 hover:shadow-md",
                  active
                    ? "border-[#b88c35] bg-[#2d2b26] text-white ring-4 ring-[#c9a45c]/15 dark:bg-[#eee8d9] dark:text-[#22211d]"
                    : "border-black/10 bg-white/92 hover:border-[#c9a45c]/55 dark:border-white/10 dark:bg-[#24241f]/95",
                )}
                style={nodeStyle(node)}
                aria-current={active ? "page" : undefined}
              >
                <span className={clsx("text-[10px] font-semibold uppercase tracking-[0.16em]", active ? "text-white/55 dark:text-black/50" : "text-[#9a762c]")}>{modeLabel(node.thread?.mode)}</span>
                <span className="mt-2 block line-clamp-2 text-sm font-semibold leading-5">{node.label}</span>
                <span className={clsx("mt-3 block text-[11px]", active ? "text-white/55 dark:text-black/50" : "text-black/45 dark:text-white/45")}>{node.description}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function buildCanvasLayout(threads: ConversationCanvasThread[]) {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const grouped = modes.map((mode) => ({
    ...mode,
    threads: threads.filter((thread) => thread.mode === mode.id),
  }));
  const rowGap = 112;
  let cursorY = 80;
  const modeNodes: CanvasNode[] = [];

  for (const group of grouped) {
    const rowCount = Math.max(1, group.threads.length);
    const groupHeight = Math.max(74, rowCount * rowGap);
    const modeNode: CanvasNode = {
      id: `mode:${group.id}`,
      kind: "mode",
      x: 330,
      y: cursorY + groupHeight / 2 - 34,
      width: 210,
      height: 68,
      label: group.label,
      description: group.threads.length ? `${group.threads.length} conversation${group.threads.length === 1 ? "" : "s"}` : "No conversations yet",
      mode: group.id,
    };
    nodes.push(modeNode);
    modeNodes.push(modeNode);

    group.threads.forEach((thread, index) => {
      const threadNode: CanvasNode = {
        id: `thread:${thread.id}`,
        kind: "thread",
        x: 650,
        y: cursorY + index * rowGap,
        width: 270,
        height: 92,
        label: thread.title,
        description: relativeTime(thread.updatedAt),
        mode: thread.mode,
        thread,
      };
      nodes.push(threadNode);
      edges.push({ id: `${modeNode.id}:${threadNode.id}`, from: modeNode, to: threadNode });
    });
    cursorY += groupHeight + 54;
  }

  const rootNode: CanvasNode = {
    id: "workspace",
    kind: "root",
    x: 24,
    y: 80,
    width: 220,
    height: 184,
    label: "Asael workspace",
    description: `${threads.length} connected conversation${threads.length === 1 ? "" : "s"}`,
  };
  nodes.unshift(rootNode);
  modeNodes.forEach((modeNode) => edges.unshift({ id: `${rootNode.id}:${modeNode.id}`, from: rootNode, to: modeNode }));

  return {
    nodes,
    edges,
    width: 980,
    height: Math.max(640, cursorY + 60),
  };
}

function nodeStyle(node: CanvasNode) {
  return { left: node.x, top: node.y, width: node.width, minHeight: node.height };
}

function relativeTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Recently updated";
  return `Updated ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date)}`;
}

function modeLabel(mode?: ConversationMode) {
  return modes.find((item) => item.id === mode)?.label || "Conversation";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
