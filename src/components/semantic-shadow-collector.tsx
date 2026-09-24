"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FlaskConical,
  LoaderCircle,
  Play,
  TriangleAlert,
} from "lucide-react";
import { startVisibleRefresh } from "@/lib/client/visible-refresh";
import type { MemoryIntelligenceOverview } from "@/lib/memory/intelligence";
import styles from "@/components/memory-intelligence-workspace.module.css";

type SemanticShadowStats = NonNullable<
  MemoryIntelligenceOverview["semanticShadow"]
>;
type SemanticShadowJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type SemanticShadowJob = {
  id: string;
  status: SemanticShadowJobStatus;
  progress?: {
    stage?: string;
    outcome?: string;
    shadowOnly: true;
  };
  failureCode?: string;
  threadId?: string;
};

const terminalJobStatuses = new Set<SemanticShadowJobStatus>([
  "completed",
  "failed",
  "canceled",
]);
const jobStatuses = new Set<SemanticShadowJobStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);
const maximumThreadsPerCollection = 48;
const collectionConcurrency = 4;

export function semanticShadowBatchSize(
  stats: SemanticShadowStats | undefined,
) {
  if (!stats) return 0;
  const episodeGap = Math.max(
    0,
    stats.minimumEpisodeTarget - stats.currentEpisodeCount,
  );
  const threadGap = Math.max(
    0,
    stats.minimumThreadTarget - stats.distinctThreadCount,
  );
  if (!episodeGap && !threadGap) return 0;
  return Math.min(24, Math.max(episodeGap, threadGap * 2, 1));
}

export function parseSemanticShadowJob(
  value: unknown,
  threadId?: string,
): SemanticShadowJob | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const status = typeof value.status === "string" &&
      jobStatuses.has(value.status as SemanticShadowJobStatus)
    ? value.status as SemanticShadowJobStatus
    : undefined;
  if (!id || !status) return undefined;
  const progress = isRecord(value.progress)
    ? {
        ...(typeof value.progress.stage === "string"
          ? { stage: value.progress.stage }
          : {}),
        ...(typeof value.progress.outcome === "string"
          ? { outcome: value.progress.outcome }
          : {}),
        shadowOnly: true as const,
      }
    : undefined;
  return {
    id,
    status,
    ...(progress ? { progress } : {}),
    ...(typeof value.failureCode === "string"
      ? { failureCode: value.failureCode }
      : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function mergeSemanticShadowJobs(
  current: readonly SemanticShadowJob[],
  updates: readonly SemanticShadowJob[],
) {
  const merged = new Map(current.map((job) => [job.id, job]));
  for (const update of updates) {
    const previous = merged.get(update.id);
    merged.set(update.id, {
      ...previous,
      ...update,
      ...(update.threadId || !previous?.threadId
        ? {}
        : { threadId: previous.threadId }),
    });
  }
  return [...merged.values()];
}

export function SemanticShadowCollector(props: {
  semanticShadow?: MemoryIntelligenceOverview["semanticShadow"];
  onProgressChanged: () => Promise<void>;
}) {
  const { semanticShadow, onProgressChanged } = props;
  const [collecting, setCollecting] = useState(false);
  const [jobs, setJobs] = useState<SemanticShadowJob[]>([]);
  const [feedback, setFeedback] = useState<string>();
  const completionSignatureRef = useRef("");
  const batchSize = semanticShadowBatchSize(semanticShadow);
  const activeJobs = jobs.filter((job) => !terminalJobStatuses.has(job.status));
  const completedJobs = jobs.filter((job) => job.status === "completed");
  const failedJobs = jobs.filter((job) =>
    job.status === "failed" || job.status === "canceled"
  );
  const activeSignature = activeJobs
    .map((job) => job.id)
    .sort()
    .join("|");
  const collectionProgress = semanticShadow
    ? Math.min(
        100,
        Math.round(
          semanticShadow.currentEpisodeCount /
            semanticShadow.minimumEpisodeTarget * 100,
        ),
      )
    : 0;
  const progressLabel = useMemo(() => {
    if (activeJobs.length) {
      const stage = activeJobs[0]?.progress?.stage;
      return `${activeJobs.length} active${stage ? ` · ${startCase(stage)}` : ""}`;
    }
    if (failedJobs.length) return `${failedJobs.length} need attention`;
    if (completedJobs.length) return `${completedJobs.length} complete`;
    return "Ready";
  }, [activeJobs, completedJobs.length, failedJobs.length]);

  useEffect(() => {
    if (!activeSignature) return;
    const activeIds = activeSignature.split("|");
    return startVisibleRefresh({
      refreshOnStart: true,
      pollIntervalMs: 2_500,
      onRefresh: async () => {
        const updates = await fetch(
          `/api/operations/jobs?ids=${activeIds.map(encodeURIComponent).join(",")}`,
          { cache: "no-store" },
        ).then(async (response) => {
          const body = await response.json().catch(() => ({})) as {
            jobs?: unknown[];
          };
          return response.ok && Array.isArray(body.jobs)
            ? body.jobs.map((job) => parseSemanticShadowJob(job))
            : [];
        }).catch(() => []);
        const validUpdates: SemanticShadowJob[] = [];
        for (const job of updates) {
          if (job) validUpdates.push(job);
        }
        if (validUpdates.length) {
          setJobs((current) =>
            mergeSemanticShadowJobs(current, validUpdates)
          );
        }
      },
    });
  }, [activeSignature]);

  useEffect(() => {
    if (!jobs.length || activeJobs.length || collecting) return;
    const signature = jobs
      .map((job) => `${job.id}:${job.status}`)
      .sort()
      .join("|");
    if (completionSignatureRef.current === signature) return;
    completionSignatureRef.current = signature;
    const summary = failedJobs.length
      ? `${completedJobs.length} shadow episodes completed; ${failedJobs.length} need attention. Safe retries cannot change active memory.`
      : `${completedJobs.length} shadow episodes completed. Human adjudication is still required before activation can be considered.`;
    const timer = window.setTimeout(() => {
      setFeedback(summary);
      void onProgressChanged();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    activeJobs.length,
    collecting,
    completedJobs.length,
    failedJobs.length,
    jobs,
    onProgressChanged,
  ]);

  async function collectNextBatch() {
    if (!batchSize || collecting) return;
    setCollecting(true);
    setFeedback("Checking recent conversations for sealed 12-turn episodes…");
    try {
      const threadResponse = await fetch("/api/threads?limit=100", {
        cache: "no-store",
      });
      const threadBody = await threadResponse.json().catch(() => ({}));
      if (!threadResponse.ok) {
        throw new Error(errorMessage(threadBody, "Conversations could not be checked."));
      }
      const threadIds = parseThreadIds(threadBody).slice(
        0,
        maximumThreadsPerCollection,
      );
      if (!threadIds.length) {
        setFeedback("No conversations are available for a shadow sample yet.");
        return;
      }

      let inspectedCount = 0;
      let eligibleEpisodeCount = 0;
      let unavailableMessage = "";
      const collectedJobs: SemanticShadowJob[] = [];
      const collectedJobIds = new Set<string>();

      for (
        let index = 0;
        index < threadIds.length && collectedJobs.length < batchSize;
        index += collectionConcurrency
      ) {
        const remaining = batchSize - collectedJobs.length;
        const candidates = threadIds.slice(
          index,
          index + Math.min(collectionConcurrency, remaining),
        );
        const responses = await Promise.all(candidates.map(enqueueThread));
        inspectedCount += candidates.length;
        for (const result of responses) {
          if (!result) continue;
          eligibleEpisodeCount += result.eligibleEpisodeCount;
          if (result.unavailableMessage) {
            unavailableMessage = result.unavailableMessage;
          }
          for (const job of result.jobs) {
            if (collectedJobIds.has(job.id)) continue;
            collectedJobIds.add(job.id);
            collectedJobs.push(job);
          }
        }
        if (unavailableMessage) break;
      }

      if (collectedJobs.length) {
        completionSignatureRef.current = "";
        setJobs((current) =>
          mergeSemanticShadowJobs(current, collectedJobs)
        );
        const distinctThreads = new Set(
          collectedJobs.map((job) => job.threadId).filter(Boolean),
        ).size;
        setFeedback(
          `Queued ${collectedJobs.length} evaluation-only ${collectedJobs.length === 1 ? "episode" : "episodes"} across ${distinctThreads} ${distinctThreads === 1 ? "conversation" : "conversations"}. They cannot affect answers or active memory.`,
        );
      } else if (unavailableMessage) {
        setFeedback(unavailableMessage);
      } else if (eligibleEpisodeCount) {
        setFeedback(
          `Checked ${inspectedCount} conversations. Their eligible episodes are already current or safely queued.`,
        );
        await onProgressChanged();
      } else {
        setFeedback(
          `Checked ${inspectedCount} recent conversations. None has a complete new 12-turn episode yet.`,
        );
      }
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "The shadow sample could not be queued.",
      );
    } finally {
      setCollecting(false);
    }
  }

  return (
    <section className={styles.semanticLab} aria-labelledby="semantic-shadow-lab-title">
      <header className={styles.semanticLabHeading}>
        <div className={styles.semanticLabIcon}><FlaskConical size={19} /></div>
        <div>
          <p>Evaluation lane</p>
          <h3 id="semantic-shadow-lab-title">Semantic shadow lab</h3>
          <span>
            Collect representative episode enrichments before a human judges
            evidence, recall, compression and replay quality.
          </span>
        </div>
        <span className={styles.semanticLabState} data-active={activeJobs.length > 0}>
          {activeJobs.length ? <LoaderCircle size={13} className={styles.spin} /> : <FlaskConical size={13} />}
          {progressLabel}
        </span>
      </header>
      <div className={styles.semanticLabBody}>
        <div className={styles.semanticLabProgress}>
          <div>
            <span><strong>{semanticShadow?.currentEpisodeCount ?? "—"}</strong> / {semanticShadow?.minimumEpisodeTarget ?? 24}<small>collected episodes</small></span>
            <span><strong>{semanticShadow?.distinctThreadCount ?? "—"}</strong> / {semanticShadow?.minimumThreadTarget ?? 6}<small>distinct conversations</small></span>
          </div>
          <progress value={collectionProgress} max={100} aria-label="Semantic shadow episode collection progress" />
        </div>
        <div className={styles.semanticLabAction}>
          <div>
            <strong>{batchSize ? "Step 1 · Collect the next bounded batch" : "Collection target reached"}</strong>
            <span>
              Uses the Memory model selected in Settings. Collection is
              shadow-only; it does not change ranking, answers or durable truth.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void collectNextBatch()}
            disabled={collecting || !batchSize}
          >
            {collecting ? <LoaderCircle size={15} className={styles.spin} /> : batchSize ? <Play size={15} /> : <CheckCircle2 size={15} />}
            {collecting ? "Checking conversations" : batchSize ? `Collect up to ${batchSize}` : "Target collected"}
          </button>
        </div>
        {jobs.length ? (
          <dl className={styles.semanticLabJobs}>
            <div><dt>Active</dt><dd>{activeJobs.length}</dd></div>
            <div><dt>Complete</dt><dd>{completedJobs.length}</dd></div>
            <div data-attention={failedJobs.length > 0}><dt>Attention</dt><dd>{failedJobs.length}</dd></div>
          </dl>
        ) : null}
        <p className={styles.semanticLabBoundary} aria-live="polite">
          {failedJobs.length ? <TriangleAlert size={15} /> : <FlaskConical size={15} />}
          {feedback || "After collection, human-reviewed cases across all ten scenario dimensions are still required. Passing the gate never activates memory automatically."}
        </p>
      </div>
    </section>
  );
}

async function enqueueThread(threadId: string) {
  try {
    const response = await fetch(
      `/api/threads/${encodeURIComponent(threadId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "enqueue_semantic_summaries",
          limit: 1,
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        jobs: [],
        eligibleEpisodeCount: 0,
        unavailableMessage: errorMessage(
          body,
          "The semantic shadow sample could not be queued.",
        ),
      };
    }
    const record = isRecord(body) ? body : {};
    const enrichment = isRecord(record.semanticEnrichment)
      ? record.semanticEnrichment
      : {};
    const status = typeof enrichment.status === "string"
      ? enrichment.status
      : "";
    const jobs = Array.isArray(record.jobs)
      ? record.jobs
          .map((job) => parseSemanticShadowJob(job, threadId))
          .filter((job): job is SemanticShadowJob => Boolean(job))
      : [];
    return {
      jobs,
      eligibleEpisodeCount: safeCount(record.eligibleEpisodeCount),
      unavailableMessage: status === "not_configured"
        ? errorMessage(
            record,
            "Choose a Memory model in Settings before collecting semantic shadow samples.",
          )
        : "",
    };
  } catch {
    return undefined;
  }
}

function parseThreadIds(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.threads)) return [];
  return value.threads.flatMap((thread) => {
    if (!isRecord(thread) || typeof thread.id !== "string") return [];
    const id = thread.id.trim();
    return id ? [id] : [];
  });
}

function errorMessage(value: unknown, fallback: string) {
  return isRecord(value) && typeof value.message === "string"
    ? value.message
    : isRecord(value) && typeof value.error === "string"
      ? value.error
      : fallback;
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function startCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (match) =>
    match.toUpperCase()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
