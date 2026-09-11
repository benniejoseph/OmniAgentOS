import type { KnowledgeCognitionRecord } from "@/lib/knowledge/cognification-store";
import type {
  CognificationCandidateBatchV1,
  CognificationEvidenceBindingV1,
} from "@/lib/knowledge/cognification-contract";
import type { MemoryCatalogRecord } from "@/lib/memory/store";
import type { MemoryGraphBuildRecord } from "@/lib/memory/types";
import { contentSha256Hex } from "@/lib/sources/text-lineage";

export const MEMORY_COGNITION_QUALITY_METRICS_VERSION =
  "memory-cognition-quality-metrics:1" as const;

export const MEMORY_GRAPH_STALE_AFTER_MS = 86_400_000;

export type MemoryCognitionQualityMetrics = Readonly<{
  version: typeof MEMORY_COGNITION_QUALITY_METRICS_VERSION;
  generatedAt: string;
  scope: Readonly<{
    tenantId: string;
    actorId: string;
  }>;
  evidenceSupportedExtraction: Readonly<{
    knowledgeDocumentCount: number;
    knowledgeChunkCount: number;
    cognitionBatchSampleCount: number;
    candidateItemSampleCount: number;
    exactEvidenceBatchCount: number;
    exactEvidenceCandidateItemCount: number;
    exactEvidenceBatchRate: number | null;
    exactEvidenceCandidateItemRate: number | null;
  }>;
  reviewAcceptance: Readonly<{
    cognitionBatchSampleCount: number;
    reviewedBatchSampleCount: number;
    pendingCount: number;
    confirmedCount: number;
    unprojectedConfirmedCount: number;
    projectedCount: number;
    dismissedCount: number;
    acceptanceRate: number | null;
  }>;
  retrievalUsefulness: Readonly<{
    interpretation: "observed_retrieval_use_only_not_causal";
    durableMemorySampleCount: number;
    eligibleActiveDurableMemoryCount: number;
    usedActiveDurableMemoryCount: number;
    observedUseCount: number;
    usedActiveDurableMemoryRate: number | null;
  }>;
  graphLag: Readonly<{
    buildSampleCount: 0 | 1;
    latestBuildAt: string | null;
    lagMs: number | null;
    status: "current" | "stale" | "failed" | "unbuilt";
  }>;
}>;

export type PublicMemoryCognitionQualityMetrics = Readonly<
  Omit<MemoryCognitionQualityMetrics, "scope">
>;

export type BuildMemoryCognitionQualityMetricsInput = Readonly<{
  cognition: Readonly<{
    tenantId: string;
    actorId: string;
    records: readonly KnowledgeCognitionRecord[];
  }>;
  durableMemories: readonly MemoryCatalogRecord[];
  knowledgeCounts: Readonly<{
    documents: number;
    chunks: number;
  }>;
  latestGraphBuild: Readonly<MemoryGraphBuildRecord> | null;
  generatedAt: string;
}>;

/**
 * Projects bounded, actor-scoped quality observations from already-loaded
 * records. This function performs no reads, writes, model calls, or clock
 * access: callers must provide the observation time and every sample.
 *
 * Retrieval use is deliberately labelled observational. A use counter cannot
 * establish that a retrieved memory caused a better outcome.
 */
export function buildMemoryCognitionQualityMetrics(
  input: BuildMemoryCognitionQualityMetricsInput,
): MemoryCognitionQualityMetrics {
  const tenantId = requiredScopeId(input.cognition.tenantId, "tenant");
  const actorId = requiredScopeId(input.cognition.actorId, "actor");
  const generatedAtMs = requiredTimestamp(input.generatedAt, "generatedAt");
  const generatedAt = new Date(generatedAtMs).toISOString();
  const knowledgeDocumentCount = requiredCount(
    input.knowledgeCounts.documents,
    "knowledge document count",
  );
  const knowledgeChunkCount = requiredCount(
    input.knowledgeCounts.chunks,
    "knowledge chunk count",
  );

  assertInputScope(input, tenantId, actorId);

  let candidateItemSampleCount = 0;
  let exactEvidenceCandidateItemCount = 0;
  let exactEvidenceBatchCount = 0;
  let pendingCount = 0;
  let confirmedCount = 0;
  let projectedCount = 0;
  let dismissedCount = 0;

  for (const record of input.cognition.records) {
    const candidates = candidateItems(record.candidate);
    const exactCandidateCount = candidates.filter((candidate) =>
      candidateHasExactEvidence(record.candidate, candidate.evidence)
    ).length;
    candidateItemSampleCount = saturatedAdd(
      candidateItemSampleCount,
      candidates.length,
    );
    exactEvidenceCandidateItemCount = saturatedAdd(
      exactEvidenceCandidateItemCount,
      exactCandidateCount,
    );
    if (
      batchHasExactEvidence(record.candidate) &&
      exactCandidateCount === candidates.length
    ) {
      exactEvidenceBatchCount = saturatedAdd(exactEvidenceBatchCount, 1);
    }

    if (record.status === "pending_review") pendingCount += 1;
    if (record.status === "dismissed") dismissedCount += 1;
    if (record.status === "confirmed") {
      confirmedCount += 1;
      if (record.projectedMemoryId && record.projectedAt) projectedCount += 1;
    }
  }

  const reviewedBatchSampleCount = saturatedAdd(
    confirmedCount,
    dismissedCount,
  );
  const eligibleMemories = input.durableMemories.filter((memory) =>
    isEligibleActiveMemory(memory, generatedAtMs)
  );
  const usedMemories = eligibleMemories.filter((memory) =>
    normalizedUseCount(memory.useCount) > 0
  );
  const observedUseCount = eligibleMemories.reduce(
    (total, memory) => saturatedAdd(total, normalizedUseCount(memory.useCount)),
    0,
  );

  return Object.freeze({
    version: MEMORY_COGNITION_QUALITY_METRICS_VERSION,
    generatedAt,
    scope: Object.freeze({ tenantId, actorId }),
    evidenceSupportedExtraction: Object.freeze({
      knowledgeDocumentCount,
      knowledgeChunkCount,
      cognitionBatchSampleCount: input.cognition.records.length,
      candidateItemSampleCount,
      exactEvidenceBatchCount,
      exactEvidenceCandidateItemCount,
      exactEvidenceBatchRate: boundedRate(
        exactEvidenceBatchCount,
        input.cognition.records.length,
      ),
      exactEvidenceCandidateItemRate: boundedRate(
        exactEvidenceCandidateItemCount,
        candidateItemSampleCount,
      ),
    }),
    reviewAcceptance: Object.freeze({
      cognitionBatchSampleCount: input.cognition.records.length,
      reviewedBatchSampleCount,
      pendingCount,
      confirmedCount,
      unprojectedConfirmedCount: confirmedCount - projectedCount,
      projectedCount,
      dismissedCount,
      acceptanceRate: boundedRate(
        confirmedCount,
        reviewedBatchSampleCount,
      ),
    }),
    retrievalUsefulness: Object.freeze({
      interpretation: "observed_retrieval_use_only_not_causal" as const,
      durableMemorySampleCount: input.durableMemories.length,
      eligibleActiveDurableMemoryCount: eligibleMemories.length,
      usedActiveDurableMemoryCount: usedMemories.length,
      observedUseCount,
      usedActiveDurableMemoryRate: boundedRate(
        usedMemories.length,
        eligibleMemories.length,
      ),
    }),
    graphLag: graphLagMetrics(
      input.latestGraphBuild,
      tenantId,
      generatedAtMs,
    ),
  });
}

/** Removes internal tenant/actor binding before returning metrics to a UI. */
export function publicMemoryCognitionQualityMetrics(
  metrics: MemoryCognitionQualityMetrics,
): PublicMemoryCognitionQualityMetrics {
  return Object.freeze({
    version: metrics.version,
    generatedAt: metrics.generatedAt,
    evidenceSupportedExtraction: metrics.evidenceSupportedExtraction,
    reviewAcceptance: metrics.reviewAcceptance,
    retrievalUsefulness: metrics.retrievalUsefulness,
    graphLag: metrics.graphLag,
  });
}

type CandidateWithEvidence = Readonly<{
  evidence: readonly CognificationEvidenceBindingV1[];
}>;

function candidateItems(
  candidate: CognificationCandidateBatchV1,
): readonly CandidateWithEvidence[] {
  return [
    ...candidate.topics,
    ...candidate.claims,
    ...candidate.entities,
    ...candidate.relations,
    candidate.summary,
  ];
}

function batchHasExactEvidence(candidate: CognificationCandidateBatchV1) {
  return candidate.chunkCount > 0 &&
    candidate.evidenceUnitIds.length === candidate.chunkCount &&
    new Set(candidate.evidenceUnitIds).size === candidate.evidenceUnitIds.length &&
    candidate.lastChunkIndex >= candidate.firstChunkIndex &&
    candidate.lastChunkIndex - candidate.firstChunkIndex + 1 ===
      candidate.chunkCount;
}

function candidateHasExactEvidence(
  candidate: CognificationCandidateBatchV1,
  evidence: readonly CognificationEvidenceBindingV1[],
) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  const evidenceUnitIds = new Set(candidate.evidenceUnitIds);
  return evidence.every((binding) =>
    evidenceUnitIds.has(binding.evidenceUnitId) &&
    binding.chunkIndex >= candidate.firstChunkIndex &&
    binding.chunkIndex <= candidate.lastChunkIndex &&
    binding.coordinateSpace === "evidence_content" &&
    binding.offsetUnit === "utf16_code_unit" &&
    binding.startOffset >= 0 &&
    binding.endOffsetExclusive > binding.startOffset &&
    binding.endOffsetExclusive - binding.startOffset === binding.quote.length &&
    contentSha256Hex(binding.quote) === binding.quoteSha256
  );
}

function isEligibleActiveMemory(
  memory: MemoryCatalogRecord,
  generatedAtMs: number,
) {
  if (
    (memory.claimStatus && memory.claimStatus !== "active") ||
    memory.forgottenAt ||
    memory.archivedAt
  ) {
    return false;
  }
  return timestampIsAtOrBefore(memory.validFrom, generatedAtMs) &&
    timestampIsAfter(memory.validTo, generatedAtMs) &&
    timestampIsAfter(memory.retentionExpiresAt, generatedAtMs);
}

function timestampIsAtOrBefore(value: string | undefined, referenceMs: number) {
  return value === undefined ||
    requiredTimestamp(value, "memory valid-from timestamp") <= referenceMs;
}

function timestampIsAfter(value: string | undefined, referenceMs: number) {
  return value === undefined ||
    requiredTimestamp(value, "memory expiry timestamp") > referenceMs;
}

function graphLagMetrics(
  build: Readonly<MemoryGraphBuildRecord> | null,
  tenantId: string,
  generatedAtMs: number,
): MemoryCognitionQualityMetrics["graphLag"] {
  if (!build) {
    return Object.freeze({
      buildSampleCount: 0 as const,
      latestBuildAt: null,
      lagMs: null,
      status: "unbuilt" as const,
    });
  }
  if (build.tenantId !== tenantId) {
    throw new Error("Latest memory graph build crosses the requested tenant scope.");
  }
  const buildAtMs = requiredTimestamp(build.createdAt, "graph build timestamp");
  const lagMs = Math.max(0, generatedAtMs - buildAtMs);
  return Object.freeze({
    buildSampleCount: 1 as const,
    latestBuildAt: new Date(buildAtMs).toISOString(),
    lagMs,
    status: build.status === "failed"
      ? "failed" as const
      : lagMs > MEMORY_GRAPH_STALE_AFTER_MS
        ? "stale" as const
        : "current" as const,
  });
}

function assertInputScope(
  input: BuildMemoryCognitionQualityMetricsInput,
  tenantId: string,
  actorId: string,
) {
  for (const record of input.cognition.records) {
    if (
      record.candidate.tenantId !== tenantId ||
      record.candidate.ownerActorId !== actorId
    ) {
      throw new Error("Knowledge cognition metrics cross the requested actor scope.");
    }
  }
  for (const memory of input.durableMemories) {
    if (
      (memory.tenantId && memory.tenantId !== tenantId) ||
      (memory.accessBinding && memory.accessBinding.tenantId !== tenantId)
    ) {
      throw new Error("Durable memory metrics cross the requested tenant scope.");
    }
  }
}

function requiredScopeId(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Memory quality metrics require a ${label} id.`);
  return normalized;
}

function requiredTimestamp(value: string, label: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Memory quality metrics received an invalid ${label}.`);
  }
  return timestamp;
}

function requiredCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Memory quality metrics require a non-negative ${label}.`);
  }
  return value;
}

function normalizedUseCount(value: number | undefined) {
  return requiredCount(value ?? 0, "memory use count");
}

function saturatedAdd(left: number, right: number) {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function boundedRate(numerator: number, denominator: number) {
  if (denominator === 0) return null;
  return Math.min(1, Math.max(0, numerator / denominator));
}
