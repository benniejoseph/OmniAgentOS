import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationPolicyBindingV1,
  buildClaimBindingV1,
  buildClaimEvidenceMapV1,
  buildClaimSemanticAssessmentReceiptV1,
  buildEvidenceAuthorizationDecisionReceiptV1,
  buildEvidenceUnitSnapshotV1,
  buildExecutionScopeBindingV1,
  claimEvidenceDigestV1,
  claimEvidenceMapStructuralVerificationReceiptV1Schema,
  claimEvidenceMapV1Schema,
  claimSemanticAssessmentReceiptV1Schema,
  claimCoverageV1Schema,
  claimSupportResultV1Schema,
  evidenceAuthorizationDecisionReceiptV1Schema,
  evidenceUnitSnapshotV1Schema,
  MAX_ANSWER_UTF16_CODE_UNITS,
  MAX_CLAIM_SEMANTIC_ASSESSMENTS,
  MAX_EXECUTION_SCOPE_GRANTS,
  MAX_INFERENCE_PARENTS,
  parseClaimEvidenceMapV1,
  verifyClaimEvidenceMapStructureV1,
  type AuthorizationPolicyBindingV1,
  type BuildEvidenceUnitSnapshotV1Input,
  type ClaimBindingV1,
  type ClaimSemanticAssessmentReceiptV1,
  type EvidenceAuthorizationDecisionReceiptV1,
  type EvidenceUnitSnapshotV1,
  type SemanticAssessmentMethodV1,
} from "@/lib/rag/claim-evidence-map";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import {
  buildEvidenceUnitV1,
  buildSourceItemV1,
  buildSourceRevisionV1,
  sourceContractSha256,
  type BuildEvidenceUnitV1Input,
} from "@/lib/sources/contracts";

const ANSWER =
  "Alpha is current. Beta follows Alpha. Gamma is disputed. Delta is optional.";
const EVALUATED_AT = "2026-01-05T12:00:00.000Z";
const AS_OF_TIME = EVALUATED_AT;
const RECORDED_AT = "2026-01-05T12:01:00.000Z";
const VERIFIED_AT = "2026-01-05T12:02:00.000Z";
const AUTH_NOT_BEFORE = "2026-01-05T11:00:00.000Z";
const AUTH_EXPIRES = "2026-01-05T13:00:00.000Z";
const SOURCE_CAPTURED_AT = "2026-01-04T10:00:00.000Z";
const SOURCE_EXTRACTED_AT = "2026-01-04T10:01:00.000Z";
const RETENTION_EXPIRES_AT = "2026-02-01T00:00:00.000Z";
const PURPOSE_ID = "purpose_answer";

function digest(seed: string) {
  return sourceContractSha256({ seed });
}

const SCOPE = createExecutionScope({
  tenantId: "tenant_claim_map_test",
  initiatingActorId: "actor_claim_map_test",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_claim_map_test",
  workspaceId: "workspace_claim_map_test",
  projectId: "project_claim_map_test",
  missionId: null,
  delegationId: null,
  correlationId: "correlation_claim_map_test",
  causationId: "turn_claim_map_test",
  contextGrantIds: ["context_one"],
  capabilityGrantIds: ["capability_one"],
  purpose: "answer_with_authorized_evidence",
});

const POLICY = buildAuthorizationPolicyBindingV1({
  authorizationAuthorityId: "authority_claim_map_test",
  authorizationResolverId: "resolver_claim_map_test",
  authorizationResolverVersionId: "resolver_claim_map_v1",
  authorizationPolicyId: "policy_claim_map_test",
  authorizationPolicyVersionId: "policy_claim_map_v1",
  authorizationPolicySha256: digest("authorization-policy"),
});

const DECOMPOSITION = {
  decomposerId: "claim_decomposer_test",
  decomposerVersionId: "claim_decomposer_v1",
  method: "deterministic" as const,
  methodVersionId: "claim_decomposition_method_v1",
  policySha256: digest("claim-decomposition-policy"),
  decomposedAt: "2026-01-05T11:15:00.000Z",
};

type EvidenceFixture = {
  input: BuildEvidenceUnitSnapshotV1Input;
  snapshot: EvidenceUnitSnapshotV1;
};

function evidenceFixture(
  seed: string,
  options: {
    capturedAt?: string;
    extractedAt?: string;
    retentionExpiresAt?: string | null;
    provenance?: BuildEvidenceUnitSnapshotV1Input["provenance"];
  } = {},
): EvidenceFixture {
  const binding = {
    tenantId: SCOPE.tenantId,
    ownerActorId: "actor_evidence_owner",
    workspaceId: SCOPE.workspaceId,
    projectId: SCOPE.projectId,
    missionId: null,
    connectionId: `connection_${seed}`,
    visibility: "project_shared" as const,
    sensitivity: "confidential" as const,
    permissionGrantIds: ["permission_project", "permission_read"],
    allowedPurposeIds: ["purpose_answer", "purpose_search"],
    retentionPolicyId: "retention_claim_map_test",
    retentionExpiresAt:
      options.retentionExpiresAt === undefined
        ? RETENTION_EXPIRES_AT
        : options.retentionExpiresAt,
  };
  const extractorIdentity = {
    extractorId: "extractor_claim_map_test",
    extractorVersionId: "extractor_claim_map_v1",
    extractorConfigSha256: digest(`extractor-${seed}`),
    modelVersionId: null,
  };
  const sourceItem = buildSourceItemV1({
    ...binding,
    sourceKind: "document",
    providerItemKeySha256: digest(`provider-item-${seed}`),
    metadataSha256: digest(`metadata-${seed}`),
    sourceCreatedAt: "2026-01-03T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-04T00:00:00.000Z",
    capturedAt: options.capturedAt || SOURCE_CAPTURED_AT,
    extractorIdentity,
  });
  const revision = buildSourceRevisionV1({
    ...binding,
    sourceItemId: sourceItem.sourceItemId,
    previousSourceRevisionId: null,
    sourceKind: "document",
    providerItemKeySha256: digest(`provider-item-${seed}`),
    providerRevisionKeySha256: digest(`provider-revision-${seed}`),
    contentSha256: digest(`source-content-${seed}`),
    contentByteLength: 512,
    mediaType: "text/plain",
    metadataSha256: digest(`metadata-${seed}`),
    sourceCreatedAt: "2026-01-03T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-04T00:00:00.000Z",
    capturedAt: options.capturedAt || SOURCE_CAPTURED_AT,
    extractorIdentity,
  });
  const evidenceInput: BuildEvidenceUnitV1Input = {
    ...binding,
    sourceItemId: sourceItem.sourceItemId,
    sourceRevisionId: revision.sourceRevisionId,
    sourceKind: "document",
    providerItemKeySha256: digest(`provider-item-${seed}`),
    evidenceContentSha256: digest(`evidence-content-${seed}`),
    evidenceByteLength: 128,
    locator: {
      kind: "text_span",
      offsetUnit: "utf16_code_unit",
      startOffset: 0,
      endOffsetExclusive: 12,
      containerLength: 128,
      containerSha256: digest(`container-${seed}`),
    },
    sourceCreatedAt: "2026-01-03T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-04T00:00:00.000Z",
    capturedAt: options.capturedAt || SOURCE_CAPTURED_AT,
    extractedAt: options.extractedAt || SOURCE_EXTRACTED_AT,
    extractorIdentity,
  };
  const input = {
    evidenceUnit: buildEvidenceUnitV1(evidenceInput),
    provenance: options.provenance || {
      kind: "external_source" as const,
      originRunId: null,
      originReceiptId: null,
      originReceiptSha256: null,
      originAnswerId: null,
    },
  };
  return { input, snapshot: buildEvidenceUnitSnapshotV1(input) };
}

function claim(
  phrase: string,
  materiality: "material" | "non_material" = "material",
  answerText = ANSWER,
): ClaimBindingV1 {
  const startUtf16 = answerText.indexOf(phrase);
  if (startUtf16 < 0) throw new Error(`Missing fixture phrase: ${phrase}`);
  return buildClaimBindingV1({
    runId: "run_claim_map_test",
    answerId: "answer_claim_map_test",
    answerText,
    startUtf16,
    endUtf16Exclusive: startUtf16 + phrase.length,
    materiality,
  });
}

function authorization(
  evidence: EvidenceUnitSnapshotV1,
  overrides: Partial<{
    executionScope: ExecutionScope;
    authorizationPolicy: AuthorizationPolicyBindingV1;
    decisionState: "authorized" | "denied" | "revoked";
    decidedAt: string;
    notBefore: string;
    expiresAt: string;
    revokedAt: string | null;
    purposeId: string;
    decisionBasisSha256: string;
  }> = {},
): EvidenceAuthorizationDecisionReceiptV1 {
  return buildEvidenceAuthorizationDecisionReceiptV1({
    runId: "run_claim_map_test",
    purposeId: overrides.purposeId || PURPOSE_ID,
    executionScope: overrides.executionScope || SCOPE,
    authorizationPolicy: overrides.authorizationPolicy || POLICY,
    evidence,
    decisionState: overrides.decisionState || "authorized",
    decisionBasisSha256:
      overrides.decisionBasisSha256 || digest("authorization-decision-basis"),
    decidedAt: overrides.decidedAt || AUTH_NOT_BEFORE,
    notBefore: overrides.notBefore || AUTH_NOT_BEFORE,
    expiresAt: overrides.expiresAt || AUTH_EXPIRES,
    revokedAt: overrides.revokedAt === undefined ? null : overrides.revokedAt,
  });
}

function assessment(
  claimBinding: ClaimBindingV1,
  evidence: readonly EvidenceUnitSnapshotV1[],
  overrides: Partial<{
    inferenceParentClaimIds: readonly string[];
    method: SemanticAssessmentMethodV1;
    verdict: "supports" | "contradicts" | "insufficient";
    supportMode: "direct" | "inference" | "none";
    confidenceBps: number;
    assessedAt: string;
    validFrom: string;
    validUntilExclusive: string | null;
    lifecycleState: "current" | "superseded";
    supersededAt: string | null;
    authorizationDecisions: readonly EvidenceAuthorizationDecisionReceiptV1[];
  }> = {},
): ClaimSemanticAssessmentReceiptV1 {
  return buildClaimSemanticAssessmentReceiptV1({
    claim: claimBinding,
    evidence,
    authorizationDecisions:
      overrides.authorizationDecisions ||
      evidence.map((item) => authorization(item)),
    inferenceParentClaimIds: overrides.inferenceParentClaimIds || [],
    verifierId: "semantic_verifier_test",
    verifierVersionId: "semantic_verifier_v1",
    method: overrides.method || "deterministic_entailment",
    methodVersionId: "semantic_method_v1",
    verdict: overrides.verdict || "supports",
    supportMode: overrides.supportMode || "direct",
    confidenceBps: overrides.confidenceBps ?? 9_500,
    assessedAt: overrides.assessedAt || "2026-01-05T11:30:00.000Z",
    validFrom: overrides.validFrom || AUTH_NOT_BEFORE,
    validUntilExclusive:
      overrides.validUntilExclusive === undefined
        ? AUTH_EXPIRES
        : overrides.validUntilExclusive,
    lifecycleState: overrides.lifecycleState || "current",
    supersededAt:
      overrides.supersededAt === undefined ? null : overrides.supersededAt,
  });
}

function claimInput(
  binding: ClaimBindingV1,
  inferenceParentClaimIds: readonly string[] = [],
) {
  return {
    startUtf16: binding.startUtf16,
    endUtf16Exclusive: binding.endUtf16Exclusive,
    materiality: binding.materiality,
    inferenceParentClaimIds,
  };
}

function mapFixture(input: {
  answerText?: string;
  scope?: ExecutionScope;
  claims: readonly {
    binding: ClaimBindingV1;
    inferenceParentClaimIds?: readonly string[];
  }[];
  evidence: readonly EvidenceFixture[];
  authorizationDecisions?: readonly EvidenceAuthorizationDecisionReceiptV1[];
  semanticAssessments: readonly ClaimSemanticAssessmentReceiptV1[];
  purposeId?: string;
  asOfTime?: string;
  evaluatedAt?: string;
}) {
  return buildClaimEvidenceMapV1({
    runId: "run_claim_map_test",
    purposeId: input.purposeId || PURPOSE_ID,
    answerId: "answer_claim_map_test",
    answerText: input.answerText || ANSWER,
    executionScope: input.scope || SCOPE,
    asOfTime: input.asOfTime || AS_OF_TIME,
    evaluatedAt: input.evaluatedAt || EVALUATED_AT,
    recordedAt: RECORDED_AT,
    claimDecomposition: DECOMPOSITION,
    claims: input.claims.map((item) =>
      claimInput(item.binding, item.inferenceParentClaimIds),
    ),
    evidence: input.evidence.map((item) => item.input),
    authorizationPolicy: POLICY,
    authorizationDecisions:
      input.authorizationDecisions ||
      input.evidence.map((item) => authorization(item.snapshot)),
    semanticAssessments: input.semanticAssessments,
  });
}

describe("ClaimEvidenceMap v1", () => {
  it("builds and structurally verifies one exact authorized supported claim", () => {
    const evidence = evidenceFixture("positive");
    const alpha = claim("Alpha is current.");
    const semantic = assessment(alpha, [evidence.snapshot]);
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [semantic],
    });
    const repeated = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [semantic],
    });
    const receipt = verifyClaimEvidenceMapStructureV1({
      claimEvidenceMap: map,
      expectedRunId: "run_claim_map_test",
      expectedPurposeId: PURPOSE_ID,
      expectedAnswerId: "answer_claim_map_test",
      expectedAnswerText: ANSWER,
      expectedExecutionScope: SCOPE,
      verificationExecutionScope: SCOPE,
      verifierId: "structural_verifier_test",
      verifierVersionId: "structural_verifier_v1",
      verificationPolicySha256: digest("structural-verification-policy"),
      verifiedAt: VERIFIED_AT,
    });

    expect(map).toEqual(repeated);
    expect(map.claims[0].supportState).toBe("supported");
    expect(map.coverage).toEqual({
      basis: "declared_claim_set",
      state: "applicable",
      materialClaimCount: 1,
      supportedMaterialClaimCount: 1,
      coverageBps: 10_000,
    });
    expect(receipt.verificationScope).toBe("bindings_and_contracts_only");
    expect(receipt.semanticTruthVerification).toBe("not_performed");
    expect(receipt.evidenceSourceTrustVerification).toBe(
      "not_established_by_this_verifier",
    );
    expect(receipt.authorizationTrustVerification).toBe(
      "not_established_by_this_verifier",
    );
    expect(receipt.claimSetCompletenessVerification).toBe("not_performed");
    expect(receipt.recordedAt).toBe(RECORDED_AT);
    expect(receipt.subjectExecutionScope.tenantId).toBe(SCOPE.tenantId);
    expect(receipt.verificationExecutionScope.initiatingActorId).toBe(
      SCOPE.initiatingActorId,
    );
    expect(parseClaimEvidenceMapV1(map)).toEqual(map);
  });

  it("rejects a fully rehashed cross-tenant structural-verifier receipt", () => {
    const alpha = claim("Alpha is current.");
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [],
      authorizationDecisions: [],
      semanticAssessments: [],
    });
    const receipt = verifyClaimEvidenceMapStructureV1({
      claimEvidenceMap: map,
      expectedRunId: "run_claim_map_test",
      expectedPurposeId: PURPOSE_ID,
      expectedAnswerId: "answer_claim_map_test",
      expectedAnswerText: ANSWER,
      expectedExecutionScope: SCOPE,
      verificationExecutionScope: SCOPE,
      verifierId: "structural_verifier_test",
      verifierVersionId: "structural_verifier_v1",
      verificationPolicySha256: digest("structural-verification-policy"),
      verifiedAt: VERIFIED_AT,
    });
    const crossTenantVerifierScope = buildExecutionScopeBindingV1(
      createExecutionScope({
        ...SCOPE,
        tenantId: "tenant_other",
      }),
    );
    const {
      structuralVerificationId: _originalReceiptId,
      structuralVerificationSha256: _originalReceiptSha256,
      ...receiptBody
    } = receipt;
    const tamperedBody = {
      ...receiptBody,
      verificationExecutionScope: crossTenantVerifierScope,
    };
    const structuralVerificationId = `claim_map_verification_${claimEvidenceDigestV1(
      "structural_verification_identity",
      tamperedBody,
    ).slice(0, 56)}`;
    const tamperedReceipt = {
      ...tamperedBody,
      structuralVerificationId,
      structuralVerificationSha256: claimEvidenceDigestV1(
        "structural_verification_receipt",
        { ...tamperedBody, structuralVerificationId },
      ),
    };

    expect(() =>
      claimEvidenceMapStructuralVerificationReceiptV1Schema.parse(
        tamperedReceipt,
      ),
    ).toThrow(/subject tenant and initiating actor/i);
  });

  it.each([
    "citation_id_match",
    "model_assertion",
    "generated_summary",
    "none",
    "unassessed",
  ] as const)("does not upgrade the weak %s method to support", (method) => {
    const evidence = evidenceFixture(`weak-${method}`);
    const alpha = claim("Alpha is current.");
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [assessment(alpha, [evidence.snapshot], { method })],
    });

    expect(map.claims[0].supportState).toBe("unsupported");
    expect(map.coverage.coverageBps).toBe(0);
  });

  it("rejects wrong-claim assessment replay and receipt tampering", () => {
    const evidence = evidenceFixture("replay");
    const alpha = claim("Alpha is current.");
    const beta = claim("Beta follows Alpha.");
    const alphaAssessment = assessment(alpha, [evidence.snapshot]);

    expect(() =>
      mapFixture({
        claims: [{ binding: beta }],
        evidence: [evidence],
        semanticAssessments: [alphaAssessment],
      }),
    ).toThrow(/wrong claim|deterministically/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }, { binding: beta }],
        evidence: [evidence],
        semanticAssessments: [
          { ...alphaAssessment, claim: beta } as ClaimSemanticAssessmentReceiptV1,
        ],
      }),
    ).toThrow(/digest|ID/i);
  });

  it("rejects scope, policy, and authorization-state mismatches", () => {
    const evidence = evidenceFixture("scope-mismatch");
    const alpha = claim("Alpha is current.");
    const otherScope = createExecutionScope({
      ...SCOPE,
      executingPrincipalId: "agent_other",
    });
    const crossTenantScope = createExecutionScope({
      ...SCOPE,
      tenantId: "tenant_other",
    });
    const otherPolicy = buildAuthorizationPolicyBindingV1({
      authorizationAuthorityId: POLICY.authorizationAuthorityId,
      authorizationResolverId: POLICY.authorizationResolverId,
      authorizationResolverVersionId: POLICY.authorizationResolverVersionId,
      authorizationPolicyId: "policy_other",
      authorizationPolicyVersionId: POLICY.authorizationPolicyVersionId,
      authorizationPolicySha256: POLICY.authorizationPolicySha256,
    });

    expect(() =>
      authorization(evidence.snapshot, {
        executionScope: crossTenantScope,
      }),
    ).toThrow(/cross tenant/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [
          authorization(evidence.snapshot, { executionScope: otherScope }),
        ],
        semanticAssessments: [],
      }),
    ).toThrow(/scope|policy/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [
          authorization(evidence.snapshot, { authorizationPolicy: otherPolicy }),
        ],
        semanticAssessments: [],
      }),
    ).toThrow(/scope|policy/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [
          authorization(evidence.snapshot, { decisionState: "denied" }),
        ],
        semanticAssessments: [],
      }),
    ).toThrow(/authorized|unrevoked/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [
          authorization(evidence.snapshot, { purposeId: "purpose_other" }),
        ],
        semanticAssessments: [],
      }),
    ).toThrow(/purpose|scope|policy/i);
  });

  it("uses half-open authorization windows and rejects expired or revoked decisions", () => {
    const evidence = evidenceFixture("authorization-window");
    const alpha = claim("Alpha is current.");
    const openingDecision = authorization(evidence.snapshot, {
      decidedAt: AUTH_NOT_BEFORE,
      notBefore: EVALUATED_AT,
    });
    const atOpeningEdge = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      authorizationDecisions: [openingDecision],
      semanticAssessments: [
        assessment(alpha, [evidence.snapshot], {
          assessedAt: EVALUATED_AT,
          authorizationDecisions: [openingDecision],
        }),
      ],
    });

    expect(atOpeningEdge.claims[0].supportState).toBe("supported");
    expect(() => {
      const closingDecision = authorization(evidence.snapshot, {
        expiresAt: EVALUATED_AT,
      });
      return mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [closingDecision],
        semanticAssessments: [
          assessment(alpha, [evidence.snapshot], {
            authorizationDecisions: [closingDecision],
          }),
        ],
      });
    }).toThrow(/authorized|active|half-open/i);
    expect(() => {
      const revokedDecision = authorization(evidence.snapshot, {
        decisionState: "revoked",
        revokedAt: "2026-01-05T11:45:00.000Z",
      });
      return mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [revokedDecision],
        semanticAssessments: [],
      });
    }).toThrow(/authorized|unrevoked/i);
  });

  it("rejects duplicate claim, evidence, authorization, and assessment identities", () => {
    const evidence = evidenceFixture("duplicates");
    const alpha = claim("Alpha is current.");
    const semantic = assessment(alpha, [evidence.snapshot]);
    const decision = authorization(evidence.snapshot);

    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }, { binding: alpha }],
        evidence: [evidence],
        semanticAssessments: [semantic],
      }),
    ).toThrow(/unique|canonical/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence, evidence],
        authorizationDecisions: [decision],
        semanticAssessments: [semantic],
      }),
    ).toThrow(/unique|exactly one|canonical/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [decision, decision],
        semanticAssessments: [semantic],
      }),
    ).toThrow(/unique|exactly one|canonical/i);
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [decision],
        semanticAssessments: [semantic, semantic],
      }),
    ).toThrow(/unique|canonical/i);

    const nonMaterialAlpha = claim("Alpha is current.", "non_material");
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }, { binding: nonMaterialAlpha }],
        evidence: [evidence],
        semanticAssessments: [],
      }),
    ).toThrow(/same answer span|unique|canonical/i);
  });

  it("binds each semantic assessment to its exact authorization decision", () => {
    const evidence = evidenceFixture("authorization-reassociation");
    const alpha = claim("Alpha is current.");
    const assessedDecision = authorization(evidence.snapshot);
    const replacementDecision = authorization(evidence.snapshot, {
      decisionBasisSha256: digest("replacement-authorization-basis"),
    });
    const semantic = assessment(alpha, [evidence.snapshot], {
      authorizationDecisions: [assessedDecision],
    });

    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        authorizationDecisions: [replacementDecision],
        semanticAssessments: [semantic],
      }),
    ).toThrow(/authorization|active/i);
  });

  it("rejects mixed authorization contexts inside one semantic assessment", () => {
    const firstEvidence = evidenceFixture("mixed-context-a");
    const secondEvidence = evidenceFixture("mixed-context-b");
    const alpha = claim("Alpha is current.");

    expect(() =>
      assessment(alpha, [firstEvidence.snapshot, secondEvidence.snapshot], {
        authorizationDecisions: [
          authorization(firstEvidence.snapshot),
          authorization(secondEvidence.snapshot, {
            purposeId: "purpose_other",
          }),
        ],
      }),
    ).toThrow(/share one run, tenant, purpose, scope, and policy/i);
  });

  it("applies contradiction, direct-support, inference, and stale precedence", () => {
    const evidence = evidenceFixture("precedence");
    const alpha = claim("Alpha is current.");
    const beta = claim("Beta follows Alpha.");
    const currentSupport = assessment(alpha, [evidence.snapshot]);
    const currentContradiction = assessment(alpha, [evidence.snapshot], {
      verdict: "contradicts",
      supportMode: "none",
      confidenceBps: 9_900,
    });
    const disputed = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [currentSupport, currentContradiction],
    });
    const staleContradiction = assessment(alpha, [evidence.snapshot], {
      verdict: "contradicts",
      supportMode: "none",
      validUntilExclusive: EVALUATED_AT,
    });
    const supported = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [currentSupport, staleContradiction],
    });
    const inferred = mapFixture({
      claims: [
        { binding: beta, inferenceParentClaimIds: [alpha.claimId] },
        { binding: alpha },
      ],
      evidence: [evidence],
      semanticAssessments: [
        currentSupport,
        assessment(beta, [evidence.snapshot], {
          supportMode: "inference",
          inferenceParentClaimIds: [alpha.claimId],
        }),
      ],
    });

    expect(disputed.claims[0].supportState).toBe("disputed");
    expect(supported.claims[0].supportState).toBe("supported");
    expect(
      inferred.claims.find((item) => item.claim.claimId === beta.claimId)
        ?.supportState,
    ).toBe("inferred");
  });

  it("separates supporting evidence from weak and stale evidence", () => {
    const supportingEvidence = evidenceFixture("evidence-current-support");
    const weakEvidence = evidenceFixture("evidence-weak");
    const staleEvidence = evidenceFixture("evidence-stale-support");
    const alpha = claim("Alpha is current.");
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [supportingEvidence, weakEvidence, staleEvidence],
      semanticAssessments: [
        assessment(alpha, [supportingEvidence.snapshot]),
        assessment(alpha, [weakEvidence.snapshot], {
          method: "citation_id_match",
        }),
        assessment(alpha, [staleEvidence.snapshot], {
          validUntilExclusive: EVALUATED_AT,
        }),
      ],
    });
    const result = map.claims[0];

    expect(result.supportState).toBe("supported");
    expect(result.consideredEvidenceUnitIds).toHaveLength(3);
    expect(result.currentSupportAssertionEvidenceUnitIds).toEqual([
      supportingEvidence.snapshot.evidenceUnitId,
    ]);
    expect(result.staleSupportAssertionEvidenceUnitIds).toEqual([
      staleEvidence.snapshot.evidenceUnitId,
    ]);
    expect(result.currentSupportAssertionEvidenceUnitIds).not.toContain(
      weakEvidence.snapshot.evidenceUnitId,
    );
  });

  it("rejects zero-confidence support and contradiction assertions", () => {
    const evidence = evidenceFixture("zero-confidence");
    const alpha = claim("Alpha is current.");

    expect(() =>
      assessment(alpha, [evidence.snapshot], { confidenceBps: 0 }),
    ).toThrow(/non-zero confidence/i);
    expect(() =>
      assessment(alpha, [evidence.snapshot], {
        verdict: "contradicts",
        supportMode: "none",
        confidenceBps: 0,
      }),
    ).toThrow(/non-zero confidence/i);
  });

  it("rejects assessment before claim decomposition and invalid standalone coverage", () => {
    const evidence = evidenceFixture("causal-decomposition");
    const alpha = claim("Alpha is current.");

    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [evidence],
        semanticAssessments: [
          assessment(alpha, [evidence.snapshot], {
            assessedAt: "2026-01-05T11:14:59.999Z",
          }),
        ],
      }),
    ).toThrow(/predate claim decomposition/i);
    expect(() =>
      claimCoverageV1Schema.parse({
        basis: "declared_claim_set",
        state: "applicable",
        materialClaimCount: 2,
        supportedMaterialClaimCount: 1,
        coverageBps: 10_000,
      }),
    ).toThrow(/half-up ratio/i);

    const validMap = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [assessment(alpha, [evidence.snapshot])],
    });
    expect(() =>
      claimSupportResultV1Schema.parse({
        ...validMap.claims[0],
        supportReason: "current_strong_contradiction",
      }),
    ).toThrow(/state and reason/i);
    expect(() =>
      claimSupportResultV1Schema.parse({
        ...validMap.claims[0],
        currentSupportAssertionEvidenceUnitIds: ["evidence_unknown"],
      }),
    ).toThrow(/part of considered evidence/i);
    expect(() =>
      claimSupportResultV1Schema.parse({
        ...validMap.claims[0],
        inferenceParentClaimIds: Array.from(
          { length: MAX_INFERENCE_PARENTS + 1 },
          (_, index) => `claim_parent_${String(index).padStart(3, "0")}`,
        ),
      }),
    ).toThrow(/bounded plain-data preflight/i);
  });

  it("rejects cyclic inference graphs", () => {
    const alpha = claim("Alpha is current.");
    const beta = claim("Beta follows Alpha.");

    expect(() =>
      mapFixture({
        claims: [
          { binding: alpha, inferenceParentClaimIds: [beta.claimId] },
          { binding: beta, inferenceParentClaimIds: [alpha.claimId] },
        ],
        evidence: [],
        authorizationDecisions: [],
        semanticAssessments: [],
      }),
    ).toThrow(/acyclic/i);
  });

  it("enforces inference depth independently of canonical claim order", () => {
    const answerText = "0123456789";
    const bindings = [...answerText].map((character) =>
      claim(character, "material", answerText),
    );

    expect(() =>
      mapFixture({
        answerText,
        claims: bindings.map((binding, index) => ({
          binding,
          inferenceParentClaimIds:
            index === 0 ? [] : [bindings[index - 1].claimId],
        })),
        evidence: [],
        authorizationDecisions: [],
        semanticAssessments: [],
      }),
    ).toThrow(/depth|bounded|acyclic/i);
  });

  it("treats validity as half-open: expired support is stale, future support unsupported", () => {
    const evidence = evidenceFixture("semantic-time");
    const alpha = claim("Alpha is current.");
    const atOpeningEdge = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [
        assessment(alpha, [evidence.snapshot], { validFrom: EVALUATED_AT }),
      ],
    });
    const atClosingEdge = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [
        assessment(alpha, [evidence.snapshot], {
          validUntilExclusive: EVALUATED_AT,
        }),
      ],
    });
    const future = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [
        assessment(alpha, [evidence.snapshot], {
          validFrom: "2026-01-05T12:00:00.001Z",
          validUntilExclusive: AUTH_EXPIRES,
        }),
      ],
    });
    const superseded = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [
        assessment(alpha, [evidence.snapshot], {
          lifecycleState: "superseded",
          supersededAt: "2026-01-05T11:45:00.000Z",
        }),
      ],
    });

    expect(atOpeningEdge.claims[0].supportState).toBe("supported");
    expect(atClosingEdge.claims[0].supportState).toBe("stale");
    expect(superseded.claims[0].supportState).toBe("stale");
    expect(future.claims[0].supportState).toBe("unsupported");
  });

  it("rejects retention-expired evidence and evidence unavailable at evaluation", () => {
    const expiredEvidence = evidenceFixture("retention-expired", {
      retentionExpiresAt: EVALUATED_AT,
    });
    const futureEvidence = evidenceFixture("future-evidence", {
      capturedAt: "2026-01-05T12:00:00.001Z",
      extractedAt: "2026-01-05T12:00:00.002Z",
    });
    const alpha = claim("Alpha is current.");
    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [expiredEvidence],
        semanticAssessments: [assessment(alpha, [expiredEvidence.snapshot])],
      }),
    ).toThrow(/retention-expired/i);
    try {
      const futureDecision = authorization(futureEvidence.snapshot, {
        decidedAt: "2026-01-05T12:00:00.003Z",
        notBefore: "2026-01-05T12:00:00.002Z",
      });
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [futureEvidence],
        authorizationDecisions: [futureDecision],
        semanticAssessments: [
          assessment(alpha, [futureEvidence.snapshot], {
            assessedAt: "2026-01-05T12:00:00.004Z",
            authorizationDecisions: [futureDecision],
          }),
        ],
      });
      throw new Error("Expected future evidence to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["authorizationDecisions", 0, "decidedAt"],
            message:
              "Authorization and evaluation cannot predate captured and extracted evidence.",
          }),
        ]),
      );
    }
  });

  it("evaluates semantic validity at historical as-of time, not recording time", () => {
    const evidence = evidenceFixture("historical-as-of");
    const alpha = claim("Alpha is current.");
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      asOfTime: "2026-01-02T12:00:00.000Z",
      semanticAssessments: [
        assessment(alpha, [evidence.snapshot], {
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntilExclusive: "2026-01-03T00:00:00.000Z",
        }),
      ],
    });

    expect(map.claims[0].supportState).toBe("supported");
    expect(map.asOfTime).toBe("2026-01-02T12:00:00.000Z");
  });

  it("rejects a future as-of time that evaluation could not yet establish", () => {
    const alpha = claim("Alpha is current.");

    expect(() =>
      mapFixture({
        claims: [{ binding: alpha }],
        evidence: [],
        authorizationDecisions: [],
        semanticAssessments: [],
        asOfTime: "2026-01-05T12:00:00.001Z",
      }),
    ).toThrow(/as-of time|evaluation time/i);
  });

  it("computes integer half-up coverage from supported material claims only", () => {
    const evidence = evidenceFixture("coverage");
    const alpha = claim("Alpha is current.");
    const beta = claim("Beta follows Alpha.");
    const gamma = claim("Gamma is disputed.");
    const delta = claim("Delta is optional.", "non_material");
    const map = mapFixture({
      claims: [
        { binding: gamma },
        { binding: delta },
        { binding: beta },
        { binding: alpha },
      ],
      evidence: [evidence],
      semanticAssessments: [
        assessment(alpha, [evidence.snapshot]),
        assessment(beta, [evidence.snapshot]),
        assessment(gamma, [evidence.snapshot], {
          method: "citation_id_match",
        }),
        assessment(delta, [evidence.snapshot]),
      ],
    });

    expect(map.coverage).toEqual({
      basis: "declared_claim_set",
      state: "applicable",
      materialClaimCount: 3,
      supportedMaterialClaimCount: 2,
      coverageBps: 6_667,
    });
  });

  it("returns not_applicable/null coverage for zero material claims", () => {
    const evidence = evidenceFixture("no-material");
    const delta = claim("Delta is optional.", "non_material");
    const map = mapFixture({
      claims: [{ binding: delta }],
      evidence: [evidence],
      semanticAssessments: [assessment(delta, [evidence.snapshot])],
    });

    expect(map.coverage).toEqual({
      basis: "declared_claim_set",
      state: "not_applicable",
      materialClaimCount: 0,
      supportedMaterialClaimCount: 0,
      coverageBps: null,
    });
  });

  it("canonicalizes caller order without changing deterministic identity", () => {
    const firstEvidence = evidenceFixture("canonical-a");
    const secondEvidence = evidenceFixture("canonical-b");
    const alpha = claim("Alpha is current.");
    const beta = claim("Beta follows Alpha.");
    const firstAssessment = assessment(alpha, [firstEvidence.snapshot]);
    const secondAssessment = assessment(beta, [secondEvidence.snapshot]);
    const first = mapFixture({
      claims: [{ binding: beta }, { binding: alpha }],
      evidence: [secondEvidence, firstEvidence],
      authorizationDecisions: [
        authorization(secondEvidence.snapshot),
        authorization(firstEvidence.snapshot),
      ],
      semanticAssessments: [secondAssessment, firstAssessment],
    });
    const second = mapFixture({
      claims: [{ binding: alpha }, { binding: beta }],
      evidence: [firstEvidence, secondEvidence],
      authorizationDecisions: [
        authorization(firstEvidence.snapshot),
        authorization(secondEvidence.snapshot),
      ],
      semanticAssessments: [firstAssessment, secondAssessment],
    });

    expect(first).toEqual(second);
    expect(first.claims.map((item) => item.claim.startUtf16)).toEqual(
      [...first.claims.map((item) => item.claim.startUtf16)].sort(
        (left, right) => left - right,
      ),
    );
    expect(first.evidenceUnits.map((item) => item.evidenceUnitId)).toEqual(
      [...first.evidenceUnits.map((item) => item.evidenceUnitId)].sort(),
    );
  });

  it("treats execution-scope grant lists as canonical sets", () => {
    const alpha = claim("Alpha is current.");
    const firstScope = createExecutionScope({
      ...SCOPE,
      contextGrantIds: ["context_a", "context_b"],
      capabilityGrantIds: ["capability_a", "capability_b"],
    });
    const secondScope = createExecutionScope({
      ...SCOPE,
      contextGrantIds: ["context_b", "context_a"],
      capabilityGrantIds: ["capability_b", "capability_a"],
    });
    const first = mapFixture({
      scope: firstScope,
      claims: [{ binding: alpha }],
      evidence: [],
      authorizationDecisions: [],
      semanticAssessments: [],
    });
    const second = mapFixture({
      scope: secondScope,
      claims: [{ binding: alpha }],
      evidence: [],
      authorizationDecisions: [],
      semanticAssessments: [],
    });

    expect(first).toEqual(second);
  });

  it("preflights execution-scope grant arrays before schema traversal", () => {
    const oversizedContextGrants = new Array(
      MAX_EXECUTION_SCOPE_GRANTS + 1,
    ).fill("context_repeated");
    const subclassCapabilityGrants = ["capability_one"];
    Object.setPrototypeOf(
      subclassCapabilityGrants,
      Object.create(Array.prototype),
    );

    expect(() =>
      buildExecutionScopeBindingV1({
        ...SCOPE,
        contextGrantIds: oversizedContextGrants,
      } as ExecutionScope),
    ).toThrow(/execution-scope context grants.*array bound/i);
    expect(() =>
      buildExecutionScopeBindingV1({
        ...SCOPE,
        capabilityGrantIds: subclassCapabilityGrants,
      } as ExecutionScope),
    ).toThrow(/execution-scope capability grants.*array bound/i);
    expect(() =>
      buildExecutionScopeBindingV1({
        ...SCOPE,
        unmodeledAuthority: "must-not-be-silently-dropped",
      } as ExecutionScope),
    ).toThrow();
  });

  it("rejects oversized, sparse, accessor, and subclass arrays before dynamic traversal", () => {
    const evidence = evidenceFixture("bounded-input");
    const alpha = claim("Alpha is current.");
    const semantic = assessment(alpha, [evidence.snapshot]);
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [semantic],
    });
    const subclass = [claimInput(alpha)];
    Object.setPrototypeOf(subclass, Object.create(Array.prototype));
    const sparse = new Array(1);
    let getterCalled = false;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalled = true;
        return claimInput(alpha);
      },
    });
    accessor.length = 1;

    for (const claims of [subclass, sparse, accessor]) {
      expect(() =>
        buildClaimEvidenceMapV1({
          runId: "run_claim_map_test",
          purposeId: PURPOSE_ID,
          answerId: "answer_claim_map_test",
          answerText: ANSWER,
          executionScope: SCOPE,
          asOfTime: AS_OF_TIME,
          evaluatedAt: EVALUATED_AT,
          recordedAt: RECORDED_AT,
          claimDecomposition: DECOMPOSITION,
          claims: claims as ReturnType<typeof claimInput>[],
          evidence: [evidence.input],
          authorizationPolicy: POLICY,
          authorizationDecisions: [authorization(evidence.snapshot)],
          semanticAssessments: [semantic],
        }),
      ).toThrow(/plain data array|array bound|enumerable data/i);
    }
    expect(getterCalled).toBe(false);
    expect(() =>
      parseClaimEvidenceMapV1({
        ...map,
        semanticAssessments: new Array(
          MAX_CLAIM_SEMANTIC_ASSESSMENTS + 1,
        ).fill(semantic),
      }),
    ).toThrow(/bounded plain arrays|array bound|node bound/i);
    expect(() =>
      claimEvidenceMapV1Schema.parse({
        ...map,
        semanticAssessments: new Array(
          MAX_CLAIM_SEMANTIC_ASSESSMENTS + 1,
        ).fill(semantic),
      }),
    ).toThrow(/bounded plain-data preflight/i);
    expect(() =>
      claimSemanticAssessmentReceiptV1Schema.parse({
        ...semantic,
        evidenceBindings: new Array(129).fill(semantic.evidenceBindings[0]),
      }),
    ).toThrow(/semantic assessment failed bounded plain-data preflight/i);
    const decisionWithAccessor = {
      ...authorization(evidence.snapshot),
    } as Record<string, unknown>;
    let decisionAccessorCalled = false;
    Object.defineProperty(decisionWithAccessor, "untrustedUnknownField", {
      enumerable: true,
      get() {
        decisionAccessorCalled = true;
        return "must-not-be-read";
      },
    });
    expect(() =>
      evidenceAuthorizationDecisionReceiptV1Schema.parse(
        decisionWithAccessor,
      ),
    ).toThrow(/authorization decision failed bounded plain-data preflight/i);
    expect(decisionAccessorCalled).toBe(false);
    const snapshotWithAccessor = {
      ...evidence.snapshot,
    } as Record<string, unknown>;
    let snapshotAccessorCalled = false;
    Object.defineProperty(snapshotWithAccessor, "untrustedUnknownField", {
      enumerable: true,
      get() {
        snapshotAccessorCalled = true;
        return "must-not-be-read";
      },
    });
    expect(() =>
      evidenceUnitSnapshotV1Schema.parse(snapshotWithAccessor),
    ).toThrow(/evidence snapshot failed bounded plain-data preflight/i);
    expect(snapshotAccessorCalled).toBe(false);
    const snapshotInputWithAccessor = {
      ...evidence.input,
    } as Record<string, unknown>;
    let snapshotInputAccessorCalled = false;
    Object.defineProperty(snapshotInputWithAccessor, "untrustedUnknownField", {
      enumerable: true,
      get() {
        snapshotInputAccessorCalled = true;
        return "must-not-be-read";
      },
    });
    expect(() =>
      buildEvidenceUnitSnapshotV1(
        snapshotInputWithAccessor as unknown as BuildEvidenceUnitSnapshotV1Input,
      ),
    ).toThrow(/enumerable data properties/i);
    expect(snapshotInputAccessorCalled).toBe(false);
    expect(() =>
      buildClaimEvidenceMapV1({
        runId: "run_claim_map_test",
        purposeId: PURPOSE_ID,
        answerId: "answer_claim_map_test",
        answerText: ANSWER,
        executionScope: SCOPE,
        asOfTime: AS_OF_TIME,
        evaluatedAt: EVALUATED_AT,
        recordedAt: RECORDED_AT,
        claimDecomposition: DECOMPOSITION,
        claims: [
          {
            ...claimInput(alpha),
            inferenceParentClaimIds: new Array(MAX_INFERENCE_PARENTS + 1).fill(
              alpha.claimId,
            ),
          },
        ],
        evidence: [],
        authorizationPolicy: POLICY,
        authorizationDecisions: [],
        semanticAssessments: [],
      }),
    ).toThrow(/claim inference parents.*array bound/i);
    expect(() => claimEvidenceDigestV1("claim_text", new Array(1))).toThrow(
      /sparse|data items/i,
    );
    expect(() =>
      claimEvidenceDigestV1(
        "claim_text",
        "x".repeat(MAX_ANSWER_UTF16_CODE_UNITS + 1),
      ),
    ).toThrow(/string.*UTF-16 bound/i);
  });

  it("retains no raw answer, claim, evidence text, or arbitrary metadata", () => {
    const privateAnswer = "The private launch phrase is oriole-seven.";
    const privateClaim = claim(privateAnswer, "material", privateAnswer);
    const evidence = evidenceFixture("privacy");
    const map = mapFixture({
      answerText: privateAnswer,
      claims: [{ binding: privateClaim }],
      evidence: [evidence],
      semanticAssessments: [assessment(privateClaim, [evidence.snapshot])],
    });
    const serialized = JSON.stringify(map);

    expect(serialized).not.toContain(privateAnswer);
    expect(serialized).not.toContain("oriole-seven");
    expect(serialized).not.toContain("evidence-content-privacy");
    expect(() =>
      parseClaimEvidenceMapV1({
        ...map,
        rawClaimText: privateAnswer,
      }),
    ).toThrow();
  });

  it("rejects generated-output and self-answer evidence lineage", () => {
    const evidence = evidenceFixture("generated-lineage");

    expect(() =>
      buildEvidenceUnitSnapshotV1({
        ...evidence.input,
        provenance: {
          ...evidence.input.provenance,
          kind: "generated_output",
        } as unknown as BuildEvidenceUnitSnapshotV1Input["provenance"],
      }),
    ).toThrow();
    expect(() =>
      buildEvidenceUnitSnapshotV1({
        ...evidence.input,
        provenance: {
          ...evidence.input.provenance,
          originAnswerId: "answer_claim_map_test",
        },
      }),
    ).toThrow(/generated output|self lineage/i);
  });

  it("detects a fully rehashed wrong claim span digest", () => {
    const alpha = claim("Alpha is current.");
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [],
      authorizationDecisions: [],
      semanticAssessments: [],
    });
    const originalClaim = map.claims[0].claim;
    const {
      claimId: _originalClaimId,
      claimBindingSha256: _originalBindingSha256,
      ...claimBody
    } = originalClaim;
    const tamperedClaimBody = {
      ...claimBody,
      claimSha256: "0".repeat(64),
    };
    const claimId = `claim_${claimEvidenceDigestV1(
      "claim_binding",
      tamperedClaimBody,
    ).slice(0, 56)}`;
    const tamperedClaim = {
      ...tamperedClaimBody,
      claimId,
      claimBindingSha256: claimEvidenceDigestV1("claim_binding", {
        ...tamperedClaimBody,
        claimId,
      }),
    };
    const {
      claimEvidenceMapId: _originalMapId,
      claimEvidenceMapSha256: _originalMapSha256,
      ...mapBody
    } = map;
    const tamperedMapBody = {
      ...mapBody,
      claims: [{ ...map.claims[0], claim: tamperedClaim }],
    };
    const claimEvidenceMapId = `claim_evidence_map_${claimEvidenceDigestV1(
      "claim_evidence_map_identity",
      tamperedMapBody,
    ).slice(0, 56)}`;
    const tamperedMap = {
      ...tamperedMapBody,
      claimEvidenceMapId,
      claimEvidenceMapSha256: claimEvidenceDigestV1("claim_evidence_map", {
        ...tamperedMapBody,
        claimEvidenceMapId,
      }),
    };

    expect(() => parseClaimEvidenceMapV1(tamperedMap)).not.toThrow();
    expect(() =>
      verifyClaimEvidenceMapStructureV1({
        claimEvidenceMap: tamperedMap,
        expectedRunId: "run_claim_map_test",
        expectedPurposeId: PURPOSE_ID,
        expectedAnswerId: "answer_claim_map_test",
        expectedAnswerText: ANSWER,
        expectedExecutionScope: SCOPE,
        verificationExecutionScope: SCOPE,
        verifierId: "structural_verifier_test",
        verifierVersionId: "structural_verifier_v1",
        verificationPolicySha256: digest("structural-verification-policy"),
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(/claim hash/i);
  });

  it("detects answer mismatch and deeply freezes every returned contract", () => {
    const evidence = evidenceFixture("frozen");
    const alpha = claim("Alpha is current.");
    const semantic = assessment(alpha, [evidence.snapshot]);
    const map = mapFixture({
      claims: [{ binding: alpha }],
      evidence: [evidence],
      semanticAssessments: [semantic],
    });
    const verification = verifyClaimEvidenceMapStructureV1({
      claimEvidenceMap: map,
      expectedRunId: "run_claim_map_test",
      expectedPurposeId: PURPOSE_ID,
      expectedAnswerId: "answer_claim_map_test",
      expectedAnswerText: ANSWER,
      expectedExecutionScope: SCOPE,
      verificationExecutionScope: SCOPE,
      verifierId: "structural_verifier_test",
      verifierVersionId: "structural_verifier_v1",
      verificationPolicySha256: digest("structural-verification-policy"),
      verifiedAt: VERIFIED_AT,
    });

    expect(() =>
      verifyClaimEvidenceMapStructureV1({
        claimEvidenceMap: map,
        expectedRunId: "run_claim_map_test",
        expectedPurposeId: PURPOSE_ID,
        expectedAnswerId: "answer_claim_map_test",
        expectedAnswerText: ANSWER.replace("Alpha", "Omega"),
        expectedExecutionScope: SCOPE,
        verificationExecutionScope: SCOPE,
        verifierId: "structural_verifier_test",
        verifierVersionId: "structural_verifier_v1",
        verificationPolicySha256: digest("structural-verification-policy"),
        verifiedAt: VERIFIED_AT,
      }),
    ).toThrow(/different run, purpose, or answer|claim hash/i);
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.claims)).toBe(true);
    expect(Object.isFrozen(map.claims[0].claim)).toBe(true);
    expect(Object.isFrozen(map.evidenceUnits[0].provenance)).toBe(true);
    expect(Object.isFrozen(semantic)).toBe(true);
    expect(Object.isFrozen(verification)).toBe(true);
    expect(Object.isFrozen(verification.checks)).toBe(true);
  });
});
