"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Brain,
  Check,
  CircleDot,
  Database,
  GitMerge,
  Loader2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import {
  countPendingEntityMergeReviews,
  EntityRegistryDialog,
  type EntityRegistryPayload,
} from "@/components/entity-registry-dialog";
import {
  memoryFormationReasonLabel,
  memoryTierPoliciesV1,
  resolveMemoryTier,
  type MemoryTier,
} from "@/lib/memory/tier-policy";
import type {
  MemoryReconciliationDecision,
  MemoryReconciliationReview,
} from "@/lib/memory/reconciliation";
import type {
  MemoryLifecycleAction,
  MemoryMaintenanceReport,
  MemoryPromotionDecision,
  MemoryPromotionReview,
} from "@/lib/memory/lifecycle";
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
  affectedEntityCount: number;
  retiredEntityCount: number;
  retiredEntityAliasCount: number;
  invalidatedAgentRunCount: number;
  invalidatedWorkflowRunCount: number;
  invalidatedDailyBriefCount: number;
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
type EntityProjectionSummary = {
  candidateCount: number;
  createdCount: number;
  linkedCount: number;
  reviewRequiredCount: number;
};

const memoryTiers = Object.keys(memoryTierPoliciesV1) as MemoryTier[];
const userCreatableMemoryTiers = memoryTiers.filter((tier) => tier !== "working");

export function MemoryWorkspace() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [nodes, setNodes] = useState<MemoryGraphNode[]>([]);
  const [edges, setEdges] = useState<MemoryGraphEdge[]>([]);
  const [stats, setStats] = useState<MemoryGraphStats>();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<MemoryTier | "all">("all");
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [draft, setDraft] = useState<{ title: string; content: string; confidence: number }>();
  const [showCreate, setShowCreate] = useState(false);
  const [showReconciliation, setShowReconciliation] = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [maintenanceReviews, setMaintenanceReviews] = useState<
    MemoryPromotionReview[]
  >([]);
  const [maintenanceReport, setMaintenanceReport] = useState<
    MemoryMaintenanceReport
  >();
  const [maintenanceBusy, setMaintenanceBusy] = useState<string>();
  const [reconciliationReviews, setReconciliationReviews] = useState<
    MemoryReconciliationReview[]
  >([]);
  const [showEntities, setShowEntities] = useState(false);
  const [entityRegistry, setEntityRegistry] = useState<EntityRegistryPayload>();
  const [entityRegistryError, setEntityRegistryError] = useState<string>();
  const [indexCollapsed, setIndexCollapsed] = useState(false);
  const [forgetState, setForgetState] = useState<ForgetState>("idle");
  const [forgetPreview, setForgetPreview] = useState<MemoryDeletionPreview>();
  const [deletionResult, setDeletionResult] = useState<MemoryDeletionResult>();
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [memoryResponse, graphResponse, reconciliationResponse, maintenanceResponse] = await Promise.all([
        fetch("/api/memory?limit=100", { cache: "no-store" }),
        fetch("/api/memory/graph?limit=100", { cache: "no-store" }),
        fetch("/api/memory/reconciliation?status=all&limit=100", {
          cache: "no-store",
        }),
        fetch("/api/memory/maintenance?status=all&limit=100", {
          cache: "no-store",
        }),
      ]);
      if (!memoryResponse.ok || !graphResponse.ok || !reconciliationResponse.ok || !maintenanceResponse.ok) {
        throw new Error("Memory workspace could not be loaded.");
      }
      const memoryPayload = await memoryResponse.json() as { memories?: MemoryRecord[] };
      const graphPayload = await graphResponse.json() as { nodes?: MemoryGraphNode[]; edges?: MemoryGraphEdge[]; stats?: MemoryGraphStats };
      const reconciliationPayload = await reconciliationResponse.json() as {
        reviews?: MemoryReconciliationReview[];
      };
      const maintenancePayload = await maintenanceResponse.json() as {
        reviews?: MemoryPromotionReview[];
      };
      setMemories(memoryPayload.memories || []);
      setNodes(graphPayload.nodes || []);
      setEdges(graphPayload.edges || []);
      setStats(graphPayload.stats);
      setReconciliationReviews(reconciliationPayload.reviews || []);
      setMaintenanceReviews(maintenancePayload.reviews || []);
      setLoadState("ready");
      setError(undefined);
    } catch (loadError) {
      setLoadState("error");
      setError(message(loadError));
    }
  }, []);

  const loadEntityRegistry = useCallback(async () => {
    try {
      const response = await fetch("/api/entities", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "Entity registry could not be loaded.");
      }
      const registry = payload as EntityRegistryPayload;
      setEntityRegistry(registry);
      setEntityRegistryError(undefined);
      return registry;
    } catch (registryError) {
      setEntityRegistryError(message(registryError));
      return undefined;
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadEntityRegistry(), 0);
    return () => window.clearTimeout(task);
  }, [loadEntityRegistry]);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return memories.filter((memory) => {
      if (
        tierFilter !== "all" &&
        resolveMemoryTier(memory.tier, memory.type) !== tierFilter
      ) return false;
      if (!terms.length) return true;
      const haystack = `${memory.title} ${memory.content} ${memory.tags.join(" ")} ${memory.source}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [memories, query, tierFilter]);
  const selectedMemory = memories.find((memory) => memory.id === selectedMemoryId);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const positionedNodes = useMemo(() => positionGraphNodes(nodes.slice(0, 42)), [nodes]);
  const visibleNodeIds = useMemo(() => new Set(positionedNodes.map((node) => node.id)), [positionedNodes]);
  const visibleEdges = edges.filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)).slice(0, 90);
  const pendingEntityReviews = countPendingEntityMergeReviews(entityRegistry);
  const pendingMemoryReviews = reconciliationReviews.filter(
    (review) => review.status === "pending",
  ).length;
  const pendingPromotionReviews = maintenanceReviews.filter(
    (review) => review.status === "pending",
  ).length;

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

  async function saveCorrection(contradiction = false) {
    if (!selectedMemory || !draft) return;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(selectedMemory.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          content: draft.content,
          confidence: draft.confidence,
          ...(contradiction ? { contradiction: true } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || "Correction failed.");
      const corrected = payload.corrected as MemoryRecord;
      const review = payload.review as MemoryReconciliationReview | undefined;
      if (review?.status === "pending") {
        setMemories((current) => [
          corrected,
          ...current.filter((item) => item.id !== corrected.id),
        ]);
        setReconciliationReviews((current) => [
          review,
          ...current.filter((item) => item.id !== review.id),
        ]);
        setSelectedMemoryId(selectedMemory.id);
        setDraft({
          title: selectedMemory.title,
          content: selectedMemory.content,
          confidence: selectedMemory.confidence ?? 0.7,
        });
        setSaveState("idle");
        setShowReconciliation(true);
        setAnnouncement(
          "Contradiction held for review. The existing claim remains active.",
        );
        return;
      }
      setMemories((current) => [corrected, ...current.map((item) => item.id === selectedMemory.id ? { ...item, claimStatus: "superseded" as const } : item)]);
      setSelectedMemoryId(corrected.id);
      setDraft({ title: corrected.title, content: corrected.content, confidence: corrected.confidence ?? 0.7 });
      setSaveState("saved");
      setAnnouncement("Memory corrected. The previous claim remains in its provenance lineage.");
      void refreshGraph();
      void loadEntityRegistry();
    } catch (saveError) {
      setSaveState("error");
      setError(message(saveError));
    }
  }

  function recordResolvedReview(review: MemoryReconciliationReview) {
    setReconciliationReviews((current) => current.map((item) =>
      item.id === review.id ? review : item
    ));
    setMemories((current) => {
      const replacements = new Map<string, MemoryRecord>([
        [review.candidate.id, review.candidate],
        ...(review.existing
          ? [[review.existing.id, review.existing] as [string, MemoryRecord]]
          : []),
      ]);
      const seen = new Set<string>();
      const next = current.map((memory) => {
        const replacement = replacements.get(memory.id);
        if (!replacement) return memory;
        seen.add(memory.id);
        return replacement;
      });
      for (const [id, memory] of replacements) {
        if (!seen.has(id)) next.unshift(memory);
      }
      return next;
    });
    setAnnouncement(reconciliationDecisionAnnouncement(review));
    void refreshGraph();
    void loadEntityRegistry();
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
      void loadEntityRegistry();
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

  async function updateLifecycle(action: MemoryLifecycleAction) {
    if (!selectedMemory) return;
    setMaintenanceBusy(`memory:${selectedMemory.id}`);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/memory/${encodeURIComponent(selectedMemory.id)}/lifecycle`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "Lifecycle update failed.");
      }
      const updated = payload.memory as MemoryRecord;
      setMemories((current) => current.map((memory) =>
        memory.id === updated.id ? updated : memory
      ));
      selectMemory(updated);
      setAnnouncement(
        action === "pin"
          ? "Memory pinned. Priority decay is paused while the claim remains unchanged."
          : action === "unpin"
            ? "Memory unpinned. Normal priority decay has resumed."
            : action === "archive"
              ? "Memory archived outside recall. Historical truth was not changed."
              : "Memory restored to eligible recall.",
      );
    } catch (lifecycleError) {
      setError(message(lifecycleError));
    } finally {
      setMaintenanceBusy(undefined);
    }
  }

  async function runMaintenance() {
    setMaintenanceBusy("run");
    setError(undefined);
    try {
      const response = await fetch("/api/memory/maintenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "Memory maintenance failed.");
      }
      setMaintenanceReport(payload.report as MemoryMaintenanceReport);
      setAnnouncement("Memory maintenance completed. Exact duplicates were archived reversibly.");
      await load();
      setShowMaintenance(true);
    } catch (maintenanceError) {
      setError(message(maintenanceError));
    } finally {
      setMaintenanceBusy(undefined);
    }
  }

  async function decidePromotion(
    review: MemoryPromotionReview,
    decision: MemoryPromotionDecision,
  ) {
    setMaintenanceBusy(review.id);
    setError(undefined);
    try {
      const response = await fetch("/api/memory/maintenance", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "decide_promotion",
          reviewId: review.id,
          decision,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "Promotion review failed.");
      }
      const resolved = payload.review as MemoryPromotionReview;
      setMaintenanceReviews((current) => current.map((item) =>
        item.id === resolved.id ? resolved : item
      ));
      if (payload.promotedMemory) {
        const promoted = payload.promotedMemory as MemoryRecord;
        setMemories((current) => [
          promoted,
          ...current.filter((memory) => memory.id !== promoted.id),
        ]);
      }
      setAnnouncement(decision === "promote"
        ? "Verified episodes promoted to a procedure with review lineage."
        : "Procedure promotion dismissed; source episodes remain unchanged.");
    } catch (promotionError) {
      setError(message(promotionError));
    } finally {
      setMaintenanceBusy(undefined);
    }
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
          <button type="button" className={clsx(styles.stat, styles.entityTrigger)} onClick={() => setShowEntities(true)}><GitMerge size={14} aria-hidden="true" /><span><strong>{entityRegistry?.entities.length || 0}</strong><small>{pendingEntityReviews ? `${pendingEntityReviews} to review` : "Entities"}</small></span></button>
          <button type="button" className={clsx(styles.stat, styles.entityTrigger, pendingMemoryReviews > 0 && styles.reviewTriggerPending)} onClick={() => setShowReconciliation(true)}><AlertTriangle size={14} aria-hidden="true" /><span><strong>{pendingMemoryReviews}</strong><small>{pendingMemoryReviews === 1 ? "Claim to review" : "Claims to review"}</small></span></button>
          <button type="button" className={clsx(styles.stat, styles.entityTrigger, pendingPromotionReviews > 0 && styles.reviewTriggerPending)} onClick={() => setShowMaintenance(true)}><Wrench size={14} aria-hidden="true" /><span><strong>{pendingPromotionReviews}</strong><small>{pendingPromotionReviews === 1 ? "Promotion to review" : "Promotions to review"}</small></span></button>
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
            <div className="memory-type-filter" aria-label="Memory tier filter"><button type="button" className={clsx(tierFilter === "all" && "is-selected")} onClick={() => setTierFilter("all")}>All</button>{memoryTiers.map((tier) => <button type="button" key={tier} className={clsx(tierFilter === tier && "is-selected")} onClick={() => setTierFilter(tier)}>{tier}</button>)}</div>
            <div className="memory-index-list">
              {loadState === "loading" ? <div className="memory-index-empty"><Loader2 className="animate-spin" size={18} aria-hidden="true" /> Loading memory…</div> : filtered.length ? filtered.map((memory) => <button key={memory.id} type="button" className={clsx(selectedMemoryId === memory.id && "is-selected", `is-${memory.claimStatus || "active"}`)} onClick={() => selectMemory(memory)}><i /><span><strong>{memory.title}</strong><small>{resolveMemoryTier(memory.tier, memory.type)} · {memory.type} · {memory.pinnedAt ? "pinned" : memory.archivedAt ? "archived" : memory.source}</small><em>{Math.round((memory.confidence ?? .7) * 100)}% confidence</em></span></button>) : <div className="memory-index-empty"><Brain size={18} aria-hidden="true" /> No memories match this view.</div>}
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
            <div className="memory-inspector-heading"><div><p>{resolveMemoryTier(selectedMemory.tier, selectedMemory.type)} · {selectedMemory.type}</p><h2>{selectedMemory.title}</h2></div><span className={clsx(`is-${selectedMemory.claimStatus || "active"}`)}>{selectedMemory.archivedAt ? "archived" : selectedMemory.pinnedAt ? "pinned" : selectedMemory.claimStatus || "active"}</span></div>
            <label>Title<input value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }); setSaveState("idle"); }} /></label>
            <label>Claim<textarea rows={9} value={draft.content} onChange={(event) => { setDraft({ ...draft, content: event.currentTarget.value }); setSaveState("idle"); }} /></label>
            <label>Confidence <span>{Math.round(draft.confidence * 100)}%</span><input type="range" min="0" max="1" step=".01" value={draft.confidence} onChange={(event) => { setDraft({ ...draft, confidence: Number(event.currentTarget.value) }); setSaveState("idle"); }} /></label>
            <div className="memory-provenance"><p><ShieldCheck size={13} aria-hidden="true" /> Why this memory exists</p><span>{memoryFormationReasonLabel(selectedMemory.formationReason || "legacy_record")}</span><dl><dt>Tier</dt><dd>{resolveMemoryTier(selectedMemory.tier, selectedMemory.type)}</dd><dt>Asserted by</dt><dd>{selectedMemory.assertedBy || "unknown"}</dd><dt>Source</dt><dd>{selectedMemory.source}</dd><dt>Scope</dt><dd>{selectedMemory.scope}</dd><dt>Lifecycle</dt><dd>{selectedMemory.pinnedAt ? "Pinned" : selectedMemory.archivedAt ? `Archived · ${selectedMemory.archiveReason?.replaceAll("_", " ") || "manual"}` : "Eligible recall"}</dd><dt>Last used</dt><dd>{selectedMemory.lastUsedAt ? formatDate(selectedMemory.lastUsedAt) : "Never"}</dd><dt>Use count</dt><dd>{selectedMemory.useCount || 0}</dd><dt>Valid from</dt><dd>{selectedMemory.validFrom ? formatDate(selectedMemory.validFrom) : "Immediately"}</dd><dt>Valid until</dt><dd>{selectedMemory.validTo ? formatDate(selectedMemory.validTo) : "No claim expiry"}</dd><dt>Retained until</dt><dd>{selectedMemory.retentionExpiresAt ? formatDate(selectedMemory.retentionExpiresAt) : "Policy controlled"}</dd><dt>Updated</dt><dd>{formatDate(selectedMemory.updatedAt)}</dd></dl>{selectedMemory.evidenceRefs?.length ? <div>{selectedMemory.evidenceRefs.map((reference) => <code key={reference}>{reference}</code>)}</div> : null}</div>
            <MemoryTierPolicySummary tier={resolveMemoryTier(selectedMemory.tier, selectedMemory.type)} />
            <div className={styles.lifecycleActions} aria-label="Memory lifecycle controls"><button type="button" disabled={Boolean(maintenanceBusy) || Boolean(selectedMemory.archivedAt)} onClick={() => void updateLifecycle(selectedMemory.pinnedAt ? "unpin" : "pin")}>{maintenanceBusy === `memory:${selectedMemory.id}` ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : selectedMemory.pinnedAt ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}{selectedMemory.pinnedAt ? "Unpin" : "Pin"}</button><button type="button" disabled={Boolean(maintenanceBusy) || Boolean(selectedMemory.pinnedAt)} onClick={() => void updateLifecycle(selectedMemory.archivedAt ? "restore" : "archive")}>{selectedMemory.archivedAt ? <RotateCcw size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}{selectedMemory.archivedAt ? "Restore" : "Archive"}</button></div>
            {forgetPreview ? <DeletionPreview preview={forgetPreview} /> : null}
            <div className="memory-inspector-actions"><button type="button" className="memory-save" disabled={saveState === "saving" || !draft.title.trim() || !draft.content.trim()} onClick={() => void saveCorrection()}>{saveState === "saving" && forgetState !== "deleting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : saveState === "saved" ? <Check size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}{saveState === "saved" ? "Corrected" : "Save correction"}</button><button type="button" className="memory-cancel" disabled={saveState === "saving" || !draft.title.trim() || !draft.content.trim()} onClick={() => void saveCorrection(true)}><AlertTriangle size={13} aria-hidden="true" /> Flag contradiction</button><button type="button" className={clsx("memory-forget", forgetState === "ready" && "is-confirming")} disabled={forgetState === "previewing" || forgetState === "deleting"} onClick={() => forgetState === "ready" ? void forgetSelected() : void requestForgetPreview()}>{forgetState === "previewing" || forgetState === "deleting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}{forgetState === "previewing" ? "Checking impact" : forgetState === "deleting" ? "Committing deletion" : forgetState === "ready" ? "Forget permanently" : "Review forget impact"}</button>{forgetState === "ready" ? <button type="button" className="memory-cancel" onClick={() => { setForgetState("idle"); setForgetPreview(undefined); }}><X size={13} aria-hidden="true" /> Cancel</button> : null}</div>
          </> : deletionResult ? <DeletionReceipt result={deletionResult} onClose={() => setDeletionResult(undefined)} /> : selectedNode ? <div className="memory-node-inspector"><CircleDot size={22} aria-hidden="true" /><p>{selectedNode.kind}</p><h2>{selectedNode.label}</h2><span>{selectedNode.summary}</span><dl><dt>Sources</dt><dd>{selectedNode.sourceCount}</dd><dt>Weight</dt><dd>{selectedNode.weight.toFixed(1)}</dd><dt>Memories</dt><dd>{selectedNode.memoryIds.length}</dd></dl></div> : <div className="memory-inspector-empty"><Brain size={26} aria-hidden="true" /><h2>Select a memory</h2><p>Inspect provenance, correct a claim, or forget information that should no longer influence your agents.</p></div>}
        </aside>
      </div>
      {showCreate ? <CreateMemoryDialog onClose={() => setShowCreate(false)} onCreated={(memory, projection) => { setShowCreate(false); setMemories((current) => [memory, ...current]); selectMemory(memory); setAnnouncement(projection?.candidateCount ? `Memory added. ${projection.createdCount} new and ${projection.linkedCount} existing private entities matched; ${projection.reviewRequiredCount} require review.` : "Memory added."); void refreshGraph(); void loadEntityRegistry(); }} /> : null}
      {showEntities ? <EntityRegistryDialog registry={entityRegistry} loadError={entityRegistryError} onClose={() => setShowEntities(false)} onReload={loadEntityRegistry} onAnnouncement={setAnnouncement} /> : null}
      {showReconciliation ? <MemoryReconciliationDialog reviews={reconciliationReviews} onClose={() => setShowReconciliation(false)} onResolved={recordResolvedReview} /> : null}
      {showMaintenance ? <MemoryMaintenanceDialog reviews={maintenanceReviews} memories={memories} report={maintenanceReport} busyId={maintenanceBusy} onRun={() => void runMaintenance()} onDecision={(review, decision) => void decidePromotion(review, decision)} onClose={() => setShowMaintenance(false)} /> : null}
    </main>
  );
}

function MemoryMaintenanceDialog({
  reviews,
  memories,
  report,
  busyId,
  onRun,
  onDecision,
  onClose,
}: {
  reviews: MemoryPromotionReview[];
  memories: MemoryRecord[];
  report?: MemoryMaintenanceReport;
  busyId?: string;
  onRun: () => void;
  onDecision: (
    review: MemoryPromotionReview,
    decision: MemoryPromotionDecision,
  ) => void;
  onClose: () => void;
}) {
  const pending = reviews.filter((review) => review.status === "pending");
  return <div className={clsx("memory-dialog-backdrop", styles.dialogBackdrop, styles.registryBackdrop)} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={clsx("memory-dialog", styles.dialog, styles.registryDialog, styles.reconciliationDialog)} role="dialog" aria-modal="true" aria-labelledby="memory-maintenance-title"><header className={styles.registryHeader}><div><p>Lifecycle control</p><h2 id="memory-maintenance-title">Memory maintenance</h2><span>Deduplicate recall, decay retrieval priority, and review repeated verified episodes before they become procedures. Archival never deletes historical truth.</span></div><div className={styles.registryHeaderActions}><button type="button" disabled={Boolean(busyId)} onClick={onRun} aria-label="Run memory maintenance">{busyId === "run" ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}</button><button type="button" onClick={onClose} aria-label="Close memory maintenance"><X size={16} aria-hidden="true" /></button></div></header><div className={styles.registrySummary}><span><strong>{pending.length}</strong> pending promotions</span>{report ? <><span><strong>{report.autoArchivedDuplicates}</strong> duplicates archived</span><span><strong>{Math.round(report.duplicateRateAfter * 10000) / 100}%</strong> duplicate rate</span></> : null}</div><section className={styles.registrySection}><div className={styles.registrySectionHeading}><div><p>Explicit review</p><h3>Procedure candidates</h3></div><span>{pending.length}</span></div>{pending.length ? <div className={styles.reconciliationList}>{pending.map((review) => { const source = memories.find((memory) => memory.id === review.canonicalMemoryId); return <article key={review.id} className={styles.reconciliationCard}><header><span><Wrench size={13} aria-hidden="true" /> Repeated verified episode</span><small>{formatDate(review.createdAt)}</small></header><div><h4>{source?.title || "Verified episode pattern"}</h4><p>{source ? truncate(source.content, 240) : `${review.sourceMemoryIds.length} source memories`}</p></div><div className={styles.maintenanceLineage}><span>{review.sourceMemoryIds.length} verified occurrences</span><code title={review.sourceClaimSha256}>{review.sourceClaimSha256.slice(0, 16)}…</code></div><div className={styles.reconciliationActions}><button type="button" disabled={Boolean(busyId)} onClick={() => onDecision(review, "dismiss")}>Dismiss</button><button type="button" disabled={Boolean(busyId)} onClick={() => onDecision(review, "promote")}>{busyId === review.id ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} Promote to procedure</button></div></article>; })}</div> : <p className={styles.registryEmpty}>No repeated verified episodes are waiting for promotion.</p>}</section></section></div>;
}

function DeletionPreview({ preview }: { preview: MemoryDeletionPreview }) {
  const impact = preview.impact;
  return <section className={styles.deletionPreview} aria-label="Permanent deletion preview"><header><AlertTriangle size={15} aria-hidden="true" /><div><strong>Permanent deletion preview</strong><span>{preview.guarantee === "rollback_proof_barrier" ? "A rollback-proof barrier will block recall immediately." : "Local development provides a best-effort deletion only."}</span></div></header><dl><dt>Memories</dt><dd>{impact.rootMemoryCount + impact.descendantMemoryCount}</dd><dt>Retrieval traces</dt><dd>{impact.retrievalTraceCount}</dd><dt>Graph projections</dt><dd>{impact.graphNodeCount + impact.graphEdgeCount}</dd><dt>Pending runs canceled</dt><dd>{impact.pendingAgentRunCount + impact.pendingWorkflowRunCount}</dd></dl>{preview.descendantMemories.length ? <div className={styles.deletionDescendants}><span>Descendant memories also blocked</span><ul>{preview.descendantMemories.map((memory) => <li key={memory.id}><strong>{memory.title}</strong><small>{memory.type}</small></li>)}</ul></div> : null}<p>This removes the claim from search, context, graph views, and future exports. This action cannot be undone.</p></section>;
}

function DeletionReceipt({ result, onClose }: { result: MemoryDeletionResult; onClose: () => void }) {
  const receipt = result.deletionReceipt;
  return <div className={styles.deletionReceipt}><ShieldCheck size={25} aria-hidden="true" /><p>Deletion committed</p><h2>{receipt ? "Receipt verified" : "Best-effort local deletion"}</h2><span>{receipt ? `The permanent barrier was recorded ${formatDate(receipt.forgottenAt)}.` : "The memory was removed from the local development store."}</span>{receipt ? <><dl><dt>Descendant memories</dt><dd>{receipt.descendantMemoryCount}</dd><dt>Retrieval traces</dt><dd>{receipt.retrievalTraceCount}</dd><dt>Graph projections</dt><dd>{receipt.graphNodeCount + receipt.graphEdgeCount}</dd><dt>Entity records affected</dt><dd>{result.affectedEntityCount}</dd><dt>Entities retired</dt><dd>{result.retiredEntityCount}</dd><dt>Aliases retired</dt><dd>{result.retiredEntityAliasCount}</dd><dt>Briefs invalidated</dt><dd>{result.invalidatedDailyBriefCount}</dd><dt>Runs canceled</dt><dd>{result.invalidatedAgentRunCount + result.invalidatedWorkflowRunCount}</dd></dl><code title={receipt.receiptSha256 || receipt.id}>{receipt.receiptSha256 || receipt.id}</code></> : null}<button type="button" onClick={onClose}>Back to memory</button></div>;
}

function MemoryReconciliationDialog({
  reviews,
  onClose,
  onResolved,
}: {
  reviews: MemoryReconciliationReview[];
  onClose: () => void;
  onResolved: (review: MemoryReconciliationReview) => void;
}) {
  const [resolvingId, setResolvingId] = useState<string>();
  const [error, setError] = useState<string>();
  const pending = reviews.filter((review) => review.status === "pending");
  const resolved = reviews.filter((review) => review.status === "resolved")
    .slice(0, 20);

  async function resolve(
    review: MemoryReconciliationReview,
    decision: MemoryReconciliationDecision,
  ) {
    setResolvingId(review.id);
    setError(undefined);
    try {
      const response = await fetch("/api/memory/reconciliation", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId: review.id, decision }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload.message || payload.error || "Memory review failed.",
        );
      }
      onResolved(payload.review as MemoryReconciliationReview);
    } catch (reviewError) {
      setError(message(reviewError));
    } finally {
      setResolvingId(undefined);
    }
  }

  return <div className={clsx("memory-dialog-backdrop", styles.dialogBackdrop, styles.registryBackdrop)} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={clsx("memory-dialog", styles.dialog, styles.registryDialog, styles.reconciliationDialog)} role="dialog" aria-modal="true" aria-labelledby="memory-reconciliation-title"><header className={styles.registryHeader}><div><p>Claim control</p><h2 id="memory-reconciliation-title">Confirmations & contradictions</h2><span>Unverified candidates stay outside recall. Compare their source and validity before choosing what Asael may believe.</span></div><div className={styles.registryHeaderActions}><button type="button" onClick={onClose} aria-label="Close memory review"><X size={16} aria-hidden="true" /></button></div></header>{error ? <p className={styles.registryError} role="alert">{error}</p> : null}<div className={styles.registrySummary}><span><strong>{pending.length}</strong> pending</span><span><strong>{resolved.length}</strong> recent decisions</span></div><section className={styles.registrySection}><div className={styles.registrySectionHeading}><div><p>Needs your decision</p><h3>Pending claims</h3></div><span>{pending.length}</span></div>{pending.length ? <div className={styles.reconciliationList}>{pending.map((review) => <MemoryReconciliationCard key={review.id} review={review} busy={resolvingId === review.id} onResolve={(decision) => void resolve(review, decision)} />)}</div> : <p className={styles.registryEmpty}>No claims are waiting for confirmation.</p>}</section>{resolved.length ? <section className={styles.registrySection}><div className={styles.registrySectionHeading}><div><p>Review history</p><h3>Recent decisions</h3></div><span>{resolved.length}</span></div><div className={styles.reconciliationHistory}>{resolved.map((review) => <article key={review.id}><div><strong>{review.candidate.title}</strong><span>{review.kind.replaceAll("_", " ")} · {review.decision ? reconciliationDecisionLabel(review.decision) : "resolved"}</span></div><small>{review.resolvedAt ? formatDate(review.resolvedAt) : formatDate(review.updatedAt)}</small></article>)}</div></section> : null}</section></div>;
}

function MemoryReconciliationCard({
  review,
  busy,
  onResolve,
}: {
  review: MemoryReconciliationReview;
  busy: boolean;
  onResolve: (decision: MemoryReconciliationDecision) => void;
}) {
  return <article className={styles.reconciliationCard}><header><span><AlertTriangle size={13} aria-hidden="true" /> {review.kind === "contradiction" ? "Conflicting claim" : "Confirmation needed"}</span><small>{formatDate(review.createdAt)}</small></header><div className={styles.reconciliationClaims}>{review.existing ? <MemoryReviewClaim label="Current active claim" memory={review.existing} /> : null}<MemoryReviewClaim label="Candidate · not used yet" memory={review.candidate} /></div><div className={styles.reconciliationActions}>{review.existing ? <button type="button" disabled={busy} onClick={() => onResolve("keep_existing")}>Keep current</button> : <button type="button" disabled={busy} onClick={() => onResolve("keep_existing")}>Dismiss candidate</button>}{review.kind === "contradiction" ? <button type="button" disabled={busy} onClick={() => onResolve("keep_both")}>Both are valid</button> : null}<button type="button" disabled={busy} onClick={() => onResolve("confirm_candidate")}>{busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} Confirm candidate</button></div></article>;
}

function MemoryReviewClaim({
  label,
  memory,
}: {
  label: string;
  memory: MemoryRecord;
}) {
  return <section><p>{label}</p><h4>{memory.title}</h4><blockquote>{memory.content}</blockquote><dl><dt>Source</dt><dd>{memory.source}</dd><dt>Confidence</dt><dd>{Math.round((memory.confidence ?? 0.7) * 100)}%</dd><dt>Valid from</dt><dd>{memory.validFrom ? formatDate(memory.validFrom) : "Immediately"}</dd><dt>Valid until</dt><dd>{memory.validTo ? formatDate(memory.validTo) : "Open"}</dd></dl>{memory.evidenceRefs?.length ? <div>{memory.evidenceRefs.slice(0, 4).map((reference) => <code key={reference}>{reference}</code>)}</div> : null}</section>;
}

function reconciliationDecisionLabel(decision: MemoryReconciliationDecision) {
  if (decision === "confirm_candidate") return "candidate confirmed";
  if (decision === "keep_existing") return "existing claim kept";
  return "both claims kept";
}

function reconciliationDecisionAnnouncement(review: MemoryReconciliationReview) {
  if (review.decision === "confirm_candidate") {
    return review.existing
      ? "Candidate confirmed. The previous claim is now contradicted and excluded from recall."
      : "Candidate confirmed and added to active recall.";
  }
  if (review.decision === "keep_both") {
    return "Both claims were confirmed with their separate source and validity context.";
  }
  return review.existing
    ? "Existing claim kept. The candidate is excluded from recall."
    : "Candidate dismissed and excluded from recall.";
}

function CreateMemoryDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (memory: MemoryRecord, entityProjection?: EntityProjectionSummary) => void }) {
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [tier, setTier] = useState<MemoryTier>("semantic"); const [saving, setSaving] = useState(false); const [error, setError] = useState<string>();
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); try { const response = await fetch("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, content, tier, type: memoryTypeForTier(tier), importance: .75, confidence: .95 }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message || payload.error || "Memory could not be saved."); onCreated(payload.record as MemoryRecord, payload.entityProjection as EntityProjectionSummary | undefined); } catch (submitError) { setError(message(submitError)); setSaving(false); } }
  return <div className={clsx("memory-dialog-backdrop", styles.dialogBackdrop)} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className={clsx("memory-dialog", styles.dialog)} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-memory-title"><header><div><p>Direct memory</p><h2 id="new-memory-title">Add a memory</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>{error ? <p className="memory-dialog-error">{error}</p> : null}<label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={240} required /></label><label>Tier<select value={tier} onChange={(event) => setTier(event.currentTarget.value as MemoryTier)}>{userCreatableMemoryTiers.map((item) => <option key={item}>{item}</option>)}</select></label><label>What should your agents know?<textarea rows={8} value={content} onChange={(event) => setContent(event.currentTarget.value)} maxLength={200000} placeholder={'Use explicit markers such as project: Phoenix or person named "Ada Lovelace" to add them to your private entity registry.'} required /></label><footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving || !title.trim() || !content.trim()}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Brain size={13} />} Save memory</button></footer></form></div>;
}

function MemoryTierPolicySummary({ tier }: { tier: MemoryTier }) {
  const policy = memoryTierPoliciesV1[tier];
  return <div className="memory-provenance"><p><Database size={13} aria-hidden="true" /> Tier policy v{policy.version}</p><dl><dt>Retention</dt><dd>{policy.retention.mode.replaceAll("_", " ")}{policy.retention.defaultDays ? ` · ${policy.retention.defaultDays} days` : ""}</dd><dt>Promotion</dt><dd>{policy.promotion.targets.length ? `Reviewed only → ${policy.promotion.targets.join(", ")}` : "Not promotable"}</dd><dt>Correction</dt><dd>Superseding revision; history retained</dd><dt>Retrieval</dt><dd>Active, valid, authorized · priority {policy.retrieval.priorityWeight.toFixed(2)}</dd></dl></div>;
}

function memoryTypeForTier(tier: MemoryTier): MemoryType {
  if (tier === "episodic") return "episode";
  if (tier === "procedural") return "procedure";
  if (tier === "preference") return "preference";
  if (tier === "decision") return "decision";
  if (tier === "commitment") return "task";
  if (tier === "semantic" || tier === "summary") return "knowledge";
  return "fact";
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
