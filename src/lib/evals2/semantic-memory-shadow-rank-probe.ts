import { z } from "zod";

import {
  LOCAL_LEARNED_RERANKER_VERSION,
  rerankRetrievalCandidates,
  type RetrievalRerankerReceipt,
} from "@/lib/rag/learned-reranker";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const SEMANTIC_MEMORY_SHADOW_RANK_PROBE_CONTRACT =
  "semantic-memory-shadow-rank-probe:1" as const;
export const SEMANTIC_MEMORY_SHADOW_RANK_PROBE_EVENT_TYPE =
  "conversation.summary.semantic_shadow_rank_probed" as const;
export const SEMANTIC_MEMORY_SHADOW_RANK_PROBE_MINIMUM_CORPUS = 24;

const identifierSchema = z.string().trim().min(1).max(320);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const semanticMemoryShadowRankProbeInputSchema = z.object({
  enrichmentId: identifierSchema,
  reviewSourceSha256: sha256Schema,
  query: z.string().trim().min(3).max(500),
  humanConfirmedTarget: z.literal(true),
}).strict();

export type SemanticMemoryShadowRankProbeInput = z.infer<
  typeof semanticMemoryShadowRankProbeInputSchema
>;

export type SemanticMemoryShadowRankProbeCandidate = Readonly<{
  enrichmentId: string;
  reviewSourceSha256: string;
  deterministicSummary: string;
  semanticText: string;
}>;

export type SemanticMemoryShadowRankProbeResult = Readonly<{
  schemaVersion: 1;
  contract: typeof SEMANTIC_MEMORY_SHADOW_RANK_PROBE_CONTRACT;
  enrichmentId: string;
  reviewSourceSha256: string;
  querySha256: string;
  corpusSha256: string;
  corpusCount: number;
  baselineFirstRelevantRank: number;
  semanticFirstRelevantRank: number;
  rankDelta: number;
  rankingEngine: RetrievalRerankerReceipt;
  humanConfirmedTarget: true;
}>;

/**
 * Runs a local, deterministic A/B retrieval probe over the same sealed episode
 * corpus. It performs no model call, database write, network request, or
 * runtime ranking change. The human supplies only the query and confirms which
 * episode is relevant; ranks are calculated here rather than typed into a form.
 */
export function runSemanticMemoryShadowRankProbe(input: {
  query: string;
  targetEnrichmentId: string;
  targetReviewSourceSha256: string;
  candidates: readonly SemanticMemoryShadowRankProbeCandidate[];
}): SemanticMemoryShadowRankProbeResult {
  const query = semanticMemoryShadowRankProbeInputSchema.shape.query.parse(
    input.query,
  );
  const candidates = [...input.candidates]
    .map((candidate) => Object.freeze({
      enrichmentId: identifierSchema.parse(candidate.enrichmentId),
      reviewSourceSha256: sha256Schema.parse(candidate.reviewSourceSha256),
      deterministicSummary: z.string().min(1).max(64_000).parse(
        candidate.deterministicSummary,
      ),
      semanticText: z.string().min(1).max(64_000).parse(candidate.semanticText),
    }))
    .sort((left, right) =>
      left.enrichmentId.localeCompare(right.enrichmentId)
    );
  if (candidates.length < SEMANTIC_MEMORY_SHADOW_RANK_PROBE_MINIMUM_CORPUS) {
    throw new SemanticMemoryShadowRankProbeUnavailableError(
      `Collect at least ${SEMANTIC_MEMORY_SHADOW_RANK_PROBE_MINIMUM_CORPUS} reviewable episodes before measuring retrieval rank.`,
    );
  }
  if (new Set(candidates.map(({ enrichmentId }) => enrichmentId)).size !==
    candidates.length) {
    throw new SemanticMemoryShadowRankProbeUnavailableError(
      "The current semantic evaluation corpus contains duplicate episodes.",
    );
  }
  const target = candidates.find(({ enrichmentId }) =>
    enrichmentId === input.targetEnrichmentId
  );
  if (
    !target ||
    target.reviewSourceSha256 !== input.targetReviewSourceSha256
  ) {
    throw new SemanticMemoryShadowRankProbeUnavailableError(
      "This semantic episode changed. Refresh it before running the probe.",
    );
  }

  const baseline = rank(query, candidates, "deterministicSummary");
  const semantic = rank(query, candidates, "semanticText");
  const baselineFirstRelevantRank = targetRank(
    baseline.results.map(({ value }) => value),
    target.enrichmentId,
  );
  const semanticFirstRelevantRank = targetRank(
    semantic.results.map(({ value }) => value),
    target.enrichmentId,
  );
  if (
    JSON.stringify(baseline.receipt) !== JSON.stringify(semantic.receipt) ||
    baseline.receipt.modelVersion !== LOCAL_LEARNED_RERANKER_VERSION
  ) {
    throw new SemanticMemoryShadowRankProbeUnavailableError(
      "The two retrieval lanes did not use the same ranking engine.",
    );
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    contract: SEMANTIC_MEMORY_SHADOW_RANK_PROBE_CONTRACT,
    enrichmentId: target.enrichmentId,
    reviewSourceSha256: target.reviewSourceSha256,
    querySha256: sourceContractSha256({
      domain: "asael:semantic-memory-shadow-rank-query:v1",
      query,
    }),
    corpusSha256: sourceContractSha256({
      domain: "asael:semantic-memory-shadow-rank-corpus:v1",
      candidates: candidates.map((candidate) => ({
        enrichmentId: candidate.enrichmentId,
        reviewSourceSha256: candidate.reviewSourceSha256,
      })),
    }),
    corpusCount: candidates.length,
    baselineFirstRelevantRank,
    semanticFirstRelevantRank,
    rankDelta: baselineFirstRelevantRank - semanticFirstRelevantRank,
    rankingEngine: baseline.receipt,
    humanConfirmedTarget: true as const,
  });
}

export class SemanticMemoryShadowRankProbeUnavailableError extends Error {
  readonly code = "semantic_memory_shadow_rank_probe_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "SemanticMemoryShadowRankProbeUnavailableError";
  }
}

function rank(
  query: string,
  candidates: readonly SemanticMemoryShadowRankProbeCandidate[],
  field: "deterministicSummary" | "semanticText",
) {
  return rerankRetrievalCandidates(
    query,
    candidates.map((candidate) => ({
      value: candidate.enrichmentId,
      text: candidate[field],
      baseScore: 0.5,
      freshnessScore: 0.5,
    })),
  );
}

function targetRank(orderedIds: readonly string[], targetId: string) {
  const index = orderedIds.indexOf(targetId);
  if (index < 0 || index >= 100) {
    throw new SemanticMemoryShadowRankProbeUnavailableError(
      "The relevant episode was outside the bounded retrieval result.",
    );
  }
  return index + 1;
}
