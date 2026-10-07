"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { csmRoleSnapshotSchema } from "@/lib/csm/role-contracts";
import {
  Archive,
  ArrowRight,
  BookOpen,
  Brain,
  Check,
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
import { SemanticShadowCollector } from "@/components/semantic-shadow-collector";
import { SemanticShadowReviewQueue } from "@/components/semantic-shadow-review-queue";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { startVisibleRefresh } from "@/lib/client/visible-refresh";
import { workspaceOwnerScope } from "@/components/app-shell/workspace-owner-scope";
import { useContentSearchLocation } from "@/components/app-shell/content-search-location";
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
        Preparing your knowledge map…
      </div>
    ),
  },
);

type WorkspaceView = "memory" | "knowledge" | "reviews" | "universe";
type CreateIntent = "memory" | "connected_fact";
type Page<T> = { items: T[]; total: number; nextCursor: string | null };
type ConsentStatus = {
  state: "active" | "inactive";
  notice: { text: string; sha256: string };
};
type ForgetPreview = {
  memory: { id: string; title: string };
  expectedReceiptManifestSha256: string;
  guarantee: "rollback_proof_barrier" | "best_effort";
  impact: {
    descendantMemoryCount: number;
    retrievalTraceCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
  };
};
type CognificationEvidence = {
  quote: string;
};
type CognificationReview = {
  candidate: {
    batchId: string;
    batchIndex: number;
    batchCount: number;
    summary: {
      text: string;
      confidenceBasisPoints: number;
      evidence: CognificationEvidence[];
    };
    topics: Array<{ label: string }>;
    claims: Array<{ statement: string }>;
    entities: Array<{ canonicalLabel: string }>;
    relations: Array<{ statement: string }>;
    modelAttribution: {
      provider: string;
      model: string;
    };
  };
  status: "pending_review" | "confirmed" | "dismissed";
  projected?: boolean;
};
type CognificationReviewGroup = {
  id: string;
  kind: "duplicate" | "contradiction";
  epistemicKind: "fact" | "procedure" | "opinion" | "prediction";
  scoreBasisPoints: number;
  confidenceBasisPoints: number;
  references: Array<{
    batchId: string;
    claimIndex: number;
    status: "pending_review" | "confirmed";
    polarity: "affirmed" | "negated";
    statement: string;
  }>;
};
type CognificationJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: Record<string, unknown>;
  result?: Record<string, unknown>;
  lastError?: string;
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
  const { session, status, role } = useWorkspaceSession();
  const scope = JSON.stringify([session?.user?.id, session?.context?.tenantId, session?.context?.actorId, role, status, session?.authenticated]);
  return <MemoryWorkspace key={scope} searchAvailable={status === "ready" && Boolean(workspaceOwnerScope(session, role))} />;
}

function MemoryWorkspace({ searchAvailable }: { searchAvailable: boolean }) {
  const searchLocation = useContentSearchLocation();
  const searchMemoryId = searchAvailable ? new URLSearchParams(searchLocation.split("?")[1]).get("memory") : null;
  const [view, setView] = useState<WorkspaceView>("memory");
  const [overview, setOverview] = useState<MemoryIntelligenceOverview>();
  const [memoryPage, setMemoryPage] = useState<Page<MemoryIndexItem>>(emptyPage);
  const [knowledgePage, setKnowledgePage] = useState<Page<KnowledgeIndexItem>>(emptyPage);
  const [reviews, setReviews] = useState<MemoryReconciliationReview[]>([]);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [cognitionReviews, setCognitionReviews] = useState<CognificationReview[]>([]);
  const [cognitionReviewGroups, setCognitionReviewGroups] = useState<CognificationReviewGroup[]>([]);
  const [cognitionReviewsLoaded, setCognitionReviewsLoaded] = useState(false);
  const [cognitionReviewsLoading, setCognitionReviewsLoading] = useState(false);
  const [cognitionReviewsError, setCognitionReviewsError] = useState<string>();
  const [cognitionQueueFeedback, setCognitionQueueFeedback] = useState<string>();
  const [cognitionJobs, setCognitionJobs] = useState<CognificationJob[]>([]);
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
  const [overviewError, setOverviewError] = useState<string>();
  const [indexLoading, setIndexLoading] = useState(false);
  const [loadedIndexes, setLoadedIndexes] = useState({ memory: false, knowledge: false });
  const [indexErrors, setIndexErrors] = useState<Partial<Record<"memory" | "knowledge", string>>>({});
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewsLoadError, setReviewsLoadError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createIntent, setCreateIntent] = useState<CreateIntent>("memory");
  const [universeRevision, setUniverseRevision] = useState(0);
  const [forgetPreview, setForgetPreview] = useState<ForgetPreview>();
  const selectedMemoryIdRef = useRef(selectedMemoryId);
  selectedMemoryIdRef.current = selectedMemoryId;
  const forgetIntentRef = useRef<{ id: string; digest: string; key: string } | null>(null);
  const [consent, setConsent] = useState<ConsentStatus>();
  const overviewRequestRef = useRef<AbortController | null>(null);
  const indexRequestRef = useRef<AbortController | null>(null);
  const reviewsRequestRef = useRef<AbortController | null>(null);
  const cognitionReviewsRequestRef = useRef<AbortController | null>(null);
  const indexSignatureRef = useRef<Partial<Record<"memory" | "knowledge", string>>>({});
  const reviewSignatureRef = useRef("");
  const cognitionReviewSignatureRef = useRef("");
  const cognitionCompletionSignatureRef = useRef("");

  const loadOverview = useCallback(async () => {
    overviewRequestRef.current?.abort();
    const controller = new AbortController();
    overviewRequestRef.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/memory/intelligence?view=overview&limit=40", {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json();
      if (controller.signal.aborted || overviewRequestRef.current !== controller) return;
      if (!response.ok) throw new Error(body.error || "Memory intelligence could not be loaded.");
      setOverview(body.overview as MemoryIntelligenceOverview);
      setOverviewError(undefined);
      setError(undefined);
    } catch (loadError) {
      if (controller.signal.aborted || overviewRequestRef.current !== controller) return;
      setOverviewError(message(loadError));
      setError(message(loadError));
    } finally {
      if (!controller.signal.aborted && overviewRequestRef.current === controller) setLoading(false);
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
    return () => {
      window.clearTimeout(timer);
      overviewRequestRef.current?.abort();
    };
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
    setIndexErrors((current) => ({ ...current, [kind]: undefined }));
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
      setLoadedIndexes((current) => ({ ...current, [kind]: true }));
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setIndexErrors((current) => ({ ...current, [kind]: message(loadError) }));
        setError(message(loadError));
      }
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
      setReviewsLoadError(undefined);
      reviewSignatureRef.current = signature;
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setReviewsLoadError(message(loadError));
        setError(message(loadError));
      }
    } finally {
      if (reviewsRequestRef.current === controller) setReviewsLoading(false);
    }
  }, [reviewLimit]);

  const loadCognitionReviews = useCallback(async (force = false) => {
    const signature = `source-maps:${reviewLimit}`;
    if (!force && cognitionReviewSignatureRef.current === signature) return;
    cognitionReviewsRequestRef.current?.abort();
    const controller = new AbortController();
    cognitionReviewsRequestRef.current = controller;
    setCognitionReviewsLoading(true);
    try {
      const response = await fetch(
        `/api/knowledge/cognification?limit=${reviewLimit}`,
        { cache: "no-store", signal: controller.signal },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Source map proposals could not be loaded.");
      }
      setCognitionReviews(Array.isArray(body.reviews) ? body.reviews : []);
      setCognitionReviewGroups(
        Array.isArray(body.reviewGroups) ? body.reviewGroups : [],
      );
      setCognitionReviewsLoaded(true);
      setCognitionReviewsError(undefined);
      cognitionReviewSignatureRef.current = signature;
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setCognitionReviewsError(message(loadError));
      }
    } finally {
      if (cognitionReviewsRequestRef.current === controller) {
        setCognitionReviewsLoading(false);
      }
    }
  }, [reviewLimit]);

  useEffect(() => {
    if (view !== "reviews") {
      reviewsRequestRef.current?.abort();
      cognitionReviewsRequestRef.current?.abort();
      return;
    }
    const timer = window.setTimeout(() => {
      void loadReviews();
      void loadCognitionReviews();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      reviewsRequestRef.current?.abort();
      cognitionReviewsRequestRef.current?.abort();
    };
  }, [view, loadCognitionReviews, loadReviews]);

  useEffect(() => {
    if (!cognitionJobs.length) return;
    const knownIds = new Set(cognitionJobs.map((job) => job.id));
    const followUpIds = cognitionJobs.flatMap((job) => {
      const nextJobId = stringRecordValue(job.result, "nextJobId");
      return nextJobId && !knownIds.has(nextJobId) ? [nextJobId] : [];
    });
    const pollIds = [...new Set([
      ...cognitionJobs
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) => job.id),
      ...followUpIds,
    ])];
    if (!pollIds.length) return;

    const controller = new AbortController();
    const stop = startVisibleRefresh({
      pollIntervalMs: 2_000,
      onRefresh: async () => {
        const updates = await fetch(
          `/api/operations/jobs?ids=${pollIds.map(encodeURIComponent).join(",")}`,
          { cache: "no-store", signal: controller.signal },
        ).then(async (response) => {
          const body = await response.json().catch(() => ({})) as {
            jobs?: unknown[];
          };
          return response.ok && Array.isArray(body.jobs)
            ? body.jobs.map(parseCognificationJob)
            : [];
        }).catch(() => []);
        if (controller.signal.aborted) return;
        const jobs: CognificationJob[] = [];
        for (const job of updates) {
          if (job) jobs.push(job);
        }
        if (jobs.length) {
          setCognitionJobs((current) => mergeCognificationJobs(current, jobs));
        }
      },
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [cognitionJobs]);

  useEffect(() => {
    if (!cognitionJobs.length) return;
    const knownIds = new Set(cognitionJobs.map((job) => job.id));
    const hasUnresolvedFollowUp = cognitionJobs.some((job) => {
      const nextJobId = stringRecordValue(job.result, "nextJobId");
      return Boolean(nextJobId && !knownIds.has(nextJobId));
    });
    const active = cognitionJobs.filter((job) =>
      job.status === "queued" || job.status === "running"
    );
    const completed = cognitionJobs.filter((job) =>
      job.status === "completed"
    ).length;
    const failed = cognitionJobs.filter((job) =>
      job.status === "failed" || job.status === "canceled"
    );
    if (active.length || hasUnresolvedFollowUp) {
      const timer = window.setTimeout(() => {
        setCognitionQueueFeedback(
          `Building source maps in the background · ${completed} ${completed === 1 ? "batch" : "batches"} complete · ${active.length || 1} active.`,
        );
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const signature = cognitionJobs
      .map((job) => `${job.id}:${job.status}`)
      .sort()
      .join("|");
    if (cognitionCompletionSignatureRef.current === signature) return;
    cognitionCompletionSignatureRef.current = signature;
    const feedback = failed.length
      ? `${failed.length} source-map ${failed.length === 1 ? "batch needs" : "batches need"} attention. ${failed[0].lastError || "Use Cognify sources to retry safely."}`
      : `${completed} source-map ${completed === 1 ? "batch is" : "batches are"} ready for review.`;
    const timer = window.setTimeout(() => {
      setCognitionQueueFeedback(feedback);
      setAnnouncement(feedback);
      cognitionReviewSignatureRef.current = "";
      void Promise.all([
        loadOverview(),
        view === "reviews" ? loadCognitionReviews(true) : Promise.resolve(),
      ]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cognitionJobs, loadCognitionReviews, loadOverview, view]);

  useEffect(() => {
    if (!searchMemoryId) return;
    const timer = window.setTimeout(() => {
      setView("memory");
      setSelectedMemory(undefined);
      setSelectedMemoryId(searchMemoryId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchMemoryId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setForgetPreview(undefined);
      if (!selectedMemoryId) {
        setSelectedMemory(undefined);
        return;
      }
      setDetailLoading(true);
      void fetch(`${searchMemoryId === selectedMemoryId ? "/api/content-search/memory" : "/api/memory"}/${encodeURIComponent(selectedMemoryId)}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Memory details could not be loaded.");
        if (controller.signal.aborted) return;
        if (!body.memory || body.memory.id !== selectedMemoryId) throw new Error("Memory returned a different claim.");
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
  }, [selectedMemoryId, searchMemoryId]);

  const embeddingCoverage = overview?.summary.knowledgeChunks
    ? Math.round(overview.summary.embeddedChunks / overview.summary.knowledgeChunks * 100)
    : undefined;
  const pendingCognitionReviewCount = cognitionReviews.filter(
    (review) => review.status === "pending_review",
  ).length;
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

  async function resolveCognitionReview(
    candidateId: string,
    decision: "confirm" | "dismiss",
  ) {
    setBusy(`cognition-review:${candidateId}`);
    setReviewErrors((current) => {
      const next = { ...current };
      delete next[`cognition:${candidateId}`];
      return next;
    });
    try {
      const response = await fetch("/api/knowledge/cognification", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: candidateId, decision }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "The source map decision could not be applied.");
      }
      setCognitionReviews((current) => current.filter(
        (review) => review.candidate.batchId !== candidateId,
      ));
      setAnnouncement(decision === "confirm"
        ? "Source map confirmed. Its reviewed summary is now available to memory and the evidence graph."
        : "Source map dismissed. It remains outside memory, recall and the evidence graph.");
      await Promise.all([loadCognitionReviews(true), loadOverview()]);
    } catch (actionError) {
      const detail = message(actionError);
      setReviewErrors((current) => ({
        ...current,
        [`cognition:${candidateId}`]: detail,
      }));
      setAnnouncement(`Source map was not changed. ${detail}`);
    } finally {
      setBusy(undefined);
    }
  }

  async function queueCognification() {
    setBusy("cognify-sources");
    setError(undefined);
    setCognitionQueueFeedback("Checking eligible source revisions…");
    try {
      const response = await fetch("/api/knowledge/cognification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 12 }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Source map processing could not be queued.");
      }
      const queuedCount = Number(body.queuedJobCount || 0);
      const eligibleCount = Number(body.eligibleDocumentCount || 0);
      const queuedJobs = Array.isArray(body.jobs)
        ? body.jobs
          .map(parseCognificationJob)
          .filter((job: CognificationJob | undefined): job is CognificationJob =>
            Boolean(job)
          )
        : [];
      cognitionCompletionSignatureRef.current = "";
      setCognitionJobs(queuedJobs);
      const feedback = queuedCount
        ? `${queuedCount} ${queuedCount === 1 ? "source" : "sources"} queued. Processing continues in the background; proposals will appear in Reviews.`
        : eligibleCount
          ? "Eligible sources are already queued or up to date. New proposals will appear in Reviews."
          : "No eligible source revisions need a new map right now.";
      setCognitionQueueFeedback(feedback);
      setAnnouncement(feedback);
      cognitionReviewSignatureRef.current = "";
      if (view === "reviews") await loadCognitionReviews(true);
    } catch (actionError) {
      const detail = message(actionError);
      setCognitionQueueFeedback(`Source maps were not queued. ${detail}`);
      setError(detail);
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

  async function backfillKnowledgeEmbeddings() {
    setBusy("indexing");
    setError(undefined);
    let processed = 0;
    let remaining = 0;
    try {
      for (let batch = 0; batch < 12; batch += 1) {
        const response = await fetch("/api/memory/indexing", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "backfill_embeddings", limit: 48 }),
        });
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error || "Semantic indexing could not continue.");
        }
        processed += Number(body.processed || 0);
        remaining = Number(body.remaining || 0);
        setAnnouncement(
          remaining
            ? `Semantic indexing: ${processed} repaired, ${remaining} remaining…`
            : `Semantic indexing complete. ${processed} chunks repaired.`,
        );
        if (body.complete || !body.processed) break;
      }
      indexSignatureRef.current = {};
      await Promise.all([
        loadOverview(),
        view === "knowledge"
          ? loadIndex("knowledge", undefined, true)
          : Promise.resolve(),
      ]);
      if (remaining) {
        setAnnouncement(
          `${processed} chunks repaired. ${remaining} remain and can resume from this recommendation.`,
        );
      }
    } catch (indexError) {
      setError(message(indexError));
    } finally {
      setBusy(undefined);
    }
  }

  async function rebuildEvidenceMap() {
    setBusy("graph");
    setError(undefined);
    try {
      const response = await fetch("/api/memory/graph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "mnemosyne-recommendation" }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "The evidence map could not be rebuilt.");
      }
      setUniverseRevision((current) => current + 1);
      setAnnouncement(
        `Evidence map rebuilt with ${body.stats?.nodes || 0} points and ${body.stats?.edges || 0} links.`,
      );
      await loadOverview();
    } catch (graphError) {
      setError(message(graphError));
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
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
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
    if (!selectedMemory || selectedMemory.id !== selectedMemoryIdRef.current) return;
    const targetId = selectedMemory.id;
    setBusy("forget-preview");
    try {
      const response = await fetch(
        `/api/memory/${encodeURIComponent(selectedMemory.id)}?view=deletion-preview`,
        { cache: "no-store" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Deletion impact could not be loaded.");
      if (selectedMemoryIdRef.current !== targetId) return;
      if (body.preview?.memory?.id !== targetId) throw new Error("The deletion preview changed. Open this memory again before deleting it.");
      const preview = body.preview as ForgetPreview;
      if (forgetIntentRef.current?.id !== targetId || forgetIntentRef.current.digest !== preview.expectedReceiptManifestSha256) {
        forgetIntentRef.current = { id: targetId, digest: preview.expectedReceiptManifestSha256, key: crypto.randomUUID() };
      }
      setForgetPreview(preview);
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setBusy(undefined);
    }
  }

  async function forgetMemory() {
    if (!selectedMemory || !forgetPreview || selectedMemory.id !== selectedMemoryIdRef.current || forgetPreview.memory.id !== selectedMemory.id || !forgetIntentRef.current || forgetIntentRef.current.id !== selectedMemory.id || forgetIntentRef.current.digest !== forgetPreview.expectedReceiptManifestSha256) return;
    setBusy("forget");
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(selectedMemory.id)}`, {
        method: "DELETE",
        headers: {
          "idempotency-key": forgetIntentRef.current.key,
          "x-asael-deletion-preview": forgetPreview.expectedReceiptManifestSha256,
        },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Memory could not be forgotten.");
      setSelectedMemoryId(undefined);
      setForgetPreview(undefined);
      setAnnouncement("Memory deleted. Related recall paths were removed and a deletion receipt was saved.");
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
    if (item.action === "backfill_embeddings") void backfillKnowledgeEmbeddings();
    if (item.action === "run_maintenance") void runMaintenance();
    if (item.action === "enroll_ownership") void enrollLegacyOwnership();
    if (item.action === "rebuild_graph") void rebuildEvidenceMap();
  }

  function selectView(nextView: WorkspaceView) {
    setView(nextView);
    if (nextView === "universe") setUniverseVisited(true);
  }

  return (
    <section className={styles.shell} aria-labelledby="memory-page-title">
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1 id="memory-page-title">Memory</h1>
          {view !== "universe" ? <span>Inspect what Asael remembers and the sources behind it.</span> : null}
        </div>
        <div className={styles.heroActions}>
          {view !== "universe" ? <div className={styles.search}>
            <Search size={17} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search memories and sources"
              aria-label="Search memory and knowledge"
            />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={15} /></button> : null}
          </div> : null}
          <button type="button" className={styles.secondaryAction} onClick={() => void loadOverview()} disabled={loading}>
            <RefreshCw size={16} className={loading ? styles.spin : undefined} /> Refresh
          </button>
          <button type="button" className={styles.primaryAction} onClick={() => {
            setCreateIntent("memory");
            setCreateOpen(true);
          }}>
            <Plus size={17} /> Add memory
          </button>
        </div>
      </header>

      {error ? <div className={styles.error} role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss</button></div> : null}
      <p className={styles.announcement} role="status">{announcement}</p>

      <nav className={styles.tabs} aria-label="Memory workspace">
        <Tab active={view === "memory"} onClick={() => selectView("memory")} icon={<Brain size={17} />} label="Memory" count={overview?.summary.durableMemories} />
        <Tab active={view === "knowledge"} onClick={() => selectView("knowledge")} icon={<BookOpen size={17} />} label="Knowledge" count={overview?.summary.knowledgeDocuments} />
        <Tab
          active={view === "reviews"}
          onClick={() => selectView("reviews")}
          icon={<ShieldCheck size={17} />}
          label="Reviews"
          count={overview ? overview.summary.pendingReviews + pendingCognitionReviewCount : undefined}
        />
        <Tab active={view === "universe"} onClick={() => selectView("universe")} icon={<Layers3 size={17} />} label="Map" />
      </nav>

      <details className={styles.overviewDetails} hidden={view === "universe"}>
        <summary>Memory health and how it works</summary>
        <section className={styles.metrics} aria-label="Memory health summary">
          <Metric icon={<Brain />} value={overview?.summary.durableMemories} label="Durable memories" loading={loading} />
          <Metric icon={<FileStack />} value={overview?.summary.knowledgeDocuments} label="Knowledge sources" loading={loading} />
          <Metric icon={<Database />} value={embeddingCoverage !== undefined ? `${embeddingCoverage}%` : overview ? "No chunks" : undefined} label="Vector coverage" loading={loading} />
          <Metric icon={<ShieldCheck />} value={overview?.summary.pendingReviews} label="Awaiting review" warning={Boolean(overview?.summary.pendingReviews)} loading={loading} />
          <Metric icon={<GitBranch />} value={overview ? `${overview.summary.graphNodes.toLocaleString()} / ${overview.summary.graphEdges.toLocaleString()}` : undefined} label="Nodes / links" loading={loading} />
        </section>
        <MemoryGuide />
      </details>

      {universeVisited ? (
        <div className={styles.universeWrap} hidden={view !== "universe"}>
          <MemoryUniverse
            key={`memory-universe:${universeRevision}`}
            active={view === "universe"}
            onOpenMemory={(id) => { setSelectedMemoryId(id); selectView("memory"); }}
            onOpenSource={(title) => { setQuery(title); selectView("knowledge"); }}
            onAddConnectedFact={() => {
              setCreateIntent("connected_fact");
              setCreateOpen(true);
            }}
          />
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
                loaded={loadedIndexes.memory}
                error={indexErrors.memory}
                onRetry={() => void loadIndex("memory", undefined, true)}
                onMore={() => void loadIndex("memory", memoryPage.nextCursor || undefined)}
              />
            ) : view === "knowledge" ? (
              <KnowledgeIndex
                overview={overview}
                page={knowledgePage}
                category={knowledgeCategory}
                onCategory={setKnowledgeCategory}
                loading={indexLoading}
                loaded={loadedIndexes.knowledge}
                error={indexErrors.knowledge}
                onRetry={() => void loadIndex("knowledge", undefined, true)}
                onMore={() => void loadIndex("knowledge", knowledgePage.nextCursor || undefined)}
              />
            ) : (
              <ReviewIndex
                reviews={reviews}
                cognitionReviews={cognitionReviews}
                cognitionReviewGroups={cognitionReviewGroups}
                quality={overview?.quality}
                overviewLoading={loading}
                overviewError={overviewError}
                semanticShadow={overview?.semanticShadow}
                onSemanticShadowProgress={loadOverview}
                loaded={reviewsLoaded}
                cognitionLoaded={cognitionReviewsLoaded}
                loading={reviewsLoading}
                cognitionLoading={cognitionReviewsLoading}
                cognitionLoadError={cognitionReviewsError}
                loadError={reviewsLoadError}
                busy={busy}
                errors={reviewErrors}
                onResolve={resolveReview}
                onResolveCognition={resolveCognitionReview}
                onReloadCognition={() => void loadCognitionReviews(true)}
                total={overview?.summary.pendingReviews || reviews.length}
                onMore={() => setReviewLimit((current) => current + 20)}
              />
            )}
          </section>

          <details className={styles.toolsDetails}>
            <summary>Memory settings and maintenance{overview?.steward.state === "attention" ? " · Needs attention" : ""}</summary>
          <MnemosynePanel
            overview={overview}
            loading={loading}
            consent={consent}
            busy={busy}
            cognitionFeedback={cognitionQueueFeedback}
            cognitionJobs={cognitionJobs}
            onConsent={() => void toggleConsent()}
            onScan={() => void runMaintenance()}
            onCognify={() => void queueCognification()}
            onRecommendation={handleRecommendation}
          />
          </details>
        </div>
      ) : null}

      {selectedMemoryId && view === "memory" ? (
        <MemoryInspector
          memory={selectedMemory?.id === selectedMemoryId ? selectedMemory : undefined}
          loading={detailLoading}
          error={error}
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
          error={error}
          intent={createIntent}
          onClose={() => setCreateOpen(false)}
          onCreate={async (draft) => {
            setBusy("create");
            try {
              const response = await fetch("/api/memory", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "idempotency-key": crypto.randomUUID(),
                },
                body: JSON.stringify(draft),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error || body.message || "Memory could not be saved.");
              setCreateOpen(false);
              setUniverseRevision((current) => current + 1);
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
    </section>
  );
}

function Metric(props: { icon: React.ReactNode; value?: number | string; label: string; warning?: boolean; loading: boolean }) {
  return <article className={props.warning ? styles.metricWarning : undefined}><i aria-hidden="true">{props.icon}</i><div><strong>{props.value ?? (props.loading ? "Loading…" : "Unavailable")}</strong><span>{props.label}</span></div></article>;
}

function MemoryGuide() {
  return <section className={styles.memoryGuide} aria-labelledby="memory-guide-title">
    <header>
      <h2 id="memory-guide-title">How memory works</h2>
      <span>Personal memories and source documents keep their own scope and provenance.</span>
    </header>
    <div>
      <article><BookOpen size={18} /><span><strong>Knowledge</strong><small>Your documents and transcripts. Evidence to search—not automatically treated as personal truth.</small></span></article>
      <article><Brain size={18} /><span><strong>Memory</strong><small>Durable facts, preferences, decisions and experiences Asael may carry into future work.</small></span></article>
      <article><ShieldCheck size={18} /><span><strong>Reviews</strong><small>The safety gate. Evidence-bound source maps and conflicting claims stay outside recall until you confirm them.</small></span></article>
      <article><GitBranch size={18} /><span><strong>Knowledge map</strong><small>Browse named memories and sources by collection, or focus on one item’s recorded connections.</small></span></article>
    </div>
  </section>;
}

function Tab(props: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number }) {
  return <button type="button" className={props.active ? styles.activeTab : undefined} onClick={props.onClick} aria-pressed={props.active}>{props.icon}<span>{props.label}</span>{props.count !== undefined ? <small>{props.count.toLocaleString()}</small> : null}</button>;
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
  loaded: boolean;
  error?: string;
  onRetry: () => void;
  onMore: () => void;
}) {
  const visibleItems = props.state === "all" ? props.page.items.filter((item) => !retiredMemoryPlaceholder(item.title)) : props.page.items;
  const hiddenCount = props.page.items.length - visibleItems.length;
  return <>
    <IndexHeading
      eyebrow=""
      title="Memories"
      detail={props.loaded ? `${visibleItems.length.toLocaleString()} shown from ${props.page.items.length.toLocaleString()} loaded memories.${hiddenCount ? ` ${hiddenCount} retired placeholders hidden; choose Archived or Replaced to view them.` : " Open one to read, pin, archive or delete it."}` : "Open a memory to read, pin, archive or delete it."}
    />
    <CategoryRail active={props.category} onSelect={props.onCategory} items={props.overview?.memoryCategories} />
    <div className={styles.filters}>
      <label>Kind <select value={props.tier} onChange={(event) => props.onTier(event.target.value as MemoryTier | "all")}>{memoryTiers.map((item) => <option key={item} value={item}>{memoryLabel(item)}</option>)}</select></label>
      <label>Status <select value={props.state} onChange={(event) => props.onState(event.target.value as MemoryIndexItem["state"] | "all")}><option value="all">All except retired</option><option value="active">Active</option><option value="candidate">Needs review</option><option value="contradicted">Conflicting</option><option value="superseded">Replaced</option><option value="archived">Archived</option></select></label>
    </div>
    {props.error ? <IndexUnavailable hasRecords={Boolean(props.page.items.length)} onRetry={props.onRetry} /> : null}
    <ul className={styles.indexList} aria-label="Memory index" aria-busy={props.loading}>
      {visibleItems.map((item) => <li key={item.id}>
        <button type="button" className={`${styles.memoryRow} ${props.selectedId === item.id ? styles.selectedRow : ""}`} onClick={() => props.onSelect(item.id)} aria-pressed={props.selectedId === item.id}>
          <span className={styles.rowTitle}><strong>{displayMemoryTitle(item.title, item.updatedAt)}</strong><small>{memoryLabel(item.tier)} · {memoryLabel(item.scope)}{item.pinned ? " · Pinned" : ""}</small></span>
          <span className={styles.rowFacts}>
            <span><span className={styles.factLabel}>Status</span><em className={`${styles.state} ${styles[`state${startCase(item.state)}`] || ""}`}>{memoryLabel(item.state)}</em></span>
            <span><span className={styles.factLabel}>Evidence</span>{item.evidenceCount}</span>
            <span><span className={styles.factLabel}>Updated</span>{relativeDate(item.updatedAt)}</span>
          </span>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </li>)}
    </ul>
    {!props.loading && props.loaded && !props.error && !visibleItems.length ? <EmptyState icon={<Brain />} title={hiddenCount ? "No current memories in this page" : "No memories match this view"} detail={hiddenCount ? "Load more memories, or choose Archived or Replaced to view retained records." : "Try another kind, status or search phrase."} /> : null}
    {props.loading || (!props.loaded && !props.error) ? <LoadingRow /> : null}
    {props.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={props.onMore} disabled={props.loading}>Load more memories</button> : null}
  </>;
}

function KnowledgeIndex(props: {
  overview?: MemoryIntelligenceOverview;
  page: Page<KnowledgeIndexItem>;
  category: KnowledgeCategoryId | "all";
  onCategory: (value: KnowledgeCategoryId | "all") => void;
  loading: boolean;
  loaded: boolean;
  error?: string;
  onRetry: () => void;
  onMore: () => void;
}) {
  return <>
    <IndexHeading
      eyebrow="Source knowledge"
      title="Knowledge sources"
      detail={props.loaded ? `${props.page.total.toLocaleString()} sources in the last loaded view. Source documents provide evidence; they are not automatically personal memories.` : "Source documents provide evidence; they are not automatically personal memories."}
    />
    <CategoryRail active={props.category} onSelect={props.onCategory} items={props.overview?.knowledgeCategories} />
    {props.error ? <IndexUnavailable hasRecords={Boolean(props.page.items.length)} onRetry={props.onRetry} /> : null}
    <ul className={styles.indexList} aria-label="Knowledge source index" aria-busy={props.loading}>
      {props.page.items.map((item) => <li key={item.id} className={styles.knowledgeRow}>
        <span className={styles.rowTitle}><strong>{item.title}</strong><small>{item.sourceLabel}{item.hasCanonicalLineage ? " · Canonical lineage" : ""}</small></span>
        <dl className={styles.rowFacts}>
          <div><dt>Category</dt><dd>{startCase(item.category)}</dd></div>
          <div><dt>Chunks</dt><dd>{item.chunkCount.toLocaleString()}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(item.totalCharacters)}</dd></div>
          <div><dt>Indexed</dt><dd>{relativeDate(item.indexedAt)}</dd></div>
        </dl>
      </li>)}
    </ul>
    {!props.loading && props.loaded && !props.error && !props.page.items.length ? <EmptyState icon={<BookOpen />} title="No knowledge sources match" detail="Adjust the category or search phrase." /> : null}
    {props.loading || (!props.loaded && !props.error) ? <LoadingRow /> : null}
    {props.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={props.onMore} disabled={props.loading}>Load more sources</button> : null}
  </>;
}

function IndexUnavailable(props: { hasRecords: boolean; onRetry: () => void }) {
  return <div className={styles.indexUnavailable} role="status">
    <CircleAlert size={17} aria-hidden="true" />
    <span>{props.hasRecords ? "Showing previously loaded records. The current view could not be loaded." : "This index is unavailable. Its records could not be checked."}</span>
    <button type="button" onClick={props.onRetry}>Retry index</button>
  </div>;
}

function ReviewIndex(props: {
  reviews: MemoryReconciliationReview[];
  cognitionReviews: CognificationReview[];
  cognitionReviewGroups: CognificationReviewGroup[];
  quality?: MemoryIntelligenceOverview["quality"];
  overviewLoading: boolean;
  overviewError?: string;
  semanticShadow?: MemoryIntelligenceOverview["semanticShadow"];
  onSemanticShadowProgress: () => Promise<void>;
  loaded: boolean;
  cognitionLoaded: boolean;
  loading: boolean;
  cognitionLoading: boolean;
  cognitionLoadError?: string;
  loadError?: string;
  busy?: string;
  errors: Record<string, string>;
  total: number;
  onMore: () => void;
  onResolve: (
    id: string,
    decision: "confirm_candidate" | "keep_existing" | "keep_both",
  ) => void;
  onResolveCognition: (id: string, decision: "confirm" | "dismiss") => void;
  onReloadCognition: () => void;
}) {
  const pending = props.reviews.filter((review) => review.status === "pending");
  const sourceMaps = props.cognitionReviews.filter(
    (review) => review.status !== "dismissed",
  );
  const pendingSourceMaps = sourceMaps.filter(
    (review) => review.status === "pending_review",
  );
  return <>
    <IndexHeading eyebrow="Memory decisions" title="Reviews" detail="Inspect proposed memories and their evidence before deciding what enters recall." />
    <p id="memory-review-busy" className={styles.reviewBusy} role="status">{props.busy ? "A memory action is in progress. Other review actions are unavailable until it finishes." : ""}</p>
    <section className={styles.cognitionSection} aria-labelledby="source-map-review-title">
      <header className={styles.reviewSectionHeading}>
        <div className={styles.reviewSectionIcon}><GitBranch size={18} /></div>
        <div>
          <p>Evidence-bound extraction</p>
          <h3 id="source-map-review-title">Source map proposals</h3>
          <span>Topics, claims and relationships extracted from your sources with exact supporting quotes.</span>
        </div>
        <div className={styles.reviewSectionActions}>
          <button
            type="button"
            onClick={props.onReloadCognition}
            disabled={props.cognitionLoading || Boolean(props.busy)}
            aria-label="Refresh source map proposals"
          >
            <RefreshCw size={14} className={props.cognitionLoading ? styles.spin : undefined} />
            Refresh
          </button>
          <span>{props.cognitionLoaded ? `${pendingSourceMaps.length} pending${props.cognitionLoadError || props.cognitionLoading ? " · Last loaded" : ""}` : props.cognitionLoadError ? "Count unavailable" : "Loading…"}</span>
        </div>
      </header>
      <p className={styles.cognitionBoundary}>
        <ShieldCheck size={16} />
        Pending proposals stay outside memory, recall and the Universe until you confirm them.
      </p>
      <CognitionReviewGroups groups={props.cognitionReviewGroups} />
      {props.cognitionLoadError ? (
        <div className={styles.inlineReviewError} role="alert">
          <CircleAlert size={16} />
          <span>{props.cognitionLoadError}{props.cognitionLoaded ? " Showing the last loaded source maps." : " Source maps could not be checked."}</span>
          <button type="button" onClick={props.onReloadCognition} disabled={Boolean(props.busy)}>Try again</button>
        </div>
      ) : null}
      <div className={styles.cognitionList}>
        {sourceMaps.map((review) => {
          const candidate = review.candidate;
          const resolving = props.busy === `cognition-review:${candidate.batchId}`;
          const pendingDecision = review.status === "pending_review";
          const evidence = candidate.summary.evidence || [];
          const actionError = props.errors[`cognition:${candidate.batchId}`];
          return <article key={candidate.batchId} aria-busy={resolving} aria-label={`Source map ${candidate.batchIndex + 1} of ${candidate.batchCount}`}>
            <header>
              <div>
                <h4>Source map {candidate.batchIndex + 1} of {candidate.batchCount}</h4>
                <small>{pendingDecision ? "Proposed extraction" : "Saved review decision"}</small>
              </div>
              <em className={pendingDecision ? styles.cognitionPending : review.projected ? styles.cognitionConfirmed : styles.cognitionInterrupted}>
                {pendingDecision
                  ? "Awaiting review"
                  : review.projected
                    ? "Confirmed"
                    : "Projection interrupted"}
              </em>
            </header>
            <div className={styles.cognitionBody}>
              <div className={styles.cognitionSummary}>
                <p>{pendingDecision ? "Proposed source summary" : "Reviewed source summary"}</p>
                <strong>{candidate.summary.text}</strong>
                {candidate.topics.length ? <div className={styles.cognitionTopics}>{candidate.topics.map((topic) => <span key={topic.label}>{topic.label}</span>)}</div> : null}
              </div>
              <details className={styles.cognitionEvidence} open>
                <summary>Exact source evidence · {evidence.length} {evidence.length === 1 ? "quote" : "quotes"}</summary>
                <p>Extraction confidence: {Math.round(candidate.summary.confidenceBasisPoints / 100)}%. Review the quoted text before confirming.</p>
                {evidence.length ? <div className={styles.evidenceQuotes} role="region" aria-label={`Exact evidence for source map ${candidate.batchIndex + 1} of ${candidate.batchCount}`} tabIndex={0}>
                  {evidence.map((item, index) => <blockquote key={index}>{item.quote}</blockquote>)}
                </div> : <p>No supporting quote was returned for this summary.</p>}
              </details>
              <dl className={styles.cognitionCounts}>
                <div><dt>Topics</dt><dd>{candidate.topics.length}</dd></div>
                <div><dt>Claims</dt><dd>{candidate.claims.length}</dd></div>
                <div><dt>Entities</dt><dd>{candidate.entities.length}</dd></div>
                <div><dt>Links</dt><dd>{candidate.relations.length}</dd></div>
              </dl>
              <details className={styles.cognitionContents}>
                <summary>Claims, entities and links</summary>
                <div>
                  <section><h5>Claims</h5>{candidate.claims.length ? <ul>{candidate.claims.map((claim, index) => <li key={index}>{claim.statement}</li>)}</ul> : <p>No claims were returned.</p>}</section>
                  <section><h5>Entities</h5>{candidate.entities.length ? <ul>{candidate.entities.map((entity, index) => <li key={index}>{entity.canonicalLabel}</li>)}</ul> : <p>No entities were returned.</p>}</section>
                  <section><h5>Links</h5>{candidate.relations.length ? <ul>{candidate.relations.map((relation, index) => <li key={index}>{relation.statement}</li>)}</ul> : <p>No links were returned.</p>}</section>
                </div>
              </details>
              <details className={styles.cognitionAttribution}>
                <summary>Extraction model and review identity</summary>
                <dl><div><dt>Provider</dt><dd>{startCase(candidate.modelAttribution.provider)}</dd></div><div><dt>Model</dt><dd>{candidate.modelAttribution.model}</dd></div><div><dt>Batch identity</dt><dd><code>{candidate.batchId}</code></dd></div></dl>
              </details>
            </div>
            {actionError ? <p className={styles.reviewError} role="alert"><CircleAlert size={15} />{actionError}</p> : null}
            {pendingDecision ? <footer>
              <span className={styles.reviewProgress} role="status">{resolving ? "Applying decision…" : ""}</span>
              <button className={styles.primaryReviewAction} type="button" onClick={() => props.onResolveCognition(candidate.batchId, "confirm")} disabled={Boolean(props.busy)} aria-describedby={props.busy ? "memory-review-busy" : undefined}><Check size={15} /> Confirm source map</button>
              <button type="button" onClick={() => props.onResolveCognition(candidate.batchId, "dismiss")} disabled={Boolean(props.busy)} aria-describedby={props.busy ? "memory-review-busy" : undefined}><X size={15} /> Dismiss</button>
            </footer> : review.projected ? (
              <footer className={styles.confirmedFooter}><Check size={15} /> Added to reviewed memory and graph</footer>
            ) : (
              <footer>
                <span className={styles.reviewProgress} role="status">{resolving ? "Retrying projection…" : "Review saved; graph projection needs another attempt."}</span>
                <button className={styles.primaryReviewAction} type="button" onClick={() => props.onResolveCognition(candidate.batchId, "confirm")} disabled={Boolean(props.busy)} aria-describedby={props.busy ? "memory-review-busy" : undefined}><RefreshCw size={15} /> Retry projection</button>
              </footer>
            )}
          </article>;
        })}
        {props.cognitionLoaded && !props.cognitionLoading && !sourceMaps.length && !props.cognitionLoadError ? <EmptyState icon={<GitBranch />} title="No source maps await review" detail="Ask Mnemosyne to cognify eligible sources; proposals will appear here after background processing." /> : null}
        {props.cognitionLoading || (!props.cognitionLoaded && !props.cognitionLoadError) ? <LoadingRow /> : null}
      </div>
    </section>

    <section className={styles.memoryReviewSection} aria-labelledby="memory-review-title">
      <header className={styles.memoryReviewHeading}>
        <div><p>Memory decisions</p><h3 id="memory-review-title">Conflicts and promotions</h3></div>
        <span>{props.loaded ? `${pending.length} pending${props.loadError || props.loading ? " · Last loaded" : ""}` : props.loadError ? "Count unavailable" : "Loading…"}</span>
      </header>
      {props.loadError ? <p className={styles.inlineReviewError} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{props.loadError}{props.loaded ? " Showing the last loaded memory reviews." : " The memory review queue could not be checked."}</span></p> : null}
      <div className={styles.reviewList}>
        {pending.map((review) => {
          const resolving = props.busy === `review:${review.id}`;
          return <article key={review.id} aria-busy={resolving} aria-label={`${review.kind === "contradiction" ? "Conflict" : "Proposed memory"}: ${review.candidate.title}`}>
            <header><span>{review.kind === "contradiction" ? "Conflict" : "Proposed memory"}</span><small>{startCase(review.detectionReason)}</small></header>
            <div className={styles.reviewClaims}><ReviewMemoryClaim record={review.candidate} label="Proposed memory" />{review.existing ? <ReviewMemoryClaim record={review.existing} label="Current memory" /> : null}</div>
            {props.errors[review.id] ? <p className={styles.reviewError} role="alert"><CircleAlert size={15} />{props.errors[review.id]}</p> : null}
            <footer>
              <span className={styles.reviewProgress} role="status">{resolving ? "Applying decision…" : ""}</span>
              <button className={styles.primaryReviewAction} type="button" onClick={() => props.onResolve(review.id, "confirm_candidate")} disabled={Boolean(props.busy)} aria-describedby={props.busy ? "memory-review-busy" : undefined}><Check size={15} /> Use candidate</button>
              {review.existing ? <button type="button" onClick={() => props.onResolve(review.id, "keep_existing")} disabled={Boolean(props.busy)} aria-describedby={props.busy ? "memory-review-busy" : undefined}>Keep current</button> : <button type="button" onClick={() => props.onResolve(review.id, "keep_existing")} disabled={Boolean(props.busy)} aria-describedby={props.busy ? "memory-review-busy" : undefined}>Dismiss</button>}
              {review.existing ? <button type="button" onClick={() => props.onResolve(review.id, "keep_both")} disabled={Boolean(props.busy)} aria-describedby={props.busy ? "memory-review-busy" : undefined}>Keep both</button> : null}
            </footer>
          </article>;
        })}
        {props.loaded && !props.loading && !props.loadError && !pending.length ? <EmptyState icon={<ShieldCheck />} title="Memory review queue is clear" detail="Mnemosyne will place contradictions and inferred memory candidates here before they can affect recall." /> : null}
        {props.loading || (!props.loaded && !props.loadError) ? <LoadingRow /> : null}
      </div>
      {pending.length < props.total ? <button className={styles.loadMore} type="button" onClick={props.onMore} disabled={props.loading}>Load {Math.min(20, props.total - pending.length)} more reviews</button> : null}
    </section>
    <details className={styles.evaluationDetails}>
      <summary>Quality signals and semantic evaluation</summary>
      <p>Semantic evaluation collects human evidence. Its proposals and rank probes do not change live recall or activate semantic memory.</p>
      <MemoryQualityMetrics quality={props.quality} semanticShadow={props.semanticShadow} loading={props.overviewLoading} />
      <SemanticShadowCollector
        semanticShadow={props.semanticShadow}
        overviewLoading={props.overviewLoading}
        overviewError={props.overviewError}
        onProgressChanged={props.onSemanticShadowProgress}
      />
      <SemanticShadowReviewQueue onProgressChanged={props.onSemanticShadowProgress} />
    </details>
  </>;
}

function ReviewMemoryClaim(props: { record: MemoryRecord; label: string }) {
  const record = props.record;
  return <section>
    <p>{props.label}</p><strong>{record.title}</strong><span>{record.content}</span>
    <details className={styles.reviewProvenance}>
      <summary>Memory identity and source</summary>
      <dl>
        <div><dt>Memory identity</dt><dd><code>{record.id}</code></dd></div>
        <div><dt>Scope</dt><dd>{startCase(record.scope)}</dd></div>
        <div><dt>Source</dt><dd><code>{record.source}</code></dd></div>
        <div><dt>Evidence references</dt><dd>{record.evidenceRefs?.length ? <ul>{record.evidenceRefs.map((reference, index) => <li key={index}><code>{reference}</code></li>)}</ul> : "No evidence references were returned."}</dd></div>
      </dl>
    </details>
  </section>;
}

function CognitionReviewGroups(props: {
  groups: CognificationReviewGroup[];
}) {
  if (!props.groups.length) return null;
  return (
    <section className={styles.claimGroups} aria-labelledby="claim-groups-title">
      <header>
        <div>
          <p>Claim overlap</p>
          <h4 id="claim-groups-title">Review these statements together</h4>
        </div>
        <span>{props.groups.length} {props.groups.length === 1 ? "group" : "groups"}</span>
      </header>
      <div>
        {props.groups.map((group) => (
          <article key={group.id}>
            <header>
              <strong>{group.kind === "contradiction" ? "Likely contradiction" : "Possible duplicate"}</strong>
              <span>{Math.round(group.scoreBasisPoints / 100)}% overlap</span>
            </header>
            <ul>
              {group.references.map((reference) => (
                <li key={`${reference.batchId}:${reference.claimIndex}`}>
                  <i className={reference.status === "confirmed" ? styles.currentClaim : styles.proposedClaim}>
                    {reference.status === "confirmed" ? "Current" : "Proposed"}
                  </i>
                  <span>{reference.statement}</span>
                </li>
              ))}
            </ul>
            <small>This is a deterministic review hint, not a truth decision. Confirm or dismiss the related source maps below.</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function MemoryQualityMetrics(props: {
  quality?: MemoryIntelligenceOverview["quality"];
  semanticShadow?: MemoryIntelligenceOverview["semanticShadow"];
  loading: boolean;
}) {
  const quality = props.quality;
  const extraction = quality?.evidenceSupportedExtraction;
  const reviews = quality?.reviewAcceptance;
  const retrieval = quality?.retrievalUsefulness;
  const outcomes = quality?.retrievalOutcomeUtility;
  const graph = quality?.graphLag;
  const semanticShadow = props.semanticShadow;
  const unavailable = props.loading ? "Loading…" : "Unavailable";
  return (
    <section className={styles.qualityMetrics} aria-label="Memory quality signals">
      <article>
        <span>Evidence support</span>
        <strong>{extraction ? percentageOrPending(extraction.exactEvidenceCandidateItemRate) : unavailable}</strong>
        <small>{extraction ? `${extraction.exactEvidenceCandidateItemCount} of ${extraction.candidateItemSampleCount} extracted items` : props.loading ? "Loading extraction samples" : "Extraction samples are unavailable"}</small>
      </article>
      <article>
        <span>Review acceptance</span>
        <strong>{reviews ? percentageOrPending(reviews.acceptanceRate) : unavailable}</strong>
        <small>{reviews ? `${reviews.reviewedBatchSampleCount} reviewed source maps` : props.loading ? "Loading review samples" : "Review samples are unavailable"}</small>
      </article>
      <article>
        <span>Observed recall use</span>
        <strong>{retrieval ? percentageOrPending(retrieval.usedActiveDurableMemoryRate) : unavailable}</strong>
        <small>{retrieval ? `${retrieval.observedUseCount.toLocaleString()} uses · observational only` : props.loading ? "Loading recall samples" : "Recall samples are unavailable"}</small>
      </article>
      <article>
        <span>Rated context outcomes</span>
        <strong>{outcomes ? percentageOrPending(outcomes.usefulRate) : unavailable}</strong>
        <small>{outcomes ? `${outcomes.usefulCount} of ${outcomes.contextLinkedRatedRunCount} explicitly rated runs · shadow only, does not tune ranking` : props.loading ? "Loading rated outcomes" : "Rated outcomes are unavailable"}</small>
      </article>
      <article>
        <span>Graph freshness</span>
        <strong>{graph ? startCase(graph.status) : unavailable}</strong>
        <small>{graph ? graphLagLabel(graph.lagMs) : props.loading ? "Loading graph freshness" : "Graph freshness is unavailable"}</small>
      </article>
      <article>
        <span>Semantic shadow</span>
        <strong>{semanticShadow ? `${semanticShadow.currentEpisodeCount} / ${semanticShadow.minimumEpisodeTarget}` : unavailable}</strong>
        <small>{semanticShadow ? `${semanticShadow.distinctThreadCount} of ${semanticShadow.minimumThreadTarget} threads · evaluation only, does not affect answers` : props.loading ? "Loading shadow sample" : "Shadow sample is unavailable"}</small>
      </article>
    </section>
  );
}

function percentageOrPending(value: number | null | undefined) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "No sample";
}

function graphLagLabel(value: number | null | undefined) {
  if (typeof value !== "number") return "No completed graph build";
  if (value < 60_000) return "Updated less than a minute ago";
  if (value < 3_600_000) return `Updated ${Math.round(value / 60_000)}m ago`;
  if (value < 86_400_000) return `Updated ${Math.round(value / 3_600_000)}h ago`;
  return `Updated ${Math.round(value / 86_400_000)}d ago`;
}

function IndexHeading(props: { eyebrow: string; title: string; detail: string }) {
  return <header className={styles.indexHeading}>{props.eyebrow ? <p>{props.eyebrow}</p> : null}<h2>{props.title}</h2><span>{props.detail}</span></header>;
}

function CategoryRail<T extends string>(props: { active: T | "all"; onSelect: (value: T | "all") => void; items?: readonly { id: T; label: string; count: number }[] }) {
  const total = props.items?.reduce((sum, item) => sum + item.count, 0);
  return <div className={styles.categoryRail} role="group" aria-label="Filter by category">
    <button type="button" className={props.active === "all" ? styles.activeCategory : undefined} onClick={() => props.onSelect("all")} aria-pressed={props.active === "all"}>All{total !== undefined ? <small>{total.toLocaleString()}</small> : null}</button>
    {props.items?.map((item) => <button type="button" key={item.id} className={props.active === item.id ? styles.activeCategory : undefined} onClick={() => props.onSelect(item.id)} aria-pressed={props.active === item.id}>{item.label} <small>{item.count.toLocaleString()}</small></button>)}
  </div>;
}

function MnemosynePanel(props: {
  overview?: MemoryIntelligenceOverview;
  loading: boolean;
  consent?: ConsentStatus;
  busy?: string;
  cognitionFeedback?: string;
  cognitionJobs: CognificationJob[];
  onConsent: () => void;
  onScan: () => void;
  onCognify: () => void;
  onRecommendation: (item: MemoryStewardRecommendation) => void;
}) {
  const steward = props.overview?.steward;
  return <aside className={styles.steward} aria-labelledby="memory-steward-title">
    <header>
      <div><h2 id="memory-steward-title">Memory care</h2></div>
      <span className={steward?.state === "attention" ? styles.attention : steward?.state === "healthy" ? styles.healthy : undefined}>{steward ? startCase(steward.state) : props.loading ? "Loading…" : "Unavailable"}</span>
    </header>
    <p className={styles.autonomy}>{steward?.autonomy || (props.loading ? "Loading memory health and recommendations…" : "Memory health and recommendations are unavailable.")}</p>
    <div className={styles.healthScore}><span>Index health</span><strong>{steward ? `${steward.healthScore} / 100` : props.loading ? "Loading…" : "Unavailable"}</strong></div>
    <p className={styles.scoreHelp}>Based on indexing coverage, unresolved reviews and ownership.</p>
    <details className={styles.learning}>
      <summary>Learning signals</summary>
      <dl><div><dt>Recall uses</dt><dd>{steward?.learningSignals.retrievalUses.toLocaleString() ?? "Unavailable"}</dd></div><div><dt>Corrections learned</dt><dd>{steward?.learningSignals.corrections.toLocaleString() ?? "Unavailable"}</dd></div><div><dt>Reviews resolved</dt><dd>{steward?.learningSignals.resolvedReviews.toLocaleString() ?? "Unavailable"}</dd></div><div><dt>Forget receipts</dt><dd>{steward?.learningSignals.forgetRequests.toLocaleString() ?? "Unavailable"}</dd></div></dl>
    </details>
    <section className={styles.recallControl} aria-labelledby="personal-recall-title">
      <h3 id="personal-recall-title">Personal automatic recall</h3>
      {props.consent ? <>
        <p id="personal-recall-status">{props.consent.state === "active" ? "On · Available when selected in conversation" : "Off · Enable it to make personal recall available in conversation"}</p>
        <details className={styles.consentNotice}><summary>Recall notice</summary><p id="personal-recall-notice">{props.consent.notice.text}</p></details>
        <button type="button" onClick={props.onConsent} disabled={props.busy === "consent"} aria-pressed={props.consent.state === "active"} aria-describedby="personal-recall-status personal-recall-notice">
          {props.busy === "consent" ? "Updating recall…" : props.consent.state === "active" ? "Turn off personal recall" : "Enable personal recall"}
        </button>
      </> : <p>Recall settings are unavailable.</p>}
    </section>
    <section className={styles.cognifyControl}>
      <div className={styles.cognifyControlHeading}>
        <span><strong>Source maps</strong><small>Build quoted topics, claims and links from eligible knowledge.</small></span>
      </div>
      <button type="button" onClick={props.onCognify} disabled={Boolean(props.busy)}>
        {props.busy === "cognify-sources" ? <LoaderCircle size={15} className={styles.spin} /> : <GitBranch size={15} />}
        {props.busy === "cognify-sources" ? "Queueing sources…" : "Build or refresh maps"}
      </button>
      {props.cognitionJobs.length ? <CognitionJobSummary jobs={props.cognitionJobs} /> : null}
      <p aria-live="polite">{props.cognitionFeedback || "Resumes missing work. Each proposal stays outside recall until reviewed. Changing the model in Settings creates a separate review generation."}</p>
    </section>
    <section className={styles.recommendations}>
      <div className={styles.panelHeading}><h3>Recommendations</h3>{steward ? <span>{steward.recommendations.length}</span> : null}</div>
      {steward?.recommendations.length ? steward.recommendations.map((item) => <button type="button" key={item.id} onClick={() => props.onRecommendation(item)} disabled={item.action === "none" || Boolean(props.busy)}>
        <span><strong>{item.title}</strong><small>{startCase(item.priority)} priority · {item.detail}</small></span>{item.action !== "none" ? <ArrowRight size={15} aria-hidden="true" /> : null}
      </button>) : <p className={steward ? styles.allClear : styles.unavailable}>{steward ? <><Check size={16} aria-hidden="true" /> No action needed right now.</> : props.loading ? "Loading recommendations…" : "Recommendations are unavailable."}</p>}
    </section>
    <button type="button" className={styles.scanButton} onClick={props.onScan} disabled={props.busy === "maintenance"}>{props.busy === "maintenance" ? <LoaderCircle size={16} className={styles.spin} /> : <Sparkles size={16} />} Check memory health</button>
    <p className={styles.governance}><ShieldCheck size={16} aria-hidden="true" /> Suggestions need your review before they change what Asael remembers.</p>
  </aside>;
}

function useMemoryDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}

function MemoryInspector(props: { memory?: MemoryRecord; loading: boolean; busy?: string; error?: string; preview?: ForgetPreview; onClose: () => void; onLifecycle: (action: "pin" | "unpin" | "archive" | "restore") => void; onPreviewForget: () => void; onForget: () => void; onCancelForget: () => void }) {
  const dialogRef = useMemoryDialog();
  const roleContext = (() => { try { const result = csmRoleSnapshotSchema.safeParse(JSON.parse(props.memory?.content || "")); return result.success ? result.data : undefined; } catch { return undefined; } })();
  const visibleTags = props.memory?.tags.filter((tag) => !roleContext || tag !== "csm-role-context-v1") || [];
  const lifecycleHelp = props.memory?.archivedAt
    ? "Restore this memory before pinning it."
    : props.memory?.pinnedAt
      ? "Unpin this memory before archiving it."
      : undefined;
  return <dialog ref={dialogRef} className={styles.inspectorLayer} aria-labelledby="memory-details-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div className={styles.inspector}>
      <header><p id="memory-details-title">Memory details</p><button type="button" onClick={props.onClose} aria-label="Close memory details"><X size={18} /></button></header>
      {props.error ? <p className={styles.modalError} role="alert"><CircleAlert size={17} aria-hidden="true" />{props.error}</p> : null}
      {props.loading ? <div className={styles.inspectorLoading} role="status">Loading selected memory…</div> : props.memory ? <>
        <div className={styles.inspectorTitle}><span>{memoryLabel(props.memory.tier || props.memory.type)} · {props.memory.scope === "user" ? "Personal" : startCase(props.memory.scope)}</span><h2>{displayMemoryTitle(props.memory.title, props.memory.updatedAt)}</h2>{roleContext ? <><p>{roleContext.text.trim() || "No role notes saved yet. Add your responsibilities, working preferences and guidance in My CSM role."}</p><p>{roleContext.sourceLinks.length ? `${roleContext.sourceLinks.length} linked ${roleContext.sourceLinks.length === 1 ? "document" : "documents"}. Open My CSM role to view the saved sources.` : "No role documents linked yet."}</p><Link href="/app/projects?view=role">Open My CSM role <ArrowRight size={15} /></Link></> : <p>{props.memory.content}</p>}</div>
        <dl className={styles.memoryMetadata}>
          <div><dt>Confidence</dt><dd>{props.memory.confidence !== undefined ? `${Math.round(props.memory.confidence * 100)}%` : "Not recorded"}</dd></div>
          <div><dt>Importance</dt><dd>{Math.round(props.memory.importance * 100)}%</dd></div>
          <div><dt>Used</dt><dd>{props.memory.useCount !== undefined ? `${props.memory.useCount} times` : "Not recorded"}</dd></div>
          <div><dt>Updated</dt><dd>{relativeDate(props.memory.updatedAt)}</dd></div>
          <div><dt>Asserted by</dt><dd>{props.memory.assertedBy === "user" ? "You" : props.memory.assertedBy === "agent" ? "Assistant" : props.memory.assertedBy ? "Imported source" : "Not recorded"}</dd></div>
        </dl>
        {visibleTags.length ? <div className={styles.memoryTags} aria-label="Memory tags">{visibleTags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
        <div className={styles.lifecycle}>
          <button type="button" disabled={Boolean(props.busy) || Boolean(props.memory.archivedAt)} aria-describedby={lifecycleHelp ? "memory-lifecycle-help" : undefined} onClick={() => props.onLifecycle(props.memory?.pinnedAt ? "unpin" : "pin")}>{props.memory.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}{props.memory.pinnedAt ? "Unpin" : "Pin"}</button>
          <button type="button" disabled={Boolean(props.busy) || Boolean(props.memory.pinnedAt)} aria-describedby={lifecycleHelp ? "memory-lifecycle-help" : undefined} onClick={() => props.onLifecycle(props.memory?.archivedAt ? "restore" : "archive")}>{props.memory.archivedAt ? <RotateCcw size={15} /> : <Archive size={15} />}{props.memory.archivedAt ? "Restore" : "Archive"}</button>
        </div>
        {lifecycleHelp ? <p id="memory-lifecycle-help" className={styles.lifecycleHelp}>{lifecycleHelp}</p> : null}
        <details className={styles.technicalDetails}><summary>Source and technical details</summary><p>Original title: {props.memory.title}</p><p>Source: {props.memory.source || "Not recorded"}</p><p>Reference: {props.memory.id}</p>{roleContext ? <><p>Stored role record</p><pre>{props.memory.content}</pre><p>Stored tags: {props.memory.tags.join(", ")}</p></> : null}</details>
        {props.preview ? <section className={styles.forgetPreview} aria-labelledby="forget-impact-title">
          <h3 id="forget-impact-title"><CircleAlert size={16} aria-hidden="true" /> Delete this memory?</h3>
          <p>This permanently removes “{displayMemoryTitle(props.memory.title, props.memory.updatedAt)}” and {props.preview.impact.descendantMemoryCount} memories created from it. It also removes their map connections and recall history. This cannot be undone.</p>
          <p>{props.preview.guarantee === "rollback_proof_barrier" ? "A saved deletion record prevents these memories from returning after a restore." : "Deletion is best effort: older backups may still contain this memory."} Original files and messages are not deleted.</p>
          <details><summary>View deletion details</summary><p>{props.preview.impact.graphNodeCount} map items, {props.preview.impact.graphEdgeCount} connections and {props.preview.impact.retrievalTraceCount} recall records will be removed. A deletion receipt is retained.</p></details>
          <div><button type="button" onClick={props.onCancelForget}>Cancel</button><button type="button" onClick={props.onForget} disabled={props.busy === "forget"}>{props.busy === "forget" ? <LoaderCircle size={15} className={styles.spin} /> : <Trash2 size={15} />} Delete permanently</button></div>
        </section> : <button type="button" className={styles.forgetButton} onClick={props.onPreviewForget} disabled={Boolean(props.busy)}><Trash2 size={15} />{props.busy === "forget-preview" ? "Checking deletion…" : "Delete memory"}</button>}
      </> : <div className={styles.inspectorLoading}>{props.error ? "This memory could not be loaded." : "Loading selected memory…"}</div>}
    </div>
  </dialog>;
}

function CognitionJobSummary(props: { jobs: CognificationJob[] }) {
  const count = (statuses: CognificationJob["status"][]) =>
    props.jobs.filter((job) => statuses.includes(job.status)).length;
  const active = count(["queued", "running"]);
  const completed = count(["completed"]);
  const attention = count(["failed", "canceled"]);
  return <dl className={styles.cognifyJobSummary} aria-label="Source map processing progress">
    <div><dt>Active</dt><dd>{active}</dd></div>
    <div><dt>Ready</dt><dd>{completed}</dd></div>
    <div data-attention={attention ? "true" : undefined}><dt>Attention</dt><dd>{attention}</dd></div>
  </dl>;
}

function CreateMemoryDialog(props: { busy: boolean; error?: string; intent: CreateIntent; onClose: () => void; onCreate: (draft: { title: string; content: string; type: MemoryType; tier: MemoryTier; importance: number; confidence: number }) => Promise<void> }) {
  const dialogRef = useMemoryDialog();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [type, setType] = useState<MemoryType>("fact");
  const [confidence, setConfidence] = useState(.9);
  async function submit(event: FormEvent) { event.preventDefault(); const selected = memoryTypes.find((item) => item.id === type) || memoryTypes[0]; await props.onCreate({ title, content, type, tier: selected.tier, importance: .75, confidence }); }
  function applyRelationshipTemplate(template: "assignment" | "project") {
    setType("fact");
    if (!title.trim()) setTitle(template === "assignment" ? "Work assignment" : "Project relationship");
    setContent(template === "assignment"
      ? 'relation: assigned_to | work item: "Prepare launch brief" -> person: "Bennie"'
      : 'relation: belongs_to | work item: "Prepare launch brief" -> project: "Asael"');
  }
  return <dialog ref={dialogRef} className={styles.dialogLayer} aria-labelledby="new-memory-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <form className={styles.dialog} onSubmit={(event) => void submit(event)}>
      <header><div><p>{props.intent === "connected_fact" ? "Connected fact" : "Explicit memory"}</p><h2 id="new-memory-title">{props.intent === "connected_fact" ? "Add a connected fact" : "Add a memory"}</h2></div><button type="button" onClick={props.onClose} aria-label="Close new memory dialog"><X size={18} /></button></header>
      {props.error ? <p className={styles.modalError} role="alert"><CircleAlert size={17} aria-hidden="true" />{props.error}</p> : null}
      {props.intent === "connected_fact" ? <section className={styles.relationshipGuide}><div><GitBranch size={17} /><span><strong>Verified links require explicit wording</strong><small>This prevents names guessed by AI from becoming facts. Choose a template, then replace its example values.</small></span></div><p><button type="button" onClick={() => applyRelationshipTemplate("assignment")}>Work item → person</button><button type="button" onClick={() => applyRelationshipTemplate("project")}>Work item → project</button></p></section> : null}
      <label>Category<select value={type} onChange={(event) => setType(event.target.value as MemoryType)}>{memoryTypes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Short title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} required placeholder="e.g. Prefer meetings after 10 AM" /></label>
      <label>Details<textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={200000} required rows={7} placeholder={props.intent === "connected_fact" ? 'relation: assigned_to | work item: "…" -> person: "…"' : "Add the precise context that should be recalled…"} /></label>
      <label>Confidence <span>{Math.round(confidence * 100)}%</span><input type="range" min="0.5" max="1" step="0.05" value={confidence} onChange={(event) => setConfidence(Number(event.target.value))} /></label>
      <footer><p><ShieldCheck size={16} aria-hidden="true" /> You can read, archive or delete this later.</p><button type="submit" disabled={props.busy || !title.trim() || !content.trim()}>{props.busy ? <LoaderCircle size={16} className={styles.spin} /> : <Plus size={16} />}{props.busy ? "Saving memory…" : "Save memory"}</button></footer>
    </form>
  </dialog>;
}

function EmptyState(props: { icon: React.ReactNode; title: string; detail: string }) { return <div className={styles.empty}>{props.icon}<strong>{props.title}</strong><span>{props.detail}</span></div>; }
function LoadingRow() { return <div className={styles.loadingRow} role="status"><span aria-hidden="true" /> Updating index…</div>; }
function retiredMemoryPlaceholder(title: string) { return /^\s*\[retired\]/i.test(title); }
function displayMemoryTitle(title: string, updatedAt?: string) {
  const generated = /^Assistant inference from run\s+[a-f0-9]{8}(?:-[a-f0-9]{1,12}){0,4}(?:…|\.{3})?$/i.test(title.trim());
  if (!generated && !retiredMemoryPlaceholder(title)) return title;
  const date = updatedAt ? new Date(updatedAt) : undefined;
  const suffix = date && !Number.isNaN(date.getTime()) ? ` · ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}` : "";
  return `${generated ? "Assistant note" : "Retired memory"}${suffix}`;
}
function memoryLabel(value: string) { const labels: Record<string, string> = { all: "All kinds", semantic: "Facts", episodic: "Experiences", procedural: "How-to", preference: "Preferences", commitment: "Commitments", decision: "Decisions", summary: "Summaries", working: "Recent context", user: "Personal", candidate: "Needs review", contradicted: "Conflicting", superseded: "Replaced" }; return labels[value] || startCase(value); }
function startCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function relativeDate(value: string) { const milliseconds = Date.now() - new Date(value).getTime(); const days = Math.floor(milliseconds / 86_400_000); if (days < 1) return "Today"; if (days === 1) return "Yesterday"; if (days < 30) return `${days}d ago`; return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)); }
function formatBytes(characters: number) { const bytes = characters * 2; if (bytes < 1024) return `${bytes} B`; if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1_048_576).toFixed(1)} MB`; }
function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong."; }

function parseCognificationJob(value: unknown): CognificationJob | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const status = record.status;
  if (
    !id ||
    !["queued", "running", "completed", "failed", "canceled"].includes(
      String(status),
    )
  ) return undefined;
  return {
    id,
    status: status as CognificationJob["status"],
    progress: objectRecord(record.progress),
    result: objectRecord(record.result),
    lastError: typeof record.lastError === "string"
      ? record.lastError.trim().slice(0, 500)
      : undefined,
  };
}

function mergeCognificationJobs(
  current: CognificationJob[],
  updates: CognificationJob[],
) {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of updates) byId.set(job.id, job);
  return [...byId.values()];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
