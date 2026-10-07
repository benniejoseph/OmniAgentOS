"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, Brain, CheckCheck, ChevronRight, FileText, Flag, GitBranch, Heart, Lightbulb, ListChecks, Mail, MessageSquare, Search, RefreshCw, Sparkles } from "lucide-react";
import type { KnowledgeIndexItem, MemoryIndexItem } from "@/lib/memory/intelligence";
import styles from "./memory-landscape.module.css";

type Collection = "memory" | "knowledge";
type Catalog = { items: Array<MemoryIndexItem | KnowledgeIndexItem>; total: number; nextCursor?: string | null };
type Entry = { id: string; title: string; category: string; date: string; detail: string; state?: string };
const collections: Record<string, { label: string; description: string; icon: typeof Brain }> = {
  preferences: { label: "Your preferences", description: "How you like things done", icon: Heart },
  commitments: { label: "Commitments", description: "Promises and follow-through", icon: Flag },
  decisions: { label: "Decisions", description: "Choices worth remembering", icon: CheckCheck },
  procedures: { label: "How-to", description: "Ways of getting things done", icon: ListChecks },
  experiences: { label: "Experiences", description: "What happened and what you learned", icon: MessageSquare },
  summaries: { label: "Summaries", description: "The useful context to carry forward", icon: FileText },
  facts: { label: "Facts & context", description: "Things Asael can refer back to", icon: Lightbulb },
  mail: { label: "Email", description: "Messages and correspondence", icon: Mail },
  calendar: { label: "Calendar", description: "Events and appointments", icon: Flag },
  drive: { label: "Drive files", description: "Files from your connected drive", icon: FileText },
  transcripts: { label: "Conversations", description: "Meeting notes and transcripts", icon: MessageSquare },
  documents: { label: "Documents", description: "Reports, decks and other documents", icon: FileText },
  web: { label: "Web sources", description: "Saved pages and research", icon: BookOpen },
  notes: { label: "Notes", description: "Ideas and notes you saved", icon: Lightbulb },
  other: { label: "Other sources", description: "Other material in your library", icon: BookOpen },
};

/** Organizes the already-authorized catalog. Branches mean category membership, never inferred facts. */
export function MemoryLandscape({ active, onOpenMemory, onOpenSource, onShowConnections }: { active: boolean; onOpenMemory?: (id: string) => void; onOpenSource?: (title: string) => void; onShowConnections?: () => void }) {
  const [collection, setCollection] = useState<Collection>("memory");
  const [catalogs, setCatalogs] = useState<Partial<Record<Collection, Catalog>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    const parameters = new URLSearchParams({ view: collection, limit: "100", state: collection === "memory" ? "active" : "all" });
    void fetch(`/api/memory/intelligence?${parameters}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || "Your library could not be loaded.");
      const catalog = body[collection] as Catalog | undefined;
      if (!catalog || !Array.isArray(catalog.items)) throw new Error("The library returned an unreadable result.");
      setCatalogs((current) => ({ ...current, [collection]: catalog }));
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Your library could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, collection, revision]);

  const catalog = catalogs[collection];
  const entries = useMemo<Entry[]>(() => (catalog?.items || []).filter((item) => !/^\s*\[retired\]/i.test(item.title)).map((item) => {
    if ("evidenceCount" in item) return { id: item.id, title: friendlyTitle(item.title, item.updatedAt), category: item.category, date: item.updatedAt, detail: `${item.evidenceCount} ${item.evidenceCount === 1 ? "source" : "sources"} · ${item.useCount} ${item.useCount === 1 ? "recall" : "recalls"}`, state: item.state };
    return { id: item.id, title: item.title, category: item.category, date: item.indexedAt, detail: item.sourceLabel || "Saved source" };
  }), [catalog]);
  const matching = useMemo(() => entries.filter((entry) => `${entry.title} ${collections[entry.category]?.label || entry.category}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [entries, query]);
  const groups = useMemo(() => {
    const result = new Map<string, Entry[]>();
    for (const entry of matching) { if (!result.has(entry.category)) result.set(entry.category, []); result.get(entry.category)!.push(entry); }
    return [...result].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [matching]);
  const currentGroups = category ? groups.filter(([key]) => key === category) : groups;
  function changeCollection(next: Collection) { setCollection(next); setCategory(undefined); setSelected(undefined); setQuery(""); }
  function recordDetails(entry: Entry) { return <aside className={styles.selection} aria-label="Selected record"><div><span className={styles.selectionType}>{collections[entry.category]?.label || readable(entry.category)}</span><h3>{entry.title}</h3><p>{entry.detail} · {dateLabel(entry.date)}{entry.state ? ` · ${readable(entry.state)}` : ""}</p></div>{collection === "memory" && onOpenMemory ? <button type="button" className={styles.openButton} onClick={() => onOpenMemory(entry.id)}>Open memory <ArrowUpRight size={16} /></button> : onOpenSource ? <button type="button" className={styles.openButton} onClick={() => onOpenSource(entry.title)}>Open source library <ArrowUpRight size={16} /></button> : <p className={styles.sourceHelp}>Find this title in the Knowledge tab to view its source record.</p>}<button type="button" className={styles.close} onClick={() => setSelected(undefined)} aria-label="Close selected record">×</button></aside>; }

  return <section className={styles.workspace} aria-label="Knowledge map">
    <div className={styles.toolbar}>
      <div className={styles.switcher} aria-label="Map collection"><button type="button" aria-pressed={collection === "memory"} onClick={() => changeCollection("memory")}><Brain size={16} />Memories</button><button type="button" aria-pressed={collection === "knowledge"} onClick={() => changeCollection("knowledge")}><BookOpen size={16} />Sources</button></div>
      {onShowConnections ? <button type="button" className={styles.connectionButton} onClick={onShowConnections}><GitBranch size={16} />Connections</button> : null}
      <label className={styles.search}><Search size={17} /><input aria-label="Search this map" placeholder="Find a title or collection" value={query} onChange={(event) => { setQuery(event.target.value); setCategory(undefined); setSelected(undefined); }} /></label>
      <button type="button" className={styles.iconButton} onClick={() => setRevision((value) => value + 1)} disabled={loading} aria-label="Refresh knowledge map"><RefreshCw size={17} /></button>
    </div>
    {error ? <p className={styles.error} role="alert">{error}{catalog ? " Previously loaded titles are still shown." : ""}</p> : null}
    {loading ? <p className={styles.loading} role="status">{catalog ? "Refreshing your map…" : "Opening your memory library…"}</p> : null}
    <div className={styles.mapFrame} aria-busy={loading}>
      <div className={styles.mapCaption}>
        {category ? <button type="button" onClick={() => { setCategory(undefined); setSelected(undefined); }}><ArrowLeft size={15} />All collections</button> : <span><Sparkles size={15} />{collection === "memory" ? "What Asael remembers" : "Where the context comes from"}</span>}
        <span>{matching.length} {query ? "matching" : "loaded"} {collection === "memory" ? "memories" : "sources"} · {groups.length} collections</span>
      </div>
      {currentGroups.length ? <div className={`${styles.diagram} ${category ? styles.focused : ""}`}>
        <div className={styles.origin}><div className={styles.originNode}>{collection === "memory" ? <Brain size={26} strokeWidth={1.5} /> : <BookOpen size={26} strokeWidth={1.5} />}<strong>{collection === "memory" ? "Your memory" : "Your sources"}</strong><span>{category ? collections[category]?.label || readable(category) : "A place for every piece"}</span></div></div>
        <div className={styles.branches}>{currentGroups.map(([key, rows]) => {
          const definition = collections[key] || { label: readable(key), description: "Saved context", icon: BookOpen }; const Icon = definition.icon;
          const shown = category ? rows : rows.slice(0, groups.length > 3 ? 2 : 3);
          return <section key={key} className={styles.branch} aria-label={definition.label}>
            <div className={styles.collectionCell}><button type="button" className={styles.collectionButton} aria-pressed={category === key} onClick={() => { setCategory(category === key ? undefined : key); setSelected(undefined); }}><Icon size={20} strokeWidth={1.6} /><span><strong>{definition.label}</strong><small>{rows.length} {collection === "memory" ? "memories" : "sources"}</small></span><ChevronRight size={16} /></button><p>{definition.description}</p></div>
            <ul className={styles.records}>{shown.map((entry) => <li key={entry.id}><button type="button" className={styles.record} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}><span className={styles.recordMarker} /><span><strong>{entry.title}</strong><small>{dateLabel(entry.date)}</small></span><ChevronRight size={14} /></button>{selected === entry.id ? recordDetails(entry) : null}</li>)}{shown.length < rows.length ? <li className={styles.more}><button type="button" onClick={() => setCategory(key)}>Explore {rows.length - shown.length} more <ArrowUpRight size={14} /></button></li> : null}</ul>
          </section>;
        })}</div>
      </div> : !loading ? <div className={styles.empty}><BookOpen size={28} strokeWidth={1.5} /><h3>{query ? "No titles match that search" : collection === "memory" ? "Give your memory a starting point" : "Your source map starts here"}</h3><p>{query ? "Search looks through the titles loaded in this map. Your full library is available in Memory and Knowledge." : collection === "memory" ? "Add something useful to remember. Preferences, decisions and experiences will find their own place here." : "Upload a document or save some research. Your sources will be organized here by type."}</p></div> : <div className={styles.skeleton} aria-hidden="true"><span /><span /><span /></div>}

      <footer className={styles.coverage}><span>Branches group saved records by category. They do not imply a factual relationship.</span><span>{catalog?.nextCursor ? "Showing up to 100 recently updated records; use your library for the full collection." : collection === "memory" ? "Active memories only. Archived and replaced items remain in your library." : "The available source catalog is shown."}</span></footer>
    </div>
  </section>;
}
function friendlyTitle(title: string, updatedAt: string) { return /^Assistant inference from run\s+[a-f0-9]{8}(?:-[a-f0-9]{1,12}){0,4}(?:…|\.{3})?$/i.test(title.trim()) ? `Assistant note · ${dateLabel(updatedAt)}` : title; }
function readable(value: string) { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date); }
