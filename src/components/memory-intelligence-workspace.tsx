"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import dynamic from "next/dynamic";
import {
  Archive,
  ArrowRight,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Database,
  FileStack,
  GitBranch,
  Layers3,
  LoaderCircle,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  KnowledgeCategoryId,
  KnowledgeIndexItem,
  MemoryCategoryId,
  MemoryIndexItem,
  MemoryIntelligenceOverview,
  MemoryStewardRecommendation,
} from "@/lib/memory/intelligence";
import type { MemoryReconciliationReview } from "@/lib/memory/reconciliation";
import type { MemoryTier } from "@/lib/memory/tier-policy";
import type { MemoryRecord, MemoryType } from "@/lib/memory/types";
import styles from "@/components/memory-intelligence-workspace.module.css";

const MemoryUniverse = dynamic(
  () => import("@/components/memory-universe").then((module) =>
    module.MemoryUniverse
  ),
  {
    ssr: false,
    loading: () => (
      <div className={styles.universeLoading} role="status">
        <LoaderCircle size={18} className={styles.spin} />
        Preparing the relationship map…
      </div>
    ),
  },
);

type WorkspaceView = "memory" | "knowledge" | "reviews" | "universe";
type Page<T> = { items: T[]; total: number; nextCursor: string | null };
type ConsentStatus = {
  state: "active" | "inactive";
  notice: { text: string; sha256: string };
};
type ForgetPreview = {
  expectedReceiptManifestSha256: string;
  guarantee: "rollback_proof_barrier" | "best_effort";
  impact: {
    descendantMemoryCount: number;
    retrievalTraceCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
  };
};

const emptyPage = <T,>(): Page<T> => ({ items: [], total: 0, nextCursor: null });
const memoryTiers: Array<MemoryTier | "all"> = [
  "all", "preference", "commitment", "decision", "procedural", "episodic",
  "semantic", "summary", "working",
];
const memoryTypes: Array<{ id: MemoryType; label: string; tier: MemoryTier }> = [
  { id: "fact", label: "Fact", tier: "semantic" },
  { id: "preference", label: "Preference", tier: "preference" },
  { id: "decision", label: "Decision", tier: "decision" },
  { id: "task", label: "Commitment", tier: "commitment" },
  { id: "procedure", label: "Procedure", tier: "procedural" },
  { id: "episode", label: "Experience", tier: "episodic" },
];

export function MemoryIntelligenceWorkspace() {
  const [view, setView] = useState<WorkspaceView>("memory");
  const [overview, setOverview] = useState<MemoryIntelligenceOverview>();
  const [memoryPage, setMemoryPage] = useState<Page<MemoryIndexItem>>(emptyPage);
  const [knowledgePage, setKnowledgePage] = useState<Page<KnowledgeIndexItem>>(emptyPage);
  const [reviews, setReviews] = useState<MemoryReconciliationReview[]>([]);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [reviewLimit, setReviewLimit] = useState(20);
  const [universeVisited, setUniverseVisited] = useState(false);
  const [query, setQuery] = useState("");
  const [indexQuery, setIndexQuery] = useState("");
  const [memoryCategory, setMemoryCategory] = useState<MemoryCategoryId | "all">("all");
  const [knowledgeCategory, setKnowledgeCategory] = useState<KnowledgeCategoryId | "all">("all");
  const [tier, setTier] = useState<MemoryTier | "all">("all");
  const [state, setState] = useState<MemoryIndexItem["state"] | "all">("all");
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>();
  const [selectedMemory, setSelectedMemory] = useState<MemoryRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [indexLoading, setIndexLoading] = useState(false);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [forgetPreview, setForgetPreview] = useState<ForgetPreview>();
  const [consent, setConsent] = useState<ConsentStatus>();
  const indexRequestRef = useRef<AbortController | null>(null);
  const reviewsRequestRef = useRef<AbortController | null>(null);
  const indexSignatureRef = useRef<Partial<Record<"memory" | "knowledge", string>>>({});
  const reviewSignatureRef = useRef("");

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/memory/intelligence?view=overview&limit=40", {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Memory intelligence could not be loaded.");
      setOverview(body.overview as MemoryIntelligenceOverview);
      setError(undefined);
    } catch (loadError) {
      setError(message(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConsent = useCallback(async () => {
    try {
      const response = await fetch("/api/memory/personal-context-consent", {
        cache: "no-store",
      });
      if (response.ok) setConsent(await response.json() as ConsentStatus);
    } catch {
      // Consent is an enhancement. The memory catalogue remains available.
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadOverview();
      void loadConsent();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadOverview, loadConsent]);

  useEffect(() => {
    const timer = window.setTimeout(() => setIndexQuery(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadIndex = useCallback(async (
    kind: "memory" | "knowledge",
    cursor?: string,
    force = false,
  ) => {
    const parameters = new URLSearchParams({ view: kind, limit: "40" });
    if (indexQuery) parameters.set("q", indexQuery);
    if (cursor) parameters.set("cursor", cursor);
    if (kind === "memory") {
      parameters.set("category", memoryCategory);
      parameters.set("tier", tier);
      parameters.set("state", state);
    } else {
      parameters.set("category", knowledgeCategory);
    }
    const signature = parameters.toString().replace(/&cursor=[^&]+/, "");
    if (!cursor && !force && indexSignatureRef.current[kind] === signature) {
      return;
    }

    indexRequestRef.current?.abort();
    const controller = new AbortController();
    indexRequestRef.current = controller;
    setIndexLoading(true);
    try {
      const response = await fetch(`/api/memory/intelligence?${parameters}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The index could not be loaded.");
      if (kind === "memory") {
        const next = body.memory as Page<MemoryIndexItem>;
        setMemoryPage((current) => cursor
          ? { ...next, items: [...current.items, ...next.items] }
          : next);
      } else {
        const next = body.knowledge as Page<KnowledgeIndexItem>;
        setKnowledgePage((current) => cursor
          ? { ...next, items: [...current.items, ...next.items] }
          : next);
      }
      indexSignatureRef.current[kind] = signature;
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (indexRequestRef.current === controller) setIndexLoading(false);
    }
  }, [indexQuery, knowledgeCategory, memoryCategory, state, tier]);

  useEffect(() => {
    if (view !== "memory" && view !== "knowledge") {
      indexRequestRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(() => void loadIndex(view), 0);
    return () => window.clearTimeout(timer);
  }, [view, loadIndex]);

  const loadReviews = useCallback(async (force = false) => {
    const signature = `pending:${reviewLimit}`;
    if (!force && reviewSignatureRef.current === signature) return;
    reviewsRequestRef.current?.abort();
    const controller = new AbortController();
    reviewsRequestRef.current = controller;
    setReviewsLoading(true);
    try {
      const response = await fetch(`/api/memory/reconciliation?status=pending&limit=${reviewLimit}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Memory reviews could not be loaded.");
      setReviews(body.reviews || []);
      setReviewsLoaded(true);
      reviewSignatureRef.current = signature;
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(message(loadError));
    } finally {
      if (reviewsRequestRef.current === controller) setReviewsLoading(false);
    }
  }, [reviewLimit]);

  useEffect(() => {
    if (view !== "reviews") {
      reviewsRequestRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(() => void loadReviews(), 0);
    return () => {
      window.clearTimeout(timer);
      reviewsRequestRef.current?.abort();
    };
  }, [view, loadReviews]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setForgetPreview(undefined);
      if (!selectedMemoryId) {
        setSelectedMemory(undefined);
        return;
      }
      setDetailLoading(true);
      void fetch(`/api/memory/${encodeURIComponent(selectedMemoryId)}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Memory details could not be loaded.");
        setSelectedMemory(body.memory as MemoryRecord);
      }).catch((detailError) => {
        if (!controller.signal.aborted) setError(message(detailError));
      }).finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selectedMemoryId]);

  const embeddingCoverage = overview?.summary.knowledgeChunks
    ? Math.round(overview.summary.embeddedChunks / overview.summary.knowledgeChunks * 100)
    : 100;
  async function resolveReview(
    reviewId: string,
    decision: "confirm_candidate" | "keep_existing" | "keep_both",
  ) {
    setBusy(`review:${reviewId}`);
    setReviewErrors((current) => {
      const next = { ...current };
      delete next[reviewId];
      return next;
    });
    try {
      const response = await fetch("/api/memory/reconciliation", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId, decision }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The review could not be resolved.");
      setReviews((current) => current.filter((review) => review.id !== reviewId));
      setAnnouncement("Review resolved. The recall index is being refreshed.");
      await Promise.all([loadReviews(true), loadOverview()]);
    } catch (actionError) {
      const detail = message(actionError);
      setReviewErrors((current) => ({ ...current, [reviewId]: detail }));
      setAnnouncement(`Review was not changed. ${detail}`);
    } finally {
      setBusy(undefined);
    }
  }

  async function runMaintenance() {
    setBusy("maintenance");
    try {
      const response = await fetch("/api/memory/maintenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Memory maintenance could not run.");
      setAnnouncement(
        `Mnemosyne completed a lifecycle scan. ${body.report?.exactDuplicatesArchived || 0} duplicates archived; ${body.reviews?.length || 0} promotions await review.`,
      );
      await loadOverview();
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setBusy(undefined);
    }
  }

  async function enrollLegacyOwnership() {
    setBusy("ownership");
    setError(undefined);
    try {
      const previewResponse = await fetch("/api/memory/ownership", {
        cache: "no-store",
      });
      const previewBody = await previewResponse.json();
      if (!previewResponse.ok) {
        throw new Error(previewBody.error || "Older memory ownership could not be checked.");
      }
      const preview = previewBody.preview as {
        count: number;
        activeCount: number;
        historicalCount: number;
        manifestSha256: string;
      };
      if (!preview.count) {
        setAnnouncement("All durable memories already use your private ownership boundary.");
        await loadOverview();
        return;
      }
      const confirmed = window.confirm(
        `Secure ${preview.count} older memories for your account? ` +
        `${preview.activeCount} are active and ${preview.historicalCount} are retained history.`,
      );
      if (!confirmed) return;
      const response = await fetch("/api/memory/ownership", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "enroll_current_user",
          expectedManifestSha256: preview.manifestSha256,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Older memory ownership could not be secured.");
      }
      indexSignatureRef.current = {};
      reviewSignatureRef.current = "";
      setAnnouncement(
        `${body.migration.migratedCount} older memories now use your private ownership boundary.`,
      );
      await Promise.all([
        loadOverview(),
        loadIndex("memory", undefined, true),
        reviewsLoaded ? loadReviews(true) : Promise.resolve(),
      ]);
    } catch (migrationError) {
      setError(message(migrationError));
    } finally {
      setBusy(undefined);
    }
  }

  async function toggleConsent() {
    if (!consent) return;
    setBusy("consent");
    try {
      const response = await fetch("/api/memory/personal-context-consent", {
        method: consent.state === "active" ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: consent.state === "active"
          ? undefined
          : JSON.stringify({ noticeSha256: consent.notice.sha256 }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Automatic recall could not be changed.");
      setConsent(body as ConsentStatus);
      setAnnouncement(
        body.state === "active"
          ? "Personal automatic recall is now available when you choose it in a conversation."
          : "Personal automatic recall is off.",
      );
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setBusy(undefined);
    }
  }

  async function updateLifecycle(action: "pin" | "unpin" | "archive" | "restore") {
    if (!selectedMemory) return;
    setBusy("lifecycle");
    try {
      const response = await fetch(
        `/api/memory/${encodeURIComponent(selectedMemory.id)}/lifecycle`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Memory state could not be updated.");
      setSelectedMemory(body.memory as MemoryRecord);
      setAnnouncement(`Memory ${action === "unpin" ? "unpinned" : `${action}d`}.`);
      await Promise.all([loadOverview(), loadIndex("memory", undefined, true)]);
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setBusy(undefined);
    }
  }

  async function previewForget() {
    if (!selectedMemory) return;
    setBusy("forget-preview");
    try {
      const response = await fetch(
        `/api/memory/${encodeURIComponent(selectedMemory.id)}?view=deletion-preview`,
        { cache: "no-store" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Deletion impact could not be loaded.");
      setForgetPreview(body.preview as ForgetPreview);
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setBusy(undefined);
    }
  }

  async function forgetMemory() {
    if (!selectedMemory || !forgetPreview) return;
    setBusy("forget");
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(selectedMemory.id)}`, {
        method: "DELETE",
        headers: {
          "x-asael-deletion-preview": forgetPreview.expectedReceiptManifestSha256,
        },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Memory could not be forgotten.");
      setSelectedMemoryId(undefined);
      setForgetPreview(undefined);
      setAnnouncement("Memory and its derived recall paths were forgotten with a deletion receipt.");
      await Promise.all([loadOverview(), loadIndex("memory", undefined, true)]);
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setBusy(undefined);
    }
  }

  function handleRecommendation(item: MemoryStewardRecommendation) {
    if (item.action === "open_reviews") setView("reviews");
    if (item.action === "open_knowledge") setView("knowledge");
    if (item.action === "run_maintenance") void runMaintenance();
    if (item.action === "enroll_ownership") void enrollLegacyOwnership();
  }

  function selectView(nextView: WorkspaceView) {
    setView(nextView);
    if (nextView === "universe") setUniverseVisited(true);
  }

  return (
    <main className={styles.shell}>
      <div className={styles.orbit} aria-hidden="true"><i /><i /><i /></div>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p><Brain size={16} /> Memory observatory</p>
          <h1>A living index of what Asael knows.</h1>
          <span>Durable memory, source knowledge, evidence links and recall quality—organized in one place.</span>
        </div>
        <div className={styles.heroActions}>
          <label className={styles.search}>
            <Search size={17} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this index"
              aria-label="Search memory and knowledge"
            />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={15} /></button> : null}
          </label>
          <button type="button" className={styles.secondaryAction} onClick={() => void loadOverview()} disabled={loading}>
            <RefreshCw size={16} className={loading ? styles.spin : undefined} /> Refresh
          </button>
          <button type="button" className={styles.primaryAction} onClick={() => setCreateOpen(true)}>
            <Plus size={17} /> Add memory
          </button>
        </div>
      </header>

      {error ? <div className={styles.error}><CircleAlert size={17} /><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss</button></div> : null}
      <p className={styles.announcement} role="status">{announcement}</p>

      <section className={styles.metrics} aria-label="Memory health summary">
        <Metric icon={<Brain />} value={overview?.summary.durableMemories} label="Durable memories" />
        <Metric icon={<FileStack />} value={overview?.summary.knowledgeDocuments} label="Knowledge sources" />
        <Metric icon={<Database />} value={`${embeddingCoverage}%`} label="Vector coverage" />
        <Metric icon={<ShieldCheck />} value={overview?.summary.pendingReviews} label="Awaiting review" warning={Boolean(overview?.summary.pendingReviews)} />
        <Metric icon={<GitBranch />} value={overview ? `${overview.summary.graphNodes.toLocaleString()} / ${overview.summary.graphEdges.toLocaleString()}` : undefined} label="Nodes / links" />
      </section>

      <MemoryGuide />

      <nav className={styles.tabs} aria-label="Memory workspace">
        <Tab active={view === "memory"} onClick={() => selectView("memory")} icon={<Brain size={17} />} label="Memory" count={overview?.summary.durableMemories} />
        <Tab active={view === "knowledge"} onClick={() => selectView("knowledge")} icon={<BookOpen size={17} />} label="Knowledge" count={overview?.summary.knowledgeDocuments} />
        <Tab active={view === "reviews"} onClick={() => selectView("reviews")} icon={<ShieldCheck size={17} />} label="Reviews" count={overview?.summary.pendingReviews} />
        <Tab active={view === "universe"} onClick={() => selectView("universe")} icon={<Layers3 size={17} />} label="Universe" />
      </nav>

      {universeVisited ? (
        <div className={styles.universeWrap} hidden={view !== "universe"}>
          <MemoryUniverse active={view === "universe"} />
        </div>
      ) : null}
      {view !== "universe" ? (
        <div className={styles.workspaceGrid}>
          <section className={styles.indexPane}>
            {view === "memory" ? (
              <MemoryIndex
                overview={overview}
                page={memoryPage}
                category={memoryCategory}
                onCategory={setMemoryCategory}
                tier={tier}
                onTier={setTier}
                state={state}
                onState={setState}
                selectedId={selectedMemoryId}
                onSelect={setSelectedMemoryId}
                loading={indexLoading}
                onMore={() => void loadIndex("memory", memoryPage.nextCursor || undefined)}
              />
            ) : view === "knowledge" ? (
              <KnowledgeIndex
                overview={overview}
                page={knowledgePage}
                category={knowledgeCategory}
                onCategory={setKnowledgeCategory}
                loading={indexLoading}
                onMore={() => void loadIndex("knowledge", knowledgePage.nextCursor || undefined)}
              />
            ) : (
              <ReviewIndex
                reviews={reviews}
                loaded={reviewsLoaded}
                loading={reviewsLoading}
                busy={busy}
                errors={reviewErrors}
                onResolve={resolveReview}
                total={overview?.summary.pendingReviews || reviews.length}
                onMore={() => setReviewLimit((current) => current + 20)}
              />
            )}
          </section>

          <MnemosynePanel
            overview={overview}
            consent={consent}
            busy={busy}
            onConsent={() => void toggleConsent()}
            onScan={() => void runMaintenance()}
            onRecommendation={handleRecommendation}
          />
        </div>
      ) : null}

      {selectedMemoryId && view === "memory" ? (
        <MemoryInspector
          memory={selectedMemory}
          loading={detailLoading}
          busy={busy}
          preview={forgetPreview}
          onClose={() => setSelectedMemoryId(undefined)}
          onLifecycle={updateLifecycle}
          onPreviewForget={() => void previewForget()}
          onForget={() => void forgetMemory()}
          onCancelForget={() => setForgetPreview(undefined)}
        />
      ) : null}

      {createOpen ? (
        <CreateMemoryDialog
          busy={busy === "create"}
          onClose={() => setCreateOpen(false)}
          onCreate={async (draft) => {
            setBusy("create");
            try {
              const response = await fetch("/api/memory", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(draft),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error || body.message || "Memory could not be saved.");
              setCreateOpen(false);
              setAnnouncement("Memory saved. Mnemosyne indexed it and linked any explicit entities.");
              await Promise.all([
                loadOverview(),
                loadIndex("memory", undefined, true),
              ]);
            } catch (actionError) {
              setError(message(actionError));
            } finally {
              setBusy(undefined);
            }
          }}
        />
      ) : null}
    </main>
  );
}

function Metric(props: { icon: React.ReactNode; value?: number | string; label: string; warning?: boolean }) {
  return <article className={props.warning ? styles.metricWarning : undefined}><i>{props.icon}</i><div><strong>{props.value ?? "—"}</strong><span>{props.label}</span></div></article>;
}

function MemoryGuide() {
  return <section className={styles.memoryGuide} aria-labelledby="memory-guide-title">
    <header>
      <p>How memory works</p>
      <h2 id="memory-guide-title">Four layers, each with a different job.</h2>
      <span>When you ask something, Asael searches approved memory and source knowledge, follows useful links, then learns from corrections and review decisions.</span>
    </header>
    <div>
      <article><BookOpen size={18} /><span><strong>Knowledge</strong><small>Your documents and transcripts. Evidence to search—not automatically treated as personal truth.</small></span></article>
      <article><Brain size={18} /><span><strong>Memory</strong><small>Durable facts, preferences, decisions and experiences Asael may carry into future work.</small></span></article>
      <article><ShieldCheck size={18} /><span><strong>Reviews</strong><small>The safety gate. Proposed or conflicting claims remain outside active recall until decided.</small></span></article>
      <article><GitBranch size={18} /><span><strong>Universe</strong><small>A map of concepts and evidence links. Points are ideas; lines show observed relationships.</small></span></article>
    </div>
  </section>;
}

function Tab(props: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number }) {
  return <button type="button" className={props.active ? styles.activeTab : undefined} onClick={props.onClick} aria-current={props.active ? "page" : undefined}>{props.icon}<span>{props.label}</span>{props.count !== undefined ? <small>{props.count.toLocaleString()}</small> : null}</button>;
}

function MemoryIndex(props: {
  overview?: MemoryIntelligenceOverview;
  page: Page<MemoryIndexItem>;
  category: MemoryCategoryId | "all";
  onCategory: (value: MemoryCategoryId | "all") => void;
  tier: MemoryTier | "all";
  onTier: (value: MemoryTier | "all") => void;
  state: MemoryIndexItem["state"] | "all";
  onState: (value: MemoryIndexItem["state"] | "all") => void;
  selectedId?: string;
  onSelect: (id: string) => void;
  loading: boolean;
  onMore: () => void;
}) {
  return <>
    <IndexHeading eyebrow="Durable memory" title="Claims Asael can carry forward" detail={`${props.page.total.toLocaleString()} indexed memories. Exact content is revealed only when selected.`} />
    <CategoryRail active={props.category} onSelect={props.onCategory} items={props.overview?.memoryCategories || []} />
    <div className={styles.filters}>
      <label>Tier <select value={props.tier} onChange={(event) => props.onTier(event.target.value as MemoryTier | "all")}>{memoryTiers.map((item) => <option key={item} value={item}>{startCase(item)}</option>)}</select><ChevronDown size={14} /></label>
      <label>State <select value={props.state} onChange={(event) => props.onState(event.target.value as MemoryIndexItem["state"] | "all")}><option value="all">All states</option><option value="active">Active</option><option value="candidate">Candidate</option><option value="contradicted">Contradicted</option><option value="superseded">Superseded</option><option value="archived">Archived</option></select><ChevronDown size={14} /></label>
    </div>
    <div className={styles.table} role="table" aria-label="Memory index">
      <div className={styles.tableHead} role="row"><span>Memory</span><span>Tier</span><span>State</span><span>Evidence</span><span>Updated</span></div>
      {props.page.items.map((item) => <button role="row" type="button" key={item.id} className={props.selectedId === item.id ? styles.selectedRow : undefined} onClick={() => props.onSelect(item.id)}><span><i className={styles.categoryDot} /><strong>{item.title}</strong><small>{startCase(item.category)} · {startCase(item.scope)}</small></span><span>{startCase(item.tier)}</span><span><em className={`${styles.state} ${styles[`state${startCase(item.state)}`] || ""}`}>{startCase(item.state)}</em></span><span>{item.evidenceCount}</span><span>{relativeDate(item.updatedAt)} <ArrowRight size={14} /></span></button>)}
      {!props.loading && !props.page.items.length ? <EmptyState icon={<Brain />} title="No memories match this view" detail="Try another category, tier, state or search phrase." /> : null}
      {props.loading ? <LoadingRow /> : null}
    </div>
    {props.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={props.onMore} disabled={props.loading}>Load more memories</button> : null}
  </>;
}

function KnowledgeIndex(props: {
  overview?: MemoryIntelligenceOverview;
  page: Page<KnowledgeIndexItem>;
  category: KnowledgeCategoryId | "all";
  onCategory: (value: KnowledgeCategoryId | "all") => void;
  loading: boolean;
  onMore: () => void;
}) {
  return <>
    <IndexHeading eyebrow="Source knowledge" title="Documents available to retrieval" detail={`${props.page.total.toLocaleString()} sources grouped by provider and document purpose.`} />
    <CategoryRail active={props.category} onSelect={props.onCategory} items={props.overview?.knowledgeCategories || []} />
    <div className={`${styles.table} ${styles.knowledgeTable}`} role="table" aria-label="Knowledge source index">
      <div className={styles.tableHead} role="row"><span>Source</span><span>Category</span><span>Chunks</span><span>Size</span><span>Indexed</span></div>
      {props.page.items.map((item) => <div role="row" key={item.id}><span><i className={styles.sourceIcon}><FileStack size={16} /></i><strong>{item.title}</strong><small>{item.sourceLabel}{item.hasCanonicalLineage ? " · Canonical lineage" : ""}</small></span><span>{startCase(item.category)}</span><span>{item.chunkCount.toLocaleString()}</span><span>{formatBytes(item.totalCharacters)}</span><span>{relativeDate(item.indexedAt)}</span></div>)}
      {!props.loading && !props.page.items.length ? <EmptyState icon={<BookOpen />} title="No knowledge sources match" detail="Adjust the category or search phrase." /> : null}
      {props.loading ? <LoadingRow /> : null}
    </div>
    {props.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={props.onMore} disabled={props.loading}>Load more sources</button> : null}
  </>;
}

function ReviewIndex(props: { reviews: MemoryReconciliationReview[]; loaded: boolean; loading: boolean; busy?: string; errors: Record<string, string>; total: number; onMore: () => void; onResolve: (id: string, decision: "confirm_candidate" | "keep_existing" | "keep_both") => void }) {
  const pending = props.reviews.filter((review) => review.status === "pending");
  return <>
    <IndexHeading eyebrow="Truth review" title="Keep memory accurate and inspectable" detail="Candidates never enter active recall until you make a governed decision." />
    <div className={styles.reviewList}>
      {pending.map((review) => {
        const resolving = props.busy === `review:${review.id}`;
        return <article key={review.id} aria-busy={resolving}>
          <header><span>{review.kind === "contradiction" ? "Conflict" : "Proposed memory"}</span><small>{startCase(review.detectionReason)}</small></header>
          <div className={styles.reviewClaims}><section><p>Candidate</p><strong>{review.candidate.title}</strong><span>{review.candidate.content}</span></section>{review.existing ? <section><p>Current memory</p><strong>{review.existing.title}</strong><span>{review.existing.content}</span></section> : null}</div>
          {props.errors[review.id] ? <p className={styles.reviewError} role="alert"><CircleAlert size={15} />{props.errors[review.id]}</p> : null}
          <footer>
            {resolving ? <span className={styles.reviewProgress} role="status"><LoaderCircle size={15} className={styles.spin} /> Applying decision…</span> : null}
            <button type="button" onClick={() => props.onResolve(review.id, "confirm_candidate")} disabled={resolving}><Check size={15} /> Use candidate</button>
            {review.existing ? <button type="button" onClick={() => props.onResolve(review.id, "keep_existing")} disabled={resolving}>Keep current</button> : <button type="button" onClick={() => props.onResolve(review.id, "keep_existing")} disabled={resolving}>Dismiss</button>}
            {review.existing ? <button type="button" onClick={() => props.onResolve(review.id, "keep_both")} disabled={resolving}>Keep both</button> : null}
          </footer>
        </article>;
      })}
      {props.loaded && !props.loading && !pending.length ? <EmptyState icon={<ShieldCheck />} title="Review queue is clear" detail="Mnemosyne will place contradictions and inferred candidates here before they can affect recall." /> : null}
      {props.loading ? <LoadingRow /> : null}
    </div>
    {pending.length < props.total ? <button className={styles.loadMore} type="button" onClick={props.onMore} disabled={props.loading}>Load {Math.min(20, props.total - pending.length)} more reviews</button> : null}
  </>;
}

function IndexHeading(props: { eyebrow: string; title: string; detail: string }) {
  return <header className={styles.indexHeading}><p>{props.eyebrow}</p><h2>{props.title}</h2><span>{props.detail}</span></header>;
}

function CategoryRail<T extends string>(props: { active: T | "all"; onSelect: (value: T | "all") => void; items: readonly { id: T; label: string; count: number }[] }) {
  const total = props.items.reduce((sum, item) => sum + item.count, 0);
  return <div className={styles.categoryRail}><button type="button" className={props.active === "all" ? styles.activeCategory : undefined} onClick={() => props.onSelect("all")}>All <small>{total.toLocaleString()}</small></button>{props.items.map((item) => <button type="button" key={item.id} className={props.active === item.id ? styles.activeCategory : undefined} onClick={() => props.onSelect(item.id)}>{item.label} <small>{item.count.toLocaleString()}</small></button>)}</div>;
}

function MnemosynePanel(props: { overview?: MemoryIntelligenceOverview; consent?: ConsentStatus; busy?: string; onConsent: () => void; onScan: () => void; onRecommendation: (item: MemoryStewardRecommendation) => void }) {
  const steward = props.overview?.steward;
  return <aside className={styles.steward}>
    <header><div className={styles.agentOrb}><Bot size={22} /><i /></div><div><p>Memory steward</p><h2>Mnemosyne</h2><span className={steward?.state === "attention" ? styles.attention : styles.healthy}><i /> {steward ? startCase(steward.state) : "Observing"}</span></div><strong style={{ "--score": `${steward?.healthScore || 0}%` } as React.CSSProperties}>{steward?.healthScore ?? "—"}<small>health</small></strong></header>
    <p className={styles.autonomy}>{steward?.autonomy || "Reading the catalogue and checking retrieval quality…"}</p>
    <p className={styles.scoreHelp}>This health score measures indexing coverage, unresolved reviews and ownership—not how intelligent Asael is.</p>
    <div className={styles.learning}><p><Sparkles size={14} /> Learning signals</p><dl><div><dt>Useful recalls</dt><dd>{steward?.learningSignals.retrievalUses.toLocaleString() ?? "—"}</dd></div><div><dt>Corrections learned</dt><dd>{steward?.learningSignals.corrections.toLocaleString() ?? "—"}</dd></div><div><dt>Reviews resolved</dt><dd>{steward?.learningSignals.resolvedReviews.toLocaleString() ?? "—"}</dd></div><div><dt>Forget receipts</dt><dd>{steward?.learningSignals.forgetRequests.toLocaleString() ?? "—"}</dd></div></dl></div>
    {props.consent ? <section className={styles.recallControl}><div><strong>Personal automatic recall</strong><span>{props.consent.state === "active" ? "Available when selected in conversation" : "Off until you explicitly enable it"}</span></div><button type="button" className={props.consent.state === "active" ? styles.switchOn : undefined} onClick={props.onConsent} disabled={props.busy === "consent"} aria-pressed={props.consent.state === "active"}><i /></button></section> : null}
    <section className={styles.recommendations}><div className={styles.panelHeading}><p>Recommendations</p><span>{steward?.recommendations.length || 0}</span></div>{steward?.recommendations.length ? steward.recommendations.map((item) => <button type="button" key={item.id} onClick={() => props.onRecommendation(item)} disabled={item.action === "none" || Boolean(props.busy)}><i className={styles[`priority${startCase(item.priority)}`]} /><span><strong>{item.title}</strong><small>{item.detail}</small></span>{item.action !== "none" ? <ArrowRight size={15} /> : null}</button>) : <div className={styles.allClear}><Check size={16} /> No action needed right now.</div>}</section>
    <button type="button" className={styles.scanButton} onClick={props.onScan} disabled={props.busy === "maintenance"}>{props.busy === "maintenance" ? <LoaderCircle size={16} className={styles.spin} /> : <Sparkles size={16} />} Run lifecycle scan</button>
    <p className={styles.governance}><ShieldCheck size={14} /> Mnemosyne may classify, link and recommend. It cannot silently promote, rewrite or forget truth.</p>
  </aside>;
}

function MemoryInspector(props: { memory?: MemoryRecord; loading: boolean; busy?: string; preview?: ForgetPreview; onClose: () => void; onLifecycle: (action: "pin" | "unpin" | "archive" | "restore") => void; onPreviewForget: () => void; onForget: () => void; onCancelForget: () => void }) {
  return <div className={styles.inspectorLayer}><button type="button" className={styles.scrim} onClick={props.onClose} aria-label="Close memory details" /><aside className={styles.inspector} aria-label="Memory details"><header><p>Exact memory</p><button type="button" onClick={props.onClose} aria-label="Close"><X size={18} /></button></header>{props.loading ? <div className={styles.inspectorLoading}><LoaderCircle className={styles.spin} /> Decrypting selected memory…</div> : props.memory ? <><div className={styles.inspectorTitle}><span>{startCase(props.memory.tier || props.memory.type)} · {startCase(props.memory.scope)}</span><h2>{props.memory.title}</h2><p>{props.memory.content}</p></div><dl className={styles.memoryMetadata}><div><dt>Confidence</dt><dd>{Math.round((props.memory.confidence ?? .7) * 100)}%</dd></div><div><dt>Importance</dt><dd>{Math.round(props.memory.importance * 100)}%</dd></div><div><dt>Used</dt><dd>{props.memory.useCount || 0} times</dd></div><div><dt>Updated</dt><dd>{relativeDate(props.memory.updatedAt)}</dd></div></dl>{props.memory.tags.length ? <div className={styles.memoryTags}>{props.memory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}<div className={styles.lifecycle}><button type="button" disabled={Boolean(props.busy) || Boolean(props.memory.archivedAt)} onClick={() => props.onLifecycle(props.memory?.pinnedAt ? "unpin" : "pin")}>{props.memory.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}{props.memory.pinnedAt ? "Unpin" : "Pin"}</button><button type="button" disabled={Boolean(props.busy) || Boolean(props.memory.pinnedAt)} onClick={() => props.onLifecycle(props.memory?.archivedAt ? "restore" : "archive")}>{props.memory.archivedAt ? <RotateCcw size={15} /> : <Archive size={15} />}{props.memory.archivedAt ? "Restore" : "Archive"}</button></div>{props.preview ? <section className={styles.forgetPreview}><p><CircleAlert size={16} /> Permanent forgetting</p><span>This removes the memory plus {props.preview.impact.descendantMemoryCount} derived memories, {props.preview.impact.graphNodeCount} graph points and {props.preview.impact.graphEdgeCount} links. A deletion receipt will be stored.</span><div><button type="button" onClick={props.onCancelForget}>Cancel</button><button type="button" onClick={props.onForget} disabled={props.busy === "forget"}>{props.busy === "forget" ? <LoaderCircle size={15} className={styles.spin} /> : <Trash2 size={15} />} Forget permanently</button></div></section> : <button type="button" className={styles.forgetButton} onClick={props.onPreviewForget} disabled={Boolean(props.busy)}><Trash2 size={15} /> Review forgetting impact</button>}</> : null}</aside></div>;
}

function CreateMemoryDialog(props: { busy: boolean; onClose: () => void; onCreate: (draft: { title: string; content: string; type: MemoryType; tier: MemoryTier; importance: number; confidence: number }) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [type, setType] = useState<MemoryType>("fact");
  const [confidence, setConfidence] = useState(.9);
  async function submit(event: FormEvent) { event.preventDefault(); const selected = memoryTypes.find((item) => item.id === type) || memoryTypes[0]; await props.onCreate({ title, content, type, tier: selected.tier, importance: .75, confidence }); }
  return <div className={styles.dialogLayer}><button type="button" className={styles.scrim} onClick={props.onClose} aria-label="Close new memory dialog" /><form className={styles.dialog} onSubmit={(event) => void submit(event)}><header><div><p>Explicit memory</p><h2>What should Asael remember?</h2></div><button type="button" onClick={props.onClose} aria-label="Close"><X size={18} /></button></header><label>Category<select value={type} onChange={(event) => setType(event.target.value as MemoryType)}>{memoryTypes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Short title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} required placeholder="e.g. Prefer meetings after 10 AM" /></label><label>Details<textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={200000} required rows={7} placeholder="Add the precise context that should be recalled…" /></label><label>Confidence <span>{Math.round(confidence * 100)}%</span><input type="range" min="0.5" max="1" step="0.05" value={confidence} onChange={(event) => setConfidence(Number(event.target.value))} /></label><footer><p><ShieldCheck size={14} /> You can inspect, correct or forget this later.</p><button type="submit" disabled={props.busy || !title.trim() || !content.trim()}>{props.busy ? <LoaderCircle size={16} className={styles.spin} /> : <Plus size={16} />} Save memory</button></footer></form></div>;
}

function EmptyState(props: { icon: React.ReactNode; title: string; detail: string }) { return <div className={styles.empty}>{props.icon}<strong>{props.title}</strong><span>{props.detail}</span></div>; }
function LoadingRow() { return <div className={styles.loadingRow}><LoaderCircle size={17} className={styles.spin} /> Updating index…</div>; }
function startCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function relativeDate(value: string) { const milliseconds = Date.now() - new Date(value).getTime(); const days = Math.floor(milliseconds / 86_400_000); if (days < 1) return "Today"; if (days === 1) return "Yesterday"; if (days < 30) return `${days}d ago`; return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)); }
function formatBytes(characters: number) { const bytes = characters * 2; if (bytes < 1024) return `${bytes} B`; if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1_048_576).toFixed(1)} MB`; }
function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong."; }
