"use client";

import {
  AudioLines,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  Download,
  FileStack,
  FileText,
  HardDrive,
  Loader2,
  NotebookPen,
  Paperclip,
  RefreshCw,
  ScanLine,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { ConnectedSources, type OAuthGrantItem, type OAuthProviderItem } from "@/components/capture/connected-sources";
import { LongRecordingStudio, type LongRecordingDraft } from "@/components/capture/long-recording-studio";
import { VisualStudio } from "@/components/capture/visual-studio";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { WorkspaceLibrary } from "@/components/workspace-library";
import {
  captureBatchRejectionMessage,
  captureSearchMatches,
  captureBatchTitle,
  mergeCaptureBatchFiles,
  runCaptureBatch,
} from "@/lib/capture/batch-client";
import { startVisibleRefresh } from "@/lib/client/visible-refresh";
import {
  claimLegacyOfflineCaptures,
  listOfflineCaptures,
  queueOfflineCapture,
  removeOfflineCapture,
  type OfflineCapture,
  type OfflineCaptureOwner,
} from "@/lib/capture/offline";
import { googleWorkspaceCapabilitiesForScopes } from "@/lib/connectors/google-workspace-capabilities";
import { workspaceOwnerScope } from "@/components/app-shell/workspace-owner-scope";
import styles from "./capture-workspace.module.css";

type DocumentItem = {
  id: string;
  title: string;
  source: string;
  sourceType: string;
  updatedAt: string;
  chunkCount: number;
  totalCharacters?: number;
};

type KnowledgeStats = { documents: number; chunks: number; characters: number; embedded: number };

type CaptureAsset = {
  id: string;
  filename: string;
  mediaType: string;
  extension: string;
  byteCount: number;
  storageKind: "database" | "filesystem";
  status: "stored" | "queued" | "indexed" | "unsupported" | "failed";
  extractionStatus: "pending" | "completed" | "partial" | "unsupported" | "failed";
  extractionReceipt?: {
    unitCount: number;
    locatorKinds: string[];
    warningCodes: string[];
  };
  ingestJobId?: string;
  error?: string;
  tags: string[];
  contentAvailable?: boolean;
  indexable?: boolean;
  manageable?: boolean;
  createdAt: string;
  updatedAt: string;
};

type CaptureJob = {
  id: string;
  type?: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: Record<string, unknown>;
  result?: Record<string, unknown>;
  attempt?: number;
  maxAttempts?: number;
  lastError?: string;
  updatedAt?: string;
};

type CaptureProcessingJob = CaptureJob & { assetId: string };

type CaptureMode = "note" | "record" | "upload";
type Notice = { tone: "success" | "warning" | "error"; text: string };
type CaptureSource = "knowledge" | "assets" | "oauth" | "capabilities";
type SourceReadState = { loaded: boolean; error?: string };
const captureSources: readonly CaptureSource[] = ["knowledge", "assets", "oauth", "capabilities"];
type CaptureBatchStatus =
  | "selected"
  | "uploading"
  | "queued"
  | "running"
  | "completed"
  | "offline"
  | "stored"
  | "failed";
type CaptureBatchItem = {
  id: string;
  file: File;
  status: CaptureBatchStatus;
  job?: CaptureJob;
  assetId?: string;
  error?: string;
};

export function CaptureWorkspace() {
  const { session, status } = useWorkspaceSession();
  const [mode, setMode] = useState<CaptureMode>("note");
  const [recordingDraft, setRecordingDraft] = useState<LongRecordingDraft>({
    title: "",
    tags: "",
    deleteRawAudioAfterProcessing: false,
  });
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [batchItems, setBatchItems] = useState<CaptureBatchItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<Notice>();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [assets, setAssets] = useState<CaptureAsset[]>([]);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>();
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderItem[]>([]);
  const [oauthGrants, setOAuthGrants] = useState<OAuthGrantItem[]>([]);
  const [oauthReadContract, setOauthReadContract] = useState<
    "exact_v1" | "readable_v1"
  >();
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [sourceReads, setSourceReads] = useState<Record<CaptureSource, SourceReadState>>({
    knowledge: { loaded: false },
    assets: { loaded: false },
    oauth: { loaded: false },
    capabilities: { loaded: false },
  });
  const [offlinePending, setOfflinePending] = useState(0);
  const [activeJob, setActiveJob] = useState<CaptureJob>();
  const [processingJobs, setProcessingJobs] = useState<CaptureProcessingJob[]>([]);
  const [imageGenerationRoute, setImageGenerationRoute] = useState<{ configured?: boolean; provider?: string; model?: string }>();
  const [videoGenerationRoute, setVideoGenerationRoute] = useState<{ configured?: boolean; provider?: string; model?: string }>();
  const [libraryQuery, setLibraryQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [deletingAsset, setDeletingAsset] = useState<string>();
  const [reindexingAssetIds, setReindexingAssetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const completedJobRef = useRef<string | undefined>(undefined);
  const workspaceLoadControllerRef = useRef<AbortController | null>(null);
  const captureBlocked = permissionMessage(session, status, "write.memory");
  const visualBlocked = permissionMessage(session, status, "run.agent");
  const offlineOwner = useMemo<OfflineCaptureOwner | undefined>(() => {
    const tenantId = session?.context?.tenantId;
    const actorId = session?.context?.actorId;
    return tenantId && actorId ? { tenantId, actorId } : undefined;
  }, [session?.context?.actorId, session?.context?.tenantId]);

  const loadWorkspace = useCallback(async () => {
    if (status !== "ready" || !session) return;
    workspaceLoadControllerRef.current?.abort();
    const controller = new AbortController();
    workspaceLoadControllerRef.current = controller;
    setLoadingWorkspace(true);
    setOauthReadContract(undefined);
    const results = await Promise.allSettled([
      fetch("/api/knowledge?limit=30", { cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Knowledge library could not be loaded.");
        const payload = await response.json() as { documents?: DocumentItem[]; stats?: KnowledgeStats };
        if (controller.signal.aborted) return;
        setDocuments(Array.isArray(payload.documents) ? payload.documents : []);
        setKnowledgeStats(payload.stats);
        setSourceReads((current) => ({ ...current, knowledge: { loaded: true } }));
      }),
      fetch("/api/capture?limit=100", { cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Original files could not be loaded.");
        const payload = await response.json() as { assets?: CaptureAsset[]; processingJobs?: CaptureProcessingJob[] };
        if (controller.signal.aborted) return;
        const nextJobs = Array.isArray(payload.processingJobs) ? payload.processingJobs : [];
        setAssets(Array.isArray(payload.assets) ? payload.assets : []);
        setProcessingJobs(nextJobs);
        setBatchItems((current) => mergeCaptureBatchJobs(current, nextJobs));
        setSourceReads((current) => ({ ...current, assets: { loaded: true } }));
      }),
      fetch("/api/oauth?ownerScope=readable", { cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Connected sources could not be loaded.");
        const payload = await response.json() as {
          providers?: OAuthProviderItem[];
          grants?: OAuthGrantItem[];
          requestReadContracts?: {
            oauthGrants?: "exact_v1" | "readable_v1";
          };
        };
        if (controller.signal.aborted) return;
        setOAuthProviders(Array.isArray(payload.providers) ? payload.providers : []);
        setOAuthGrants(Array.isArray(payload.grants) ? payload.grants : []);
        setOauthReadContract(payload.requestReadContracts?.oauthGrants);
        setSourceReads((current) => ({ ...current, oauth: { loaded: true } }));
      }),
      fetch("/api/capabilities?view=settings", { cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Media capabilities could not be loaded.");
        const payload = await response.json() as {
          imageGenerationRoute?: { configured?: boolean; provider?: string; model?: string };
          videoGenerationRoute?: { configured?: boolean; provider?: string; model?: string };
        };
        if (controller.signal.aborted) return;
        setImageGenerationRoute(payload.imageGenerationRoute);
        setVideoGenerationRoute(payload.videoGenerationRoute);
        setSourceReads((current) => ({ ...current, capabilities: { loaded: true } }));
      }),
    ]);
    if (controller.signal.aborted) return;
    setSourceReads((current) => {
      const next = { ...current };
      results.forEach((result, index) => {
        const source = captureSources[index];
        if (source && result.status === "rejected") {
          next[source] = {
            ...current[source],
            error: result.reason instanceof Error ? result.reason.message : "This source could not be loaded.",
          };
        }
      });
      return next;
    });
    setLoadingWorkspace(false);
  }, [session, status]);

  useEffect(() => {
    if (status !== "ready" || !session || !processingJobs.some((job) => ["queued", "running"].includes(job.status))) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/capture?limit=100", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Originals and processing could not be refreshed.");
        const payload = await response.json() as {
          assets?: CaptureAsset[];
          processingJobs?: CaptureProcessingJob[];
        };
        if (controller.signal.aborted) return;
        const nextJobs = Array.isArray(payload.processingJobs) ? payload.processingJobs : [];
        const activeIds = new Set(processingJobs.filter((job) => ["queued", "running"].includes(job.status)).map((job) => job.id));
        const finished = nextJobs.some((job) => activeIds.has(job.id) && ["completed", "failed", "canceled"].includes(job.status));
        setAssets(Array.isArray(payload.assets) ? payload.assets : []);
        setProcessingJobs(nextJobs);
        setBatchItems((current) => mergeCaptureBatchJobs(current, nextJobs));
        setSourceReads((current) => ({ ...current, assets: { loaded: true } }));
        if (finished) void loadWorkspace();
      } catch {
        // The queue is durable. The next poll or full refresh can recover.
        if (!controller.signal.aborted) {
          setSourceReads((current) => ({
            ...current,
            assets: { ...current.assets, error: "Originals and processing could not be refreshed." },
          }));
        }
      }
    }, 2_000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadWorkspace, processingJobs, session, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => {
      window.clearTimeout(timer);
      workspaceLoadControllerRef.current?.abort();
    };
  }, [loadWorkspace]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const sharedTitle = params.get("title")?.trim();
      const sharedText = [params.get("text"), params.get("url")].filter(Boolean).join("\n\n").trim();
      if (sharedTitle) setTitle((current) => current || sharedTitle);
      if (sharedText) setContent((current) => current || sharedText);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!offlineOwner) return;
    let active = true;
    const refreshCount = async () => {
      const captures = await listOfflineCaptures(offlineOwner).catch(() => []);
      if (active) setOfflinePending(captures.length);
    };
    const flush = () => {
      void flushOfflineCaptures(offlineOwner).then(refreshCount);
    };
    const initialize = async () => {
      await claimLegacyOfflineCaptures(
        offlineOwner,
        session?.account?.canClaimLegacyOfflineCaptures === true,
      ).catch(() => 0);
      if (!active) return;
      await refreshCount();
      if (navigator.onLine) flush();
    };
    void initialize();
    window.addEventListener("online", flush);
    return () => { active = false; window.removeEventListener("online", flush); };
  }, [offlineOwner, session?.account?.canClaimLegacyOfflineCaptures]);

  useEffect(() => {
    if (!activeJob || !["completed", "failed", "canceled"].includes(activeJob.status) || completedJobRef.current === activeJob.id) return;
    completedJobRef.current = activeJob.id;
    const frame = window.requestAnimationFrame(() => {
      if (activeJob.status === "completed") {
        setCaptureNotice({ tone: "success", text: "Capture indexed. It is now available as context in Command conversations." });
      } else {
        setCaptureNotice({ tone: "error", text: activeJob.lastError || "Indexing did not complete. The original file is still stored in your Capture library." });
      }
      void loadWorkspace();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeJob, loadWorkspace]);

  useEffect(() => {
    const durableIds = new Set(processingJobs.map((job) => job.id));
    const pending = batchItems.filter((item) =>
      item.job && ["queued", "running"].includes(item.status) && !durableIds.has(item.job.id)
    );
    const activeJobId = activeJob && ["queued", "running"].includes(activeJob.status)
      ? activeJob.id
      : undefined;
    const jobIds = [...new Set([
      ...(activeJobId ? [activeJobId] : []),
      ...pending.flatMap((item) => item.job ? [item.job.id] : []),
    ])];
    if (!jobIds.length) return;

    const controller = new AbortController();
    const stop = startVisibleRefresh({
      pollIntervalMs: 2_000,
      onRefresh: async () => {
        try {
          const response = await fetch(
            `/api/operations/jobs?ids=${jobIds.map(encodeURIComponent).join(",")}`,
            { cache: "no-store", signal: controller.signal },
          );
          const payload = (await response.json().catch(() => ({}))) as {
            jobs?: CaptureJob[];
          };
          if (!response.ok || controller.signal.aborted) return;
          const updates = new Map(
            (Array.isArray(payload.jobs) ? payload.jobs : []).map((job) => [
              job.id,
              job,
            ] as const),
          );
          if (!updates.size) return;

          if (activeJobId) {
            const nextActiveJob = updates.get(activeJobId);
            if (nextActiveJob) setActiveJob(nextActiveJob);
          }
          const completed = batchItems.some((item) =>
            item.status !== "completed" &&
            item.job &&
            updates.get(item.job.id)?.status === "completed"
          );
          setBatchItems((current) => current.map((item) => {
            const job = item.job ? updates.get(item.job.id) : undefined;
            if (!job) return item;
            const nextStatus = batchStatusFromJob(job);
            return {
              ...item,
              job,
              status: nextStatus,
              error: job.lastError || (job.status === "canceled" ? "Indexing was canceled." : undefined),
            };
          }));
          if (completed) void loadWorkspace();
        } catch {
          // The queued work remains durable; a later visible poll can recover.
        }
      },
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [activeJob, batchItems, loadWorkspace, processingJobs]);

  const filteredDocuments = useMemo(() => documents.filter((document) => {
    if (!captureSearchMatches(libraryQuery, [document.title, document.source])) return false;
    return sourceFilter === "all" || documentSource(document.source) === sourceFilter;
  }), [documents, libraryQuery, sourceFilter]);
  const filteredAssets = useMemo(() => assets.filter((asset) => {
    if (sourceFilter !== "all" && sourceFilter !== "capture") return false;
    return captureSearchMatches(libraryQuery, [
      asset.filename,
      asset.mediaType,
      asset.extension,
      asset.status,
      ...asset.tags,
    ]);
  }), [assets, libraryQuery, sourceFilter]);
  const activelyProcessingAssetIds = useMemo(() => new Set(
    processingJobs
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.assetId),
  ), [processingJobs]);
  const reindexableAssets = useMemo(() => filteredAssets
    .filter((asset) =>
      asset.manageable === true &&
      asset.indexable === true &&
      !activelyProcessingAssetIds.has(asset.id) &&
      !reindexingAssetIds.has(asset.id)
    )
    .slice(0, 50), [activelyProcessingAssetIds, filteredAssets, reindexingAssetIds]);

  const batchCounts = useMemo(() => summarizeBatch(batchItems), [batchItems]);
  const durableQueue = useMemo(() => {
    const assetById = new Map(assets.map((asset) => [asset.id, asset] as const));
    return processingJobs
      .map((job) => ({ job, asset: assetById.get(job.assetId) }))
      .filter((entry): entry is { job: CaptureProcessingJob; asset: CaptureAsset } => Boolean(entry.asset))
      .sort((left, right) => {
        const leftActive = ["queued", "running"].includes(left.job.status) ? 1 : 0;
        const rightActive = ["queued", "running"].includes(right.job.status) ? 1 : 0;
        return rightActive - leftActive || Date.parse(right.job.updatedAt || "") - Date.parse(left.job.updatedAt || "");
      })
      .slice(0, 8);
  }, [assets, processingJobs]);

  function chooseFiles(next: readonly File[]) {
    setCaptureNotice(undefined);
    if (!next.length) return;
    const merged = mergeCaptureBatchFiles(
      batchItems.map((item) => item.file),
      next,
    );
    setBatchItems((current) => [
      ...current,
      ...merged.accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        status: "selected" as const,
      })),
    ]);
    setMode("upload");
    const rejection = captureBatchRejectionMessage(merged.rejected);
    if (rejection) setCaptureNotice({ tone: "warning", text: rejection });
  }

  async function submitCapture(event: React.FormEvent) {
    event.preventDefault();
    if (captureBlocked) return setCaptureNotice({ tone: "error", text: captureBlocked });
    if (mode === "upload") {
      await submitCaptureBatch();
      return;
    }
    if (!content.trim()) return setCaptureNotice({ tone: "error", text: "Write a note to preserve." });
    setSubmitting(true);
    setCaptureNotice(undefined);
    if (!navigator.onLine) {
      await queueCurrentNote();
      setSubmitting(false);
      return;
    }
    const form = captureForm({ title: title.trim(), content: content.trim(), tags: tags.trim() });
    try {
      const response = await fetch("/api/capture", { method: "POST", body: form, headers: { "idempotency-key": crypto.randomUUID() } });
      const payload = (await response.json().catch(() => ({}))) as {
        job?: CaptureJob;
        asset?: CaptureAsset;
        capture?: { title?: string };
        ingestion?: { status?: string; reason?: string };
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Capture failed.");
      resetCaptureDraft();
      if (payload.job) {
        completedJobRef.current = undefined;
        setActiveJob(payload.job);
        setCaptureNotice({ tone: "success", text: `“${payload.capture?.title || payload.asset?.filename || "Capture"}” is stored. ${jobLabel(payload.job.status)}.` });
      } else if (payload.asset) {
        setCaptureNotice({ tone: "warning", text: `Original file stored, but it was not indexed${payload.ingestion?.reason ? `: ${payload.ingestion.reason}` : "."}` });
      }
      await loadWorkspace();
    } catch (submitError) {
      if (!navigator.onLine || submitError instanceof TypeError) await queueCurrentNote();
      else setCaptureNotice({ tone: "error", text: submitError instanceof Error ? submitError.message : "Capture failed." });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCaptureBatch() {
    const selected = batchItems.filter((item) => item.status === "selected");
    if (!selected.length) {
      setCaptureNotice({
        tone: "warning",
        text: batchItems.length
          ? "Add files or retry a failed item to start another upload."
          : "Choose one or more files to process.",
      });
      return;
    }
    setSubmitting(true);
    setCaptureNotice(undefined);
    const shared = { content: content.trim(), tags: tags.trim() };
    const singleTitle = selected.length === 1 ? title.trim() : "";
    try {
      const results = await runCaptureBatch(selected, async (item) => {
        setBatchItem(item.id, { status: "uploading", error: undefined });
        const capture = {
          ...shared,
          title: singleTitle || captureBatchTitle(item.file.name),
          file: item.file,
        };
        if (!navigator.onLine) {
          return queueBatchItemOffline(item, capture);
        }
        try {
          const response = await fetch("/api/capture", {
            method: "POST",
            body: captureForm(capture),
            headers: { "idempotency-key": `capture-batch-${item.id}` },
          });
          const payload = (await response.json().catch(() => ({}))) as {
            job?: CaptureJob;
            asset?: CaptureAsset;
            ingestion?: { reason?: string };
            error?: string;
          };
          if (!response.ok) throw new Error(payload.error || "This file could not be captured.");
          if (payload.job) {
            setBatchItem(item.id, {
              job: payload.job,
              assetId: payload.asset?.id,
              status: batchStatusFromJob(payload.job),
              error: undefined,
            });
            return "queued" as const;
          }
          setBatchItem(item.id, {
            assetId: payload.asset?.id,
            status: "stored",
            error: payload.ingestion?.reason || "The original was stored, but no searchable text was indexed.",
          });
          return "stored" as const;
        } catch (error) {
          if (!navigator.onLine || error instanceof TypeError) {
            return queueBatchItemOffline(item, capture);
          }
          setBatchItem(item.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "This file could not be captured.",
          });
          return "failed" as const;
        }
      });
      const accepted = results.filter((result) => result !== "failed").length;
      setCaptureNotice({
        tone: accepted ? "success" : "error",
        text: accepted
          ? `${accepted} file${accepted === 1 ? " is" : "s are"} stored or saved on this device. Review each file’s indexing and sync status below.`
          : "None of the selected files could be queued. Review the file-level errors and retry.",
      });
      await loadWorkspace();
      const pending = offlineOwner
        ? await listOfflineCaptures(offlineOwner).catch(() => [])
        : [];
      setOfflinePending(pending.length);
    } finally {
      setSubmitting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function queueBatchItemOffline(
    item: CaptureBatchItem,
    capture: Pick<OfflineCapture, "title" | "content" | "tags" | "file">,
  ) {
    try {
      if (!offlineOwner) throw new Error("Sign in again before saving offline work.");
      await queueOfflineCapture(offlineOwner, capture);
      setBatchItem(item.id, { status: "offline", error: undefined });
      return "offline" as const;
    } catch (error) {
      setBatchItem(item.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "This file could not be saved for offline upload.",
      });
      return "failed" as const;
    }
  }

  function setBatchItem(id: string, patch: Partial<CaptureBatchItem>) {
    setBatchItems((current) => current.map((item) =>
      item.id === id ? { ...item, ...patch } : item
    ));
  }

  function removeBatchItem(id: string) {
    setBatchItems((current) => current.filter((item) => item.id !== id));
  }

  function retryBatchItem(id: string) {
    setBatchItems((current) => current.map((item) => item.id === id
      ? { ...item, id: crypto.randomUUID(), status: "selected", job: undefined, error: undefined }
      : item
    ));
  }

  function clearFinishedBatchItems() {
    setBatchItems((current) => current.filter((item) =>
      !["completed", "offline", "stored", "failed"].includes(item.status)
    ));
  }

  async function queueCurrentNote() {
    if (!offlineOwner) throw new Error("Sign in again before saving offline work.");
    await queueOfflineCapture(offlineOwner, {
      title: title.trim(),
      content: content.trim(),
      tags: tags.trim(),
    });
    resetCaptureDraft();
    const pending = await listOfflineCaptures(offlineOwner);
    setOfflinePending(pending.length);
    setCaptureNotice({ tone: "success", text: "Saved privately on this device. Asael will store and index it when you are back online." });
  }

  function resetCaptureDraft() {
    setTitle("");
    setContent("");
    setTags("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function deleteAsset(id: string) {
    if (captureBlocked) {
      setCaptureNotice({ tone: "error", text: captureBlocked });
      return;
    }
    setDeletingAsset(id);
    try {
      const response = await fetch(`/api/capture/assets/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The file could not be deleted.");
      setCaptureNotice({ tone: "success", text: "Original file, indexed knowledge, and linked memory were removed." });
      await loadWorkspace();
    } catch (deleteError) {
      setCaptureNotice({ tone: "error", text: deleteError instanceof Error ? deleteError.message : "The file could not be deleted." });
    } finally {
      setDeletingAsset(undefined);
    }
  }

  async function reindexAssets(targets: readonly CaptureAsset[]) {
    if (captureBlocked) {
      setCaptureNotice({ tone: "error", text: captureBlocked });
      return;
    }
    const eligible = targets.filter((asset) =>
      asset.manageable === true &&
      asset.indexable === true &&
      !activelyProcessingAssetIds.has(asset.id) &&
      !reindexingAssetIds.has(asset.id)
    ).slice(0, 50);
    if (!eligible.length) {
      setCaptureNotice({ tone: "warning", text: "Every matching original is already queued or cannot be indexed." });
      return;
    }
    setCaptureNotice(undefined);
    setReindexingAssetIds((current) => new Set([
      ...current,
      ...eligible.map((asset) => asset.id),
    ]));
    try {
      const results = await runCaptureBatch(eligible, async (asset) => {
        try {
          const response = await fetch(
            `/api/capture/assets/${encodeURIComponent(asset.id)}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": `capture-reindex-${asset.id}-${crypto.randomUUID()}`,
              },
              body: "{}",
            },
          );
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!response.ok) {
            throw new Error(payload.error || `${asset.filename} could not be queued.`);
          }
          return { asset, queued: true as const };
        } catch (error) {
          return {
            asset,
            queued: false as const,
            error: error instanceof Error ? error.message : `${asset.filename} could not be queued.`,
          };
        }
      });
      const queued = results.filter((result) => result.queued).length;
      const failed = results.length - queued;
      setCaptureNotice({
        tone: failed ? "warning" : "success",
        text: failed
          ? `${queued} original${queued === 1 ? "" : "s"} queued; ${failed} need attention. The existing files were kept.`
          : `${queued} original${queued === 1 ? " is" : "s are"} queued for fresh extraction, RAG, memory, and graph links.`,
      });
      await loadWorkspace();
    } finally {
      setReindexingAssetIds((current) => {
        const next = new Set(current);
        for (const asset of eligible) next.delete(asset.id);
        return next;
      });
    }
  }

  const loadError = !loadingWorkspace && captureSources.some((source) => sourceReads[source].error)
    ? "Some Capture data could not be refreshed. Check the source status below, or refresh to retry. Your unsaved draft has not changed."
    : undefined;
  const activeSourceCount = sourceReads.oauth.loaded ? oauthGrants
    .filter((grant) => grant.provider === "google" && grant.status !== "revoked")
    .reduce((count, grant) => {
      const capabilities = googleWorkspaceCapabilitiesForScopes(grant.scopes);
      return count + Number(capabilities.has("gmail.read") || capabilities.has("gmail.send")) +
        Number(capabilities.has("calendar.events.read")) +
        Number(capabilities.has("drive.read")) +
        Number(capabilities.has("photos.pick"));
    }, 0) : undefined;
  const activeProcessingCount = processingJobs.filter((job) => ["queued", "running"].includes(job.status)).length;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1>Capture</h1>
          <p>Save a note or original file, then follow its indexing status.</p>
        </div>
        <button type="button" onClick={() => void loadWorkspace()} disabled={loadingWorkspace || status !== "ready"} className={styles.button}>
          <RefreshCw size={16} className={loadingWorkspace ? styles.spinner : undefined} aria-hidden="true" />
          {loadingWorkspace ? "Refreshing…" : "Refresh Capture"}
        </button>
      </header>
      <dl className={styles.summary} aria-label="Capture overview">
        <Metric value={knowledgeStats?.documents} label="Documents" read={sourceReads.knowledge} refreshing={loadingWorkspace} />
        <Metric value={knowledgeStats?.chunks} label="Indexed passages" read={sourceReads.knowledge} refreshing={loadingWorkspace} />
        <Metric value={activeSourceCount} label="Active sources" read={sourceReads.oauth} refreshing={loadingWorkspace} />
      </dl>

      {loadingWorkspace ? <p role="status" className={styles.readStatus}>Refreshing Capture data…</p> : null}
      {loadError ? <p role="alert" className={clsx(styles.notice, styles.warning)}><CircleAlert size={16} aria-hidden="true" /><span>{loadError}</span></p> : null}
      {offlinePending ? <p role="status" className={clsx(styles.notice, styles.warning)}><HardDrive size={16} aria-hidden="true" /><span>{offlinePending} offline capture{offlinePending === 1 ? "" : "s"} waiting to sync</span></p> : null}

      <section className={styles.intake} aria-labelledby="capture-composer-title">
        <form onSubmit={mode === "record" ? (event) => event.preventDefault() : submitCapture} className={styles.form}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 id="capture-composer-title">New capture</h2>
              <p>Choose how to add your source.</p>
            </div>
            <div className={styles.modeGroup} role="group" aria-label="Capture type">
              <ModeButton active={mode === "note"} onClick={() => setMode("note")} icon={NotebookPen} label="Note" />
              <ModeButton active={mode === "record"} onClick={() => setMode("record")} icon={AudioLines} label="Record" />
              <ModeButton active={mode === "upload"} onClick={() => setMode("upload")} icon={Upload} label="Upload" />
            </div>
          </div>

          {mode === "record" ? (
            <LongRecordingStudio draft={recordingDraft} onDraftChange={setRecordingDraft} disabledReason={captureBlocked} onJob={(job) => { completedJobRef.current = undefined; setActiveJob(job); }} onIndexed={loadWorkspace} />
          ) : (
            <div className={styles.editor}>
              {mode === "note" ? (
                <div className={styles.editorBody}>
                  <label htmlFor="capture-content" className={styles.fieldLabel}>Note</label>
                  <textarea
                    id="capture-content"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    disabled={submitting}
                    rows={7}
                    placeholder="Write a thought, paste meeting notes, or record a decision…"
                    aria-describedby="capture-note-help"
                    className={clsx(styles.input, styles.noteInput)}
                  />
                  <p id="capture-note-help" className={styles.supporting}>Pasted links are saved as note text. Your draft stays here until it is stored.</p>
                  <button type="button" onClick={() => inputRef.current?.click()} className={styles.button}><Paperclip size={16} aria-hidden="true" />Attach a file instead</button>
                </div>
              ) : (
                <div className={styles.editorBody}>
                  <div
                    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                    onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
                    onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFiles([...event.dataTransfer.files]); }}
                    className={clsx(styles.dropzone, dragging && styles.dragging)}
                  >
                    <FileStack size={24} aria-hidden="true" />
                    <p className={styles.itemTitle}>Drop files here</p>
                    <p className={styles.supporting}>Up to 50 files, 5 MiB each. PDF, DOCX, TXT, Markdown, SRT and VTT files are processed independently.</p>
                    <div className={styles.actions}>
                      <button type="button" onClick={() => inputRef.current?.click()} className={styles.primaryButton}><Paperclip size={16} aria-hidden="true" />Choose files</button>
                      <button type="button" onClick={() => cameraInputRef.current?.click()} className={styles.button}><ScanLine size={16} aria-hidden="true" />Scan with camera</button>
                    </div>
                  </div>
                  {batchItems.length ? (
                    <section className={styles.batch} aria-labelledby="capture-batch-title">
                      <div className={styles.listHeader}>
                        <div>
                          <h3 id="capture-batch-title">{batchItems.length} file{batchItems.length === 1 ? "" : "s"} in this batch</h3>
                          <p>{batchCounts.selected} ready · {batchCounts.processing} processing · {batchCounts.completed} indexed · {batchCounts.attention} need attention</p>
                        </div>
                        <div className={styles.actions}>
                          <button type="button" onClick={() => inputRef.current?.click()} className={styles.button}><Upload size={16} aria-hidden="true" />Add more</button>
                          {batchCounts.finished ? <button type="button" onClick={clearFinishedBatchItems} className={styles.button}>Clear finished</button> : null}
                        </div>
                      </div>
                      <p className={styles.supporting}>Removing a row only hides it from this batch. Stored files and queued jobs remain.</p>
                      <ul className={styles.batchList} aria-label="Document upload queue" aria-live="polite">
                        {batchItems.map((item) => (
                          <li key={item.id} className={styles.batchRow}>
                            <span className={clsx(styles.statusIcon, batchStatusTone(item.status))}>{batchStatusIcon(item.status)}</span>
                            <div className={styles.rowContent}>
                              <p className={styles.rowTitle}>{item.file.name}</p>
                              <p className={styles.supporting}>{formatBytes(item.file.size)} · {item.job ? captureJobStageLabel(item.job) : batchStatusLabel(item.status)}</p>
                              {item.error ? <p className={styles.errorText}>{item.error}</p> : null}
                            </div>
                            {item.status === "failed" ? (
                              <button type="button" onClick={() => retryBatchItem(item.id)} className={styles.iconButton} aria-label={`Retry ${item.file.name}`}><RefreshCw size={16} aria-hidden="true" /></button>
                            ) : ["selected", "completed", "offline", "stored"].includes(item.status) ? (
                              <button type="button" onClick={() => removeBatchItem(item.id)} className={styles.iconButton} aria-label={`Remove ${item.file.name} from batch`}><X size={16} aria-hidden="true" /></button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  <label className={styles.field}>
                    <span>Batch note <span className={styles.supporting}>(optional · added to every file)</span></span>
                    <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={20_000} rows={3} placeholder="Add context to help interpret these files." className={styles.input} />
                  </label>
                </div>
              )}

              <div className={styles.fields}>
                <label className={styles.field}>
                  <span>Title</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={mode === "upload" && batchItems.length > 1} maxLength={240} placeholder={mode === "upload" && batchItems.length > 1 ? "Each filename becomes its document title" : "Optional — created when blank"} className={styles.input} />
                  {mode === "upload" && batchItems.length > 1 ? <span className={styles.supporting}>Each file keeps its own title.</span> : null}
                </label>
                <label className={styles.field}>
                  <span>Tags {mode === "upload" ? <span className={styles.supporting}>(applied to the full batch)</span> : null}</span>
                  <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="project, meeting, decision" className={styles.input} />
                </label>
              </div>
              <div className={styles.submitRow}>
                <p className={styles.supporting}>The original is stored before background indexing begins.</p>
                <button type="submit" disabled={submitting || Boolean(captureBlocked)} aria-describedby={captureBlocked ? "capture-permission" : undefined} className={styles.primaryButton}>
                  {submitting ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
                  {submitting ? (mode === "upload" ? "Uploading batch…" : "Storing…") : mode === "upload" ? `Process ${batchCounts.selected} file${batchCounts.selected === 1 ? "" : "s"}` : "Store and index"}
                </button>
              </div>
            </div>
          )}

          <input ref={inputRef} data-testid="capture-file-input" type="file" multiple className={styles.hiddenInput} tabIndex={-1} aria-label="Choose files to capture" onChange={(event) => chooseFiles([...(event.target.files || [])])} />
          <input ref={cameraInputRef} type="file" className={styles.hiddenInput} tabIndex={-1} aria-label="Scan an image with the camera" accept="image/*" capture="environment" onChange={(event) => chooseFiles(event.target.files?.[0] ? [event.target.files[0]] : [])} />
          {captureBlocked ? <p id="capture-permission" className={styles.permission}>{captureBlocked}</p> : null}
          {captureNotice ? <p role={captureNotice.tone === "error" ? "alert" : "status"} className={clsx(styles.notice, captureNotice.tone === "error" ? styles.danger : captureNotice.tone === "warning" ? styles.warning : styles.success)}><span>{captureNotice.text}</span></p> : null}
        </form>

        <aside className={styles.processing} aria-labelledby="capture-processing-title">
          <div className={styles.sectionHeader}>
            <div><h2 id="capture-processing-title">Processing</h2><p>Stored originals are kept if indexing needs attention.</p></div>
          </div>
          <SourceReadStatus read={sourceReads.assets} loading={loadingWorkspace} label="Originals and processing" />
          {durableQueue.length ? (
            <section aria-labelledby="durable-capture-queue-title">
              <div className={styles.listHeader}>
                <div>
                  <h3 id="durable-capture-queue-title">Recent document jobs</h3>
                  <p>Up to 8 jobs shown. Queued work continues when you leave.</p>
                </div>
                <span className={styles.count}>{activeProcessingCount} active in the loaded queue</span>
              </div>
              <ol className={styles.jobList} aria-live="polite">
                {durableQueue.map(({ job, asset }) => (
                  <li key={job.id} className={styles.jobRow}>
                    <span className={clsx(styles.statusIcon, captureJobTone(job.status))}>{captureJobIcon(job.status)}</span>
                    <div className={styles.rowContent}>
                      <p className={styles.rowTitle}>{asset.filename}</p>
                      <p className={styles.supporting}>{captureJobStageLabel(job)}{job.attempt && job.status !== "completed" ? ` · attempt ${job.attempt}` : ""}</p>
                      {job.status === "failed" && job.lastError ? <p className={styles.errorText}>{job.lastError}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : sourceReads.assets.loaded ? <p className={styles.empty}>{sourceReads.assets.error ? "No jobs were present in the last loaded view." : "No recent processing jobs in this view."}</p> : null}
          {batchItems.length ? (
            <div className={styles.processingSummary} aria-live="polite">
              <h3>Current batch</h3>
              <p>{batchCounts.completed} indexed · {batchCounts.processing} processing · {batchCounts.selected} ready{batchCounts.offline ? ` · ${batchCounts.offline} waiting for connection` : ""}{batchCounts.attention ? ` · ${batchCounts.attention} need attention` : ""}</p>
              <progress className={styles.progress} max={Math.max(batchItems.length, 1)} value={batchCounts.finished} aria-label={`${batchCounts.finished} of ${batchItems.length} files finished`} />
            </div>
          ) : null}
          {activeJob ? (
            <div className={clsx(styles.processingSummary, captureJobTone(activeJob.status))} role="status">
              <h3>{captureJobIcon(activeJob.status)}{jobLabel(activeJob.status)}</h3>
              <p>{activeJob.lastError || jobDetail(activeJob)}</p>
            </div>
          ) : null}
          <ul className={styles.facts}>
            <StatusFact icon={Database} label={knowledgeStats?.embedded === undefined ? "Embedded passage count unavailable" : `${knowledgeStats.embedded} embedded passages${sourceReads.knowledge.error || loadingWorkspace ? " · last loaded" : ""}`} />
            <StatusFact icon={FileStack} label={sourceReads.assets.loaded ? `${assets.length} originals in this view${sourceReads.assets.error || loadingWorkspace ? " · last loaded" : ""}` : "Original count unavailable"} />
            <StatusFact icon={Clock3} label="Indexing runs in the background" />
          </ul>
          <SourceReadStatus read={sourceReads.knowledge} loading={loadingWorkspace} label="Knowledge index" />
        </aside>
      </section>

      <div className={styles.childSection}>
        <SourceReadStatus read={sourceReads.oauth} loading={loadingWorkspace} label="Connected sources" />
        <ConnectedSources
          providers={oauthProviders}
          grants={oauthGrants}
          requestReadContract={oauthReadContract}
          disabledReason={captureBlocked}
          loading={loadingWorkspace}
          onRefresh={loadWorkspace}
          onJob={(job) => { completedJobRef.current = undefined; setActiveJob(job); }}
        />
      </div>

      <div className={styles.childSection}>
        <VisualStudio
          assets={assets}
          assetsRead={sourceReads.assets}
          capabilitiesRead={sourceReads.capabilities}
          loading={loadingWorkspace}
          imageRoute={imageGenerationRoute}
          videoRoute={videoGenerationRoute}
          disabledReason={visualBlocked}
          saveDisabledReason={captureBlocked}
          onJob={(job) => { completedJobRef.current = undefined; setActiveJob(job); }}
          onAssetsChanged={loadWorkspace}
        />
      </div>

      <WorkspaceLibrary
        key={JSON.stringify([session?.user?.id, session?.context?.tenantId, session?.context?.actorId, session?.context?.role, status])}
        searchScope={status === "ready" ? workspaceOwnerScope(session, session?.context?.role ?? "viewer") || undefined : undefined}
        title="Everything in this workspace"
        description="Browse files, generated artifacts, images, recordings, transcripts, email, meetings, and connected sources in one versioned and cited view."
        limit={100}
        refreshKey={`${assets.length}:${knowledgeStats?.documents || 0}:${processingJobs[0]?.updatedAt || activeJob?.updatedAt || activeJob?.status || "idle"}`}
        className={styles.library}
      />

      <section className={styles.sourceControls} aria-labelledby="capture-library-title">
        <div className={styles.sectionHeader}>
          <div>
            <h2 id="capture-library-title">Originals and knowledge</h2>
            <p>Download, re-index, or delete a source here. Browse across source types in the Library above.</p>
          </div>
        </div>
        <div className={styles.toolbar}>
          <label className={styles.field}>
            <span>Search these sources</span>
            <span className={styles.searchField}><Search size={16} aria-hidden="true" /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Filename, title or source" className={styles.input} /></span>
          </label>
          <label className={styles.field}>
            <span>Source type</span>
            <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className={styles.input}><option value="all">All sources</option><option value="capture">Capture</option><option value="mail">Email</option><option value="drive">Drive</option><option value="calendar">Calendar</option><option value="photos">Photos</option></select>
          </label>
          <button
            type="button"
            onClick={() => void reindexAssets(reindexableAssets)}
            disabled={!reindexableAssets.length || Boolean(captureBlocked)}
            aria-describedby="capture-reindex-help"
            className={styles.button}
          >
            {reindexingAssetIds.size ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            {reindexingAssetIds.size ? `Queueing ${reindexingAssetIds.size}` : `Re-index ${reindexableAssets.length} shown`}
          </button>
        </div>
        <p id="capture-reindex-help" className={styles.supporting}>{captureBlocked || "Re-index up to 50 shown originals that you manage, support indexing, and have no active job in this view."}</p>

        <div className={styles.sourceLists}>
          <section className={styles.sourceList} aria-labelledby="capture-originals-title">
            <div className={styles.listHeader}>
              <div>
                <h3 id="capture-originals-title">Original files</h3>
                <p>Up to 100 originals. Actions follow stored ownership.</p>
              </div>
              {sourceReads.assets.loaded ? <span className={styles.count}>{filteredAssets.length}{filteredAssets.length !== assets.length ? ` / ${assets.length}` : ""}{sourceReads.assets.error || loadingWorkspace ? " · last loaded" : ""}</span> : null}
            </div>
            <SourceReadStatus read={sourceReads.assets} loading={loadingWorkspace} label="Original files" />
            <ul className={styles.assetList}>
              {filteredAssets.map((asset) => (
                <li key={asset.id} className={styles.assetRow}>
                  <div className={styles.rowContent}>
                    <h4 className={styles.itemTitle}>{asset.filename}</h4>
                    <p className={styles.supporting}>{formatBytes(asset.byteCount)} · {asset.storageKind} · Updated {formatTime(asset.updatedAt)}</p>
                    <p className={clsx(styles.assetStatus, asset.status === "failed" || asset.status === "unsupported" ? styles.warningText : asset.status === "indexed" ? styles.successText : undefined)}>{assetStatusLabel(asset, activelyProcessingAssetIds.has(asset.id))}</p>
                    {asset.error ? <p className={styles.errorText}>{asset.error}</p> : null}
                    {asset.manageable !== true ? <p className={styles.supporting}>Read only · indexing and management remain with its stored owner</p> : captureBlocked ? <p className={styles.supporting}>Read only in your current role</p> : null}
                    {asset.manageable === true && asset.indexable === true && activelyProcessingAssetIds.has(asset.id) ? <p className={styles.supporting}>Re-indexing is unavailable while this job is queued or running.</p> : null}
                  </div>
                  <div className={styles.assetActions}>
                    {asset.manageable === true && asset.indexable === true && !captureBlocked ? <button type="button" onClick={() => void reindexAssets([asset])} disabled={activelyProcessingAssetIds.has(asset.id) || reindexingAssetIds.has(asset.id)} className={styles.button} aria-label={`Re-index ${asset.filename}`}>{reindexingAssetIds.has(asset.id) ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}Re-index</button> : null}
                    {asset.contentAvailable === true ? <a href={`/api/capture/assets/${encodeURIComponent(asset.id)}?content=1&download=1`} className={styles.button} aria-label={`Download ${asset.filename}`}><Download size={16} aria-hidden="true" />Download</a> : null}
                    {asset.manageable === true && !captureBlocked ? <button type="button" onClick={() => void deleteAsset(asset.id)} disabled={deletingAsset === asset.id} className={styles.button} aria-label={`Delete ${asset.filename}`}>{deletingAsset === asset.id ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}{deletingAsset === asset.id ? "Deleting…" : "Delete"}</button> : null}
                  </div>
                </li>
              ))}
            </ul>
            {sourceReads.assets.loaded && !filteredAssets.length ? <p className={styles.empty}>{assets.length ? "No original files match this filter." : sourceReads.assets.error ? "The last loaded view contained no original files." : "Uploaded and generated originals will appear here."}</p> : null}
          </section>

          <section className={styles.sourceList} aria-labelledby="capture-knowledge-title">
            <div className={styles.listHeader}>
              <div><h3 id="capture-knowledge-title">Knowledge index</h3><p>Up to 30 documents in this source view.</p></div>
              {sourceReads.knowledge.loaded ? <span className={styles.count}>{filteredDocuments.length}{filteredDocuments.length !== documents.length ? ` / ${documents.length}` : ""}{sourceReads.knowledge.error || loadingWorkspace ? " · last loaded" : ""}</span> : null}
            </div>
            <SourceReadStatus read={sourceReads.knowledge} loading={loadingWorkspace} label="Knowledge index" />
            <ul className={styles.documentList}>
              {filteredDocuments.map((document) => (
                <li key={document.id} className={styles.documentRow}>
                  <h4 className={styles.itemTitle}>{document.title}</h4>
                  <p className={styles.supporting}>Updated {formatTime(document.updatedAt)}</p>
                  <dl className={styles.documentFacts}>
                    <div><dt>Source</dt><dd>{sourceLabel(document.source)} · {documentSource(document.source)}</dd></div>
                    <div><dt>Index</dt><dd>{document.chunkCount} passage{document.chunkCount === 1 ? "" : "s"}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
            {sourceReads.knowledge.loaded && !filteredDocuments.length ? <p className={styles.empty}>{documents.length ? "No documents match this filter." : sourceReads.knowledge.error ? "The last loaded view contained no indexed documents." : "Captured knowledge will appear here after indexing."}</p> : null}
          </section>
        </div>
      </section>
    </div>
  );
}

function Metric({ value, label, read, refreshing }: { value?: number; label: string; read: SourceReadState; refreshing: boolean }) {
  return (
    <div>
      <dt>{label}{read.loaded && (read.error || refreshing) ? " · last loaded" : ""}</dt>
      <dd>{read.loaded && value !== undefined ? value : !read.loaded && refreshing ? "Loading…" : "Unavailable"}</dd>
    </div>
  );
}

function ModeButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof NotebookPen; label: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={styles.modeButton}><Icon size={16} aria-hidden="true" />{label}</button>;
}

function SourceReadStatus({ read, loading, label }: { read: SourceReadState; loading: boolean; label: string }) {
  if (!read.error && read.loaded && !loading) return null;
  const text = loading
    ? read.loaded ? `${label}: refreshing the last loaded view…` : `${label}: loading…`
    : read.error
      ? `${label}: ${read.loaded ? "refresh failed; showing the last loaded view." : "unavailable."} ${read.error}`
      : `${label}: not loaded yet.`;
  return <p className={clsx(styles.readStatus, read.error && !loading && styles.warningText)}>{text}</p>;
}

function StatusFact({ icon: Icon, label }: { icon: typeof Database; label: string }) {
  return <li><Icon size={16} aria-hidden="true" /><span>{label}</span></li>;
}

function batchStatusFromJob(job: CaptureJob): CaptureBatchStatus {
  if (job.status === "completed") return "completed";
  if (job.status === "failed" || job.status === "canceled") return "failed";
  return job.status;
}

function summarizeBatch(items: readonly CaptureBatchItem[]) {
  const count = (status: CaptureBatchStatus) => items.filter((item) => item.status === status).length;
  const selected = count("selected");
  const uploading = count("uploading");
  const queued = count("queued");
  const running = count("running");
  const completed = count("completed");
  const offline = count("offline");
  const stored = count("stored");
  const failed = count("failed");
  return {
    selected,
    uploading,
    queued,
    running,
    completed,
    offline,
    attention: stored + failed,
    processing: uploading + queued + running,
    finished: completed + offline + stored + failed,
  };
}

function mergeCaptureBatchJobs(
  items: CaptureBatchItem[],
  jobs: readonly CaptureProcessingJob[],
) {
  if (!jobs.length || !items.some((item) => item.job)) return items;
  const byId = new Map(jobs.map((job) => [job.id, job] as const));
  let changed = false;
  const next = items.map((item) => {
    if (!item.job) return item;
    const job = byId.get(item.job.id);
    if (!job || (job.updatedAt === item.job.updatedAt && job.status === item.job.status)) return item;
    changed = true;
    return {
      ...item,
      job,
      status: batchStatusFromJob(job),
      error: job.lastError || (job.status === "canceled" ? "Processing was canceled." : undefined),
    };
  });
  return changed ? next : items;
}

function batchStatusLabel(status: CaptureBatchStatus) {
  if (status === "selected") return "Ready to upload";
  if (status === "uploading") return "Preserving original";
  if (status === "queued") return "Queued for RAG and memory";
  if (status === "running") return "Building RAG and memory";
  if (status === "completed") return "Indexed and ready in Command";
  if (status === "offline") return "Saved on this device; waiting to sync";
  if (status === "stored") return "Original stored; not indexed";
  return "Needs attention";
}

function batchStatusTone(status: CaptureBatchStatus) {
  if (status === "completed") return styles.success;
  if (status === "failed" || status === "stored") return styles.warning;
  return styles.neutral;
}

function batchStatusIcon(status: CaptureBatchStatus) {
  if (status === "completed") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (status === "failed" || status === "stored") return <CircleAlert size={16} aria-hidden="true" />;
  if (status === "offline") return <HardDrive size={16} aria-hidden="true" />;
  if (["uploading", "queued", "running"].includes(status)) return <Loader2 size={16} className={styles.spinner} aria-hidden="true" />;
  return <FileText size={16} aria-hidden="true" />;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
}

function jobLabel(status: CaptureJob["status"]) {
  if (status === "completed") return "Ready for Command";
  if (status === "failed") return "Indexing needs attention";
  if (status === "canceled") return "Indexing canceled";
  if (status === "running") return "Extracting and indexing";
  return "Waiting for indexer";
}

function jobDetail(job: CaptureJob) {
  if (job.status === "completed") return "Processing completed. Review the saved output and source details in Library.";
  if (job.status === "running") return `Background worker is processing this capture${job.attempt ? ` · attempt ${job.attempt}` : ""}.`;
  if (job.status === "queued") return "The original is safe. Processing will begin in the background.";
  return "The original remains safely stored.";
}

function captureJobStageLabel(job: CaptureJob) {
  if (job.status === "completed") {
    const chunks = Number(job.result?.chunkCount || 0);
    return chunks > 0
      ? `Indexed · ${chunks} cited passage${chunks === 1 ? "" : "s"}`
      : "Indexing completed";
  }
  if (job.status === "failed") return "Processing needs attention";
  if (job.status === "canceled") return "Processing canceled";
  const stage = typeof job.progress?.stage === "string" ? job.progress.stage : job.status === "running" ? "processing" : "queued";
  if (stage === "waiting") return "Waiting for private storage verification";
  if (stage === "reading") return "Opening the private original";
  if (stage === "extracting") return "Extracting transcript text and timecodes";
  if (stage === "chunking") return "Splitting into cited passages";
  if (stage === "embedding") return "Building semantic search";
  if (stage === "knowledge") return "Writing the RAG index";
  if (stage === "entities") return "Linking named entities";
  if (stage === "memory") return "Applying the memory policy";
  if (stage === "graph") return "Finalizing the searchable index";
  if (stage === "processing" || job.status === "running") return "Processing in the background";
  return "Queued for background processing";
}

function captureJobTone(status: CaptureJob["status"]) {
  if (status === "completed") return styles.success;
  if (status === "failed" || status === "canceled") return styles.danger;
  return styles.neutral;
}

function captureJobIcon(status: CaptureJob["status"]) {
  if (status === "completed") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "failed" || status === "canceled") return <CircleAlert size={14} aria-hidden="true" />;
  return <Loader2 size={14} className={styles.spinner} aria-hidden="true" />;
}

function assetStatusLabel(asset: CaptureAsset, activelyProcessing = false) {
  if (asset.status === "indexed") return "Indexed and searchable";
  if (asset.status === "queued") {
    return activelyProcessing
      ? "Stored · indexing queued or running"
      : "Stored · indexing status needs refresh";
  }
  if (asset.status === "unsupported") return "Stored · not indexed";
  if (asset.status === "failed") return "Stored · processing failed";
  if (asset.extractionStatus === "partial") return "Stored · partially extracted";
  return asset.extractionStatus === "pending" ? "Stored · waiting for extraction" : "Stored privately";
}

function documentSource(source: string) {
  if (source.startsWith("google:mail:")) return "mail";
  if (source.startsWith("google:drive:")) return "drive";
  if (source.startsWith("google:calendar:")) return "calendar";
  if (source.startsWith("google:photos:")) return "photos";
  return "capture";
}

function sourceLabel(source: string) {
  const category = documentSource(source);
  if (category === "mail") return "Google Email";
  if (category === "drive") return "Google Drive";
  if (category === "calendar") return "Google Calendar";
  if (category === "photos") return "Google Photos";
  if (source.startsWith("capture:recording:")) return "Recorded conversation";
  if (source.startsWith("capture:asset:")) return "Captured file";
  return source.replace(/^\w+:\/\//, "") || "Manual capture";
}

function captureForm(capture: Pick<OfflineCapture, "title" | "content" | "tags" | "file">) {
  const form = new FormData();
  form.set("title", capture.title);
  form.set("content", capture.content);
  form.set("tags", capture.tags);
  if (capture.file) form.set("file", capture.file);
  return form;
}

async function flushOfflineCaptures(owner: OfflineCaptureOwner) {
  if (!navigator.onLine) return;
  const captures = await listOfflineCaptures(owner);
  for (const capture of captures) {
    try {
      const response = await fetch("/api/capture", {
        method: "POST",
        body: captureForm(capture),
        headers: {
          "idempotency-key": capture.id,
          "x-omni-correlation-id": capture.id,
          "x-asael-capture-owner-sha256": capture.ownerSha256,
        },
      });
      if (!response.ok) break;
      await removeOfflineCapture(owner, capture.id);
    } catch {
      break;
    }
  }
}
