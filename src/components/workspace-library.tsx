"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  FileImage,
  FileSpreadsheet,
  FileText,
  Files,
  Grid2X2,
  Library,
  Link2,
  List,
  LockKeyhole,
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
import styles from "@/components/workspace-library.module.css";

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
  countsAreLowerBound: boolean;
}>;

type LibraryView = "list" | "grid";

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
  const headingId = useId();
  const availableKinds = useMemo(
    () => kinds?.length ? [...new Set(kinds)] : allKinds,
    [kinds],
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<WorkspaceLibraryKind | "all">("all");
  const [offset, setOffset] = useState(0);
  const [displayedOffset, setDisplayedOffset] = useState(0);
  const [offsetHistory, setOffsetHistory] = useState<readonly number[]>([]);
  const [urlProjectId, setUrlProjectId] = useState<string>();
  const [payload, setPayload] = useState<LibraryPayload>({
    items: [],
    total: 0,
    totalIsLowerBound: false,
    nextOffset: null,
    countsByKind: {},
    countsAreLowerBound: false,
  });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [view, setView] = useState<LibraryView>("list");
  const [selectedId, setSelectedId] = useState<string>();
  const [copiedCitation, setCopiedCitation] = useState<string>();
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
          countsAreLowerBound: Boolean(body.countsAreLowerBound),
        });
        setDisplayedOffset(offset);
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
  }, [offset, query, refreshKey, reloadNonce, requestHref]);

  const shownKinds = availableKinds.filter((candidate) =>
    payload.countsByKind[candidate] || candidate === kind,
  );
  const selectedItem = payload.items.find((item) => item.id === selectedId)
    || payload.items[0];
  const visibleStart = payload.items.length ? displayedOffset + 1 : 0;
  const visibleEnd = displayedOffset + payload.items.length;

  function changeQuery(nextQuery: string) {
    setQuery(nextQuery);
    setOffset(0);
    setOffsetHistory([]);
    syncLibraryLocation({ query: nextQuery, kind, projectId: effectiveProjectId, offset: 0 }, compact);
  }

  function changeKind(nextKind: WorkspaceLibraryKind | "all") {
    setKind(nextKind);
    setOffset(0);
    setOffsetHistory([]);
    setSelectedId(undefined);
    syncLibraryLocation({ query, kind: nextKind, projectId: effectiveProjectId, offset: 0 }, compact);
  }

  function changePage(nextOffset: number) {
    const bounded = Math.min(Math.max(Math.trunc(nextOffset), 0), 10_000);
    setOffset(bounded);
    setSelectedId(undefined);
    syncLibraryLocation({ query, kind, projectId: effectiveProjectId, offset: bounded }, compact);
  }

  function showNextPage() {
    if (payload.nextOffset === null) return;
    setOffsetHistory((history) => [...history, offset]);
    changePage(payload.nextOffset);
  }

  function showPreviousPage() {
    const previousOffset = offsetHistory.at(-1);
    if (previousOffset === undefined) {
      if (offset > 0) changePage(0);
      return;
    }
    setOffsetHistory((history) => history.slice(0, -1));
    changePage(previousOffset);
  }

  function clearFilters() {
    setQuery("");
    setKind("all");
    setOffset(0);
    setOffsetHistory([]);
    setSelectedId(undefined);
    syncLibraryLocation({ query: "", kind: "all", projectId: effectiveProjectId, offset: 0 }, compact);
  }

  async function copyCitation(reference: string) {
    try {
      await navigator.clipboard.writeText(reference);
      setCopiedCitation(reference);
    } catch {
      setCopiedCitation(undefined);
    }
  }

  return (
    <section
      className={clsx(styles.shell, compact && styles.compactShell, className)}
      aria-labelledby={headingId}
      aria-busy={state === "loading"}
      data-testid="workspace-library"
    >
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <p className={styles.eyebrow}><Library size={14} aria-hidden="true" /> Unified library</p>
          <div className={styles.titleLine}>
            <h2 id={headingId}>{title}</h2>
            <span className={styles.total} aria-live="polite">
              {state === "loading" && !payload.items.length
                ? "—"
                : `${payload.total}${payload.totalIsLowerBound ? "+" : ""}`}
            </span>
          </div>
          <p className={styles.description}>{description}</p>
        </div>

        <div className={styles.toolbar}>
          <label className={styles.searchField}>
            <span>Search library</span>
            <span className={styles.inputShell}>
              <Search size={17} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => changeQuery(event.currentTarget.value)}
                placeholder="Search titles, sources, and citations"
              />
            </span>
          </label>
          <label className={styles.kindSelect}>
            <span>Asset type</span>
            <select
              value={kind}
              onChange={(event) => changeKind(event.currentTarget.value as WorkspaceLibraryKind | "all")}
            >
              <option value="all">All asset types</option>
              {availableKinds.map((candidate) => (
                <option key={candidate} value={candidate}>{workspaceLibraryKindLabel(candidate)}</option>
              ))}
            </select>
          </label>
          {!compact ? (
            <div className={styles.viewSwitch} role="group" aria-label="Library layout">
              <button
                type="button"
                onClick={() => setView("list")}
                aria-pressed={view === "list"}
                aria-label="List view"
                className={view === "list" ? styles.activeView : undefined}
              >
                <List size={16} aria-hidden="true" /> <span>List</span>
              </button>
              <button
                type="button"
                onClick={() => setView("grid")}
                aria-pressed={view === "grid"}
                aria-label="Grid view"
                className={view === "grid" ? styles.activeView : undefined}
              >
                <Grid2X2 size={15} aria-hidden="true" /> <span>Grid</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {state === "error" ? (
        <div className={styles.error} role="alert">
          <span><CircleAlert size={16} aria-hidden="true" /> {error}</span>
          <button type="button" onClick={() => setReloadNonce((value) => value + 1)}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </button>
        </div>
      ) : null}

      {compact ? (
        <CompactLibrary
          items={payload.items}
          state={state}
          query={query}
          kind={kind}
          onClear={clearFilters}
        />
      ) : (
        <div className={styles.workspace} data-testid="workspace-library-browser">
          <nav className={styles.collectionRail} aria-label="Library collections">
            <div className={styles.railHeading}>
              <span>Collections</span>
              <small>{shownKinds.length || availableKinds.length}</small>
            </div>
            <button
              type="button"
              onClick={() => changeKind("all")}
              aria-pressed={kind === "all"}
              className={kind === "all" ? styles.activeCollection : undefined}
            >
              <span className={styles.collectionIcon}><Files size={16} aria-hidden="true" /></span>
              <span><strong>All assets</strong><small>Every readable source</small></span>
              <b>{kind === "all" ? `${payload.total}${payload.totalIsLowerBound ? "+" : ""}` : ""}</b>
            </button>
            {shownKinds.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => changeKind(candidate)}
                aria-pressed={kind === candidate}
                className={kind === candidate ? styles.activeCollection : undefined}
              >
                <span className={styles.collectionIcon}>{iconForKind(candidate, 16)}</span>
                <span><strong>{workspaceLibraryKindLabel(candidate)}</strong><small>{kindDescription(candidate)}</small></span>
                <b>{boundedLibraryCount(payload.countsByKind[candidate] || 0, payload.countsAreLowerBound)}</b>
              </button>
            ))}
            {kind !== "all" ? (
              <button type="button" onClick={() => changeKind("all")} className={styles.clearFilter}>
                Show every type
              </button>
            ) : null}
          </nav>

          <div className={styles.ledger}>
            <div className={styles.ledgerHeader}>
              <div>
                <p>Recently updated</p>
                <span aria-live="polite">
                  {visibleStart}–{visibleEnd} of {payload.total}{payload.totalIsLowerBound ? "+" : ""}
                </span>
              </div>
              {state === "loading" && payload.items.length ? (
                <span className={styles.refreshing}><Clock3 size={13} aria-hidden="true" /> Updating</span>
              ) : null}
            </div>

            {state === "loading" && !payload.items.length ? (
              <LibrarySkeleton />
            ) : payload.items.length ? (
              view === "list" ? (
                <div className={styles.assetList} role="list" aria-label="Library assets">
                  {payload.items.map((item, index) => (
                    <WorkspaceLibraryRow
                      key={item.id}
                      item={item}
                      ordinal={displayedOffset + index + 1}
                      selected={selectedItem?.id === item.id}
                      onSelect={() => setSelectedId(item.id)}
                      copiedCitation={copiedCitation}
                      onCopy={(reference) => void copyCitation(reference)}
                      style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
                    />
                  ))}
                </div>
              ) : (
                <div className={styles.assetGrid} role="list" aria-label="Library assets">
                  {payload.items.map((item, index) => (
                    <WorkspaceLibraryTile
                      key={item.id}
                      item={item}
                      selected={selectedItem?.id === item.id}
                      onSelect={() => setSelectedId(item.id)}
                      copiedCitation={copiedCitation}
                      onCopy={(reference) => void copyCitation(reference)}
                      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
                    />
                  ))}
                </div>
              )
            ) : state === "ready" ? (
              <LibraryEmpty
                filtered={Boolean(query || kind !== "all")}
                onClear={clearFilters}
              />
            ) : null}

            {payload.items.length && (offset > 0 || offsetHistory.length > 0 || payload.nextOffset !== null) ? (
              <div className={styles.pager} aria-label="Library pages">
                <span>Showing {visibleStart}–{visibleEnd}</span>
                <div>
                  <button
                    type="button"
                    onClick={showPreviousPage}
                    disabled={(offset === 0 && !offsetHistory.length) || state === "loading"}
                  >
                    <ArrowLeft size={14} aria-hidden="true" /> {offsetHistory.length ? "Previous" : "First page"}
                  </button>
                  <button
                    type="button"
                    onClick={showNextPage}
                    disabled={payload.nextOffset === null || state === "loading"}
                  >
                    Next <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <WorkspaceLibraryInspector
            item={selectedItem}
            copiedCitation={copiedCitation}
            onCopy={(reference) => void copyCitation(reference)}
          />
        </div>
      )}
    </section>
  );
}

function CompactLibrary({
  items,
  state,
  query,
  kind,
  onClear,
}: {
  items: readonly WorkspaceLibraryItem[];
  state: "loading" | "ready" | "error";
  query: string;
  kind: WorkspaceLibraryKind | "all";
  onClear: () => void;
}) {
  if (state === "loading" && !items.length) return <LibrarySkeleton compact />;
  if (!items.length && state === "ready") {
    return <LibraryEmpty filtered={Boolean(query || kind !== "all")} onClear={onClear} />;
  }
  return (
    <div className={styles.compactList} role="list" aria-label="Library assets">
      {items.map((item) => {
        const relatedLinks = item.links.filter((link) => link.kind !== "source");
        return (
          <article key={item.id} className={styles.compactRow} role="listitem" data-status={item.status}>
            <span className={styles.assetGlyph} data-kind={item.kind}>{iconForKind(item.kind, 16)}</span>
            <div className={styles.compactMain}>
              <h3>{item.title}</h3>
              <p>{item.sourceLabel} · {formatLibraryTime(item.updatedAt)}</p>
            </div>
            <span className={styles.compactStatus}>{statusIcon(item.status)} {statusLabel(item.status)}</span>
            <LibraryOpenLink item={item} compact />
            <div className={styles.compactFacts}>
              <span>v{item.currentVersion.versionNumber} / {item.versionCount}</span>
              <span>{workspaceLibraryVersionSize(item.currentVersion)}</span>
              <span>{scopeLabel(item.scope.visibility)}</span>
              <code title={item.citationRefs[0]}>{item.citationRefs[0]}</code>
              {relatedLinks.slice(0, 2).map((link) => link.href ? (
                <Link key={`${link.kind}:${link.id}`} href={link.href}>{link.label}</Link>
              ) : (
                <span key={`${link.kind}:${link.id}`} title={link.id}>{link.label}</span>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function WorkspaceLibraryRow({
  item,
  ordinal,
  selected,
  onSelect,
  copiedCitation,
  onCopy,
  style,
}: {
  item: WorkspaceLibraryItem;
  ordinal: number;
  selected: boolean;
  onSelect: () => void;
  copiedCitation?: string;
  onCopy: (reference: string) => void;
  style: CSSProperties;
}) {
  return (
    <article
      className={clsx(styles.assetRow, selected && styles.selectedAsset)}
      role="listitem"
      data-library-kind={item.kind}
      data-status={item.status}
      style={style}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Show details for ${item.title}`}>
        <span className={styles.ordinal}>{String(ordinal).padStart(2, "0")}</span>
        <span className={styles.assetGlyph} data-kind={item.kind}>{iconForKind(item.kind, 17)}</span>
        <span className={styles.assetMain}>
          <strong>{item.title}</strong>
          <small>{item.summary || `${workspaceLibraryKindLabel(item.kind)} from ${item.sourceLabel}`}</small>
        </span>
        <span className={styles.sourceFact}><small>Source</small><strong>{item.sourceLabel}</strong></span>
        <span className={styles.versionFact}><small>Version</small><strong>v{item.currentVersion.versionNumber} · {workspaceLibraryVersionSize(item.currentVersion)}</strong></span>
        <span className={styles.statusFact} data-status={item.status}>{statusIcon(item.status)} {statusLabel(item.status)}</span>
        <ChevronRight className={styles.rowChevron} size={16} aria-hidden="true" />
      </button>
      <LibraryOpenLink item={item} />
      {selected ? (
        <MobileLibraryDetails item={item} copiedCitation={copiedCitation} onCopy={onCopy} />
      ) : null}
    </article>
  );
}

function WorkspaceLibraryTile({
  item,
  selected,
  onSelect,
  copiedCitation,
  onCopy,
  style,
}: {
  item: WorkspaceLibraryItem;
  selected: boolean;
  onSelect: () => void;
  copiedCitation?: string;
  onCopy: (reference: string) => void;
  style: CSSProperties;
}) {
  return (
    <article
      className={clsx(styles.assetTile, selected && styles.selectedAsset)}
      role="listitem"
      data-status={item.status}
      style={style}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Show details for ${item.title}`}>
        <span className={styles.tileTop}>
          <span className={styles.assetGlyph} data-kind={item.kind}>{iconForKind(item.kind, 20)}</span>
          <span className={styles.statusFact} data-status={item.status}>{statusIcon(item.status)} {statusLabel(item.status)}</span>
        </span>
        <span className={styles.tileTitle}>{item.title}</span>
        <span className={styles.tileSummary}>{item.summary || `${workspaceLibraryKindLabel(item.kind)} from ${item.sourceLabel}`}</span>
        <span className={styles.tileFooter}>
          <span>{item.sourceLabel}</span>
          <span>v{item.currentVersion.versionNumber} · {workspaceLibraryVersionSize(item.currentVersion)}</span>
        </span>
      </button>
      <LibraryOpenLink item={item} />
      {selected ? (
        <MobileLibraryDetails item={item} copiedCitation={copiedCitation} onCopy={onCopy} />
      ) : null}
    </article>
  );
}

function MobileLibraryDetails({
  item,
  copiedCitation,
  onCopy,
}: {
  item: WorkspaceLibraryItem;
  copiedCitation?: string;
  onCopy: (reference: string) => void;
}) {
  const citation = item.citationRefs[0];
  const relatedLinks = item.links.filter((link) => link.kind !== "source");
  return (
    <div className={styles.mobileDetails} aria-label={`Details for ${item.title}`}>
      <p>{item.summary || `${workspaceLibraryKindLabel(item.kind)} from ${item.sourceLabel}`}</p>
      <dl>
        <div><dt>Source</dt><dd>{item.sourceLabel}</dd></div>
        <div><dt>Updated</dt><dd>{formatLibraryTime(item.updatedAt)}</dd></div>
        <div><dt>Version</dt><dd>v{item.currentVersion.versionNumber} of {item.versionCount}</dd></div>
        <div><dt>Access</dt><dd>{scopeLabel(item.scope.visibility)}</dd></div>
      </dl>
      {item.tags.length ? (
        <div className={styles.mobileTags} aria-label="Tags">
          {item.tags.slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      ) : null}
      {relatedLinks.length ? (
        <div className={styles.mobileLinks} aria-label="Related work">
          {relatedLinks.slice(0, 3).map((link) => link.href ? (
            <Link key={`${link.kind}:${link.id}`} href={link.href}>{link.label}<ChevronRight size={13} aria-hidden="true" /></Link>
          ) : (
            <span key={`${link.kind}:${link.id}`}>{link.label}</span>
          ))}
        </div>
      ) : null}
      <div className={styles.mobileCitation}>
        <code>{citation}</code>
        <button type="button" onClick={() => onCopy(citation)}>
          {copiedCitation === citation ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copiedCitation === citation ? "Copied" : "Copy citation"}
        </button>
      </div>
    </div>
  );
}

function WorkspaceLibraryInspector({
  item,
  copiedCitation,
  onCopy,
}: {
  item?: WorkspaceLibraryItem;
  copiedCitation?: string;
  onCopy: (reference: string) => void;
}) {
  if (!item) {
    return (
      <aside className={styles.inspector} aria-label="Quick look">
        <div className={styles.inspectorEmpty}>
          <Library size={22} aria-hidden="true" />
          <strong>Select an asset</strong>
          <p>Its source, version, access, links, and citation will appear here.</p>
        </div>
      </aside>
    );
  }
  const citation = item.citationRefs[0];
  const relatedLinks = item.links.filter((link) => link.kind !== "source");
  return (
    <aside className={styles.inspector} aria-label="Quick look">
      <div key={item.id} className={styles.inspectorContent}>
        <div className={styles.inspectorTop}>
          <span className={styles.inspectorGlyph} data-kind={item.kind}>{iconForKind(item.kind, 22)}</span>
          <span className={styles.statusFact} data-status={item.status}>{statusIcon(item.status)} {statusLabel(item.status)}</span>
        </div>
        <p className={styles.inspectorEyebrow}>Quick look · {workspaceLibraryKindLabel(item.kind)}</p>
        <h3>{item.title}</h3>
        <p className={styles.inspectorSummary}>{item.summary || `A ${workspaceLibraryKindLabel(item.kind).toLowerCase()} from ${item.sourceLabel}.`}</p>

        <dl className={styles.inspectorFacts}>
          <div><dt>Source</dt><dd>{item.sourceLabel}</dd></div>
          <div><dt>Updated</dt><dd>{formatLibraryTime(item.updatedAt)}</dd></div>
          <div><dt>Version</dt><dd>v{item.currentVersion.versionNumber} of {item.versionCount}</dd></div>
          <div><dt>Size</dt><dd>{workspaceLibraryVersionSize(item.currentVersion)}</dd></div>
          <div><dt>Access</dt><dd><LockKeyhole size={12} aria-hidden="true" /> {scopeLabel(item.scope.visibility)}</dd></div>
        </dl>

        {item.tags.length ? (
          <div className={styles.tagBlock}>
            <p>Tags</p>
            <div>{item.tags.slice(0, 8).map((tag) => <span key={tag}>{tag}</span>)}</div>
          </div>
        ) : null}

        {relatedLinks.length ? (
          <div className={styles.linkBlock}>
            <p><Link2 size={13} aria-hidden="true" /> Related work</p>
            <div>
              {relatedLinks.slice(0, 4).map((link) => link.href ? (
                <Link key={`${link.kind}:${link.id}`} href={link.href}>{link.label}<ChevronRight size={13} aria-hidden="true" /></Link>
              ) : (
                <span key={`${link.kind}:${link.id}`}>{link.label}</span>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.citationBlock}>
          <div><p>Citation</p><span>Stable source reference</span></div>
          <code title={citation}>{citation}</code>
          <button type="button" onClick={() => onCopy(citation)} aria-label="Copy citation">
            {copiedCitation === citation ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copiedCitation === citation ? "Copied" : "Copy"}
          </button>
        </div>

        <LibraryOpenLink item={item} inspector />
      </div>
    </aside>
  );
}

function LibraryOpenLink({
  item,
  compact = false,
  inspector = false,
}: {
  item: WorkspaceLibraryItem;
  compact?: boolean;
  inspector?: boolean;
}) {
  if (!item.openHref) return null;
  const className = clsx(
    styles.openLink,
    compact && styles.compactOpenLink,
    inspector && styles.inspectorOpenLink,
  );
  const content = inspector ? (
    <>Open asset <ExternalLink size={14} aria-hidden="true" /></>
  ) : compact ? (
    <><span>Open</span><ExternalLink size={13} aria-hidden="true" /></>
  ) : (
    <><span>Open</span><ExternalLink size={14} aria-hidden="true" /></>
  );
  const accessibleLabel = `Open ${item.title}`;
  return item.openHref.startsWith("/api/") ? (
    <a href={item.openHref} className={className} aria-label={accessibleLabel}>{content}</a>
  ) : (
    <Link href={item.openHref} className={className} aria-label={accessibleLabel}>{content}</Link>
  );
}

function LibrarySkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={clsx(styles.skeletonList, compact && styles.compactSkeleton)} role="status" aria-label="Loading library assets">
      {[0, 1, 2, 3].slice(0, compact ? 3 : 4).map((index) => (
        <div key={index} className={styles.skeletonRow}>
          <span />
          <div><i /><i /></div>
          <i />
        </div>
      ))}
    </div>
  );
}

function LibraryEmpty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className={styles.emptyState}>
      <Library size={22} aria-hidden="true" />
      <strong>{filtered ? "Nothing matches this view" : "Your library is ready for its first asset"}</strong>
      <p>{filtered ? "Try another phrase or return to every asset type." : "Capture a file, complete Agent work, or connect a source."}</p>
      {filtered ? <button type="button" onClick={onClear}>Clear filters</button> : null}
    </div>
  );
}

export function workspaceLibraryVersionSize(version: WorkspaceLibraryItem["currentVersion"]) {
  return version.mediaType === "application/x.asael-source-metadata"
    ? "Metadata only"
    : formatBytes(version.byteCount);
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

function syncLibraryLocation(input: {
  query: string;
  kind: WorkspaceLibraryKind | "all";
  projectId?: string;
  offset: number;
}, compact: boolean) {
  if (compact || typeof window === "undefined") return;
  const url = new URL(window.location.href);
  setOrDelete(url.searchParams, "libraryQuery", input.query.trim());
  setOrDelete(url.searchParams, "libraryKind", input.kind === "all" ? "" : input.kind);
  setOrDelete(url.searchParams, "project", input.projectId || "");
  setOrDelete(url.searchParams, "libraryOffset", input.offset > 0 ? String(input.offset) : "");
  window.history.replaceState(window.history.state, "", url);
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}

function boundedLibraryCount(value: number, lowerBound: boolean) {
  return `${value}${lowerBound && value > 0 ? "+" : ""}`;
}

export function workspaceLibraryKindLabel(kind: WorkspaceLibraryKind) {
  if (kind === "generated_artifact") return "Generated";
  if (kind === "recording") return "Recording";
  return kind.charAt(0).toUpperCase() + kind.slice(1).replaceAll("_", " ");
}

function iconForKind(kind: WorkspaceLibraryKind, size: number) {
  if (kind === "image") return <FileImage size={size} aria-hidden="true" />;
  if (kind === "audio" || kind === "recording" || kind === "transcript") return <AudioLines size={size} aria-hidden="true" />;
  if (kind === "video") return <Video size={size} aria-hidden="true" />;
  if (kind === "email") return <Mail size={size} aria-hidden="true" />;
  if (kind === "meeting") return <CalendarDays size={size} aria-hidden="true" />;
  if (kind === "message") return <MessageSquare size={size} aria-hidden="true" />;
  if (kind === "spreadsheet") return <FileSpreadsheet size={size} aria-hidden="true" />;
  if (kind === "generated_artifact") return <Sparkles size={size} aria-hidden="true" />;
  return <FileText size={size} aria-hidden="true" />;
}

function kindDescription(kind: WorkspaceLibraryKind) {
  if (kind === "document" || kind === "file") return "Files and source material";
  if (kind === "transcript" || kind === "recording" || kind === "audio") return "Spoken knowledge";
  if (kind === "image" || kind === "video") return "Visual media";
  if (kind === "email" || kind === "message") return "Conversations";
  if (kind === "meeting") return "People and decisions";
  if (kind === "generated_artifact") return "Agent-created work";
  return "Indexed workspace item";
}

function scopeLabel(scope: WorkspaceLibraryItem["scope"]["visibility"]) {
  if (scope === "workspace_shared") return "Workspace";
  if (scope === "project_shared") return "Project";
  if (scope === "mission_shared") return "Mission";
  return "Private";
}

function statusLabel(status: WorkspaceLibraryItem["status"]) {
  if (status === "ready") return "Ready";
  if (status === "processing") return "Processing";
  if (status === "failed") return "Needs attention";
  return "Unsupported";
}

function statusIcon(status: WorkspaceLibraryItem["status"]) {
  if (status === "ready") return <CheckCircle2 size={13} aria-hidden="true" />;
  if (status === "processing") return <Clock3 size={13} aria-hidden="true" />;
  return <CircleAlert size={13} aria-hidden="true" />;
}

function formatLibraryTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
