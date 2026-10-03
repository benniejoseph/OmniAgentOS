import type {
  SemanticShadowReviewCandidate,
  SemanticShadowReviewDraft,
  buildSemanticShadowReviewPayload,
} from "@/components/semantic-shadow-review-queue";

export type ReviewTarget = { id: string; reviewSourceSha256: string };
export type ReviewSubmission = NonNullable<ReturnType<typeof buildSemanticShadowReviewPayload>["payload"]>;
type ReviewRecord = NonNullable<SemanticShadowReviewCandidate["latestReview"]>;
type ProbeRecord = NonNullable<SemanticShadowReviewCandidate["latestRankProbe"]>;
export type ReviewWorkspace = {
  candidates: SemanticShadowReviewCandidate[];
  report: null | { caseCount: number; distinctThreadCount: number; rankProbeCaseCount: number; coveredDimensions: string[]; missingDimensions: string[]; failureCodes: string[]; activationReady: boolean };
  reviewedCaseCount: number;
};
export type AcceptedReviewReceipt = { kind: "review"; target: ReviewTarget; at: string; review: ReviewRecord };
export type AcceptedProbeReceipt = { kind: "probe"; target: ReviewTarget; at: string; querySha256: string; corpusSha256: string; probe: ProbeRecord };
export type AcceptedSemanticReceipt = AcceptedReviewReceipt | AcceptedProbeReceipt;
const dimensions = new Set(["decision", "commitment", "preference", "procedure", "temporal_change", "conflict_correction", "multi_topic", "noisy_dialogue", "long_episode", "negative_control"]);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value: unknown): value is string => typeof value === "string";
const identifier = (value: unknown): value is string => text(value) && value.length > 0 && value.length <= 320 && value.trim() === value;
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const boolean = (value: unknown): value is boolean => typeof value === "boolean";
const rank = (value: unknown): value is number | null => value === null || count(value, 100, 1);
export const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function reviewTargetKey(target: ReviewTarget | undefined) {
  return target ? JSON.stringify([target.id, target.reviewSourceSha256]) : "";
}

export function createSemanticReviewGate() {
  let mounted = false;
  let generation = 0;
  let selected: ReviewTarget | undefined;
  let selectionRevision = 0;
  const reads = { workspace: 0, detail: 0 };
  let active: { generation: number; revision: number; target: ReviewTarget } | undefined;
  const invalidateReads = () => { reads.workspace += 1; reads.detail += 1; };
  return {
    mount() { mounted = true; },
    dispose() { mounted = false; generation += 1; active = undefined; invalidateReads(); },
    isMounted() { return mounted; },
    isBusy() { return active !== undefined; },
    target() { return selected; },
    select(target: ReviewTarget | undefined) {
      if (reviewTargetKey(selected) === reviewTargetKey(target)) return false;
      selected = target ? Object.freeze({ id: target.id, reviewSourceSha256: target.reviewSourceSha256 }) : undefined;
      selectionRevision += 1;
      invalidateReads();
      return true;
    },
    read(kind: "workspace" | "detail") {
      const revision = ++reads[kind];
      const epoch = generation;
      return () => mounted && epoch === generation && reads[kind] === revision;
    },
    begin() {
      if (!mounted || active || !selected) return undefined;
      invalidateReads();
      active = Object.freeze({ generation, revision: selectionRevision, target: Object.freeze({ ...selected }) });
      return active;
    },
    current(token: NonNullable<typeof active>) {
      return mounted && active === token && token.generation === generation && token.revision === selectionRevision;
    },
    finish(token: NonNullable<typeof active>) { if (active === token) active = undefined; },
  };
}

function parseReview(value: unknown, target: ReviewTarget): ReviewRecord | undefined {
  if (!record(value) || value.reviewSourceSha256 !== target.reviewSourceSha256 ||
    (value.enrichmentId !== undefined && value.enrichmentId !== target.id) || !date(value.reviewedAt) ||
    !record(value.case) || !Array.isArray(value.itemDecisions) || !value.itemDecisions.length || value.itemDecisions.length > 25) return undefined;
  const c = value.case;
  if (!text(c.dimension) || !dimensions.has(c.dimension) || !count(c.importantFactCount, 128, 1) ||
    !count(c.baselineImportantFactHitCount, c.importantFactCount) || !count(c.semanticImportantFactHitCount, c.importantFactCount) ||
    !rank(c.baselineFirstRelevantRank) || !rank(c.semanticFirstRelevantRank) ||
    (c.baselineFirstRelevantRank === null) !== (c.semanticFirstRelevantRank === null) ||
    (c.compressionJudgment !== "good" && c.compressionJudgment !== "needs_work") || !count(c.scopeLeakCount, 1_000_000)) return undefined;
  const decisions: ReviewRecord["itemDecisions"] = [];
  for (const item of value.itemDecisions) {
    if (!record(item) || !identifier(item.itemId) || (item.decision !== "supported" && item.decision !== "unsupported")) return undefined;
    decisions.push({ itemId: item.itemId, decision: item.decision });
  }
  if (new Set(decisions.map((item) => item.itemId)).size !== decisions.length) return undefined;
  return { reviewSourceSha256: value.reviewSourceSha256, reviewedAt: value.reviewedAt, itemDecisions: decisions, case: {
    dimension: c.dimension as ReviewRecord["case"]["dimension"], importantFactCount: c.importantFactCount,
    baselineImportantFactHitCount: c.baselineImportantFactHitCount, semanticImportantFactHitCount: c.semanticImportantFactHitCount,
    baselineFirstRelevantRank: c.baselineFirstRelevantRank, semanticFirstRelevantRank: c.semanticFirstRelevantRank,
    compressionJudgment: c.compressionJudgment, scopeLeakCount: c.scopeLeakCount,
  } };
}

function parseProbe(value: unknown): ProbeRecord | undefined {
  if (!record(value) || !count(value.corpusCount, 100, 1) ||
    !count(value.baselineFirstRelevantRank, value.corpusCount, 1) || !count(value.semanticFirstRelevantRank, value.corpusCount, 1) ||
    value.rankDelta !== value.baselineFirstRelevantRank - value.semanticFirstRelevantRank || !date(value.probedAt)) return undefined;
  return { corpusCount: value.corpusCount, baselineFirstRelevantRank: value.baselineFirstRelevantRank, semanticFirstRelevantRank: value.semanticFirstRelevantRank, rankDelta: value.rankDelta as number, probedAt: value.probedAt };
}

function parseCandidate(value: unknown, includeDetail: boolean): SemanticShadowReviewCandidate | undefined {
  if (!record(value) || !identifier(value.id) || !hash(value.reviewSourceSha256) || !date(value.startsAt) || !date(value.endsAt) ||
    !record(value.model) || !text(value.model.provider) || !text(value.model.model) || !record(value.metrics) || !boolean(value.reviewable)) return undefined;
  const m = value.metrics;
  if (!count(m.sourceCharacterCount) || !count(m.outputCharacterCount) || !count(m.quoteBindingCount) ||
    !count(m.validQuoteBindingCount, m.quoteBindingCount) || !count(m.semanticItemCount, 25) ||
    (m.generationLatencyMs !== null && !count(m.generationLatencyMs)) || !boolean(m.deterministicReplayMatch) ||
    (value.unavailableReason !== undefined && !text(value.unavailableReason))) return undefined;
  const candidate: SemanticShadowReviewCandidate = {
    id: value.id, reviewSourceSha256: value.reviewSourceSha256, startsAt: value.startsAt, endsAt: value.endsAt,
    model: { provider: value.model.provider, model: value.model.model },
    metrics: { sourceCharacterCount: m.sourceCharacterCount, outputCharacterCount: m.outputCharacterCount, quoteBindingCount: m.quoteBindingCount, validQuoteBindingCount: m.validQuoteBindingCount, semanticItemCount: m.semanticItemCount, generationLatencyMs: m.generationLatencyMs, deterministicReplayMatch: m.deterministicReplayMatch },
    reviewable: value.reviewable, ...(text(value.unavailableReason) ? { unavailableReason: value.unavailableReason } : {}),
  };
  if (value.latestReview !== undefined) {
    const review = parseReview(value.latestReview, candidate);
    if (!review) return undefined;
    candidate.latestReview = review;
  }
  if (value.latestRankProbe !== undefined) {
    const probe = parseProbe(value.latestRankProbe);
    if (!probe || !record(value.latestRankProbe) ||
      (value.latestRankProbe.enrichmentId !== undefined && value.latestRankProbe.enrichmentId !== candidate.id) ||
      (value.latestRankProbe.reviewSourceSha256 !== undefined && value.latestRankProbe.reviewSourceSha256 !== candidate.reviewSourceSha256)) return undefined;
    candidate.latestRankProbe = probe;
  }
  if (!includeDetail) return candidate;
  if (!Array.isArray(value.sourceTurns) || !text(value.deterministicSummary) || !Array.isArray(value.semanticItems) || value.semanticItems.length > 25) return undefined;
  const sourceTurns: NonNullable<SemanticShadowReviewCandidate["sourceTurns"]> = [];
  for (const turn of value.sourceTurns) {
    if (!record(turn) || !identifier(turn.id) || (turn.role !== "user" && turn.role !== "assistant") || !text(turn.content) || !date(turn.createdAt)) return undefined;
    sourceTurns.push({ id: turn.id, role: turn.role, content: turn.content, createdAt: turn.createdAt });
  }
  const semanticItems: NonNullable<SemanticShadowReviewCandidate["semanticItems"]> = [];
  for (const item of value.semanticItems) {
    if (!record(item) || !identifier(item.id) || !text(item.kind) || !text(item.text) || !count(item.confidenceBasisPoints, 10_000) || !Array.isArray(item.evidence)) return undefined;
    const evidence: typeof semanticItems[number]["evidence"] = [];
    for (const span of item.evidence) {
      if (!record(span) || !identifier(span.turnId) || !text(span.quote) || !count(span.startOffset) || !count(span.endOffsetExclusive) || span.endOffsetExclusive < span.startOffset || !boolean(span.valid)) return undefined;
      evidence.push({ turnId: span.turnId, quote: span.quote, startOffset: span.startOffset, endOffsetExclusive: span.endOffsetExclusive, valid: span.valid });
    }
    semanticItems.push({ id: item.id, kind: item.kind, text: item.text, confidenceBasisPoints: item.confidenceBasisPoints, evidence });
  }
  if (new Set(sourceTurns.map((turn) => turn.id)).size !== sourceTurns.length || new Set(semanticItems.map((item) => item.id)).size !== semanticItems.length || semanticItems.length !== m.semanticItemCount) return undefined;
  return { ...candidate, sourceTurns, semanticItems, deterministicSummary: value.deterministicSummary };
}

export function parseSemanticReviewWorkspace(value: unknown, limit: number, detailId?: string): ReviewWorkspace | undefined {
  if (!record(value) || !Array.isArray(value.candidates) || value.candidates.length > limit || !count(value.reviewedCaseCount, 100) || (value.report !== null && !record(value.report))) return undefined;
  const candidates: SemanticShadowReviewCandidate[] = [];
  for (const row of value.candidates) {
    const candidate = parseCandidate(row, Boolean(detailId && record(row) && row.id === detailId));
    if (!candidate) return undefined;
    candidates.push(candidate);
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return undefined;
  let report: ReviewWorkspace["report"] = null;
  if (record(value.report)) {
    const r = value.report;
    if (!count(r.caseCount, 100) || !count(r.distinctThreadCount, 100) || !count(r.rankProbeCaseCount, 100) || !boolean(r.activationReady) ||
      !Array.isArray(r.coveredDimensions) || !r.coveredDimensions.every((item) => text(item) && dimensions.has(item)) ||
      !Array.isArray(r.missingDimensions) || !r.missingDimensions.every((item) => text(item) && dimensions.has(item)) ||
      !Array.isArray(r.failureCodes) || !r.failureCodes.every(text)) return undefined;
    report = { caseCount: r.caseCount, distinctThreadCount: r.distinctThreadCount, rankProbeCaseCount: r.rankProbeCaseCount, coveredDimensions: r.coveredDimensions, missingDimensions: r.missingDimensions, failureCodes: r.failureCodes, activationReady: r.activationReady };
  }
  return { candidates, report, reviewedCaseCount: value.reviewedCaseCount };
}

export function parseSemanticReviewReceipt(value: unknown, submitted: ReviewSubmission, candidate: SemanticShadowReviewCandidate): AcceptedReviewReceipt | undefined {
  if (!record(value) || !record(value.review) || value.review.enrichmentId !== submitted.enrichmentId) return undefined;
  const target = { id: submitted.enrichmentId, reviewSourceSha256: submitted.reviewSourceSha256 };
  if (reviewTargetKey(candidate) !== reviewTargetKey(target)) return undefined;
  const review = parseReview(value.review, target);
  const c = value.review.case;
  if (!review || !record(c) || c.humanReviewed !== true || !text(c.caseId) || !/^shadow-case-[a-z0-9][a-z0-9._-]{0,119}$/.test(c.caseId) || !hash(c.threadSha256) || !hash(c.sourceSha256) || !hash(c.enrichmentSha256)) return undefined;
  for (const field of ["dimension", "importantFactCount", "baselineImportantFactHitCount", "semanticImportantFactHitCount", "compressionJudgment", "scopeLeakCount"] as const) {
    if (review.case[field] !== submitted[field]) return undefined;
  }
  if (review.itemDecisions.length !== submitted.itemDecisions.length || review.itemDecisions.some((item) => !submitted.itemDecisions.some((expected) => item.itemId === expected.itemId && item.decision === expected.decision))) return undefined;
  for (const field of ["sourceCharacterCount", "outputCharacterCount", "generationLatencyMs", "quoteBindingCount", "validQuoteBindingCount", "semanticItemCount", "deterministicReplayMatch"] as const) {
    if (c[field] !== candidate.metrics[field]) return undefined;
  }
  if (!count(c.sourceCharacterCount, 64_000, 100) || !count(c.outputCharacterCount, 32_000, 1) || !count(c.generationLatencyMs, 120_000) ||
    !count(c.quoteBindingCount, 256, 1) || !count(c.semanticItemCount, 25, 1) || c.supportedSemanticItemCount !== submitted.itemDecisions.filter((item) => item.decision === "supported").length) return undefined;
  return { kind: "review", target, at: review.reviewedAt, review };
}

export async function semanticProbeQuerySha256(query: string) {
  // These two keys are already in the server source-contract canonical lexical order.
  const bytes = new TextEncoder().encode(JSON.stringify({ domain: "asael:semantic-memory-shadow-rank-query:v1", query: query.trim() }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseSemanticProbeReceipt(value: unknown, target: ReviewTarget, querySha256: string): AcceptedProbeReceipt | undefined {
  if (!record(value) || !record(value.probe)) return undefined;
  const p = value.probe;
  const probe = parseProbe(p);
  if (!probe || p.schemaVersion !== 1 || p.contract !== "semantic-memory-shadow-rank-probe:1" || p.enrichmentId !== target.id || p.reviewSourceSha256 !== target.reviewSourceSha256 ||
    p.querySha256 !== querySha256 || !hash(p.querySha256) || !hash(p.corpusSha256) || p.humanConfirmedTarget !== true || !record(p.rankingEngine)) return undefined;
  const engine = p.rankingEngine;
  if (engine.version !== "p4.4-reranker-receipt:1" || engine.modelVersion !== "asael-local-pairwise-reranker:1" || engine.algorithm !== "pairwise_logistic_regression" ||
    engine.trainingFixtureVersion !== "p4.4-reranker-training:1" || !count(engine.trainingCaseCount, 1_000, 1) || engine.candidateCount !== probe.corpusCount || engine.externalDisclosure !== false || probe.corpusCount < 24) return undefined;
  return { kind: "probe", target: { ...target }, at: probe.probedAt, querySha256, corpusSha256: p.corpusSha256, probe };
}

export function preserveSemanticDraft<T>(previous: { key: string; value: T } | undefined, key: string, initial: T) {
  return previous?.key === key ? previous : { key, value: initial };
}

export function freezeSemanticSubmission(submission: ReviewSubmission): ReviewSubmission {
  const itemDecisions = submission.itemDecisions.map((item) => Object.freeze({ ...item }));
  Object.freeze(itemDecisions);
  return Object.freeze({ ...submission, itemDecisions });
}

export type BoundReviewDraft = { key: string; value: SemanticShadowReviewDraft };
