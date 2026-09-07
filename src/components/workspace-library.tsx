"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  CalendarDays,
  FileImage,
  FileSpreadsheet,
  FileText,
  Library,
  Link2,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  Video,
} from "lucide-react";
import { clsx } from "clsx";
import type {
  WorkspaceLibraryItem,
  WorkspaceLibraryKind,
} from "@/lib/library/contracts";

type WorkspaceLibraryProps = Readonly<{
  title?: string;
  description?: string;
  kinds?: readonly WorkspaceLibraryKind[];
  projectId?: string;
  compact?: boolean;
  limit?: number;
  refreshKey?: string | number;
  className?: string;
}>;

type LibraryPayload = Readonly<{
  items: readonly WorkspaceLibraryItem[];
  total: number;
  totalIsLowerBound: boolean;
  nextOffset: number | null;
  countsByKind: Partial<Record<WorkspaceLibraryKind, number>>;
}>;

const allKinds: readonly WorkspaceLibraryKind[] = [
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
  "message",
  "webpage",
  "record",
  "generated_artifact",
];

export function WorkspaceLibrary({
  title = "Workspace library",
  description = "Every source and output stays versioned, searchable, cited, and linked to the work it supports.",
  kinds,
  projectId,
  compact = false,
  limit = compact ? 8 : 60,
  refreshKey,
  className,
}: WorkspaceLibraryProps) {
  const availableKinds = useMemo(
    () => kinds?.length ? [...new Set(kinds)] : allKinds,
    [kinds],
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<WorkspaceLibraryKind | "all">("all");
  const [offset, setOffset] = useState(0);
  const [urlProjectId, setUrlProjectId] = useState<string>();
  const [payload, setPayload] = useState<LibraryPayload>({ items: [], total: 0, totalIsLowerBound: false, nextOffset: null, countsByKind: {} });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [reloadNonce, setReloadNonce] = useState(0);
  const effectiveProjectId = projectId || urlProjectId;
  const requestHref = useMemo(() => workspaceLibraryQueryHref({
    query,
    kinds: kind === "all" ? availableKinds : [kind],
    projectId: effectiveProjectId,
    limit,
    offset,
  }), [availableKinds, effectiveProjectId, kind, limit, offset, query]);

  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const requestedQuery = params.get("libraryQuery") || "";
    const requestedKind = params.get("libraryKind");
    const requestedOffset = Number(params.get("libraryOffset") || 0);
    const requestedProject = params.get("project") || undefined;
    const timer = window.setTimeout(() => {
      if (requestedQuery) setQuery(requestedQuery);
      if (requestedKind && availableKinds.includes(requestedKind as WorkspaceLibraryKind)) {
        setKind(requestedKind as WorkspaceLibraryKind);
      }
      if (Number.isInteger(requestedOffset) && requestedOffset > 0 && requestedOffset <= 10_000) {
        setOffset(requestedOffset);
      }
      if (!projectId && requestedProject) setUrlProjectId(requestedProject);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [availableKinds, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState("loading");
      try {
        const response = await fetch(requestHref, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({})) as Partial<LibraryPayload> & { error?: string };
        if (!response.ok) throw new Error(body.error || "Workspace library could not be loaded.");
        if (controller.signal.aborted) return;
        setPayload({
          items: Array.isArray(body.items) ? body.items : [],
          total: typeof body.total === "number" ? body.total : 0,
          totalIsLowerBound: Boolean(body.totalIsLowerBound),
          nextOffset: typeof body.nextOffset === "number" ? body.nextOffset : null,
          countsByKind: body.countsByKind || {},
        });
        setError(undefined);
        setState("ready");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Workspace library could not be loaded.");
        setState("error");
      }
    }, query ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, refreshKey, reloadNonce, requestHref]);

  const shownKinds = availableKinds.filter((candidate) =>
    payload.countsByKind[candidate] || candidate === kind,
  );

  return (
    <section
      className={clsx("rounded-xl border border-line bg-surface", compact ? "p-4" : "p-5 sm:p-6", className)}
      aria-labelledby={`workspace-library-${projectId || "all"}`}
      aria-busy={state === "loading"}
      data-testid="workspace-library"
    >
      <div className={clsx("flex gap-4", compact ? "flex-col" : "flex-col lg:flex-row lg:items-end lg:justify-between")}>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <Library size={14} aria-hidden="true" /> Unified library
          </p>
          <h2 id={`workspace-library-${projectId || "all"}`} className={clsx("mt-2 font-semibold tracking-tight", compact ? "text-lg" : "text-xl")}>{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{description}</p>
        </div>
        <div className={clsx("flex gap-2", compact ? "flex-col sm:flex-row" : "flex-col sm:flex-row")}>
          <label className="relative min-w-56 flex-1">
            <span className="sr-only">Search workspace assets</span>
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => { setQuery(event.currentTarget.value); setOffset(0); }}
              placeholder="Search titles, sources, and citations"
              className="min-h-10 w-full rounded-md border border-line bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </label>
          <label>
            <span className="sr-only">Filter workspace assets by kind</span>
            <select
              value={kind}
              onChange={(event) => { setKind(event.currentTarget.value as WorkspaceLibraryKind | "all"); setOffset(0); }}
              className="min-h-10 w-full rounded-md border border-line bg-background px-3 text-sm text-foreground sm:w-auto"
            >
              <option value="all">All asset types</option>
              {availableKinds.map((candidate) => <option key={candidate} value={candidate}>{workspaceLibraryKindLabel(candidate)}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-line py-3 text-xs text-muted">
        <strong className="text-foreground">{state === "loading" && !payload.items.length ? "—" : `${payload.total}${payload.totalIsLowerBound ? "+" : ""}`}</strong>
        <span>readable asset{payload.total === 1 ? "" : "s"}</span>
        <span aria-hidden="true">·</span>
        <span>stable versions</span>
        <span aria-hidden="true">·</span>
        <span>source citations</span>
        {shownKinds.slice(0, compact ? 3 : 8).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => { setKind(candidate); setOffset(0); }}
            className={clsx("rounded-full px-2 py-1 font-semibold", kind === candidate ? "bg-primary text-primary-ink" : "bg-background text-muted hover:text-foreground")}
          >
            {workspaceLibraryKindLabel(candidate)} {payload.countsByKind[candidate] || 0}
          </button>
        ))}
        {kind !== "all" ? <button type="button" onClick={() => { setKind("all"); setOffset(0); }} className="font-semibold text-primary">Clear type</button> : null}
      </div>

      {state === "error" ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-danger/35 bg-danger/5 px-3 py-3 text-sm" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadNonce((value) => value + 1)} className="action-button"><RefreshCw size={14} aria-hidden="true" /> Retry</button>
        </div>
      ) : null}

      {state === "loading" && !payload.items.length ? (
        <div className="mt-4 flex min-h-32 items-center justify-center gap-2 text-sm text-muted" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading readable assets…
        </div>
      ) : null}

      {payload.items.length ? (
        <>
          <div className={clsx("mt-4 grid gap-3", compact ? "grid-cols-1" : "md:grid-cols-2 2xl:grid-cols-3")}>
            {payload.items.map((item) => <WorkspaceLibraryCard key={item.id} item={item} compact={compact} />)}
          </div>
          {payload.nextOffset !== null ? (
            <div className="mt-4 flex justify-center">
              <Link
                href={workspaceLibraryBrowseHref({ query, kind, projectId: effectiveProjectId, offset: payload.nextOffset })}
                className="action-button"
              >
                Browse the next page
              </Link>
            </div>
          ) : null}
        </>
      ) : state === "ready" ? (
        <div className="mt-4 rounded-lg border border-dashed border-line px-5 py-8 text-center">
          <Library size={22} className="mx-auto text-muted" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold">No readable assets match this view.</p>
          <p className="mt-1 text-xs text-muted">Capture a file, finish Agent work, or connect a source to add one.</p>
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceLibraryCard({ item, compact }: { item: WorkspaceLibraryItem; compact: boolean }) {
  const projectLinks = item.links.filter((link) => ["project", "work_item", "mission"].includes(link.kind));
  return (
    <article className="flex min-w-0 flex-col rounded-lg border border-line bg-background p-4" data-library-kind={item.kind}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">{iconForKind(item.kind)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{workspaceLibraryKindLabel(item.kind)}</span>
            <span className={clsx("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", statusTone(item.status))}>{item.status}</span>
          </div>
          <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-5">{item.title}</h3>
          <p className="mt-1 text-xs text-muted">{item.sourceLabel} · {formatLibraryTime(item.updatedAt)}</p>
        </div>
      </div>
      {item.summary ? <p className={clsx("mt-3 text-xs leading-5 text-muted", compact ? "line-clamp-2" : "line-clamp-3")}>{item.summary}</p> : null}
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted">
        <span className="rounded bg-surface-raised px-2 py-1">v{item.currentVersion.versionNumber} / {item.versionCount}</span>
        <span className="rounded bg-surface-raised px-2 py-1">{formatBytes(item.currentVersion.byteCount)}</span>
        <span className="rounded bg-surface-raised px-2 py-1">{scopeLabel(item.scope.visibility)}</span>
      </div>
      <div className="mt-3 min-w-0 border-t border-line pt-3">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted"><Link2 size={11} aria-hidden="true" /> Citation</p>
        <code className="mt-1 block truncate text-[11px] text-foreground" title={item.citationRefs[0]}>{item.citationRefs[0]}</code>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        {projectLinks.slice(0, 2).map((link) => link.href ? (
          <Link key={`${link.kind}:${link.id}`} href={link.href} className="text-xs font-semibold text-muted hover:text-primary">{link.label}</Link>
        ) : (
          <span key={`${link.kind}:${link.id}`} className="text-xs text-muted" title={link.id}>{link.label}</span>
        ))}
        {item.openHref ? (
          item.openHref.startsWith("/api/")
            ? <a href={item.openHref} className="ml-auto text-xs font-semibold text-primary">Open</a>
            : <Link href={item.openHref} className="ml-auto text-xs font-semibold text-primary">Open</Link>
        ) : null}
      </div>
    </article>
  );
}

export function workspaceLibraryQueryHref(input: {
  query?: string;
  kinds?: readonly WorkspaceLibraryKind[];
  projectId?: string;
  limit: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (input.query?.trim()) params.set("q", input.query.trim());
  for (const kind of [...new Set(input.kinds || [])]) params.append("kind", kind);
  if (input.projectId?.trim()) params.set("project", input.projectId.trim());
  params.set("limit", String(Math.min(Math.max(Math.trunc(input.limit), 1), 100)));
  if (input.offset && input.offset > 0) params.set("offset", String(Math.min(Math.trunc(input.offset), 10_000)));
  return `/api/library?${params.toString()}`;
}

function workspaceLibraryBrowseHref(input: {
  query: string;
  kind: WorkspaceLibraryKind | "all";
  projectId?: string;
  offset: number;
}) {
  const params = new URLSearchParams();
  if (input.query.trim()) params.set("libraryQuery", input.query.trim());
  if (input.kind !== "all") params.set("libraryKind", input.kind);
  if (input.projectId) params.set("project", input.projectId);
  params.set("libraryOffset", String(input.offset));
  return `/app/capture?${params.toString()}`;
}

export function workspaceLibraryKindLabel(kind: WorkspaceLibraryKind) {
  if (kind === "generated_artifact") return "Generated";
  if (kind === "recording") return "Recording";
  return kind.charAt(0).toUpperCase() + kind.slice(1).replaceAll("_", " ");
}

function iconForKind(kind: WorkspaceLibraryKind) {
  if (kind === "image") return <FileImage size={16} aria-hidden="true" />;
  if (kind === "audio" || kind === "recording" || kind === "transcript") return <AudioLines size={16} aria-hidden="true" />;
  if (kind === "video") return <Video size={16} aria-hidden="true" />;
  if (kind === "email") return <Mail size={16} aria-hidden="true" />;
  if (kind === "meeting") return <CalendarDays size={16} aria-hidden="true" />;
  if (kind === "message") return <MessageSquare size={16} aria-hidden="true" />;
  if (kind === "spreadsheet") return <FileSpreadsheet size={16} aria-hidden="true" />;
  if (kind === "generated_artifact") return <Sparkles size={16} aria-hidden="true" />;
  return <FileText size={16} aria-hidden="true" />;
}

function scopeLabel(scope: WorkspaceLibraryItem["scope"]["visibility"]) {
  if (scope === "workspace_shared") return "Workspace";
  if (scope === "project_shared") return "Project";
  if (scope === "mission_shared") return "Mission";
  return "Private";
}

function statusTone(status: WorkspaceLibraryItem["status"]) {
  if (status === "ready") return "bg-success/10 text-success";
  if (status === "failed") return "bg-danger/10 text-danger";
  if (status === "unsupported") return "bg-warning/10 text-warning";
  return "bg-primary/10 text-primary";
}

function formatLibraryTime(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
