import type { MemoryIntelligenceOverview } from "@/lib/memory/intelligence";

export type SemanticShadowStats = NonNullable<MemoryIntelligenceOverview["semanticShadow"]>;
export type SemanticShadowJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type SemanticShadowJob = {
  id: string;
  status: SemanticShadowJobStatus;
  progress?: { stage?: string; outcome?: string; shadowOnly: true };
  failureCode?: string;
  threadId?: string;
};
export type SemanticEnqueueReceipt = {
  threadId: string;
  jobs: SemanticShadowJob[];
  status?: string;
  eligibleEpisodeCount?: number;
  issue?: string;
};

const jobStatuses = new Set(["queued", "running", "completed", "failed", "canceled"]);
const stages = new Set(["queued", "processing", "reading_episode", "generating_enrichment", "saving_enrichment", "completed", "pending"]);
const outcomes = new Set(["enriched", "already_current", "superseded"]);
const enrichmentStatuses = new Set(["queued", "up_to_date", "source_changed", "not_configured", "waiting_for_sealed_episode"]);
const countFields = ["eligibleEpisodeCount", "queuedJobCount", "upToDateCount", "staleEpisodeCount", "skippedEpisodeCount", "remainingEpisodeCount"];

export function isTerminalSemanticJob(job: SemanticShadowJob) {
  return job.status === "completed" || job.status === "failed" || job.status === "canceled";
}

export function validSemanticShadowStats(stats: SemanticShadowStats | undefined): stats is SemanticShadowStats {
  return Boolean(stats && safeCount(stats.currentEpisodeCount) && safeCount(stats.distinctThreadCount) &&
    safeCount(stats.minimumEpisodeTarget) && stats.minimumEpisodeTarget > 0 &&
    safeCount(stats.minimumThreadTarget) && stats.minimumThreadTarget > 0);
}

export function semanticShadowReadState(stats: SemanticShadowStats | undefined, loading: boolean, error?: string) {
  if (!validSemanticShadowStats(stats)) return loading ? "loading" : "unavailable";
  return error || loading ? "stale" : "ready";
}

export function semanticShadowBatchSize(stats: SemanticShadowStats | undefined) {
  if (!validSemanticShadowStats(stats)) return 0;
  const episodeGap = Math.max(0, stats.minimumEpisodeTarget - stats.currentEpisodeCount);
  const threadGap = Math.max(0, stats.minimumThreadTarget - stats.distinctThreadCount);
  return episodeGap || threadGap ? Math.min(24, Math.max(episodeGap, threadGap * 2, 1)) : 0;
}

export function parseSemanticShadowJob(value: unknown, threadId?: string): SemanticShadowJob | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.id) ||
    typeof value.status !== "string" || !jobStatuses.has(value.status)) return undefined;
  const progress = isRecord(value.progress) ? {
    ...(typeof value.progress.stage === "string" && stages.has(value.progress.stage) ? { stage: value.progress.stage } : {}),
    ...(typeof value.progress.outcome === "string" && outcomes.has(value.progress.outcome) ? { outcome: value.progress.outcome } : {}),
    shadowOnly: true as const,
  } : undefined;
  return {
    id: value.id,
    status: value.status as SemanticShadowJobStatus,
    ...(progress ? { progress } : {}),
    ...(value.status === "failed" && value.failureCode === "semantic_enrichment_failed" ? { failureCode: value.failureCode } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function parseReceiptJob(value: unknown, threadId?: string) {
  if (!isRecord(value) || value.type !== "conversation.summary.enrich" ||
    !isRecord(value.progress) || value.progress.shadowOnly !== true ||
    typeof value.progress.stage !== "string" || !stages.has(value.progress.stage) ||
    (value.progress.outcome !== undefined && (typeof value.progress.outcome !== "string" || !outcomes.has(value.progress.outcome)))) return undefined;
  return parseSemanticShadowJob(value, threadId);
}

export function mergeSemanticShadowJobs(current: readonly SemanticShadowJob[], updates: readonly SemanticShadowJob[], source: "poll" | "enqueue" = "poll") {
  const merged = new Map(current.map((job) => [job.id, job]));
  for (const update of updates) {
    const previous = merged.get(update.id);
    // Only a fresh explicit enqueue may reopen a coalesced terminal job ID.
    if (source === "poll" && previous && isTerminalSemanticJob(previous)) continue;
    merged.set(update.id, { ...update, ...(update.threadId || !previous?.threadId ? {} : { threadId: previous.threadId }) });
  }
  return [...merged.values()];
}

export function parseSemanticEnqueueReceipt(value: unknown, threadId: string): SemanticEnqueueReceipt {
  if (!isRecord(value)) return { threadId, jobs: [], issue: "The collection response could not be verified. A request may have reached the server." };
  const enrichment = isRecord(value.semanticEnrichment) ? value.semanticEnrichment : {};
  const status = typeof enrichment.status === "string" && enrichmentStatuses.has(enrichment.status) ? enrichment.status : undefined;
  // This exact request submits limit:1. Never choose between conflicting or excess rows.
  const jobs = Array.isArray(value.jobs) && value.jobs.length <= 1 ? value.jobs.flatMap((row) => {
    const job = parseReceiptJob(row, threadId);
    return job ? [job] : [];
  }) : [];
  const queuedCount = jobs.filter((job) => !isTerminalSemanticJob(job)).length;
  const consistentStatus = status === "queued" ? queuedCount > 0 : queuedCount === 0;
  const valid = value.deterministicSummariesActive === true && enrichment.shadowOnly === true && status &&
    countFields.every((field) => safeCount(value[field])) && Array.isArray(value.jobs) &&
    jobs.length === value.jobs.length && value.queuedJobCount === queuedCount && consistentStatus &&
    (!(status === "not_configured" || status === "waiting_for_sealed_episode") || !jobs.length);
  return {
    threadId,
    jobs,
    ...(status ? { status } : {}),
    ...(safeCount(value.eligibleEpisodeCount) ? { eligibleEpisodeCount: value.eligibleEpisodeCount as number } : {}),
    ...(!valid ? { issue: "Part of the collection response could not be verified. Confirmed job receipts are retained; other work is unconfirmed." } : {}),
  };
}

export function parseSemanticPoll(value: unknown, requestedIds: readonly string[]) {
  const requested = new Set(requestedIds);
  if (!isRecord(value) || !Array.isArray(value.jobs)) return { jobs: [] as SemanticShadowJob[], unconfirmedIds: [...requested], unexpected: true };
  const counts = new Map<string, number>();
  for (const row of value.jobs) {
    if (isRecord(row) && typeof row.id === "string") counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  const jobs = value.jobs.flatMap((row) => {
    const job = parseReceiptJob(row);
    return job && requested.has(job.id) && counts.get(job.id) === 1 ? [job] : [];
  });
  const confirmed = new Set(jobs.map((job) => job.id));
  return {
    jobs,
    unconfirmedIds: [...requested].filter((id) => !confirmed.has(id)),
    unexpected: value.jobs.some((row) => !isRecord(row) || typeof row.id !== "string" || !requested.has(row.id)),
  };
}

export function parseSemanticThreadIds(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.threads) || value.threads.some((thread) =>
    !isRecord(thread) || typeof thread.id !== "string" || !thread.id.trim())) return undefined;
  return [...new Set(value.threads.map((thread) => (thread as { id: string }).id))].slice(0, 48);
}

export function createSemanticCollectionGate() {
  let mounted = false;
  let generation = 0;
  let active: number | undefined;
  return {
    mount() { mounted = true; },
    dispose() { mounted = false; generation += 1; active = undefined; },
    isMounted() { return mounted; },
    begin() {
      if (!mounted || active !== undefined) return undefined;
      active = ++generation;
      return active;
    },
    isCurrent(token: number) { return mounted && active === token; },
    finish(token: number) { if (active === token) active = undefined; },
  };
}

export function createSemanticPollGate() {
  let revision = 0;
  return {
    begin() {
      const current = ++revision;
      return () => revision === current;
    },
    invalidate() { revision += 1; },
  };
}

export async function collectSemanticShadowBatch(options: {
  threadIds: readonly string[];
  batchSize: number;
  isCurrent: () => boolean;
  canContinue: () => boolean;
  enqueue: (threadId: string) => Promise<SemanticEnqueueReceipt>;
  onBatch: (receipts: SemanticEnqueueReceipt[]) => void;
}) {
  const threadIds = [...new Set(options.threadIds)].slice(0, 48);
  const target = Math.max(0, Math.min(24, Math.floor(options.batchSize)));
  const jobs = new Set<string>();
  const receipts: SemanticEnqueueReceipt[] = [];
  let inspected = 0;
  while (inspected < threadIds.length && jobs.size < target) {
    if (!options.isCurrent() || !options.canContinue()) break;
    const candidates = threadIds.slice(inspected, inspected + Math.min(4, target - jobs.size));
    const batch = await Promise.all(candidates.map(async (threadId) => {
      try { return await options.enqueue(threadId); }
      catch { return { threadId, jobs: [], issue: "The request outcome could not be confirmed. It may have reached the server." } satisfies SemanticEnqueueReceipt; }
    }));
    if (!options.isCurrent()) break;
    inspected += candidates.length;
    receipts.push(...batch);
    batch.forEach((receipt) => receipt.jobs.forEach((job) => jobs.add(job.id)));
    options.onBatch(batch);
    if (batch.some((receipt) => receipt.issue || receipt.status === "not_configured")) break;
  }
  return { receipts, inspected, jobCount: jobs.size, stopped: inspected < threadIds.length && jobs.size < target };
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
