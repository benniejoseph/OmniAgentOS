import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SemanticShadowReviewCandidate } from "@/components/semantic-shadow-review-queue";
import {
  createSemanticReviewGate,
  freezeSemanticSubmission,
  parseSemanticProbeReceipt,
  parseSemanticReviewReceipt,
  parseSemanticReviewWorkspace,
  preserveSemanticDraft,
  reviewTargetKey,
  semanticProbeQuerySha256,
  type ReviewSubmission,
} from "@/components/semantic-shadow-review-state";

const target = { id: `semantic_episode_enrichment_${"a".repeat(48)}`, reviewSourceSha256: "b".repeat(64) };
const time = "2026-10-03T12:00:00.000Z";

function candidate(): SemanticShadowReviewCandidate {
  return {
    ...target, startsAt: time, endsAt: time, reviewable: true,
    model: { provider: "openai", model: "memory-model" },
    metrics: { sourceCharacterCount: 500, outputCharacterCount: 100, quoteBindingCount: 1, validQuoteBindingCount: 1, semanticItemCount: 1, generationLatencyMs: 1200, deterministicReplayMatch: true },
    sourceTurns: [{ id: "turn_a", role: "user", content: "Use the approved release plan.", createdAt: time }],
    deterministicSummary: "Baseline summary",
    semanticItems: [{ id: "semantic_summary", kind: "summary", text: "Use the approved release plan.", confidenceBasisPoints: 9000, evidence: [{ turnId: "turn_a", quote: "Use the approved release plan.", startOffset: 0, endOffsetExclusive: 30, valid: true }] }],
  };
}

function submission(): ReviewSubmission {
  return {
    enrichmentId: target.id, reviewSourceSha256: target.reviewSourceSha256, dimension: "decision",
    itemDecisions: [{ itemId: "semantic_summary", decision: "supported" }],
    importantFactCount: 3, baselineImportantFactHitCount: 1, semanticImportantFactHitCount: 2,
    compressionJudgment: "good", scopeLeakCount: 0, humanReviewed: true,
  };
}

function reviewReceipt() {
  const submitted = submission();
  return { review: {
    enrichmentId: target.id, reviewSourceSha256: target.reviewSourceSha256,
    itemDecisions: submitted.itemDecisions, reviewedAt: time,
    actorId: "private-owner", seq: 9,
    case: {
      caseId: "shadow-case-example", threadSha256: "c".repeat(64), sourceSha256: "d".repeat(64), enrichmentSha256: "e".repeat(64),
      humanReviewed: true, ...candidate().metrics, supportedSemanticItemCount: 1,
      dimension: submitted.dimension, importantFactCount: submitted.importantFactCount,
      baselineImportantFactHitCount: submitted.baselineImportantFactHitCount, semanticImportantFactHitCount: submitted.semanticImportantFactHitCount,
      compressionJudgment: submitted.compressionJudgment, scopeLeakCount: submitted.scopeLeakCount,
      baselineFirstRelevantRank: null as number | null, semanticFirstRelevantRank: null as number | null,
    },
  } };
}

function probeReceipt() {
  return { probe: {
    schemaVersion: 1, contract: "semantic-memory-shadow-rank-probe:1", enrichmentId: target.id, reviewSourceSha256: target.reviewSourceSha256,
    querySha256: "c".repeat(64), corpusSha256: "d".repeat(64), corpusCount: 24,
    baselineFirstRelevantRank: 10, semanticFirstRelevantRank: 3, rankDelta: 7,
    rankingEngine: { version: "p4.4-reranker-receipt:1", modelVersion: "asael-local-pairwise-reranker:1", algorithm: "pairwise_logistic_regression", trainingFixtureVersion: "p4.4-reranker-training:1", trainingCaseCount: 40, candidateCount: 24, externalDisclosure: false },
    humanConfirmedTarget: true, probedAt: time, actorId: "private-owner", seq: 10,
  } };
}

afterEach(() => vi.unstubAllGlobals());

describe("semantic review request lifetime", () => {
  it("claims a single synchronous action across both effect buttons", () => {
    const gate = createSemanticReviewGate();
    gate.mount();
    gate.select(target);
    const reading = gate.read("detail");
    const review = gate.begin();
    expect(review).toBeDefined();
    expect(gate.begin()).toBeUndefined();
    expect(reading()).toBe(false);
    expect(gate.isBusy()).toBe(true);
    gate.finish(review!);
    expect(gate.begin()).toBeDefined();
  });

  it("disposes late reads and effects across a mounted generation", () => {
    const gate = createSemanticReviewGate();
    gate.mount();
    gate.select(target);
    const before = gate.read("workspace");
    const old = gate.begin()!;
    gate.dispose();
    gate.mount();
    const fresh = gate.begin()!;
    expect(before()).toBe(false);
    expect(gate.current(old)).toBe(false);
    gate.finish(old);
    expect(gate.current(fresh)).toBe(true);
    expect(gate.isBusy()).toBe(true);
  });

  it("fences A to B to A responses even when the final ID and digest match", () => {
    const gate = createSemanticReviewGate();
    gate.mount();
    gate.select(target);
    const originalA = gate.read("detail");
    const oldList = gate.read("workspace");
    gate.select({ ...target, id: "episode_b" });
    const oldB = gate.read("detail");
    gate.select(target);
    const currentA = gate.read("detail");
    expect([originalA(), oldB(), oldList(), currentA()]).toEqual([false, false, false, true]);
  });

  it("versions a same-ID target by source digest and fences both prior reads", () => {
    const gate = createSemanticReviewGate();
    gate.mount();
    gate.select(target);
    const oldDetail = gate.read("detail");
    const oldList = gate.read("workspace");
    const changed = { ...target, reviewSourceSha256: "f".repeat(64) };
    expect(gate.select(changed)).toBe(true);
    expect(oldDetail()).toBe(false);
    expect(oldList()).toBe(false);
    expect(gate.begin()?.target).toEqual(changed);
  });

  it("replaces each GET independently and releases accepted effects before follow-up reads", () => {
    const gate = createSemanticReviewGate();
    gate.mount();
    gate.select(target);
    const oldList = gate.read("workspace");
    const detail = gate.read("detail");
    const currentList = gate.read("workspace");
    expect([oldList(), detail(), currentList()]).toEqual([false, true, true]);
    const token = gate.begin()!;
    gate.finish(token);
    const refresh = gate.read("detail");
    expect(gate.isBusy()).toBe(false);
    const nextAction = gate.begin()!;
    expect(refresh()).toBe(false);
    expect(gate.current(nextAction)).toBe(true);
  });

  it("retains drafts for the exact source only, including false human confirmation", () => {
    const original = { key: reviewTargetKey(target), value: { facts: "unsaved edit", humanReviewed: false } };
    expect(preserveSemanticDraft(original, reviewTargetKey(target), { facts: "server", humanReviewed: false })).toBe(original);
    const newKey = reviewTargetKey({ ...target, reviewSourceSha256: "f".repeat(64) });
    expect(preserveSemanticDraft(original, newKey, { facts: "", humanReviewed: false })).toEqual({ key: newKey, value: { facts: "", humanReviewed: false } });
  });

  it("freezes a copied submitted judgment set independently of live draft mutations", () => {
    const source = submission();
    const frozen = freezeSemanticSubmission(source);
    source.itemDecisions[0].decision = "unsupported";
    source.itemDecisions.push({ itemId: "late", decision: "supported" });
    source.importantFactCount = 8;
    expect(frozen.itemDecisions).toEqual([{ itemId: "semantic_summary", decision: "supported" }]);
    expect(frozen.importantFactCount).toBe(3);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.itemDecisions)).toBe(true);
    expect(Object.isFrozen(frozen.itemDecisions[0])).toBe(true);
  });
});

describe("semantic review read projection", () => {
  it("projects source text only for the explicitly requested episode and drops owner metadata", () => {
    const value = { candidates: [{ ...candidate(), scope: { actorId: "private-owner" } }], report: null, reviewedCaseCount: 0 };
    const list = parseSemanticReviewWorkspace(value, 24)!;
    expect(list.candidates[0].sourceTurns).toBeUndefined();
    expect(list.candidates[0]).not.toHaveProperty("scope");
    const detail = parseSemanticReviewWorkspace(value, 100, target.id)!;
    expect(detail.candidates[0].sourceTurns).toEqual(candidate().sourceTurns);
  });

  it("distinguishes confirmed empty data from missing, duplicate or oversized windows", () => {
    expect(parseSemanticReviewWorkspace({ candidates: [], report: null, reviewedCaseCount: 0 }, 24)).toEqual({ candidates: [], report: null, reviewedCaseCount: 0 });
    expect(parseSemanticReviewWorkspace({}, 24)).toBeUndefined();
    expect(parseSemanticReviewWorkspace({ candidates: [candidate(), candidate()], report: null, reviewedCaseCount: 0 }, 24)).toBeUndefined();
    expect(parseSemanticReviewWorkspace({ candidates: Array.from({ length: 25 }, (_, index) => ({ ...candidate(), id: `episode_${index}` })), report: null, reviewedCaseCount: 0 }, 24)).toBeUndefined();
  });

  it("rejects malformed detail, source digest, dates and metrics while permitting unavailable timing", () => {
    const read = (row: unknown) => parseSemanticReviewWorkspace({ candidates: [row], report: null, reviewedCaseCount: 0 }, 100, target.id);
    const base = candidate();
    expect(read({ ...base, sourceTurns: undefined })).toBeUndefined();
    expect(read({ ...base, reviewSourceSha256: "wrong" })).toBeUndefined();
    expect(read({ ...base, endsAt: "invalid" })).toBeUndefined();
    expect(read({ ...base, metrics: { ...base.metrics, semanticItemCount: 2 } })).toBeUndefined();
    expect(read({ ...base, reviewable: false, metrics: { ...base.metrics, generationLatencyMs: null } })?.candidates[0].metrics.generationLatencyMs).toBeNull();
  });
});

describe("confirmed human review receipt", () => {
  it("accepts exact submitted judgments and measured metrics without incidental actor fields", () => {
    const accepted = parseSemanticReviewReceipt(reviewReceipt(), submission(), candidate());
    expect(accepted).toMatchObject({ kind: "review", target, at: time });
    expect(accepted?.review).not.toHaveProperty("actorId");
    expect(accepted?.review).not.toHaveProperty("seq");
    expect(accepted?.review.case).not.toHaveProperty("threadSha256");
  });

  it("rejects absent receipts and mismatched IDs, digests or selected snapshots", () => {
    expect(parseSemanticReviewReceipt({}, submission(), candidate())).toBeUndefined();
    const receipt = reviewReceipt();
    expect(parseSemanticReviewReceipt({ review: { ...receipt.review, enrichmentId: "another" } }, submission(), candidate())).toBeUndefined();
    expect(parseSemanticReviewReceipt({ review: { ...receipt.review, reviewSourceSha256: "f".repeat(64) } }, submission(), candidate())).toBeUndefined();
    expect(parseSemanticReviewReceipt(receipt, submission(), { ...candidate(), id: "another" })).toBeUndefined();
  });

  it("rejects changed judgments, duplicate item rows and forged measurement counts", () => {
    const receipt = reviewReceipt();
    expect(parseSemanticReviewReceipt({ review: { ...receipt.review, itemDecisions: [{ itemId: "semantic_summary", decision: "unsupported" }] } }, submission(), candidate())).toBeUndefined();
    expect(parseSemanticReviewReceipt({ review: { ...receipt.review, itemDecisions: [...receipt.review.itemDecisions, ...receipt.review.itemDecisions] } }, submission(), candidate())).toBeUndefined();
    for (const changed of [{ semanticImportantFactHitCount: 3 }, { supportedSemanticItemCount: 0 }, { sourceCharacterCount: 600 }, { humanReviewed: false }, { baselineFirstRelevantRank: 1 }]) {
      expect(parseSemanticReviewReceipt({ review: { ...receipt.review, case: { ...receipt.review.case, ...changed } } }, submission(), candidate())).toBeUndefined();
    }
  });
});

describe("confirmed local rank probe receipt", () => {
  it("computes the same canonical query hash as the server contract, including trimmed Unicode", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const query = "What was decided about release α?";
    const expected = createHash("sha256").update(JSON.stringify({ domain: "asael:semantic-memory-shadow-rank-query:v1", query })).digest("hex");
    expect(await semanticProbeQuerySha256(`  ${query}  `)).toBe(expected);
  });

  it("accepts the exact target and query with a bounded internally consistent engine receipt", () => {
    const receipt = probeReceipt();
    const accepted = parseSemanticProbeReceipt(receipt, target, receipt.probe.querySha256);
    expect(accepted).toMatchObject({ kind: "probe", target, at: time, probe: { corpusCount: 24, baselineFirstRelevantRank: 10, semanticFirstRelevantRank: 3, rankDelta: 7 } });
    expect(accepted?.probe).not.toHaveProperty("actorId");
    expect(accepted?.probe).not.toHaveProperty("seq");
  });

  it("rejects empty, wrong-query, wrong-version and stale-target success bodies", () => {
    const receipt = probeReceipt();
    expect(parseSemanticProbeReceipt({}, target, receipt.probe.querySha256)).toBeUndefined();
    expect(parseSemanticProbeReceipt(receipt, target, "e".repeat(64))).toBeUndefined();
    for (const changed of [{ enrichmentId: "another" }, { reviewSourceSha256: "f".repeat(64) }, { schemaVersion: 2 }, { contract: "other" }, { humanConfirmedTarget: false }, { corpusSha256: "invalid" }, { probedAt: "invalid" }]) {
      expect(parseSemanticProbeReceipt({ probe: { ...receipt.probe, ...changed } }, target, receipt.probe.querySha256)).toBeUndefined();
    }
  });

  it("rejects fabricated rank deltas, out-of-corpus ranks and mismatched engine boundaries", () => {
    const receipt = probeReceipt();
    for (const changed of [{ rankDelta: 8 }, { corpusCount: 23 }, { corpusCount: 101 }, { semanticFirstRelevantRank: 0 }, { baselineFirstRelevantRank: 25 }]) {
      expect(parseSemanticProbeReceipt({ probe: { ...receipt.probe, ...changed } }, target, receipt.probe.querySha256)).toBeUndefined();
    }
    for (const changed of [{ candidateCount: 25 }, { externalDisclosure: true }, { algorithm: "external" }, { modelVersion: "other" }, { trainingCaseCount: 0 }]) {
      expect(parseSemanticProbeReceipt({ probe: { ...receipt.probe, rankingEngine: { ...receipt.probe.rankingEngine, ...changed } } }, target, receipt.probe.querySha256)).toBeUndefined();
    }
  });
});
