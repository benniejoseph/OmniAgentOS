import { createHash } from "node:crypto";
import {
  buildAuthorizationPolicyBindingV1,
  buildClaimBindingV1,
  buildClaimEvidenceMapV1,
  buildClaimSemanticAssessmentReceiptV1,
  buildEvidenceAuthorizationDecisionReceiptV1,
  buildEvidenceUnitSnapshotV1,
  claimEvidenceDigestV1,
  verifyClaimEvidenceMapStructureV1,
  type ClaimEvidenceMapStructuralVerificationReceiptV1,
  type ClaimEvidenceMapV1,
  type ClaimSupportResultV1,
  type EvidenceAuthorizationDecisionReceiptV1,
  type EvidenceUnitSnapshotV1,
} from "@/lib/rag/claim-evidence-map";
import {
  getCanonicalKnowledgeEvidenceByChunkIds,
  type CanonicalKnowledgeEvidence,
} from "@/lib/rag/store";
import type { CitationSource } from "@/lib/rag/citations";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { CLAIM_EVIDENCE_PURPOSE_ID } from "@/lib/sources/purposes";

const CLAIM_DECOMPOSER_ID = "asael.claim-decomposer";
const CLAIM_DECOMPOSER_VERSION = "deterministic-sentence-v1";
const CLAIM_AUTHORITY_ID = "asael.source-authorization";
const CLAIM_AUTH_RESOLVER_ID = "asael.owner-scope-resolver";
const CLAIM_AUTH_RESOLVER_VERSION = "owner-scope-v1";
const CLAIM_AUTH_POLICY_ID = "asael.claim-evidence-read";
const CLAIM_AUTH_POLICY_VERSION = "owner-scope-v1";
const CLAIM_ENTAILMENT_VERIFIER_ID = "asael.exact-text-entailment";
const CLAIM_ENTAILMENT_VERSION = "normalized-exact-span-v1";
const MAX_RUNTIME_EVIDENCE_UNITS = 24;
const AUTHORIZATION_WINDOW_MS = 5 * 60 * 1_000;

const AUTHORIZATION_POLICY_BODY = Object.freeze({
  schemaVersion: 1,
  purposeId: CLAIM_EVIDENCE_PURPOSE_ID,
  tenant: "exact",
  initiatingActor: "exact-evidence-owner",
  scopeCoordinates: "every-non-null-coordinate-exact",
  sourcePurpose: "explicit-membership-required",
  retention: "active",
  evidenceBinding: "canonical-content-hash-and-byte-length",
});

const AUTHORIZATION_POLICY = buildAuthorizationPolicyBindingV1({
  authorizationAuthorityId: CLAIM_AUTHORITY_ID,
  authorizationResolverId: CLAIM_AUTH_RESOLVER_ID,
  authorizationResolverVersionId: CLAIM_AUTH_RESOLVER_VERSION,
  authorizationPolicyId: CLAIM_AUTH_POLICY_ID,
  authorizationPolicyVersionId: CLAIM_AUTH_POLICY_VERSION,
  authorizationPolicySha256: sourceContractSha256(AUTHORIZATION_POLICY_BODY),
});

export type RuntimeClaimEvidenceV1 = Readonly<{
  claimEvidenceMap: ClaimEvidenceMapV1;
  structuralVerification:
    ClaimEvidenceMapStructuralVerificationReceiptV1;
}>;

export type PublicClaimEvidenceV1 = Readonly<{
  schemaVersion: 1;
  claimEvidenceMapId: string;
  claimEvidenceMapSha256: string;
  structuralVerificationId: string;
  answerId: string;
  evaluatedAt: string;
  coverage: ClaimEvidenceMapV1["coverage"];
  claims: readonly Readonly<{
    claimId: string;
    startUtf16: number;
    endUtf16Exclusive: number;
    materiality: "material" | "non_material";
    supportState: ClaimSupportResultV1["supportState"];
    supportReason: ClaimSupportResultV1["supportReason"];
    evidenceUnitIds: readonly string[];
  }>[];
}>;

type ClaimSpan = Readonly<{
  startUtf16: number;
  endUtf16Exclusive: number;
  materiality: "material";
  inferenceParentClaimIds: readonly string[];
}>;

type PreparedEvidence = Readonly<{
  candidate: CanonicalKnowledgeEvidence;
  snapshot: EvidenceUnitSnapshotV1;
  authorizationDecision: EvidenceAuthorizationDecisionReceiptV1;
  normalizedContent: string;
}>;

export async function buildRuntimeClaimEvidenceV1(input: {
  runId: string;
  answerText: string;
  executionScope: ExecutionScope;
  citationSources: readonly CitationSource[];
  evaluatedAt?: string;
}): Promise<RuntimeClaimEvidenceV1> {
  if (!input.executionScope.initiatingActorId) {
    throw new Error("Claim evidence verification requires an initiating actor.");
  }
  const evaluatedAt = canonicalTimestamp(input.evaluatedAt || new Date().toISOString());
  const claimSpans = decomposeMaterialClaimSpans(input.answerText);
  const answerId = answerIdForRun(input.runId);
  const canonicalCandidates = await getCanonicalKnowledgeEvidenceByChunkIds(
    input.citationSources
      .filter((source) => source.kind === "knowledge")
      .map((source) => source.evidenceId),
    { tenantId: input.executionScope.tenantId },
  );
  const authorizedEvidence = canonicalCandidates
    .filter((candidate) =>
      authorizeCanonicalEvidence(candidate, input.executionScope, evaluatedAt),
    )
    .slice(0, MAX_RUNTIME_EVIDENCE_UNITS)
    .map((candidate) =>
      prepareAuthorizedEvidence({
        candidate,
        runId: input.runId,
        executionScope: input.executionScope,
        evaluatedAt,
      }),
    );

  const usedEvidence = new Map<string, PreparedEvidence>();
  const semanticAssessments = claimSpans.flatMap((span) => {
    const claim = buildClaimBindingV1({
      runId: input.runId,
      answerId,
      answerText: input.answerText,
      startUtf16: span.startUtf16,
      endUtf16Exclusive: span.endUtf16Exclusive,
      materiality: span.materiality,
    });
    const normalizedClaim = normalizeClaimText(
      input.answerText.slice(span.startUtf16, span.endUtf16Exclusive),
    );
    if (!isStrongExactClaim(normalizedClaim)) return [];
    const evidence = authorizedEvidence.find((candidate) =>
      containsExactNormalizedClaim(candidate.normalizedContent, normalizedClaim),
    );
    if (!evidence) return [];
    usedEvidence.set(evidence.snapshot.evidenceUnitId, evidence);
    return [buildClaimSemanticAssessmentReceiptV1({
      claim,
      evidence: [evidence.snapshot],
      authorizationDecisions: [evidence.authorizationDecision],
      inferenceParentClaimIds: [],
      verifierId: CLAIM_ENTAILMENT_VERIFIER_ID,
      verifierVersionId: CLAIM_ENTAILMENT_VERSION,
      method: "deterministic_entailment",
      methodVersionId: CLAIM_ENTAILMENT_VERSION,
      verdict: "supports",
      supportMode: "direct",
      confidenceBps: 10_000,
      assessedAt: evaluatedAt,
      validFrom: evaluatedAt,
      validUntilExclusive: evidence.authorizationDecision.expiresAt,
      lifecycleState: "current",
      supersededAt: null,
    })];
  });

  const evidence = [...usedEvidence.values()];
  const claimEvidenceMap = buildClaimEvidenceMapV1({
    runId: input.runId,
    purposeId: CLAIM_EVIDENCE_PURPOSE_ID,
    answerId,
    answerText: input.answerText,
    executionScope: input.executionScope,
    asOfTime: evaluatedAt,
    evaluatedAt,
    recordedAt: evaluatedAt,
    claimDecomposition: {
      decomposerId: CLAIM_DECOMPOSER_ID,
      decomposerVersionId: CLAIM_DECOMPOSER_VERSION,
      method: "deterministic",
      methodVersionId: CLAIM_DECOMPOSER_VERSION,
      policySha256: sourceContractSha256({
        schemaVersion: 1,
        lineSegmentation: "declarative-prose-v1",
        maximumClaims: 128,
        overflow: "final-bounded-aggregate",
      }),
      decomposedAt: evaluatedAt,
    },
    claims: claimSpans,
    evidence: evidence.map(({ candidate }) => ({
      evidenceUnit: candidate.evidenceUnit,
      provenance: {
        kind: "external_source",
        originRunId: null,
        originReceiptId: null,
        originReceiptSha256: null,
        originAnswerId: null,
      },
    })),
    authorizationPolicy: AUTHORIZATION_POLICY,
    authorizationDecisions: evidence.map(({ authorizationDecision }) =>
      authorizationDecision
    ),
    semanticAssessments,
  });
  const structuralVerification = verifyClaimEvidenceMapStructureV1({
    claimEvidenceMap,
    expectedRunId: input.runId,
    expectedPurposeId: CLAIM_EVIDENCE_PURPOSE_ID,
    expectedAnswerId: answerId,
    expectedAnswerText: input.answerText,
    expectedExecutionScope: input.executionScope,
    verificationExecutionScope: input.executionScope,
    verifierId: "asael.claim-map-structural-verifier",
    verifierVersionId: "claim-map-structural-v1",
    verificationPolicySha256: sourceContractSha256({
      schemaVersion: 1,
      checks: "claim-map-v1-structural",
    }),
    verifiedAt: evaluatedAt,
  });
  return Object.freeze({ claimEvidenceMap, structuralVerification });
}

export function publicClaimEvidenceV1(
  value: RuntimeClaimEvidenceV1,
): PublicClaimEvidenceV1 {
  const map = value.claimEvidenceMap;
  return Object.freeze({
    schemaVersion: 1,
    claimEvidenceMapId: map.claimEvidenceMapId,
    claimEvidenceMapSha256: map.claimEvidenceMapSha256,
    structuralVerificationId:
      value.structuralVerification.structuralVerificationId,
    answerId: map.answer.answerId,
    evaluatedAt: map.evaluatedAt,
    coverage: map.coverage,
    claims: Object.freeze(map.claims.map((result) => Object.freeze({
      claimId: result.claim.claimId,
      startUtf16: result.claim.startUtf16,
      endUtf16Exclusive: result.claim.endUtf16Exclusive,
      materiality: result.claim.materiality,
      supportState: result.supportState,
      supportReason: result.supportReason,
      evidenceUnitIds: Object.freeze([...result.consideredEvidenceUnitIds]),
    }))),
  });
}

export function decomposeMaterialClaimSpans(answerText: string): ClaimSpan[] {
  const spans: ClaimSpan[] = [];
  let inFence = false;
  let offset = 0;
  for (const lineWithBreak of answerText.match(/.*(?:\r?\n|$)/g) || []) {
    const line = lineWithBreak.replace(/\r?\n$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      offset += lineWithBreak.length;
      continue;
    }
    if (!inFence && trimmed && !/^#{1,6}\s/.test(trimmed)) {
      const contentStart = line.search(/\S/);
      const prefix = line.slice(contentStart).match(/^(?:[-*+]\s+|\d+[.)]\s+)/)?.[0] || "";
      const proseStart = contentStart + prefix.length;
      const prose = line.slice(proseStart);
      const matcher = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
      for (const match of prose.matchAll(matcher)) {
        const rawStart = offset + proseStart + (match.index || 0);
        const rawEnd = rawStart + match[0].length;
        const start = rawStart + (match[0].match(/^\s*/)?.[0].length || 0);
        const end = rawEnd - (match[0].match(/\s*$/)?.[0].length || 0);
        if (end <= start) continue;
        const visible = normalizeClaimText(answerText.slice(start, end));
        if (visible.length < 8 || visible.split(" ").filter(Boolean).length < 2) {
          continue;
        }
        spans.push({
          startUtf16: start,
          endUtf16Exclusive: end,
          materiality: "material",
          inferenceParentClaimIds: [],
        });
      }
    }
    offset += lineWithBreak.length;
  }
  if (spans.length <= 128) return spans;
  const retained = spans.slice(0, 127);
  retained.push({
    startUtf16: spans[127].startUtf16,
    endUtf16Exclusive: spans.at(-1)!.endUtf16Exclusive,
    materiality: "material",
    inferenceParentClaimIds: [],
  });
  return retained;
}

function prepareAuthorizedEvidence(input: {
  candidate: CanonicalKnowledgeEvidence;
  runId: string;
  executionScope: ExecutionScope;
  evaluatedAt: string;
}): PreparedEvidence {
  const snapshot = buildEvidenceUnitSnapshotV1({
    evidenceUnit: input.candidate.evidenceUnit,
    provenance: {
      kind: "external_source",
      originRunId: null,
      originReceiptId: null,
      originReceiptSha256: null,
      originAnswerId: null,
    },
  });
  const defaultExpiry = new Date(
    Date.parse(input.evaluatedAt) + AUTHORIZATION_WINDOW_MS,
  ).toISOString();
  const retentionExpiry = input.candidate.evidenceUnit.retentionExpiresAt;
  const expiresAt = retentionExpiry && retentionExpiry < defaultExpiry
    ? retentionExpiry
    : defaultExpiry;
  const authorizationDecision = buildEvidenceAuthorizationDecisionReceiptV1({
    runId: input.runId,
    purposeId: CLAIM_EVIDENCE_PURPOSE_ID,
    executionScope: input.executionScope,
    authorizationPolicy: AUTHORIZATION_POLICY,
    evidence: snapshot,
    decisionState: "authorized",
    decisionBasisSha256: claimEvidenceDigestV1(
      "authorization_decision_identity",
      {
        policy: AUTHORIZATION_POLICY.authorizationPolicySha256,
        evidenceUnitId: snapshot.evidenceUnitId,
        tenantId: snapshot.tenantId,
        actorId: snapshot.ownerActorId,
        purposeId: CLAIM_EVIDENCE_PURPOSE_ID,
        evaluatedAt: input.evaluatedAt,
      },
    ),
    decidedAt: input.evaluatedAt,
    notBefore: input.evaluatedAt,
    expiresAt,
    revokedAt: null,
  });
  return {
    candidate: input.candidate,
    snapshot,
    authorizationDecision,
    normalizedContent: normalizeEvidenceText(input.candidate.chunk.content),
  };
}

function authorizeCanonicalEvidence(
  candidate: CanonicalKnowledgeEvidence,
  scope: ExecutionScope,
  evaluatedAt: string,
) {
  const evidence = candidate.evidenceUnit;
  const actorId = scope.initiatingActorId;
  if (
    !actorId ||
    evidence.tenantId !== scope.tenantId ||
    evidence.ownerActorId !== actorId ||
    !evidence.allowedPurposeIds.includes(CLAIM_EVIDENCE_PURPOSE_ID) ||
    evidence.capturedAt > evaluatedAt ||
    evidence.extractedAt > evaluatedAt ||
    (evidence.retentionExpiresAt !== null &&
      evidence.retentionExpiresAt <= evaluatedAt)
  ) {
    return false;
  }
  return (
    matchesNullableScope(evidence.workspaceId, scope.workspaceId) &&
    matchesNullableScope(evidence.projectId, scope.projectId) &&
    matchesNullableScope(evidence.missionId, scope.missionId)
  );
}

function matchesNullableScope(
  evidenceValue: string | null,
  scopeValue: string | null,
) {
  return evidenceValue === null || evidenceValue === scopeValue;
}

function answerIdForRun(runId: string) {
  return `answer_${createHash("sha256").update(`${runId}\u0000final`).digest("hex").slice(0, 56)}`;
}

function canonicalTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Claim evidence evaluation time is invalid.");
  }
  return date.toISOString();
}

function normalizeClaimText(value: string) {
  return value
    .replace(/\[(?:memory|knowledge|graph|web):[^\]\s]+\]/g, " ")
    .replace(/[*_`~]/g, " ")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeEvidenceText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isStrongExactClaim(value: string) {
  return value.length >= 12 && value.split(" ").filter(Boolean).length >= 3;
}

function containsExactNormalizedClaim(content: string, claim: string) {
  return (` ${content} `).includes(` ${claim} `);
}
