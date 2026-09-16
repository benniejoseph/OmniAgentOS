import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  appendScopedDomainEvent,
  listRecentEvents,
  type DomainEvent,
} from "@/lib/events/store";
import {
  SEMANTIC_MEMORY_SHADOW_DIMENSIONS,
  SEMANTIC_MEMORY_SHADOW_GATE_VERSION,
  SEMANTIC_MEMORY_SHADOW_SCORER_VERSION,
  scoreSemanticMemoryShadowGate,
  semanticMemoryShadowObservationCaseSchema,
  type SemanticMemoryShadowGateReport,
  type SemanticMemoryShadowObservationSet,
} from "@/lib/evals2/semantic-memory-shadow";
import { listOperationJobs } from "@/lib/operations/job-queue";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { contentSha256Hex } from "@/lib/sources/text-lineage";
import {
  listOwnedSemanticSummaryEnrichments,
  type OwnedSemanticSummaryEnrichment,
} from "@/lib/threads/semantic-summary-store";
import {
  semanticEpisodeOutputSha256,
  semanticEpisodeSourceSha256,
  type SemanticEpisodeEvidenceBindingV1,
} from "@/lib/threads/semantic-summaries";

export const SEMANTIC_MEMORY_SHADOW_REVIEW_CONTRACT =
  "semantic-memory-shadow-human-review:1" as const;
export const SEMANTIC_MEMORY_SHADOW_REVIEW_EVENT_TYPE =
  "conversation.summary.semantic_shadow_reviewed" as const;

const identifierSchema = z.string().trim().min(1).max(320);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const reviewItemDecisionSchema = z.object({
  itemId: identifierSchema,
  decision: z.enum(["supported", "unsupported"]),
}).strict();

export const semanticMemoryShadowReviewInputSchema = z.object({
  enrichmentId: identifierSchema,
  reviewSourceSha256: sha256Schema,
  dimension: z.enum(SEMANTIC_MEMORY_SHADOW_DIMENSIONS),
  itemDecisions: z.array(reviewItemDecisionSchema).min(1).max(25),
  importantFactCount: z.number().int().min(1).max(128),
  baselineImportantFactHitCount: z.number().int().min(0).max(128),
  semanticImportantFactHitCount: z.number().int().min(0).max(128),
  baselineFirstRelevantRank: z.number().int().min(1).max(100).nullable(),
  semanticFirstRelevantRank: z.number().int().min(1).max(100).nullable(),
  compressionJudgment: z.enum(["good", "needs_work"]),
  scopeLeakCount: z.number().int().min(0).max(128),
  humanReviewed: z.literal(true),
}).strict().superRefine((value, context) => {
  if (new Set(value.itemDecisions.map(({ itemId }) => itemId)).size !==
    value.itemDecisions.length) {
    context.addIssue({
      code: "custom",
      path: ["itemDecisions"],
      message: "Every semantic item must have one review decision.",
    });
  }
  for (const field of [
    "baselineImportantFactHitCount",
    "semanticImportantFactHitCount",
  ] as const) {
    if (value[field] > value.importantFactCount) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} cannot exceed importantFactCount.`,
      });
    }
  }
});

export type SemanticMemoryShadowReviewInput = z.infer<
  typeof semanticMemoryShadowReviewInputSchema
>;
export type SemanticMemoryShadowItemDecision = z.infer<
  typeof reviewItemDecisionSchema
>;

export type SemanticMemoryShadowReviewItem = Readonly<{
  id: string;
  kind: "summary" | "fact" | "goal" | "decision" | "commitment" |
    "preference" | "constraint" | "procedure" | "open_question";
  text: string;
  confidenceBasisPoints: number;
  evidence: readonly Readonly<{
    turnId: string;
    quote: string;
    startOffset: number;
    endOffsetExclusive: number;
    valid: boolean;
  }>[];
}>;

export type SemanticMemoryShadowReviewRecord = Readonly<{
  case: SemanticMemoryShadowObservationSet["cases"][number];
  itemDecisions: readonly SemanticMemoryShadowItemDecision[];
  reviewSourceSha256: string;
  reviewedAt: string;
}>;

export type SemanticMemoryShadowReviewCandidate = Readonly<{
  id: string;
  reviewSourceSha256: string;
  startsAt: string;
  endsAt: string;
  model: Readonly<{ provider: string; model: string }>;
  metrics: Readonly<{
    sourceCharacterCount: number;
    outputCharacterCount: number;
    quoteBindingCount: number;
    validQuoteBindingCount: number;
    semanticItemCount: number;
    generationLatencyMs: number | null;
    deterministicReplayMatch: boolean;
  }>;
  sourceTurns: readonly Readonly<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>[];
  deterministicSummary: string;
  semanticItems: readonly SemanticMemoryShadowReviewItem[];
  reviewable: boolean;
  unavailableReason?: string;
  latestReview?: SemanticMemoryShadowReviewRecord;
  scope: Readonly<{
    ownerActorId: string;
    threadId: string;
    episodeSummaryId: string;
    projectId: string | null;
    sourceSha256: string;
    enrichmentSha256: string;
  }>;
}>;

export type SemanticMemoryShadowReviewWorkspace = Readonly<{
  candidates: readonly SemanticMemoryShadowReviewCandidate[];
  observation: SemanticMemoryShadowObservationSet | null;
  report: SemanticMemoryShadowGateReport | null;
}>;

const reviewEventPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal(SEMANTIC_MEMORY_SHADOW_REVIEW_CONTRACT),
  enrichmentId: identifierSchema,
  episodeSummaryId: identifierSchema,
  reviewSourceSha256: sha256Schema,
  itemDecisions: z.array(reviewItemDecisionSchema).min(1).max(25),
  case: semanticMemoryShadowObservationCaseSchema,
}).passthrough();

export async function getSemanticMemoryShadowReviewWorkspace(input: {
  tenantId: string;
  actorIds: readonly string[];
  limit?: number;
}): Promise<SemanticMemoryShadowReviewWorkspace> {
  const actorIds = boundedActorIds(input.actorIds);
  const limit = Math.min(Math.max(Math.round(input.limit || 24), 1), 100);
  const [pairs, jobs, eventPages] = await Promise.all([
    listOwnedSemanticSummaryEnrichments({
      tenantId: input.tenantId,
      actorIds,
      limit,
    }),
    listOperationJobs(500, {
      tenantId: input.tenantId,
      type: "conversation.summary.enrich",
    }),
    Promise.all(actorIds.map((actorId) =>
      listRecentEvents({
        tenantId: input.tenantId,
        actorId,
        type: SEMANTIC_MEMORY_SHADOW_REVIEW_EVENT_TYPE,
        limit: 500,
      })
    )),
  ]);
  const actorScope = new Set(actorIds);
  const generationLatencyByEnrichment = new Map<string, number>();
  for (const job of jobs) {
    const actorId = stringValue(job.payload.actorId);
    const result = objectValue(job.payload.result);
    const progress = objectValue(job.payload.progress);
    const enrichmentId = stringValue(result?.enrichmentId);
    const generationLatencyMs = boundedGenerationLatency(
      result?.generationLatencyMs ?? progress?.generationLatencyMs,
    );
    if (
      !actorId ||
      !actorScope.has(actorId) ||
      !enrichmentId ||
      generationLatencyMs === undefined ||
      generationLatencyByEnrichment.has(enrichmentId)
    ) continue;
    generationLatencyByEnrichment.set(enrichmentId, generationLatencyMs);
  }

  const latestReviewByOwnerAndEnrichment = latestReviews(eventPages.flat());
  const candidates = pairs.map((pair) => buildReviewCandidate({
    pair,
    generationLatencyMs:
      generationLatencyByEnrichment.get(pair.record.contract.enrichmentId),
    latestReview: latestReviewByOwnerAndEnrichment.get(
      reviewKey(
        pair.record.contract.ownerActorId,
        pair.record.contract.enrichmentId,
      ),
    ),
  }));
  const currentByOwnerAndId = new Map(candidates.map((candidate) => [
    reviewKey(candidate.scope.ownerActorId, candidate.id),
    candidate,
  ]));
  const currentReviews = [...latestReviewByOwnerAndEnrichment.entries()]
    .filter(([key, review]) =>
      currentByOwnerAndId.get(key)?.reviewSourceSha256 ===
        review.reviewSourceSha256
    )
    .map(([, review]) => review)
    .sort((left, right) => left.case.caseId.localeCompare(right.case.caseId));
  const observation = buildObservation(currentReviews);
  return Object.freeze({
    candidates: Object.freeze(candidates),
    observation,
    report: observation ? scoreSemanticMemoryShadowGate(observation) : null,
  });
}

export async function saveSemanticMemoryShadowReview(input: {
  tenantId: string;
  actorIds: readonly string[];
  review: SemanticMemoryShadowReviewInput;
  executionScope: ExecutionScope;
  correlationId?: string;
}) {
  const review = semanticMemoryShadowReviewInputSchema.parse(input.review);
  const workspace = await getSemanticMemoryShadowReviewWorkspace({
    tenantId: input.tenantId,
    actorIds: input.actorIds,
    limit: 100,
  });
  const candidate = workspace.candidates.find(({ id }) =>
    id === review.enrichmentId
  );
  if (!candidate) {
    throw new SemanticMemoryShadowReviewConflictError(
      "This semantic shadow episode is no longer current.",
    );
  }
  if (
    !candidate.reviewable ||
    candidate.metrics.generationLatencyMs === null
  ) {
    throw new SemanticMemoryShadowReviewConflictError(
      candidate.unavailableReason ||
        "This episode does not have complete review evidence.",
    );
  }
  if (review.reviewSourceSha256 !== candidate.reviewSourceSha256) {
    throw new SemanticMemoryShadowReviewConflictError();
  }
  const expectedItemIds = candidate.semanticItems.map(({ id }) => id).sort();
  const reviewedItemIds = review.itemDecisions.map(({ itemId }) => itemId)
    .sort();
  if (
    expectedItemIds.length !== reviewedItemIds.length ||
    expectedItemIds.some((itemId, index) => itemId !== reviewedItemIds[index])
  ) {
    throw new SemanticMemoryShadowReviewConflictError(
      "Every current semantic item needs one supported or unsupported decision.",
    );
  }
  const supportedSemanticItemCount = review.itemDecisions.filter(
    ({ decision }) => decision === "supported",
  ).length;
  const testCase = semanticMemoryShadowObservationCaseSchema.parse({
    caseId: semanticShadowCaseId(candidate.id),
    dimension: review.dimension,
    threadSha256: sourceContractSha256({
      domain: "asael:semantic-shadow-review-thread:v1",
      tenantId: input.tenantId,
      ownerActorId: candidate.scope.ownerActorId,
      threadId: candidate.scope.threadId,
    }),
    sourceSha256: candidate.scope.sourceSha256,
    enrichmentSha256: candidate.scope.enrichmentSha256,
    humanReviewed: true,
    sourceCharacterCount: candidate.metrics.sourceCharacterCount,
    outputCharacterCount: candidate.metrics.outputCharacterCount,
    generationLatencyMs: candidate.metrics.generationLatencyMs,
    quoteBindingCount: candidate.metrics.quoteBindingCount,
    validQuoteBindingCount: candidate.metrics.validQuoteBindingCount,
    semanticItemCount: candidate.metrics.semanticItemCount,
    supportedSemanticItemCount,
    importantFactCount: review.importantFactCount,
    baselineImportantFactHitCount: review.baselineImportantFactHitCount,
    semanticImportantFactHitCount: review.semanticImportantFactHitCount,
    baselineFirstRelevantRank: review.baselineFirstRelevantRank,
    semanticFirstRelevantRank: review.semanticFirstRelevantRank,
    compressionJudgment: review.compressionJudgment,
    scopeLeakCount: review.scopeLeakCount,
    deterministicReplayMatch: candidate.metrics.deterministicReplayMatch,
  });
  const payload = reviewEventPayloadSchema.parse({
    schemaVersion: 1,
    contract: SEMANTIC_MEMORY_SHADOW_REVIEW_CONTRACT,
    enrichmentId: candidate.id,
    episodeSummaryId: candidate.scope.episodeSummaryId,
    reviewSourceSha256: candidate.reviewSourceSha256,
    itemDecisions: review.itemDecisions,
    case: testCase,
  });
  const correlationId = input.correlationId?.trim() || randomUUID();
  assertReviewExecutionScope(
    input.executionScope,
    candidate,
    input.tenantId,
    correlationId,
  );
  try {
    const event = await appendScopedDomainEvent({
      id: `semantic-shadow-review:${sourceContractSha256({
        domain: "asael:semantic-shadow-human-review-event:v1",
        tenantId: input.tenantId,
        ownerActorId: candidate.scope.ownerActorId,
        enrichmentId: candidate.id,
        correlationId,
      })}`,
      streamId: `conversation-summary:${candidate.scope.episodeSummaryId}`,
      type: SEMANTIC_MEMORY_SHADOW_REVIEW_EVENT_TYPE,
      executionScope: input.executionScope,
      payload,
    });
    return reviewFromEvent(event)!;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Domain event id ") &&
      error.message.includes("already bound to a different event")
    ) {
      throw new SemanticMemoryShadowReviewConflictError(
        "This review request was already used with different evidence.",
      );
    }
    throw error;
  }
}

export class SemanticMemoryShadowReviewConflictError extends Error {
  readonly code = "semantic_memory_shadow_review_conflict";

  constructor(
    message = "This semantic shadow review changed. Refresh and try again.",
  ) {
    super(message);
    this.name = "SemanticMemoryShadowReviewConflictError";
  }
}

function buildReviewCandidate(input: {
  pair: OwnedSemanticSummaryEnrichment;
  generationLatencyMs?: number;
  latestReview?: SemanticMemoryShadowReviewRecord;
}): SemanticMemoryShadowReviewCandidate {
  const { record, source } = input.pair;
  const contract = record.contract;
  const turnsById = new Map(source.turns.map((turn) => [turn.id, turn]));
  const summaryItem: SemanticMemoryShadowReviewItem = Object.freeze({
    id: "semantic_summary",
    kind: "summary",
    text: contract.summary.text,
    confidenceBasisPoints: contract.summary.confidenceBasisPoints,
    evidence: Object.freeze(contract.summary.evidence.map((evidence) =>
      publicEvidence(evidence, turnsById)
    )),
  });
  const statementItems = contract.statements.map((statement) =>
    Object.freeze({
      id: statement.statementId,
      kind: statement.kind,
      text: statement.text,
      confidenceBasisPoints: statement.confidenceBasisPoints,
      evidence: Object.freeze(statement.evidence.map((evidence) =>
        publicEvidence(evidence, turnsById)
      )),
    })
  );
  const semanticItems = Object.freeze([summaryItem, ...statementItems]);
  const evidence = semanticItems.flatMap((item) => item.evidence);
  const sourceCharacterCount = source.turns.reduce(
    (total, turn) => total + turn.content.length,
    0,
  );
  const outputCharacterCount = semanticItems.reduce(
    (total, item) => total + item.text.length,
    0,
  );
  const generationLatencyMs = input.generationLatencyMs ?? null;
  const metrics = Object.freeze({
    sourceCharacterCount,
    outputCharacterCount,
    quoteBindingCount: evidence.length,
    validQuoteBindingCount: evidence.filter(({ valid }) => valid).length,
    semanticItemCount: semanticItems.length,
    generationLatencyMs,
    deterministicReplayMatch: deterministicCandidateReplayMatches({
      record,
      source,
      semanticItems,
    }),
  });
  const reviewSourceSha256 = sourceContractSha256({
    domain: "asael:semantic-shadow-review-source:v1",
    sourceSha256: contract.sourceSha256,
    enrichmentSha256: contract.enrichmentSha256,
    deterministicSummarySha256: contract.deterministicSummarySha256,
    semanticItemIds: semanticItems.map(({ id }) => id),
    metrics,
  });
  const latestReview = input.latestReview?.reviewSourceSha256 ===
      reviewSourceSha256
    ? input.latestReview
    : undefined;
  const unavailableReason = sourceCharacterCount < 100
    ? "This episode is below the 100-character evaluation floor."
    : generationLatencyMs === null
      ? "Generation timing is unavailable. Recollect this episode after the timing upgrade."
      : metrics.validQuoteBindingCount !== metrics.quoteBindingCount
        ? "At least one evidence quote no longer matches its exact source span."
        : !metrics.deterministicReplayMatch
          ? "The immutable source and enrichment did not replay deterministically."
          : undefined;
  return Object.freeze({
    id: contract.enrichmentId,
    reviewSourceSha256,
    startsAt: contract.startsAt,
    endsAt: contract.endsAt,
    model: Object.freeze({
      provider: contract.modelAttribution.provider,
      model: contract.modelAttribution.model,
    }),
    metrics,
    sourceTurns: Object.freeze(source.turns.map((turn) => Object.freeze({
      id: turn.id,
      role: turn.role,
      content: turn.content,
      createdAt: turn.createdAt,
    }))),
    deterministicSummary: source.episode.content,
    semanticItems,
    reviewable: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(latestReview ? { latestReview } : {}),
    scope: Object.freeze({
      ownerActorId: contract.ownerActorId,
      threadId: contract.threadId,
      episodeSummaryId: contract.episodeSummaryId,
      projectId: contract.projectId,
      sourceSha256: contract.sourceSha256,
      enrichmentSha256: contract.enrichmentSha256,
    }),
  });
}

function publicEvidence(
  evidence: SemanticEpisodeEvidenceBindingV1,
  turnsById: ReadonlyMap<string, { content: string }>,
) {
  const turn = turnsById.get(evidence.turnId);
  const exact = turn?.content.slice(
    evidence.startOffset,
    evidence.endOffsetExclusive,
  );
  return Object.freeze({
    turnId: evidence.turnId,
    quote: evidence.quote,
    startOffset: evidence.startOffset,
    endOffsetExclusive: evidence.endOffsetExclusive,
    valid: exact === evidence.quote &&
      contentSha256Hex(evidence.quote) === evidence.quoteSha256,
  });
}

function deterministicCandidateReplayMatches(input: {
  record: OwnedSemanticSummaryEnrichment["record"];
  source: OwnedSemanticSummaryEnrichment["source"];
  semanticItems: readonly SemanticMemoryShadowReviewItem[];
}) {
  return input.source.episode.summarySha256 ===
      input.record.episodeSummarySha256 &&
    semanticEpisodeSourceSha256({
      episode: input.source.episode,
      turns: input.source.turns,
    }) === input.record.contract.sourceSha256 &&
    semanticEpisodeOutputSha256({
      summary: input.record.contract.summary,
      statements: input.record.contract.statements,
    }) === input.record.contract.enrichmentSha256 &&
    input.semanticItems.every((item) =>
      item.evidence.every((evidence) => evidence.valid)
    );
}

function latestReviews(events: readonly DomainEvent[]) {
  const reviews = events
    .map(reviewFromEvent)
    .filter((review): review is SemanticMemoryShadowReviewRecord & {
      actorId: string;
      enrichmentId: string;
      seq: number;
    } => Boolean(review))
    .sort((left, right) => right.seq - left.seq);
  const latest = new Map<string, SemanticMemoryShadowReviewRecord>();
  for (const review of reviews) {
    const key = reviewKey(review.actorId, review.enrichmentId);
    if (!latest.has(key)) {
      latest.set(key, review);
    }
  }
  return latest;
}

function reviewFromEvent(event: DomainEvent) {
  const parsed = reviewEventPayloadSchema.safeParse(event.payload);
  if (
    event.type !== SEMANTIC_MEMORY_SHADOW_REVIEW_EVENT_TYPE ||
    !parsed.success ||
    event.streamId !==
      `conversation-summary:${parsed.data.episodeSummaryId}`
  ) return undefined;
  return Object.freeze({
    actorId: event.actorId,
    enrichmentId: parsed.data.enrichmentId,
    seq: event.seq,
    case: parsed.data.case,
    itemDecisions: Object.freeze(parsed.data.itemDecisions),
    reviewSourceSha256: parsed.data.reviewSourceSha256,
    reviewedAt: event.at,
  });
}

function reviewKey(actorId: string, enrichmentId: string) {
  return `${actorId}\u0000${enrichmentId}`;
}

function buildObservation(
  reviews: readonly SemanticMemoryShadowReviewRecord[],
): SemanticMemoryShadowObservationSet | null {
  if (!reviews.length) return null;
  return Object.freeze({
    schemaVersion: 1 as const,
    version: SEMANTIC_MEMORY_SHADOW_GATE_VERSION,
    scorerVersion: SEMANTIC_MEMORY_SHADOW_SCORER_VERSION,
    observedAt: reviews
      .map(({ reviewedAt }) => reviewedAt)
      .sort()
      .at(-1)!,
    dataClassification: "private_content_free_metrics" as const,
    observationMode: "production_shadow_human_reviewed" as const,
    sideEffectPolicy: "none" as const,
    shadowOnly: true as const,
    rankingEffect: "none" as const,
    cases: reviews.map(({ case: testCase }) => testCase),
  });
}

function semanticShadowCaseId(enrichmentId: string) {
  return `shadow-case-${enrichmentId.replace(
    /^semantic_episode_enrichment_/,
    "",
  )}`;
}

function assertReviewExecutionScope(
  value: ExecutionScope,
  candidate: SemanticMemoryShadowReviewCandidate,
  tenantId: string,
  correlationId: string,
) {
  const scope = parsePersistedExecutionScope(value);
  if (
    !scope ||
    scope.tenantId !== tenantId ||
    scope.initiatingActorId !== candidate.scope.ownerActorId ||
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== candidate.scope.ownerActorId ||
    scope.workspaceId !== null ||
    scope.projectId !== candidate.scope.projectId ||
    scope.missionId !== null ||
    scope.delegationId !== null ||
    scope.causationId !== candidate.id ||
    scope.contextGrantIds.length !== 0 ||
    scope.capabilityGrantIds.length !== 0 ||
    scope.correlationId !== correlationId ||
    scope.purpose !== "conversation.summary.semantic_shadow.review"
  ) {
    throw new Error(
      "Semantic shadow review requires its exact actor and episode scope.",
    );
  }
}

function boundedActorIds(value: readonly string[]) {
  const actorIds = [...new Set(value.map((actorId) =>
    identifierSchema.parse(actorId)
  ))].sort();
  if (!actorIds.length || actorIds.length > 32) {
    throw new Error("Semantic shadow review requires a bounded actor scope.");
  }
  return actorIds;
}

function boundedGenerationLatency(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 120_000)
    : undefined;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
