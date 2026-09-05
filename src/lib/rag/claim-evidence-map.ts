import { createHash } from "node:crypto";
import { z } from "zod";
import {
  runContractIdSchema,
  runContractSha256Schema,
} from "@/lib/runs/contracts";
import {
  EXECUTION_SCOPE_VERSION,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  evidenceUnitV1Schema,
  sourceTimestampSchema,
  type EvidenceUnitV1,
} from "@/lib/sources/contracts";

/**
 * P1.5 v1 is a dormant, metadata-only contract. It does not authorize a read,
 * perform semantic verification, or make a citation ID evidence for a claim.
 */
export const CLAIM_EVIDENCE_MAP_SCHEMA_VERSION = 1 as const;
export const MAX_CLAIM_EVIDENCE_CLAIMS = 128;
export const MAX_CLAIM_EVIDENCE_UNITS = 128;
export const MAX_CLAIM_SEMANTIC_ASSESSMENTS = 2_048;
export const MAX_INFERENCE_PARENTS = 16;
export const MAX_EXECUTION_SCOPE_GRANTS = 256;
export const MAX_INFERENCE_DEPTH = 8;
export const MAX_CLAIM_EVIDENCE_MAP_BYTES = 256_000;
export const MAX_CLAIM_EVIDENCE_RECEIPT_BYTES = 32_000;
export const MAX_ANSWER_UTF16_CODE_UNITS = 1_000_000;
export const MAX_AGGREGATE_CLAIM_UTF16_CODE_UNITS = 2_000_000;
const MAX_CANONICAL_JSON_DEPTH = 32;
const MAX_CANONICAL_JSON_NODES = 100_000;
const MAX_CANONICAL_ARRAY_ITEMS = MAX_CLAIM_SEMANTIC_ASSESSMENTS;
const MAX_CANONICAL_OBJECT_KEYS = 256;
const MAX_CANONICAL_STRING_UTF16_CODE_UNITS = MAX_ANSWER_UTF16_CODE_UNITS;
const MAX_CANONICAL_JSON_BYTES = 6_100_000;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function freezeContractOutput<T>(value: T): DeepReadonly<T> {
  return deepFreeze(value) as DeepReadonly<T>;
}

const DIGEST_DOMAIN_PREFIX = "asael.claim-evidence-map.v1";
const nullableIdSchema = runContractIdSchema.nullable();
const nullableTimestampSchema = sourceTimestampSchema.nullable();
const boundedCountSchema = z.number().int().min(0).max(1_000_000_000);
const basisPointsSchema = z.number().int().min(0).max(10_000);

const _DIGEST_DOMAINS = [
  "answer_text",
  "claim_text",
  "claim_binding",
  "execution_scope",
  "execution_scope_binding",
  "context_grant_ids",
  "capability_grant_ids",
  "purpose",
  "canonical_purpose",
  "evidence_snapshot",
  "authorization_policy_binding",
  "authorization_decision_identity",
  "authorization_decision_receipt",
  "assessment_evidence_set",
  "semantic_assessment_identity",
  "semantic_assessment_receipt",
  "claim_evidence_map_identity",
  "claim_evidence_map",
  "structural_verification_identity",
  "structural_verification_receipt",
] as const;

export type ClaimEvidenceDigestDomainV1 = (typeof _DIGEST_DOMAINS)[number];

export const claimMaterialitySchema = z.enum(["material", "non_material"]);
export const claimSupportStateSchema = z.enum([
  "supported",
  "inferred",
  "disputed",
  "stale",
  "unsupported",
]);

export const semanticAssessmentMethodSchema = z.enum([
  "human_review",
  "deterministic_entailment",
  "semantic_entailment_verifier",
  "verified_effect_postcondition",
  "citation_id_match",
  "model_assertion",
  "generated_summary",
  "none",
  "unassessed",
]);

export type SemanticAssessmentMethodV1 = z.infer<
  typeof semanticAssessmentMethodSchema
>;

const STRONG_SEMANTIC_METHODS: ReadonlySet<SemanticAssessmentMethodV1> =
  new Set([
    "human_review",
    "deterministic_entailment",
    "semantic_entailment_verifier",
    "verified_effect_postcondition",
  ]);

function canonicalIdList(max: number, minimum = 0) {
  return z
    .array(runContractIdSchema)
    .min(minimum)
    .max(max)
    .superRefine((ids, context) => {
      ids.forEach((id, index) => {
        if (index > 0 && ids[index - 1] >= id) {
          context.addIssue({
            code: "custom",
            message: "IDs must be unique and use canonical lexical order.",
            path: [index],
          });
        }
      });
    });
}

/** Domain-separated SHA-256 over recursively key-sorted JSON. */
export function claimEvidenceDigestV1(
  domain: ClaimEvidenceDigestDomainV1,
  value: unknown,
): string {
  return createHash("sha256")
    .update(`${DIGEST_DOMAIN_PREFIX}\u0000${domain}\u0000`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function answerTextSha256V1(answerText: string): string {
  return claimEvidenceDigestV1("answer_text", answerText);
}

export const answerBindingV1Schema = z
  .object({
    answerId: runContractIdSchema,
    answerSha256: runContractSha256Schema,
    answerUtf16Length: boundedCountSchema.max(MAX_ANSWER_UTF16_CODE_UNITS),
  })
  .strict()
  .transform(freezeContractOutput);

export type AnswerBindingV1 = DeepReadonly<
  z.infer<typeof answerBindingV1Schema>
>;

export function buildAnswerBindingV1(input: {
  answerId: string;
  answerText: string;
}): AnswerBindingV1 {
  const parsed = z
    .object({
      answerId: runContractIdSchema,
      answerText: z.string().max(MAX_ANSWER_UTF16_CODE_UNITS),
    })
    .strict()
    .parse(input);
  return deepFreeze(
    answerBindingV1Schema.parse({
      answerId: parsed.answerId,
      answerSha256: answerTextSha256V1(parsed.answerText),
      answerUtf16Length: parsed.answerText.length,
    }),
  );
}

const grantInputSchema = z
  .array(runContractIdSchema)
  .max(MAX_EXECUTION_SCOPE_GRANTS)
  .superRefine((ids, context) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          message: "Execution-scope grant IDs must be unique.",
          path: [index],
        });
      }
      seen.add(id);
    });
  });

const executionScopeInputSchema = z
  .object({
    version: z.literal(EXECUTION_SCOPE_VERSION),
    tenantId: runContractIdSchema,
    initiatingActorId: nullableIdSchema,
    executingPrincipalType: z.enum(["user", "agent", "system"]),
    executingPrincipalId: nullableIdSchema,
    workspaceId: nullableIdSchema,
    projectId: nullableIdSchema,
    missionId: nullableIdSchema,
    delegationId: nullableIdSchema,
    correlationId: runContractIdSchema,
    causationId: nullableIdSchema,
    contextGrantIds: grantInputSchema,
    capabilityGrantIds: grantInputSchema,
    purpose: z.string().trim().min(1).max(500),
  })
  .strict();

const executionScopeBindingBodySchema = z
  .object({
    scopeVersion: z.literal(EXECUTION_SCOPE_VERSION),
    tenantId: runContractIdSchema,
    initiatingActorId: nullableIdSchema,
    executingPrincipalType: z.enum(["user", "agent", "system"]),
    executingPrincipalId: nullableIdSchema,
    workspaceId: nullableIdSchema,
    projectId: nullableIdSchema,
    missionId: nullableIdSchema,
    delegationId: nullableIdSchema,
    correlationId: runContractIdSchema,
    causationId: nullableIdSchema,
    contextGrantCount: boundedCountSchema.max(MAX_EXECUTION_SCOPE_GRANTS),
    contextGrantIdsSha256: runContractSha256Schema,
    capabilityGrantCount: boundedCountSchema.max(MAX_EXECUTION_SCOPE_GRANTS),
    capabilityGrantIdsSha256: runContractSha256Schema,
    purposeSha256: runContractSha256Schema,
    executionScopeSha256: runContractSha256Schema,
  })
  .strict();

export const executionScopeBindingV1Schema = executionScopeBindingBodySchema
  .extend({
    executionScopeBindingSha256: runContractSha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.initiatingActorId === null) {
      context.addIssue({
        code: "custom",
        message: "Claim-evidence scope requires an initiating actor.",
        path: ["initiatingActorId"],
      });
    }
    if (value.executingPrincipalId === null) {
      context.addIssue({
        code: "custom",
        message: "Claim-evidence scope requires an executing principal.",
        path: ["executingPrincipalId"],
      });
    }
    if (
      value.executingPrincipalType === "user" &&
      value.executingPrincipalId !== value.initiatingActorId
    ) {
      context.addIssue({
        code: "custom",
        message: "A user principal must match the initiating actor.",
        path: ["executingPrincipalId"],
      });
    }
    const { executionScopeBindingSha256, ...body } = value;
    if (
      executionScopeBindingSha256 !==
      claimEvidenceDigestV1("execution_scope_binding", body)
    ) {
      context.addIssue({
        code: "custom",
        message: "Execution-scope binding digest does not match its body.",
        path: ["executionScopeBindingSha256"],
      });
    }
  })
  .transform(freezeContractOutput);

export type ExecutionScopeBindingV1 = DeepReadonly<
  z.infer<typeof executionScopeBindingV1Schema>
>;

export function buildExecutionScopeBindingV1(
  executionScope: ExecutionScope,
): ExecutionScopeBindingV1 {
  assertBoundedInputArray(
    executionScope.contextGrantIds,
    MAX_EXECUTION_SCOPE_GRANTS,
    "execution-scope context grants",
  );
  assertBoundedInputArray(
    executionScope.capabilityGrantIds,
    MAX_EXECUTION_SCOPE_GRANTS,
    "execution-scope capability grants",
  );
  const scope = executionScopeInputSchema.parse(executionScope);
  const canonicalScope = {
    ...scope,
    contextGrantIds: [...scope.contextGrantIds].sort(compareIds),
    capabilityGrantIds: [...scope.capabilityGrantIds].sort(compareIds),
  };
  const body = executionScopeBindingBodySchema.parse({
    scopeVersion: canonicalScope.version,
    tenantId: canonicalScope.tenantId,
    initiatingActorId: canonicalScope.initiatingActorId,
    executingPrincipalType: canonicalScope.executingPrincipalType,
    executingPrincipalId: canonicalScope.executingPrincipalId,
    workspaceId: canonicalScope.workspaceId,
    projectId: canonicalScope.projectId,
    missionId: canonicalScope.missionId,
    delegationId: canonicalScope.delegationId,
    correlationId: canonicalScope.correlationId,
    causationId: canonicalScope.causationId,
    contextGrantCount: canonicalScope.contextGrantIds.length,
    contextGrantIdsSha256: claimEvidenceDigestV1(
      "context_grant_ids",
      canonicalScope.contextGrantIds,
    ),
    capabilityGrantCount: canonicalScope.capabilityGrantIds.length,
    capabilityGrantIdsSha256: claimEvidenceDigestV1(
      "capability_grant_ids",
      canonicalScope.capabilityGrantIds,
    ),
    purposeSha256: claimEvidenceDigestV1("purpose", canonicalScope.purpose),
    executionScopeSha256: claimEvidenceDigestV1(
      "execution_scope",
      canonicalScope,
    ),
  });
  return deepFreeze(
    executionScopeBindingV1Schema.parse({
      ...body,
      executionScopeBindingSha256: claimEvidenceDigestV1(
        "execution_scope_binding",
        body,
      ),
    }),
  );
}

const claimBindingBodySchema = z
  .object({
    runId: runContractIdSchema,
    answerId: runContractIdSchema,
    answerSha256: runContractSha256Schema,
    answerUtf16Length: boundedCountSchema.max(MAX_ANSWER_UTF16_CODE_UNITS),
    startUtf16: boundedCountSchema.max(MAX_ANSWER_UTF16_CODE_UNITS),
    endUtf16Exclusive: boundedCountSchema.max(MAX_ANSWER_UTF16_CODE_UNITS),
    claimSha256: runContractSha256Schema,
    materiality: claimMaterialitySchema,
  })
  .strict();

export const claimBindingV1Schema = claimBindingBodySchema
  .extend({
    claimId: runContractIdSchema,
    claimBindingSha256: runContractSha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startUtf16 >= value.endUtf16Exclusive ||
      value.endUtf16Exclusive > value.answerUtf16Length
    ) {
      context.addIssue({
        code: "custom",
        message: "Claim UTF-16 span is empty or outside its bound answer.",
        path: ["endUtf16Exclusive"],
      });
    }
    const { claimId, claimBindingSha256, ...body } = value;
    const expectedClaimId = `claim_${claimEvidenceDigestV1(
      "claim_binding",
      body,
    ).slice(0, 56)}`;
    if (claimId !== expectedClaimId) {
      context.addIssue({
        code: "custom",
        message: "Claim ID does not match its exact answer span binding.",
        path: ["claimId"],
      });
    }
    if (
      claimBindingSha256 !==
      claimEvidenceDigestV1("claim_binding", { ...body, claimId })
    ) {
      context.addIssue({
        code: "custom",
        message: "Claim binding digest does not match its body.",
        path: ["claimBindingSha256"],
      });
    }
  })
  .transform(freezeContractOutput);

export type ClaimBindingV1 = DeepReadonly<z.infer<typeof claimBindingV1Schema>>;

export type BuildClaimBindingV1Input = {
  runId: string;
  answerId: string;
  answerText: string;
  startUtf16: number;
  endUtf16Exclusive: number;
  materiality: z.infer<typeof claimMaterialitySchema>;
};

/**
 * Converts an exact UTF-16 answer span into a hash-only claim binding. Raw
 * answer and claim text are used transiently and never returned.
 */
export function buildClaimBindingV1(
  input: BuildClaimBindingV1Input,
): ClaimBindingV1 {
  const parsed = z
    .object({
      runId: runContractIdSchema,
      answerId: runContractIdSchema,
      answerText: z.string().max(MAX_ANSWER_UTF16_CODE_UNITS),
      startUtf16: boundedCountSchema.max(MAX_ANSWER_UTF16_CODE_UNITS),
      endUtf16Exclusive: boundedCountSchema.max(
        MAX_ANSWER_UTF16_CODE_UNITS,
      ),
      materiality: claimMaterialitySchema,
    })
    .strict()
    .parse(input);
  const answer = buildAnswerBindingV1({
    answerId: parsed.answerId,
    answerText: parsed.answerText,
  });
  return buildClaimBindingFromAnswerV1({
    runId: parsed.runId,
    answer,
    answerText: parsed.answerText,
    startUtf16: parsed.startUtf16,
    endUtf16Exclusive: parsed.endUtf16Exclusive,
    materiality: parsed.materiality,
  });
}

function buildClaimBindingFromAnswerV1(input: {
  runId: string;
  answer: AnswerBindingV1;
  answerText: string;
  startUtf16: number;
  endUtf16Exclusive: number;
  materiality: z.infer<typeof claimMaterialitySchema>;
}): ClaimBindingV1 {
  if (
    input.answer.answerUtf16Length !== input.answerText.length ||
    input.startUtf16 >= input.endUtf16Exclusive ||
    input.endUtf16Exclusive > input.answerText.length
  ) {
    throw new Error("Claim UTF-16 span is empty or outside the answer.");
  }
  if (
    !isExactUtf16Boundary(input.answerText, input.startUtf16) ||
    !isExactUtf16Boundary(input.answerText, input.endUtf16Exclusive)
  ) {
    throw new Error("Claim span cannot split a UTF-16 surrogate pair.");
  }
  const body = claimBindingBodySchema.parse({
    runId: input.runId,
    ...input.answer,
    startUtf16: input.startUtf16,
    endUtf16Exclusive: input.endUtf16Exclusive,
    claimSha256: claimEvidenceDigestV1(
      "claim_text",
      input.answerText.slice(input.startUtf16, input.endUtf16Exclusive),
    ),
    materiality: input.materiality,
  });
  const claimId = `claim_${claimEvidenceDigestV1(
    "claim_binding",
    body,
  ).slice(0, 56)}`;
  return deepFreeze(
    claimBindingV1Schema.parse({
      ...body,
      claimId,
      claimBindingSha256: claimEvidenceDigestV1("claim_binding", {
        ...body,
        claimId,
      }),
    }),
  );
}

export const evidenceProvenanceKindSchema = z.enum([
  "external_source",
  "user_assertion",
  "captured_observation",
  "verified_tool_effect",
]);

export const evidenceProvenanceV1Schema = z
  .object({
    kind: evidenceProvenanceKindSchema,
    originRunId: nullableIdSchema,
    originReceiptId: nullableIdSchema,
    originReceiptSha256: runContractSha256Schema.nullable(),
    originAnswerId: nullableIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.originAnswerId !== null) {
      context.addIssue({
        code: "custom",
        message: "Generated output, including self lineage, cannot be evidence.",
        path: ["originAnswerId"],
      });
    }
    const hasEffectOrigin =
      value.originRunId !== null &&
      value.originReceiptId !== null &&
      value.originReceiptSha256 !== null;
    if (value.kind === "verified_tool_effect" && !hasEffectOrigin) {
      context.addIssue({
        code: "custom",
        message: "Verified tool-effect provenance requires its run and receipt.",
        path: ["kind"],
      });
    }
    if (
      value.kind !== "verified_tool_effect" &&
      (value.originReceiptId !== null || value.originReceiptSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only verified tool effects may carry an effect receipt.",
        path: ["originReceiptId"],
      });
    }
  })
  .transform(freezeContractOutput);

export type EvidenceProvenanceV1 = DeepReadonly<
  z.infer<typeof evidenceProvenanceV1Schema>
>;

const evidenceUnitSnapshotBodySchema = z
  .object({
    evidenceUnitSchemaVersion: z.literal(1),
    evidenceUnitId: runContractIdSchema,
    evidenceUnitSha256: runContractSha256Schema,
    tenantId: runContractIdSchema,
    ownerActorId: runContractIdSchema,
    workspaceId: nullableIdSchema,
    projectId: nullableIdSchema,
    missionId: nullableIdSchema,
    connectionId: runContractIdSchema,
    sourceItemId: runContractIdSchema,
    sourceRevisionId: runContractIdSchema,
    sourceKind: z.enum([
      "document",
      "spreadsheet",
      "presentation",
      "email",
      "calendar_event",
      "message",
      "webpage",
      "image",
      "audio",
      "video",
      "record",
      "file",
      "capture",
    ]),
    visibility: z.enum([
      "agent_private",
      "user_private",
      "mission_shared",
      "project_shared",
      "workspace_shared",
    ]),
    sensitivity: z.enum([
      "public",
      "internal",
      "confidential",
      "restricted",
    ]),
    permissionSetSha256: runContractSha256Schema,
    purposeSetSha256: runContractSha256Schema,
    retentionPolicyId: runContractIdSchema,
    retentionExpiresAt: nullableTimestampSchema,
    evidenceContentSha256: runContractSha256Schema,
    evidenceByteLength: boundedCountSchema,
    locatorSha256: runContractSha256Schema,
    sourceCreatedAt: nullableTimestampSchema,
    sourceUpdatedAt: nullableTimestampSchema,
    capturedAt: sourceTimestampSchema,
    extractedAt: sourceTimestampSchema,
    provenance: evidenceProvenanceV1Schema,
  })
  .strict();

const evidenceUnitSnapshotValidatedSchema = evidenceUnitSnapshotBodySchema
  .extend({
    evidenceSnapshotSha256: runContractSha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.capturedAt > value.extractedAt) {
      context.addIssue({
        code: "custom",
        message: "Evidence extraction cannot predate capture.",
        path: ["extractedAt"],
      });
    }
    const { evidenceSnapshotSha256, ...body } = value;
    if (
      evidenceSnapshotSha256 !==
      claimEvidenceDigestV1("evidence_snapshot", body)
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence snapshot digest does not match its body.",
        path: ["evidenceSnapshotSha256"],
      });
    }
  });

/** Bounded public parser for received evidence-unit snapshots. */
export const evidenceUnitSnapshotV1Schema = z
  .preprocess((value, context) => {
    try {
      preflightEvidenceUnitSnapshotV1(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Evidence snapshot failed bounded plain-data preflight.",
      });
      return z.NEVER;
    }
    return value;
  }, evidenceUnitSnapshotValidatedSchema)
  .transform(freezeContractOutput);

export type EvidenceUnitSnapshotV1 = DeepReadonly<
  z.infer<typeof evidenceUnitSnapshotV1Schema>
>;

export type BuildEvidenceUnitSnapshotV1Input = {
  evidenceUnit: EvidenceUnitV1;
  provenance: EvidenceProvenanceV1;
};

/** Builds a compact snapshot only after validating the complete EvidenceUnitV1. */
export function buildEvidenceUnitSnapshotV1(
  input: BuildEvidenceUnitSnapshotV1Input,
): EvidenceUnitSnapshotV1 {
  preflightBuildEvidenceUnitSnapshotV1Input(input);
  const parsed = z
    .object({
      evidenceUnit: evidenceUnitV1Schema,
      provenance: evidenceProvenanceV1Schema,
    })
    .strict()
    .parse(input);
  const unit = parsed.evidenceUnit;
  const body = evidenceUnitSnapshotBodySchema.parse({
    evidenceUnitSchemaVersion: unit.schemaVersion,
    evidenceUnitId: unit.evidenceUnitId,
    evidenceUnitSha256: unit.evidenceUnitSha256,
    tenantId: unit.tenantId,
    ownerActorId: unit.ownerActorId,
    workspaceId: unit.workspaceId,
    projectId: unit.projectId,
    missionId: unit.missionId,
    connectionId: unit.connectionId,
    sourceItemId: unit.sourceItemId,
    sourceRevisionId: unit.sourceRevisionId,
    sourceKind: unit.sourceKind,
    visibility: unit.visibility,
    sensitivity: unit.sensitivity,
    permissionSetSha256: unit.permissionSetSha256,
    purposeSetSha256: unit.purposeSetSha256,
    retentionPolicyId: unit.retentionPolicyId,
    retentionExpiresAt: unit.retentionExpiresAt,
    evidenceContentSha256: unit.evidenceContentSha256,
    evidenceByteLength: unit.evidenceByteLength,
    locatorSha256: unit.locatorSha256,
    sourceCreatedAt: unit.sourceCreatedAt,
    sourceUpdatedAt: unit.sourceUpdatedAt,
    capturedAt: unit.capturedAt,
    extractedAt: unit.extractedAt,
    provenance: parsed.provenance,
  });
  return deepFreeze(
    evidenceUnitSnapshotV1Schema.parse({
      ...body,
      evidenceSnapshotSha256: claimEvidenceDigestV1(
        "evidence_snapshot",
        body,
      ),
    }),
  );
}

const authorizationPolicyBindingBodySchema = z
  .object({
    authorizationAuthorityId: runContractIdSchema,
    authorizationResolverId: runContractIdSchema,
    authorizationResolverVersionId: runContractIdSchema,
    authorizationPolicyId: runContractIdSchema,
    authorizationPolicyVersionId: runContractIdSchema,
    authorizationPolicySha256: runContractSha256Schema,
  })
  .strict();

export const authorizationPolicyBindingV1Schema =
  authorizationPolicyBindingBodySchema
    .extend({
      authorizationPolicyBindingSha256: runContractSha256Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const { authorizationPolicyBindingSha256, ...body } = value;
      if (
        authorizationPolicyBindingSha256 !==
        claimEvidenceDigestV1("authorization_policy_binding", body)
      ) {
        context.addIssue({
          code: "custom",
          message: "Authorization-policy binding digest does not match.",
          path: ["authorizationPolicyBindingSha256"],
        });
      }
    })
    .transform(freezeContractOutput);

export type AuthorizationPolicyBindingV1 = DeepReadonly<
  z.infer<typeof authorizationPolicyBindingV1Schema>
>;

export type BuildAuthorizationPolicyBindingV1Input = z.infer<
  typeof authorizationPolicyBindingBodySchema
>;

export function buildAuthorizationPolicyBindingV1(
  input: BuildAuthorizationPolicyBindingV1Input,
): AuthorizationPolicyBindingV1 {
  const body = authorizationPolicyBindingBodySchema.parse(input);
  return deepFreeze(
    authorizationPolicyBindingV1Schema.parse({
      ...body,
      authorizationPolicyBindingSha256: claimEvidenceDigestV1(
        "authorization_policy_binding",
        body,
      ),
    }),
  );
}

export const evidenceAuthorizationStateSchema = z.enum([
  "authorized",
  "denied",
  "revoked",
]);

const evidenceAuthorizationDecisionBodySchema = z
  .object({
    schemaVersion: z.literal(CLAIM_EVIDENCE_MAP_SCHEMA_VERSION),
    receiptKind: z.literal("evidence_authorization_decision"),
    runId: runContractIdSchema,
    purposeId: runContractIdSchema,
    purposeIdSha256: runContractSha256Schema,
    executionScope: executionScopeBindingV1Schema,
    authorizationPolicy: authorizationPolicyBindingV1Schema,
    evidenceTenantId: runContractIdSchema,
    evidenceUnitId: runContractIdSchema,
    evidenceUnitSha256: runContractSha256Schema,
    evidenceSnapshotSha256: runContractSha256Schema,
    decisionState: evidenceAuthorizationStateSchema,
    decisionBasisSha256: runContractSha256Schema,
    decidedAt: sourceTimestampSchema,
    notBefore: sourceTimestampSchema,
    expiresAt: sourceTimestampSchema,
    revokedAt: nullableTimestampSchema,
  })
  .strict();

const evidenceAuthorizationDecisionIdentitySchema =
  evidenceAuthorizationDecisionBodySchema.extend({
    authorizationDecisionId: runContractIdSchema,
  }).strict();

const evidenceAuthorizationDecisionReceiptValidatedSchema =
  evidenceAuthorizationDecisionIdentitySchema
    .extend({
      authorizationDecisionSha256: runContractSha256Schema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.evidenceTenantId !== value.executionScope.tenantId) {
        context.addIssue({
          code: "custom",
          message: "Authorization decision cannot cross tenant boundaries.",
          path: ["evidenceTenantId"],
        });
      }
      if (
        value.purposeIdSha256 !==
        claimEvidenceDigestV1("canonical_purpose", value.purposeId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Authorization purpose digest does not match its purpose ID.",
          path: ["purposeIdSha256"],
        });
      }
      if (value.notBefore >= value.expiresAt) {
        context.addIssue({
          code: "custom",
          message: "Authorization validity must be a non-empty half-open window.",
          path: ["expiresAt"],
        });
      }
      if (value.decidedAt >= value.expiresAt) {
        context.addIssue({
          code: "custom",
          message: "Authorization must be decided before its expiry.",
          path: ["decidedAt"],
        });
      }
      if (
        value.decisionState === "revoked" &&
        (value.revokedAt === null || value.revokedAt < value.decidedAt)
      ) {
        context.addIssue({
          code: "custom",
          message: "A revoked decision requires a valid revocation timestamp.",
          path: ["revokedAt"],
        });
      }
      if (value.decisionState !== "revoked" && value.revokedAt !== null) {
        context.addIssue({
          code: "custom",
          message: "Only a revoked decision may include revokedAt.",
          path: ["revokedAt"],
        });
      }
      const {
        authorizationDecisionId,
        authorizationDecisionSha256,
        ...body
      } = value;
      const expectedId = `evidence_auth_${claimEvidenceDigestV1(
        "authorization_decision_identity",
        body,
      ).slice(0, 56)}`;
      if (authorizationDecisionId !== expectedId) {
        context.addIssue({
          code: "custom",
          message: "Authorization-decision ID does not match its binding.",
          path: ["authorizationDecisionId"],
        });
      }
      if (
        authorizationDecisionSha256 !==
        claimEvidenceDigestV1("authorization_decision_receipt", {
          ...body,
          authorizationDecisionId,
        })
      ) {
        context.addIssue({
          code: "custom",
          message: "Authorization-decision digest does not match its receipt.",
          path: ["authorizationDecisionSha256"],
        });
      }
      addByteLimitIssue(
        value,
        MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
        context,
        "Authorization decision",
      );
    });

/** Bounded public parser for received authorization-decision receipts. */
export const evidenceAuthorizationDecisionReceiptV1Schema = z
  .preprocess((value, context) => {
    try {
      preflightEvidenceAuthorizationDecisionReceiptV1(value);
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Evidence authorization decision failed bounded plain-data preflight.",
      });
      return z.NEVER;
    }
    return value;
  }, evidenceAuthorizationDecisionReceiptValidatedSchema)
  .transform(freezeContractOutput);

export type EvidenceAuthorizationDecisionReceiptV1 = DeepReadonly<
  z.infer<typeof evidenceAuthorizationDecisionReceiptV1Schema>
>;

export type BuildEvidenceAuthorizationDecisionReceiptV1Input = {
  runId: string;
  purposeId: string;
  executionScope: ExecutionScope;
  authorizationPolicy: AuthorizationPolicyBindingV1;
  evidence: EvidenceUnitSnapshotV1;
  decisionState: z.infer<typeof evidenceAuthorizationStateSchema>;
  decisionBasisSha256: string;
  decidedAt: string;
  notBefore: string;
  expiresAt: string;
  revokedAt: string | null;
};

/**
 * Serializes an already-resolved authorization decision. The caller remains
 * responsible for trusting the authority/resolver; this module only binds and
 * validates the supplied decision.
 */
export function buildEvidenceAuthorizationDecisionReceiptV1(
  input: BuildEvidenceAuthorizationDecisionReceiptV1Input,
): EvidenceAuthorizationDecisionReceiptV1 {
  const scope = buildExecutionScopeBindingV1(input.executionScope);
  const policy = authorizationPolicyBindingV1Schema.parse(
    input.authorizationPolicy,
  );
  const evidence = evidenceUnitSnapshotV1Schema.parse(input.evidence);
  const decidedAt = sourceTimestampSchema.parse(input.decidedAt);
  if (evidence.capturedAt > decidedAt || evidence.extractedAt > decidedAt) {
    throw new Error(
      "Authorization decision cannot predate captured and extracted evidence.",
    );
  }
  if (
    evidence.retentionExpiresAt !== null &&
    decidedAt >= evidence.retentionExpiresAt
  ) {
    throw new Error(
      "Authorization decision cannot authorize retention-expired evidence.",
    );
  }
  const body = evidenceAuthorizationDecisionBodySchema.parse({
    schemaVersion: CLAIM_EVIDENCE_MAP_SCHEMA_VERSION,
    receiptKind: "evidence_authorization_decision",
    runId: input.runId,
    purposeId: input.purposeId,
    purposeIdSha256: claimEvidenceDigestV1(
      "canonical_purpose",
      runContractIdSchema.parse(input.purposeId),
    ),
    executionScope: scope,
    authorizationPolicy: policy,
    evidenceTenantId: evidence.tenantId,
    evidenceUnitId: evidence.evidenceUnitId,
    evidenceUnitSha256: evidence.evidenceUnitSha256,
    evidenceSnapshotSha256: evidence.evidenceSnapshotSha256,
    decisionState: input.decisionState,
    decisionBasisSha256: input.decisionBasisSha256,
    decidedAt,
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
  });
  const authorizationDecisionId = `evidence_auth_${claimEvidenceDigestV1(
    "authorization_decision_identity",
    body,
  ).slice(0, 56)}`;
  return deepFreeze(
    evidenceAuthorizationDecisionReceiptV1Schema.parse({
      ...body,
      authorizationDecisionId,
      authorizationDecisionSha256: claimEvidenceDigestV1(
        "authorization_decision_receipt",
        { ...body, authorizationDecisionId },
      ),
    }),
  );
}

const semanticEvidenceBindingV1Schema = z
  .object({
    evidenceUnitId: runContractIdSchema,
    evidenceUnitSha256: runContractSha256Schema,
    evidenceSnapshotSha256: runContractSha256Schema,
    authorizationDecisionId: runContractIdSchema,
    authorizationDecisionSha256: runContractSha256Schema,
  })
  .strict();

export const semanticAssessmentVerdictSchema = z.enum([
  "supports",
  "contradicts",
  "insufficient",
]);
export const semanticSupportModeSchema = z.enum([
  "direct",
  "inference",
  "none",
]);
export const semanticAssessmentLifecycleSchema = z.enum([
  "current",
  "superseded",
]);

const semanticAssessmentBodySchema = z
  .object({
    schemaVersion: z.literal(CLAIM_EVIDENCE_MAP_SCHEMA_VERSION),
    receiptKind: z.literal("claim_semantic_assessment"),
    runId: runContractIdSchema,
    purposeId: runContractIdSchema,
    evidenceTenantId: runContractIdSchema,
    executionScope: executionScopeBindingV1Schema,
    authorizationPolicy: authorizationPolicyBindingV1Schema,
    claim: claimBindingV1Schema,
    evidenceBindings: z
      .array(semanticEvidenceBindingV1Schema)
      .min(1)
      .max(MAX_CLAIM_EVIDENCE_UNITS),
    evidenceSetSha256: runContractSha256Schema,
    inferenceParentClaimIds: canonicalIdList(MAX_INFERENCE_PARENTS),
    verifierId: runContractIdSchema,
    verifierVersionId: runContractIdSchema,
    method: semanticAssessmentMethodSchema,
    methodVersionId: runContractIdSchema,
    verdict: semanticAssessmentVerdictSchema,
    supportMode: semanticSupportModeSchema,
    confidenceBps: basisPointsSchema,
    assessedAt: sourceTimestampSchema,
    validFrom: sourceTimestampSchema,
    validUntilExclusive: nullableTimestampSchema,
    lifecycleState: semanticAssessmentLifecycleSchema,
    supersededAt: nullableTimestampSchema,
  })
  .strict();

const semanticAssessmentIdentitySchema = semanticAssessmentBodySchema
  .extend({
    semanticAssessmentId: runContractIdSchema,
  })
  .strict();

const claimSemanticAssessmentReceiptValidatedSchema =
  semanticAssessmentIdentitySchema
    .extend({
      semanticAssessmentSha256: runContractSha256Schema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.claim.runId !== value.runId) {
        context.addIssue({
          code: "custom",
          message: "Semantic assessment claim must match its exact run.",
          path: ["claim", "runId"],
        });
      }
      if (value.evidenceTenantId !== value.executionScope.tenantId) {
        context.addIssue({
          code: "custom",
          message: "Semantic assessment cannot cross tenant boundaries.",
          path: ["evidenceTenantId"],
        });
      }
      value.evidenceBindings.forEach((binding, index) => {
        if (
          index > 0 &&
          value.evidenceBindings[index - 1].evidenceUnitId >=
            binding.evidenceUnitId
        ) {
          context.addIssue({
            code: "custom",
            message: "Assessment evidence must be unique and canonically ordered.",
            path: ["evidenceBindings", index],
          });
        }
      });
      if (
        value.evidenceSetSha256 !==
        claimEvidenceDigestV1(
          "assessment_evidence_set",
          value.evidenceBindings,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Assessment evidence-set digest does not match.",
          path: ["evidenceSetSha256"],
        });
      }
      if (
        value.validUntilExclusive !== null &&
        value.validFrom >= value.validUntilExclusive
      ) {
        context.addIssue({
          code: "custom",
          message: "Assessment validity must be a non-empty half-open window.",
          path: ["validUntilExclusive"],
        });
      }
      if (
        value.lifecycleState === "superseded" &&
        (value.supersededAt === null || value.supersededAt < value.assessedAt)
      ) {
        context.addIssue({
          code: "custom",
          message: "Superseded semantic evidence requires supersededAt.",
          path: ["supersededAt"],
        });
      }
      if (
        value.lifecycleState === "current" &&
        value.supersededAt !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Current semantic evidence cannot include supersededAt.",
          path: ["supersededAt"],
        });
      }
      if (
        value.supportMode === "inference" &&
        value.inferenceParentClaimIds.length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Inference support requires at least one parent claim.",
          path: ["inferenceParentClaimIds"],
        });
      }
      if (
        value.supportMode !== "inference" &&
        value.inferenceParentClaimIds.length !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Only inference support may name parent claims.",
          path: ["inferenceParentClaimIds"],
        });
      }
      if (
        (value.verdict === "supports") !==
        (value.supportMode === "direct" || value.supportMode === "inference")
      ) {
        context.addIssue({
          code: "custom",
          message: "Support verdict and support mode are inconsistent.",
          path: ["supportMode"],
        });
      }
      if (value.verdict !== "supports" && value.supportMode !== "none") {
        context.addIssue({
          code: "custom",
          message: "Non-support verdicts must use support mode none.",
          path: ["supportMode"],
        });
      }
      if (value.verdict !== "insufficient" && value.confidenceBps === 0) {
        context.addIssue({
          code: "custom",
          message: "Support and contradiction assertions require non-zero confidence.",
          path: ["confidenceBps"],
        });
      }
      const {
        semanticAssessmentId,
        semanticAssessmentSha256,
        ...body
      } = value;
      const expectedId = `claim_assessment_${claimEvidenceDigestV1(
        "semantic_assessment_identity",
        body,
      ).slice(0, 56)}`;
      if (semanticAssessmentId !== expectedId) {
        context.addIssue({
          code: "custom",
          message: "Semantic-assessment ID does not match its bindings.",
          path: ["semanticAssessmentId"],
        });
      }
      if (
        semanticAssessmentSha256 !==
        claimEvidenceDigestV1("semantic_assessment_receipt", {
          ...body,
          semanticAssessmentId,
        })
      ) {
        context.addIssue({
          code: "custom",
          message: "Semantic-assessment digest does not match its receipt.",
          path: ["semanticAssessmentSha256"],
        });
      }
      addByteLimitIssue(
        value,
        MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
        context,
        "Semantic assessment",
      );
    });

/** Bounded public parser for received semantic-assessment receipts. */
export const claimSemanticAssessmentReceiptV1Schema = z
  .preprocess((value, context) => {
    try {
      preflightClaimSemanticAssessmentReceiptV1(value);
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Claim semantic assessment failed bounded plain-data preflight.",
      });
      return z.NEVER;
    }
    return value;
  }, claimSemanticAssessmentReceiptValidatedSchema)
  .transform(freezeContractOutput);

export type ClaimSemanticAssessmentReceiptV1 = DeepReadonly<
  z.infer<typeof claimSemanticAssessmentReceiptV1Schema>
>;

export type BuildClaimSemanticAssessmentReceiptV1Input = {
  claim: ClaimBindingV1;
  evidence: readonly EvidenceUnitSnapshotV1[];
  authorizationDecisions: readonly EvidenceAuthorizationDecisionReceiptV1[];
  inferenceParentClaimIds: readonly string[];
  verifierId: string;
  verifierVersionId: string;
  method: SemanticAssessmentMethodV1;
  methodVersionId: string;
  verdict: z.infer<typeof semanticAssessmentVerdictSchema>;
  supportMode: z.infer<typeof semanticSupportModeSchema>;
  confidenceBps: number;
  assessedAt: string;
  validFrom: string;
  validUntilExclusive: string | null;
  lifecycleState: z.infer<typeof semanticAssessmentLifecycleSchema>;
  supersededAt: string | null;
};

/** Records a semantic verifier's assertion; it does not reproduce that work. */
export function buildClaimSemanticAssessmentReceiptV1(
  input: BuildClaimSemanticAssessmentReceiptV1Input,
): ClaimSemanticAssessmentReceiptV1 {
  assertBoundedInputArray(
    input.evidence,
    MAX_CLAIM_EVIDENCE_UNITS,
    "semantic assessment evidence",
  );
  assertBoundedInputArray(
    input.authorizationDecisions,
    MAX_CLAIM_EVIDENCE_UNITS,
    "semantic assessment authorization decisions",
  );
  assertBoundedInputArray(
    input.inferenceParentClaimIds,
    MAX_INFERENCE_PARENTS,
    "inference parents",
  );
  if (input.evidence.length === 0) {
    throw new Error("Semantic assessment requires at least one evidence unit.");
  }
  const claim = claimBindingV1Schema.parse(input.claim);
  const assessedAt = sourceTimestampSchema.parse(input.assessedAt);
  const authorizationDecisions = input.authorizationDecisions.map((candidate) =>
    evidenceAuthorizationDecisionReceiptV1Schema.parse(candidate),
  );
  const authorizationContext = authorizationDecisions[0];
  if (!authorizationContext) {
    throw new Error(
      "Semantic assessment requires the exact authorization decision for every evidence unit.",
    );
  }
  const authorizationByEvidence = new Map<
    string,
    EvidenceAuthorizationDecisionReceiptV1
  >();
  for (const decision of authorizationDecisions) {
    if (
      decision.runId !== authorizationContext.runId ||
      decision.purposeId !== authorizationContext.purposeId ||
      decision.evidenceTenantId !== authorizationContext.evidenceTenantId ||
      !sameJson(decision.executionScope, authorizationContext.executionScope) ||
      !sameJson(
        decision.authorizationPolicy,
        authorizationContext.authorizationPolicy,
      )
    ) {
      throw new Error(
        "Semantic assessment authorization decisions must share one run, tenant, purpose, scope, and policy.",
      );
    }
    if (authorizationByEvidence.has(decision.evidenceUnitId)) {
      throw new Error(
        "Semantic assessment authorization decisions must be unique by evidence unit.",
      );
    }
    authorizationByEvidence.set(decision.evidenceUnitId, decision);
  }
  const evidenceBindings = input.evidence
    .map((item) => evidenceUnitSnapshotV1Schema.parse(item))
    .sort(compareEvidenceSnapshots)
    .map((item) => {
      const decision = authorizationByEvidence.get(item.evidenceUnitId);
      if (!decision) {
        throw new Error(
          "Semantic assessment requires the exact authorization decision for every evidence unit.",
        );
      }
      if (
        decision.evidenceTenantId !== item.tenantId ||
        decision.evidenceUnitSha256 !== item.evidenceUnitSha256 ||
        decision.evidenceSnapshotSha256 !== item.evidenceSnapshotSha256
      ) {
        throw new Error(
          "Semantic assessment authorization is bound to different evidence.",
        );
      }
      if (
        decision.runId !== claim.runId ||
        decision.decisionState !== "authorized" ||
        decision.decidedAt > assessedAt ||
        assessedAt < decision.notBefore ||
        assessedAt >= decision.expiresAt
      ) {
        throw new Error(
          "Semantic assessment requires authorization active for its exact run.",
        );
      }
      if (item.capturedAt > assessedAt || item.extractedAt > assessedAt) {
        throw new Error(
          "Semantic assessment cannot predate captured and extracted evidence.",
        );
      }
      if (
        item.retentionExpiresAt !== null &&
        assessedAt >= item.retentionExpiresAt
      ) {
        throw new Error(
          "Semantic assessment cannot use retention-expired evidence.",
        );
      }
      if (
        input.method === "verified_effect_postcondition" &&
        item.provenance.kind !== "verified_tool_effect"
      ) {
        throw new Error(
          "Verified effect postconditions require verified tool-effect evidence.",
        );
      }
      return {
        evidenceUnitId: item.evidenceUnitId,
        evidenceUnitSha256: item.evidenceUnitSha256,
        evidenceSnapshotSha256: item.evidenceSnapshotSha256,
        authorizationDecisionId: decision.authorizationDecisionId,
        authorizationDecisionSha256: decision.authorizationDecisionSha256,
      };
    });
  if (authorizationByEvidence.size !== evidenceBindings.length) {
    throw new Error(
      "Semantic assessment authorization decisions must exactly match its evidence set.",
    );
  }
  const inferenceParentClaimIds = [...input.inferenceParentClaimIds].sort(
    compareIds,
  );
  const body = semanticAssessmentBodySchema.parse({
    schemaVersion: CLAIM_EVIDENCE_MAP_SCHEMA_VERSION,
    receiptKind: "claim_semantic_assessment",
    runId: claim.runId,
    purposeId: authorizationContext.purposeId,
    evidenceTenantId: authorizationContext.evidenceTenantId,
    executionScope: authorizationContext.executionScope,
    authorizationPolicy: authorizationContext.authorizationPolicy,
    claim,
    evidenceBindings,
    evidenceSetSha256: claimEvidenceDigestV1(
      "assessment_evidence_set",
      evidenceBindings,
    ),
    inferenceParentClaimIds,
    verifierId: input.verifierId,
    verifierVersionId: input.verifierVersionId,
    method: input.method,
    methodVersionId: input.methodVersionId,
    verdict: input.verdict,
    supportMode: input.supportMode,
    confidenceBps: input.confidenceBps,
    assessedAt,
    validFrom: input.validFrom,
    validUntilExclusive: input.validUntilExclusive,
    lifecycleState: input.lifecycleState,
    supersededAt: input.supersededAt,
  });
  assertCanonicalJsonByteLimit(
    body,
    MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
    "Semantic assessment body",
  );
  const semanticAssessmentId = `claim_assessment_${claimEvidenceDigestV1(
    "semantic_assessment_identity",
    body,
  ).slice(0, 56)}`;
  return deepFreeze(
    claimSemanticAssessmentReceiptV1Schema.parse({
      ...body,
      semanticAssessmentId,
      semanticAssessmentSha256: claimEvidenceDigestV1(
        "semantic_assessment_receipt",
        { ...body, semanticAssessmentId },
      ),
    }),
  );
}

export const claimDecompositionMethodSchema = z.enum([
  "human",
  "deterministic",
  "model_assisted",
]);

export const claimDecompositionBindingV1Schema = z
  .object({
    decomposerId: runContractIdSchema,
    decomposerVersionId: runContractIdSchema,
    method: claimDecompositionMethodSchema,
    methodVersionId: runContractIdSchema,
    policySha256: runContractSha256Schema,
    decomposedAt: sourceTimestampSchema,
  })
  .strict()
  .transform(freezeContractOutput);

export type ClaimDecompositionBindingV1 = DeepReadonly<
  z.infer<typeof claimDecompositionBindingV1Schema>
>;

export const claimSupportReasonSchema = z.enum([
  "current_strong_contradiction",
  "current_strong_direct_support",
  "current_bounded_inference",
  "expired_or_superseded_support",
  "no_admissible_current_support",
]);

const claimSupportResultValidatedSchema = z
  .object({
    claim: claimBindingV1Schema,
    inferenceParentClaimIds: canonicalIdList(MAX_INFERENCE_PARENTS),
    semanticAssessmentIds: canonicalIdList(
      MAX_CLAIM_SEMANTIC_ASSESSMENTS,
    ),
    consideredEvidenceUnitIds: canonicalIdList(MAX_CLAIM_EVIDENCE_UNITS),
    currentSupportAssertionEvidenceUnitIds: canonicalIdList(
      MAX_CLAIM_EVIDENCE_UNITS,
    ),
    currentContradictionAssertionEvidenceUnitIds: canonicalIdList(
      MAX_CLAIM_EVIDENCE_UNITS,
    ),
    staleSupportAssertionEvidenceUnitIds: canonicalIdList(
      MAX_CLAIM_EVIDENCE_UNITS,
    ),
    staleContradictionAssertionEvidenceUnitIds: canonicalIdList(
      MAX_CLAIM_EVIDENCE_UNITS,
    ),
    supportState: claimSupportStateSchema,
    supportReason: claimSupportReasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedReasonByState = {
      supported: "current_strong_direct_support",
      inferred: "current_bounded_inference",
      disputed: "current_strong_contradiction",
      stale: "expired_or_superseded_support",
      unsupported: "no_admissible_current_support",
    } as const;
    if (value.supportReason !== expectedReasonByState[value.supportState]) {
      context.addIssue({
        code: "custom",
        message: "Claim support state and reason are inconsistent.",
        path: ["supportReason"],
      });
    }
    if (
      (value.semanticAssessmentIds.length === 0) !==
      (value.consideredEvidenceUnitIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Assessment identities and considered evidence must be present together.",
        path: ["consideredEvidenceUnitIds"],
      });
    }
    const considered = new Set(value.consideredEvidenceUnitIds);
    for (const [field, evidenceIds] of [
      [
        "currentSupportAssertionEvidenceUnitIds",
        value.currentSupportAssertionEvidenceUnitIds,
      ],
      [
        "currentContradictionAssertionEvidenceUnitIds",
        value.currentContradictionAssertionEvidenceUnitIds,
      ],
      [
        "staleSupportAssertionEvidenceUnitIds",
        value.staleSupportAssertionEvidenceUnitIds,
      ],
      [
        "staleContradictionAssertionEvidenceUnitIds",
        value.staleContradictionAssertionEvidenceUnitIds,
      ],
    ] as const) {
      evidenceIds.forEach((evidenceId, index) => {
        if (!considered.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            message: "Assertion evidence must be part of considered evidence.",
            path: [field, index],
          });
        }
      });
    }
    if (
      value.currentContradictionAssertionEvidenceUnitIds.length > 0 &&
      value.supportState !== "disputed"
    ) {
      context.addIssue({
        code: "custom",
        message: "Current strong contradiction must produce disputed state.",
        path: ["supportState"],
      });
    }
    if (
      value.supportState === "supported" &&
      value.currentSupportAssertionEvidenceUnitIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Supported state requires current support evidence.",
        path: ["currentSupportAssertionEvidenceUnitIds"],
      });
    }
    if (
      value.supportState === "inferred" &&
      (value.inferenceParentClaimIds.length === 0 ||
        value.currentSupportAssertionEvidenceUnitIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Inferred state requires parents and current support evidence.",
        path: ["inferenceParentClaimIds"],
      });
    }
    if (
      value.supportState === "disputed" &&
      value.currentContradictionAssertionEvidenceUnitIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Disputed state requires current contradiction evidence.",
        path: ["currentContradictionAssertionEvidenceUnitIds"],
      });
    }
    if (
      value.supportState === "stale" &&
      value.staleSupportAssertionEvidenceUnitIds.length === 0 &&
      value.currentSupportAssertionEvidenceUnitIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Stale state requires stale support or a current inference over stale parents.",
        path: ["staleSupportAssertionEvidenceUnitIds"],
      });
    }
  });

/** Bounded public parser for one derived claim-support result. */
export const claimSupportResultV1Schema = z
  .preprocess((value, context) => {
    try {
      preflightClaimSupportResultV1(value);
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Claim-support result failed bounded plain-data preflight.",
      });
      return z.NEVER;
    }
    return value;
  }, claimSupportResultValidatedSchema)
  .transform(freezeContractOutput);

export type ClaimSupportResultV1 = DeepReadonly<
  z.infer<typeof claimSupportResultV1Schema>
>;

export const claimCoverageV1Schema = z
  .object({
    basis: z.literal("declared_claim_set"),
    state: z.enum(["applicable", "not_applicable"]),
    materialClaimCount: boundedCountSchema.max(MAX_CLAIM_EVIDENCE_CLAIMS),
    supportedMaterialClaimCount: boundedCountSchema.max(
      MAX_CLAIM_EVIDENCE_CLAIMS,
    ),
    coverageBps: basisPointsSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.supportedMaterialClaimCount > value.materialClaimCount) {
      context.addIssue({
        code: "custom",
        message: "Supported material claims cannot exceed material claims.",
        path: ["supportedMaterialClaimCount"],
      });
    }
    if (
      value.materialClaimCount === 0 &&
      (value.state !== "not_applicable" || value.coverageBps !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Zero material claims require not_applicable/null coverage.",
        path: ["state"],
      });
    }
    if (
      value.materialClaimCount > 0 &&
      (value.state !== "applicable" || value.coverageBps === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Material claims require applicable numeric coverage.",
        path: ["state"],
      });
    }
    if (
      value.materialClaimCount > 0 &&
      value.coverageBps !== null &&
      value.coverageBps !==
        calculateCoverageBps(
          value.supportedMaterialClaimCount,
          value.materialClaimCount,
        )
    ) {
      context.addIssue({
        code: "custom",
        message: "Coverage must equal the deterministic half-up ratio.",
        path: ["coverageBps"],
      });
    }
  })
  .transform(freezeContractOutput);

const claimEvidenceMapBodySchema = z
  .object({
    schemaVersion: z.literal(CLAIM_EVIDENCE_MAP_SCHEMA_VERSION),
    contractKind: z.literal("claim_evidence_map"),
    runId: runContractIdSchema,
    purposeId: runContractIdSchema,
    answer: answerBindingV1Schema,
    executionScope: executionScopeBindingV1Schema,
    asOfTime: sourceTimestampSchema,
    evaluatedAt: sourceTimestampSchema,
    recordedAt: sourceTimestampSchema,
    claimDecomposition: claimDecompositionBindingV1Schema,
    authorizationPolicy: authorizationPolicyBindingV1Schema,
    authorizationBoundary: z.literal("pre_resolved_decision_receipts"),
    semanticVerificationBoundary: z.literal(
      "receipt_assertions_not_semantic_truth",
    ),
    evidenceUnits: z
      .array(evidenceUnitSnapshotV1Schema)
      .max(MAX_CLAIM_EVIDENCE_UNITS),
    authorizationDecisions: z
      .array(evidenceAuthorizationDecisionReceiptV1Schema)
      .max(MAX_CLAIM_EVIDENCE_UNITS),
    semanticAssessments: z
      .array(claimSemanticAssessmentReceiptV1Schema)
      .max(MAX_CLAIM_SEMANTIC_ASSESSMENTS),
    claims: z
      .array(claimSupportResultV1Schema)
      .max(MAX_CLAIM_EVIDENCE_CLAIMS),
    coverage: claimCoverageV1Schema,
  })
  .strict();

const claimEvidenceMapIdentitySchema = claimEvidenceMapBodySchema
  .extend({
    claimEvidenceMapId: runContractIdSchema,
  })
  .strict();

const claimEvidenceMapBaseSchema = claimEvidenceMapIdentitySchema
  .extend({
    claimEvidenceMapSha256: runContractSha256Schema,
  })
  .strict();

type ClaimEvidenceMapBase = z.infer<typeof claimEvidenceMapBaseSchema>;
export type ClaimEvidenceMapV1 = DeepReadonly<ClaimEvidenceMapBase>;

const claimEvidenceMapValidatedSchema = claimEvidenceMapBaseSchema.superRefine(
  (value, context) => {
    validateClaimEvidenceMap(value, context);
    const { claimEvidenceMapId, claimEvidenceMapSha256, ...body } = value;
    const expectedId = `claim_evidence_map_${claimEvidenceDigestV1(
      "claim_evidence_map_identity",
      body,
    ).slice(0, 56)}`;
    if (claimEvidenceMapId !== expectedId) {
      context.addIssue({
        code: "custom",
        message: "Claim-evidence-map ID does not match its body.",
        path: ["claimEvidenceMapId"],
      });
    }
    if (
      claimEvidenceMapSha256 !==
      claimEvidenceDigestV1("claim_evidence_map", {
        ...body,
        claimEvidenceMapId,
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Claim-evidence-map digest does not match its body.",
        path: ["claimEvidenceMapSha256"],
      });
    }
    addByteLimitIssue(
      value,
      MAX_CLAIM_EVIDENCE_MAP_BYTES,
      context,
      "Claim evidence map",
    );
  },
);

/** Public parsing schema with the same bounded plain-data preflight as the parser. */
export const claimEvidenceMapV1Schema = z
  .preprocess((value, context) => {
    try {
      preflightClaimEvidenceMapV1(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Claim-evidence map failed bounded plain-data preflight.",
      });
      return z.NEVER;
    }
    return value;
  }, claimEvidenceMapValidatedSchema)
  .transform(freezeContractOutput);

export type ClaimDecompositionInputV1 = {
  startUtf16: number;
  endUtf16Exclusive: number;
  materiality: z.infer<typeof claimMaterialitySchema>;
  inferenceParentClaimIds: readonly string[];
};

export type BuildClaimEvidenceMapV1Input = {
  runId: string;
  purposeId: string;
  answerId: string;
  answerText: string;
  executionScope: ExecutionScope;
  asOfTime: string;
  evaluatedAt: string;
  recordedAt: string;
  claimDecomposition: ClaimDecompositionBindingV1;
  claims: readonly ClaimDecompositionInputV1[];
  evidence: readonly BuildEvidenceUnitSnapshotV1Input[];
  authorizationPolicy: AuthorizationPolicyBindingV1;
  authorizationDecisions: readonly EvidenceAuthorizationDecisionReceiptV1[];
  semanticAssessments: readonly ClaimSemanticAssessmentReceiptV1[];
};

/**
 * Builds the dormant v1 map. Authorization decisions must have been resolved
 * by a trusted caller; scope visibility and grant IDs are never interpreted as
 * permission by this function.
 */
export function buildClaimEvidenceMapV1(
  input: BuildClaimEvidenceMapV1Input,
): ClaimEvidenceMapV1 {
  assertBoundedInputArray(
    input.claims,
    MAX_CLAIM_EVIDENCE_CLAIMS,
    "claims",
  );
  assertBoundedInputArray(
    input.evidence,
    MAX_CLAIM_EVIDENCE_UNITS,
    "evidence",
  );
  assertBoundedInputArray(
    input.authorizationDecisions,
    MAX_CLAIM_EVIDENCE_UNITS,
    "authorization decisions",
  );
  assertBoundedInputArray(
    input.semanticAssessments,
    MAX_CLAIM_SEMANTIC_ASSESSMENTS,
    "semantic assessments",
  );
  for (const claimInput of input.claims) {
    assertBoundedInputArray(
      claimInput.inferenceParentClaimIds,
      MAX_INFERENCE_PARENTS,
      "claim inference parents",
    );
  }
  assertCanonicalJsonByteLimit(
    {
      authorizationDecisions: input.authorizationDecisions,
      semanticAssessments: input.semanticAssessments,
    },
    MAX_CLAIM_EVIDENCE_MAP_BYTES,
    "Claim evidence input receipts",
  );
  const runId = runContractIdSchema.parse(input.runId);
  const purposeId = runContractIdSchema.parse(input.purposeId);
  const answer = buildAnswerBindingV1({
    answerId: input.answerId,
    answerText: input.answerText,
  });
  const executionScope = buildExecutionScopeBindingV1(input.executionScope);
  const claimDecomposition = claimDecompositionBindingV1Schema.parse(
    input.claimDecomposition,
  );
  const authorizationPolicy = authorizationPolicyBindingV1Schema.parse(
    input.authorizationPolicy,
  );
  const claimInputs = z
    .array(
      z
        .object({
          startUtf16: boundedCountSchema.max(MAX_ANSWER_UTF16_CODE_UNITS),
          endUtf16Exclusive: boundedCountSchema.max(
            MAX_ANSWER_UTF16_CODE_UNITS,
          ),
          materiality: claimMaterialitySchema,
          inferenceParentClaimIds: z
            .array(runContractIdSchema)
            .max(MAX_INFERENCE_PARENTS),
        })
        .strict(),
    )
    .max(MAX_CLAIM_EVIDENCE_CLAIMS)
    .parse(input.claims);
  assertAggregateClaimSpanBudget(claimInputs);
  const claimNodes: ClaimNode[] = claimInputs
    .map((item) => ({
      claim: buildClaimBindingFromAnswerV1({
        runId,
        answer,
        answerText: input.answerText,
        startUtf16: item.startUtf16,
        endUtf16Exclusive: item.endUtf16Exclusive,
        materiality: item.materiality,
      }),
      inferenceParentClaimIds: [...item.inferenceParentClaimIds].sort(
        compareIds,
      ),
    }))
    .sort(compareClaimNodes);
  const evidenceUnits = input.evidence
    .map(buildEvidenceUnitSnapshotV1)
    .sort(compareEvidenceSnapshots);
  const authorizationDecisions = input.authorizationDecisions
    .map((item) => evidenceAuthorizationDecisionReceiptV1Schema.parse(item))
    .sort(compareAuthorizationDecisions);
  const semanticAssessments = input.semanticAssessments
    .map((item) => claimSemanticAssessmentReceiptV1Schema.parse(item))
    .sort(compareSemanticAssessments);

  const claims = deriveClaimSupportResults({
    claimNodes,
    semanticAssessments,
    evidenceUnits,
    asOfTime: sourceTimestampSchema.parse(input.asOfTime),
  });
  const coverage = deriveCoverage(claims);
  const body = claimEvidenceMapBodySchema.parse({
    schemaVersion: CLAIM_EVIDENCE_MAP_SCHEMA_VERSION,
    contractKind: "claim_evidence_map",
    runId,
    purposeId,
    answer,
    executionScope,
    asOfTime: input.asOfTime,
    evaluatedAt: input.evaluatedAt,
    recordedAt: input.recordedAt,
    claimDecomposition,
    authorizationPolicy,
    authorizationBoundary: "pre_resolved_decision_receipts",
    semanticVerificationBoundary: "receipt_assertions_not_semantic_truth",
    evidenceUnits,
    authorizationDecisions,
    semanticAssessments,
    claims,
    coverage,
  });
  assertCanonicalJsonByteLimit(
    body,
    MAX_CLAIM_EVIDENCE_MAP_BYTES,
    "Claim evidence map body",
  );
  const claimEvidenceMapId = `claim_evidence_map_${claimEvidenceDigestV1(
    "claim_evidence_map_identity",
    body,
  ).slice(0, 56)}`;
  return deepFreeze(
    claimEvidenceMapValidatedSchema.parse({
      ...body,
      claimEvidenceMapId,
      claimEvidenceMapSha256: claimEvidenceDigestV1("claim_evidence_map", {
        ...body,
        claimEvidenceMapId,
      }),
    }),
  );
}

export function parseClaimEvidenceMapV1(value: unknown): ClaimEvidenceMapV1 {
  preflightClaimEvidenceMapV1(value);
  return deepFreeze(claimEvidenceMapValidatedSchema.parse(value));
}

type ClaimNode = {
  claim: ClaimBindingV1;
  inferenceParentClaimIds: string[];
};

type DeriveClaimSupportInput = {
  claimNodes: readonly ClaimNode[];
  semanticAssessments: readonly ClaimSemanticAssessmentReceiptV1[];
  evidenceUnits: readonly EvidenceUnitSnapshotV1[];
  asOfTime: string;
};

type DerivedClaimState = {
  state: z.infer<typeof claimSupportStateSchema>;
  reason: z.infer<typeof claimSupportReasonSchema>;
};

function deriveClaimSupportResults(
  input: DeriveClaimSupportInput,
): ClaimSupportResultV1[] {
  const claimById = new Map(
    input.claimNodes.map((node) => [node.claim.claimId, node]),
  );
  assertAcyclicClaimGraph(input.claimNodes, claimById);
  const evidenceById = new Map(
    input.evidenceUnits.map((evidence) => [evidence.evidenceUnitId, evidence]),
  );
  const assessmentsByClaim = new Map<
    string,
    ClaimSemanticAssessmentReceiptV1[]
  >();
  for (const assessment of input.semanticAssessments) {
    const list = assessmentsByClaim.get(assessment.claim.claimId) || [];
    list.push(assessment);
    assessmentsByClaim.set(assessment.claim.claimId, list);
  }

  const stateByClaim = new Map<string, DerivedClaimState>();
  const visiting = new Set<string>();

  const resolve = (claimId: string): DerivedClaimState => {
    const cached = stateByClaim.get(claimId);
    if (cached) return cached;
    if (visiting.has(claimId)) {
      throw new Error("Claim inference graph must be acyclic.");
    }
    visiting.add(claimId);
    const node = claimById.get(claimId);
    if (!node) throw new Error("Inference parent claim is missing.");
    const assessments = assessmentsByClaim.get(claimId) || [];
    const temporal = (assessment: ClaimSemanticAssessmentReceiptV1) =>
      assessmentTemporalState(
        assessment,
        evidenceById,
        input.asOfTime,
      );
    const isStrong = (assessment: ClaimSemanticAssessmentReceiptV1) =>
      STRONG_SEMANTIC_METHODS.has(assessment.method) &&
      assessment.confidenceBps > 0;

    let result: DerivedClaimState;
    if (
      assessments.some(
        (assessment) =>
          isStrong(assessment) &&
          assessment.verdict === "contradicts" &&
          temporal(assessment) === "current",
      )
    ) {
      result = {
        state: "disputed",
        reason: "current_strong_contradiction",
      };
    } else if (
      assessments.some(
        (assessment) =>
          isStrong(assessment) &&
          assessment.verdict === "supports" &&
          assessment.supportMode === "direct" &&
          temporal(assessment) === "current",
      )
    ) {
      result = {
        state: "supported",
        reason: "current_strong_direct_support",
      };
    } else {
      const parentStates = node.inferenceParentClaimIds.map(
        (parentId) => resolve(parentId).state,
      );
      const matchingInference = assessments.filter(
        (assessment) =>
          isStrong(assessment) &&
          assessment.verdict === "supports" &&
          assessment.supportMode === "inference" &&
          equalIds(
            assessment.inferenceParentClaimIds,
            node.inferenceParentClaimIds,
          ),
      );
      if (
        matchingInference.some(
          (assessment) => temporal(assessment) === "current",
        ) &&
        parentStates.length > 0 &&
        parentStates.every(
          (state) => state === "supported" || state === "inferred",
        )
      ) {
        result = {
          state: "inferred",
          reason: "current_bounded_inference",
        };
      } else {
        const staleDirect = assessments.some(
          (assessment) =>
            isStrong(assessment) &&
            assessment.verdict === "supports" &&
            assessment.supportMode === "direct" &&
            temporal(assessment) === "stale",
        );
        const admissibleParentStates =
          parentStates.length > 0 &&
          parentStates.every(
            (state) =>
              state === "supported" ||
              state === "inferred" ||
              state === "stale",
          );
        const staleInference =
          admissibleParentStates &&
          matchingInference.some((assessment) => {
            const state = temporal(assessment);
            return (
              state === "stale" ||
              (state === "current" && parentStates.includes("stale"))
            );
          });
        if (staleDirect || staleInference) {
          result = {
            state: "stale",
            reason: "expired_or_superseded_support",
          };
        } else {
          result = {
            state: "unsupported",
            reason: "no_admissible_current_support",
          };
        }
      }
    }
    visiting.delete(claimId);
    stateByClaim.set(claimId, result);
    return result;
  };

  return input.claimNodes.map((node) => {
    const assessments = (assessmentsByClaim.get(node.claim.claimId) || []).sort(
      compareSemanticAssessments,
    );
    const state = resolve(node.claim.claimId);
    const evidenceIdsFor = (
      predicate: (assessment: ClaimSemanticAssessmentReceiptV1) => boolean,
    ) => [
      ...new Set(
        assessments
          .filter(predicate)
          .flatMap((assessment) =>
            assessment.evidenceBindings.map(
              (binding) => binding.evidenceUnitId,
            ),
          ),
      ),
    ].sort(compareIds);
    const isStrong = (assessment: ClaimSemanticAssessmentReceiptV1) =>
      STRONG_SEMANTIC_METHODS.has(assessment.method) &&
      assessment.confidenceBps > 0;
    const temporal = (assessment: ClaimSemanticAssessmentReceiptV1) =>
      assessmentTemporalState(assessment, evidenceById, input.asOfTime);
    return claimSupportResultV1Schema.parse({
      claim: node.claim,
      inferenceParentClaimIds: node.inferenceParentClaimIds,
      semanticAssessmentIds: assessments
        .map((assessment) => assessment.semanticAssessmentId)
        .sort(compareIds),
      consideredEvidenceUnitIds: evidenceIdsFor(() => true),
      currentSupportAssertionEvidenceUnitIds: evidenceIdsFor(
        (assessment) =>
          isStrong(assessment) &&
          assessment.verdict === "supports" &&
          temporal(assessment) === "current",
      ),
      currentContradictionAssertionEvidenceUnitIds: evidenceIdsFor(
        (assessment) =>
          isStrong(assessment) &&
          assessment.verdict === "contradicts" &&
          temporal(assessment) === "current",
      ),
      staleSupportAssertionEvidenceUnitIds: evidenceIdsFor(
        (assessment) =>
          isStrong(assessment) &&
          assessment.verdict === "supports" &&
          temporal(assessment) === "stale",
      ),
      staleContradictionAssertionEvidenceUnitIds: evidenceIdsFor(
        (assessment) =>
          isStrong(assessment) &&
          assessment.verdict === "contradicts" &&
          temporal(assessment) === "stale",
      ),
      supportState: state.state,
      supportReason: state.reason,
    });
  });
}

function deriveCoverage(
  claims: readonly ClaimSupportResultV1[],
): z.infer<typeof claimCoverageV1Schema> {
  const materialClaimCount = claims.filter(
    (claim) => claim.claim.materiality === "material",
  ).length;
  const supportedMaterialClaimCount = claims.filter(
    (claim) =>
      claim.claim.materiality === "material" &&
      claim.supportState === "supported",
  ).length;
  if (materialClaimCount === 0) {
    return claimCoverageV1Schema.parse({
      basis: "declared_claim_set",
      state: "not_applicable",
      materialClaimCount: 0,
      supportedMaterialClaimCount: 0,
      coverageBps: null,
    });
  }
  return claimCoverageV1Schema.parse({
    basis: "declared_claim_set",
    state: "applicable",
    materialClaimCount,
    supportedMaterialClaimCount,
    coverageBps: calculateCoverageBps(
      supportedMaterialClaimCount,
      materialClaimCount,
    ),
  });
}

function calculateCoverageBps(
  supportedMaterialClaimCount: number,
  materialClaimCount: number,
) {
  return Math.floor(
    (supportedMaterialClaimCount * 20_000 + materialClaimCount) /
      (2 * materialClaimCount),
  );
}

function validateClaimEvidenceMap(
  value: ClaimEvidenceMapBase,
  context: z.RefinementCtx,
) {
  if (value.evaluatedAt > value.recordedAt) {
    addIssue(
      context,
      ["recordedAt"],
      "Map recording time cannot precede its evaluation time.",
    );
  }
  if (value.asOfTime > value.evaluatedAt) {
    addIssue(
      context,
      ["asOfTime"],
      "Map as-of time cannot be later than its evaluation time.",
    );
  }
  if (value.claimDecomposition.decomposedAt > value.evaluatedAt) {
    addIssue(
      context,
      ["claimDecomposition", "decomposedAt"],
      "Claim decomposition must exist before map evaluation.",
    );
  }

  validateCanonicalArray(
    value.evidenceUnits,
    (item) => item.evidenceUnitId,
    context,
    ["evidenceUnits"],
    "Evidence units",
  );
  validateCanonicalArray(
    value.authorizationDecisions,
    (item) => `${item.evidenceUnitId}\u0000${item.authorizationDecisionId}`,
    context,
    ["authorizationDecisions"],
    "Authorization decisions",
  );
  validateCanonicalArray(
    value.semanticAssessments,
    (item) => `${item.claim.claimId}\u0000${item.semanticAssessmentId}`,
    context,
    ["semanticAssessments"],
    "Semantic assessments",
  );
  value.claims.forEach((item, index) => {
    if (index > 0 && compareClaimResults(value.claims[index - 1], item) >= 0) {
      addIssue(
        context,
        ["claims", index],
        "Claims must be unique and use canonical span order.",
      );
    }
    if (
      index > 0 &&
      value.claims[index - 1].claim.startUtf16 === item.claim.startUtf16 &&
      value.claims[index - 1].claim.endUtf16Exclusive ===
        item.claim.endUtf16Exclusive
    ) {
      addIssue(
        context,
        ["claims", index, "claim"],
        "Two claims cannot reuse the exact same answer span.",
      );
    }
    if (
      item.claim.runId !== value.runId ||
      item.claim.answerId !== value.answer.answerId ||
      item.claim.answerSha256 !== value.answer.answerSha256 ||
      item.claim.answerUtf16Length !== value.answer.answerUtf16Length
    ) {
      addIssue(
        context,
        ["claims", index, "claim"],
        "Claim does not match the map's exact run and answer binding.",
      );
    }
  });
  const aggregateClaimUtf16CodeUnits = value.claims.reduce(
    (total, item) =>
      total + (item.claim.endUtf16Exclusive - item.claim.startUtf16),
    0,
  );
  if (
    aggregateClaimUtf16CodeUnits > MAX_AGGREGATE_CLAIM_UTF16_CODE_UNITS
  ) {
    addIssue(
      context,
      ["claims"],
      "Aggregate claim span length exceeds the v1 computation bound.",
    );
  }

  const claimById = new Map(
    value.claims.map((result) => [
      result.claim.claimId,
      {
        claim: result.claim,
        inferenceParentClaimIds: [...result.inferenceParentClaimIds],
      } satisfies ClaimNode,
    ]),
  );
  value.claims.forEach((result, claimIndex) => {
    result.inferenceParentClaimIds.forEach((parentId, parentIndex) => {
      if (parentId === result.claim.claimId || !claimById.has(parentId)) {
        addIssue(
          context,
          ["claims", claimIndex, "inferenceParentClaimIds", parentIndex],
          "Inference parents must be other claims in this exact map.",
        );
      }
    });
  });
  try {
    assertAcyclicClaimGraph([...claimById.values()], claimById);
  } catch {
    addIssue(
      context,
      ["claims"],
      "Claim inference graph must be bounded and acyclic.",
    );
  }

  const evidenceById = new Map(
    value.evidenceUnits.map((item) => [item.evidenceUnitId, item]),
  );
  const decisionsByEvidence = new Map<string, number>();
  const decisionReceiptByEvidence = new Map<
    string,
    EvidenceAuthorizationDecisionReceiptV1
  >();
  value.authorizationDecisions.forEach((decision, index) => {
    decisionsByEvidence.set(
      decision.evidenceUnitId,
      (decisionsByEvidence.get(decision.evidenceUnitId) || 0) + 1,
    );
    decisionReceiptByEvidence.set(decision.evidenceUnitId, decision);
    const evidence = evidenceById.get(decision.evidenceUnitId);
    if (!evidence) {
      addIssue(
        context,
        ["authorizationDecisions", index, "evidenceUnitId"],
        "Authorization decision targets unknown evidence.",
      );
      return;
    }
    if (
      evidence.evidenceUnitSha256 !== decision.evidenceUnitSha256 ||
      evidence.evidenceSnapshotSha256 !== decision.evidenceSnapshotSha256 ||
      evidence.tenantId !== decision.evidenceTenantId
    ) {
      addIssue(
        context,
        ["authorizationDecisions", index],
        "Authorization decision does not bind the exact evidence snapshot.",
      );
    }
    if (
      !sameJson(decision.executionScope, value.executionScope) ||
      !sameJson(decision.authorizationPolicy, value.authorizationPolicy) ||
      decision.runId !== value.runId ||
      decision.purposeId !== value.purposeId
    ) {
      addIssue(
        context,
        ["authorizationDecisions", index],
        "Authorization decision does not bind the map's exact run, purpose, scope, and policy.",
      );
    }
    if (evidence.tenantId !== value.executionScope.tenantId) {
      addIssue(
        context,
        ["evidenceUnits", evidence.evidenceUnitId],
        "Cross-tenant evidence cannot enter a claim-evidence map.",
      );
    }
    if (
      decision.decisionState !== "authorized" ||
      decision.decidedAt > value.evaluatedAt ||
      value.evaluatedAt < decision.notBefore ||
      value.evaluatedAt >= decision.expiresAt
    ) {
      addIssue(
        context,
        ["authorizationDecisions", index],
        "Evidence requires an authorized, unrevoked decision active at evaluation time.",
      );
    }
    if (
      evidence.capturedAt > decision.decidedAt ||
      evidence.extractedAt > decision.decidedAt ||
      evidence.capturedAt > value.evaluatedAt ||
      evidence.extractedAt > value.evaluatedAt
    ) {
      addIssue(
        context,
        ["authorizationDecisions", index, "decidedAt"],
        "Authorization and evaluation cannot predate captured and extracted evidence.",
      );
    }
    if (
      evidence.retentionExpiresAt !== null &&
      (decision.decidedAt >= evidence.retentionExpiresAt ||
        value.evaluatedAt >= evidence.retentionExpiresAt)
    ) {
      addIssue(
        context,
        ["evidenceUnits", evidence.evidenceUnitId, "retentionExpiresAt"],
        "Retention-expired evidence cannot enter a claim-evidence map.",
      );
    }
  });
  value.evidenceUnits.forEach((evidence, index) => {
    if (decisionsByEvidence.get(evidence.evidenceUnitId) !== 1) {
      addIssue(
        context,
        ["evidenceUnits", index],
        "Each evidence unit requires exactly one active authorization decision.",
      );
    }
  });

  const assessmentIds = new Set<string>();
  const assessedEvidenceIds = new Set<string>();
  value.semanticAssessments.forEach((assessment, index) => {
    if (assessmentIds.has(assessment.semanticAssessmentId)) {
      addIssue(
        context,
        ["semanticAssessments", index],
        "Semantic-assessment IDs must be unique.",
      );
    }
    assessmentIds.add(assessment.semanticAssessmentId);
    const node = claimById.get(assessment.claim.claimId);
    if (!node || !sameJson(node.claim, assessment.claim)) {
      addIssue(
        context,
        ["semanticAssessments", index, "claim"],
        "Semantic assessment is replayed against the wrong claim binding.",
      );
    }
    if (assessment.assessedAt > value.evaluatedAt) {
      addIssue(
        context,
        ["semanticAssessments", index, "assessedAt"],
        "Semantic assessment must exist before map evaluation.",
      );
    }
    if (
      assessment.runId !== value.runId ||
      assessment.purposeId !== value.purposeId ||
      assessment.evidenceTenantId !== value.executionScope.tenantId ||
      !sameJson(assessment.executionScope, value.executionScope) ||
      !sameJson(assessment.authorizationPolicy, value.authorizationPolicy)
    ) {
      addIssue(
        context,
        ["semanticAssessments", index],
        "Semantic assessment does not bind the map's exact run, tenant, purpose, scope, and policy.",
      );
    }
    if (assessment.assessedAt < value.claimDecomposition.decomposedAt) {
      addIssue(
        context,
        ["semanticAssessments", index, "assessedAt"],
        "Semantic assessment cannot predate claim decomposition.",
      );
    }
    if (
      assessment.supersededAt !== null &&
      assessment.supersededAt > value.evaluatedAt
    ) {
      addIssue(
        context,
        ["semanticAssessments", index, "supersededAt"],
        "Semantic supersession must exist before map evaluation.",
      );
    }
    if (
      assessment.supportMode === "inference" &&
      node &&
      !equalIds(
        assessment.inferenceParentClaimIds,
        node.inferenceParentClaimIds,
      )
    ) {
      addIssue(
        context,
        ["semanticAssessments", index, "inferenceParentClaimIds"],
        "Inference assessment does not bind the claim's exact parent set.",
      );
    }
    assessment.evidenceBindings.forEach((binding, evidenceIndex) => {
      assessedEvidenceIds.add(binding.evidenceUnitId);
      const evidence = evidenceById.get(binding.evidenceUnitId);
      const authorizationDecision = decisionReceiptByEvidence.get(
        binding.evidenceUnitId,
      );
      if (
        !evidence ||
        evidence.evidenceUnitSha256 !== binding.evidenceUnitSha256 ||
        evidence.evidenceSnapshotSha256 !== binding.evidenceSnapshotSha256
      ) {
        addIssue(
          context,
          ["semanticAssessments", index, "evidenceBindings", evidenceIndex],
          "Semantic assessment does not bind an exact authorized evidence snapshot.",
        );
      }
      if (
        !authorizationDecision ||
        authorizationDecision.authorizationDecisionId !==
          binding.authorizationDecisionId ||
        authorizationDecision.authorizationDecisionSha256 !==
          binding.authorizationDecisionSha256 ||
        authorizationDecision.decisionState !== "authorized" ||
        authorizationDecision.decidedAt > assessment.assessedAt ||
        assessment.assessedAt < authorizationDecision.notBefore ||
        assessment.assessedAt >= authorizationDecision.expiresAt
      ) {
        addIssue(
          context,
          ["semanticAssessments", index, "evidenceBindings", evidenceIndex],
          "Semantic assessment requires authorization active when evidence was assessed.",
        );
      }
      if (
        evidence &&
        (evidence.capturedAt > assessment.assessedAt ||
          evidence.extractedAt > assessment.assessedAt)
      ) {
        addIssue(
          context,
          ["semanticAssessments", index, "assessedAt"],
          "Semantic assessment cannot predate captured and extracted evidence.",
        );
      }
      if (
        evidence !== undefined &&
        evidence.retentionExpiresAt !== null &&
        assessment.assessedAt >= evidence.retentionExpiresAt
      ) {
        addIssue(
          context,
          ["semanticAssessments", index, "assessedAt"],
          "Semantic assessment cannot use retention-expired evidence.",
        );
      }
      if (
        evidence !== undefined &&
        assessment.method === "verified_effect_postcondition" &&
        evidence.provenance.kind !== "verified_tool_effect"
      ) {
        addIssue(
          context,
          ["semanticAssessments", index, "method"],
          "Verified effect postconditions require verified tool-effect evidence.",
        );
      }
    });
  });
  value.evidenceUnits.forEach((evidence, index) => {
    if (!assessedEvidenceIds.has(evidence.evidenceUnitId)) {
      addIssue(
        context,
        ["evidenceUnits", index],
        "Evidence without a claim assessment cannot enter a claim-evidence map.",
      );
    }
  });

  try {
    const expectedClaims = deriveClaimSupportResults({
      claimNodes: [...claimById.values()].sort(compareClaimNodes),
      semanticAssessments: value.semanticAssessments,
      evidenceUnits: value.evidenceUnits,
      asOfTime: value.asOfTime,
    });
    if (!sameJson(expectedClaims, value.claims)) {
      addIssue(
        context,
        ["claims"],
        "Claim support states or their bindings are not deterministically derived.",
      );
    }
    const expectedCoverage = deriveCoverage(expectedClaims);
    if (!sameJson(expectedCoverage, value.coverage)) {
      addIssue(
        context,
        ["coverage"],
        "Coverage does not match supported material claims.",
      );
    }
  } catch {
    addIssue(
      context,
      ["claims"],
      "Claim support states could not be deterministically verified.",
    );
  }
}

type AssessmentTemporalState = "current" | "stale" | "future";

function assessmentTemporalState(
  assessment: ClaimSemanticAssessmentReceiptV1,
  evidenceById: ReadonlyMap<string, EvidenceUnitSnapshotV1>,
  asOfTime: string,
): AssessmentTemporalState {
  const evidence = assessment.evidenceBindings
    .map((binding) => evidenceById.get(binding.evidenceUnitId))
    .filter((item): item is EvidenceUnitSnapshotV1 => item !== undefined);
  if (
    evidence.length !== assessment.evidenceBindings.length ||
    assessment.validFrom > asOfTime
  ) {
    return "future";
  }
  if (
    (assessment.lifecycleState === "superseded" &&
      assessment.supersededAt !== null &&
      asOfTime >= assessment.supersededAt) ||
    (assessment.validUntilExclusive !== null &&
      asOfTime >= assessment.validUntilExclusive)
  ) {
    return "stale";
  }
  return "current";
}

function assertAcyclicClaimGraph(
  nodes: readonly ClaimNode[],
  claimById: ReadonlyMap<string, ClaimNode>,
) {
  const depthByClaim = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFor = (claimId: string): number => {
    const cached = depthByClaim.get(claimId);
    if (cached !== undefined) return cached;
    if (visiting.has(claimId)) {
      throw new Error("Claim inference graph must be acyclic.");
    }
    const node = claimById.get(claimId);
    if (!node) throw new Error("Inference parent claim is missing.");
    visiting.add(claimId);
    let depth = 0;
    for (const parentId of node.inferenceParentClaimIds) {
      if (parentId === claimId) {
        throw new Error("A claim cannot infer itself.");
      }
      depth = Math.max(depth, depthFor(parentId) + 1);
      if (depth > MAX_INFERENCE_DEPTH) {
        throw new Error("Claim inference depth exceeds the v1 bound.");
      }
    }
    visiting.delete(claimId);
    depthByClaim.set(claimId, depth);
    return depth;
  };
  for (const node of nodes) depthFor(node.claim.claimId);
}

const STRUCTURAL_CHECKS = [
  "canonical_contract",
  "map_digest",
  "run_answer_binding",
  "utf16_claim_hash_binding",
  "execution_scope_binding",
  "authorization_receipt_binding_and_window",
  "semantic_receipt_binding",
  "inference_graph_structure",
  "derived_state_and_coverage",
] as const;

const structuralChecksSchema = z.tuple([
  z.literal("canonical_contract"),
  z.literal("map_digest"),
  z.literal("run_answer_binding"),
  z.literal("utf16_claim_hash_binding"),
  z.literal("execution_scope_binding"),
  z.literal("authorization_receipt_binding_and_window"),
  z.literal("semantic_receipt_binding"),
  z.literal("inference_graph_structure"),
  z.literal("derived_state_and_coverage"),
]);

const structuralVerificationBodySchema = z
  .object({
    schemaVersion: z.literal(CLAIM_EVIDENCE_MAP_SCHEMA_VERSION),
    receiptKind: z.literal("claim_evidence_map_structural_verification"),
    verificationState: z.literal("verified"),
    verificationScope: z.literal("bindings_and_contracts_only"),
    semanticTruthVerification: z.literal("not_performed"),
    evidenceSourceTrustVerification: z.literal(
      "not_established_by_this_verifier",
    ),
    authorizationTrustVerification: z.literal("not_established_by_this_verifier"),
    claimSetCompletenessVerification: z.literal("not_performed"),
    claimEvidenceMapId: runContractIdSchema,
    claimEvidenceMapSha256: runContractSha256Schema,
    runId: runContractIdSchema,
    purposeId: runContractIdSchema,
    answerId: runContractIdSchema,
    answerSha256: runContractSha256Schema,
    subjectExecutionScope: executionScopeBindingV1Schema,
    verificationExecutionScope: executionScopeBindingV1Schema,
    asOfTime: sourceTimestampSchema,
    evaluatedAt: sourceTimestampSchema,
    recordedAt: sourceTimestampSchema,
    claimCount: boundedCountSchema.max(MAX_CLAIM_EVIDENCE_CLAIMS),
    evidenceUnitCount: boundedCountSchema.max(MAX_CLAIM_EVIDENCE_UNITS),
    semanticAssessmentCount: boundedCountSchema.max(
      MAX_CLAIM_SEMANTIC_ASSESSMENTS,
    ),
    checks: structuralChecksSchema,
    verifierId: runContractIdSchema,
    verifierVersionId: runContractIdSchema,
    verificationPolicySha256: runContractSha256Schema,
    verifiedAt: sourceTimestampSchema,
  })
  .strict();

const structuralVerificationIdentitySchema = structuralVerificationBodySchema
  .extend({
    structuralVerificationId: runContractIdSchema,
  })
  .strict();

const claimEvidenceMapStructuralVerificationReceiptValidatedSchema =
  structuralVerificationIdentitySchema
    .extend({
      structuralVerificationSha256: runContractSha256Schema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.subjectExecutionScope.tenantId !==
          value.verificationExecutionScope.tenantId ||
        value.subjectExecutionScope.initiatingActorId !==
          value.verificationExecutionScope.initiatingActorId
      ) {
        addIssue(
          context,
          ["verificationExecutionScope"],
          "Structural verification must retain the subject tenant and initiating actor.",
        );
      }
      if (
        value.asOfTime > value.evaluatedAt ||
        value.evaluatedAt > value.recordedAt ||
        value.recordedAt > value.verifiedAt
      ) {
        addIssue(
          context,
          ["verifiedAt"],
          "Structural verification timestamps violate causal order.",
        );
      }
      const {
        structuralVerificationId,
        structuralVerificationSha256,
        ...body
      } = value;
      const expectedId = `claim_map_verification_${claimEvidenceDigestV1(
        "structural_verification_identity",
        body,
      ).slice(0, 56)}`;
      if (structuralVerificationId !== expectedId) {
        addIssue(
          context,
          ["structuralVerificationId"],
          "Structural-verification ID does not match its body.",
        );
      }
      if (
        structuralVerificationSha256 !==
        claimEvidenceDigestV1("structural_verification_receipt", {
          ...body,
          structuralVerificationId,
        })
      ) {
        addIssue(
          context,
          ["structuralVerificationSha256"],
          "Structural-verification digest does not match its receipt.",
        );
      }
      addByteLimitIssue(
        value,
        MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
        context,
        "Structural verification receipt",
      );
    });

/** Bounded public parser for structural-verification receipts. */
export const claimEvidenceMapStructuralVerificationReceiptV1Schema = z
  .preprocess((value, context) => {
    try {
      preflightStructuralVerificationReceiptV1(value);
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Claim-map structural verification failed bounded plain-data preflight.",
      });
      return z.NEVER;
    }
    return value;
  }, claimEvidenceMapStructuralVerificationReceiptValidatedSchema)
  .transform(freezeContractOutput);

export type ClaimEvidenceMapStructuralVerificationReceiptV1 = DeepReadonly<
  z.infer<typeof claimEvidenceMapStructuralVerificationReceiptV1Schema>
>;

export type VerifyClaimEvidenceMapStructureV1Input = {
  claimEvidenceMap: unknown;
  expectedRunId: string;
  expectedPurposeId: string;
  expectedAnswerId: string;
  expectedAnswerText: string;
  expectedExecutionScope: ExecutionScope;
  verificationExecutionScope: ExecutionScope;
  verifierId: string;
  verifierVersionId: string;
  verificationPolicySha256: string;
  verifiedAt: string;
};

/**
 * Verifies exact bindings and deterministic structure. It deliberately does
 * not re-run entailment, authenticate the authorization issuer, or attest
 * semantic truth.
 */
export function verifyClaimEvidenceMapStructureV1(
  input: VerifyClaimEvidenceMapStructureV1Input,
): ClaimEvidenceMapStructuralVerificationReceiptV1 {
  const map = parseClaimEvidenceMapV1(input.claimEvidenceMap);
  const expectedRunId = runContractIdSchema.parse(input.expectedRunId);
  const expectedPurposeId = runContractIdSchema.parse(input.expectedPurposeId);
  const expectedAnswer = buildAnswerBindingV1({
    answerId: input.expectedAnswerId,
    answerText: input.expectedAnswerText,
  });
  const expectedScope = buildExecutionScopeBindingV1(
    input.expectedExecutionScope,
  );
  const verificationScope = buildExecutionScopeBindingV1(
    input.verificationExecutionScope,
  );
  if (
    map.runId !== expectedRunId ||
    map.purposeId !== expectedPurposeId ||
    !sameJson(map.answer, expectedAnswer)
  ) {
    throw new Error(
      "Claim evidence map is bound to a different run, purpose, or answer.",
    );
  }
  if (!sameJson(map.executionScope, expectedScope)) {
    throw new Error("Claim evidence map is bound to a different execution scope.");
  }
  if (
    verificationScope.tenantId !== map.executionScope.tenantId ||
    verificationScope.initiatingActorId !==
      map.executionScope.initiatingActorId
  ) {
    throw new Error(
      "Structural verification must retain the map's tenant and initiating actor.",
    );
  }
  for (const result of map.claims) {
    const expectedClaim = buildClaimBindingFromAnswerV1({
      runId: expectedRunId,
      answer: expectedAnswer,
      answerText: input.expectedAnswerText,
      startUtf16: result.claim.startUtf16,
      endUtf16Exclusive: result.claim.endUtf16Exclusive,
      materiality: result.claim.materiality,
    });
    if (!sameJson(expectedClaim, result.claim)) {
      throw new Error("Claim hash does not match its exact UTF-16 answer span.");
    }
  }
  const verifiedAt = sourceTimestampSchema.parse(input.verifiedAt);
  if (verifiedAt < map.recordedAt) {
    throw new Error("Structural verification cannot predate map recording.");
  }
  const body = structuralVerificationBodySchema.parse({
    schemaVersion: CLAIM_EVIDENCE_MAP_SCHEMA_VERSION,
    receiptKind: "claim_evidence_map_structural_verification",
    verificationState: "verified",
    verificationScope: "bindings_and_contracts_only",
    semanticTruthVerification: "not_performed",
    evidenceSourceTrustVerification: "not_established_by_this_verifier",
    authorizationTrustVerification: "not_established_by_this_verifier",
    claimSetCompletenessVerification: "not_performed",
    claimEvidenceMapId: map.claimEvidenceMapId,
    claimEvidenceMapSha256: map.claimEvidenceMapSha256,
    runId: map.runId,
    purposeId: map.purposeId,
    answerId: map.answer.answerId,
    answerSha256: map.answer.answerSha256,
    subjectExecutionScope: map.executionScope,
    verificationExecutionScope: verificationScope,
    asOfTime: map.asOfTime,
    evaluatedAt: map.evaluatedAt,
    recordedAt: map.recordedAt,
    claimCount: map.claims.length,
    evidenceUnitCount: map.evidenceUnits.length,
    semanticAssessmentCount: map.semanticAssessments.length,
    checks: STRUCTURAL_CHECKS,
    verifierId: input.verifierId,
    verifierVersionId: input.verifierVersionId,
    verificationPolicySha256: input.verificationPolicySha256,
    verifiedAt,
  });
  const structuralVerificationId = `claim_map_verification_${claimEvidenceDigestV1(
    "structural_verification_identity",
    body,
  ).slice(0, 56)}`;
  return deepFreeze(
    claimEvidenceMapStructuralVerificationReceiptV1Schema.parse({
      ...body,
      structuralVerificationId,
      structuralVerificationSha256: claimEvidenceDigestV1(
        "structural_verification_receipt",
        { ...body, structuralVerificationId },
      ),
    }),
  );
}

export function parseClaimEvidenceMapStructuralVerificationReceiptV1(
  value: unknown,
): ClaimEvidenceMapStructuralVerificationReceiptV1 {
  assertCanonicalJsonByteLimit(
    value,
    MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
    "Structural verification receipt",
  );
  return deepFreeze(
    claimEvidenceMapStructuralVerificationReceiptV1Schema.parse(value),
  );
}

function validateCanonicalArray<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
) {
  values.forEach((value, index) => {
    if (index > 0 && key(values[index - 1]) >= key(value)) {
      addIssue(
        context,
        [...path, index],
        `${label} must be unique and use canonical order.`,
      );
    }
  });
}

function assertBoundedInputArray(
  value: readonly unknown[],
  maximum: number,
  label: string,
) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new Error(`Claim-evidence ${label} exceeds the v1 array bound.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length),
    )
  ) {
    throw new Error(
      `Claim-evidence ${label} must be a dense plain data array.`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(
        `Claim-evidence ${label} must contain only enumerable data items.`,
      );
    }
  }
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvidenceSnapshots(
  left: EvidenceUnitSnapshotV1,
  right: EvidenceUnitSnapshotV1,
) {
  return compareIds(left.evidenceUnitId, right.evidenceUnitId);
}

function compareAuthorizationDecisions(
  left: EvidenceAuthorizationDecisionReceiptV1,
  right: EvidenceAuthorizationDecisionReceiptV1,
) {
  return compareIds(
    `${left.evidenceUnitId}\u0000${left.authorizationDecisionId}`,
    `${right.evidenceUnitId}\u0000${right.authorizationDecisionId}`,
  );
}

function compareSemanticAssessments(
  left: ClaimSemanticAssessmentReceiptV1,
  right: ClaimSemanticAssessmentReceiptV1,
) {
  return compareIds(
    `${left.claim.claimId}\u0000${left.semanticAssessmentId}`,
    `${right.claim.claimId}\u0000${right.semanticAssessmentId}`,
  );
}

function compareClaimNodes(left: ClaimNode, right: ClaimNode) {
  return compareClaimBindings(left.claim, right.claim);
}

function compareClaimResults(
  left: ClaimSupportResultV1,
  right: ClaimSupportResultV1,
) {
  return compareClaimBindings(left.claim, right.claim);
}

function compareClaimBindings(left: ClaimBindingV1, right: ClaimBindingV1) {
  if (left.startUtf16 !== right.startUtf16) {
    return left.startUtf16 - right.startUtf16;
  }
  if (left.endUtf16Exclusive !== right.endUtf16Exclusive) {
    return left.endUtf16Exclusive - right.endUtf16Exclusive;
  }
  return compareIds(left.claimId, right.claimId);
}

function equalIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameJson(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
) {
  context.addIssue({ code: "custom", message, path });
}

function addByteLimitIssue(
  value: unknown,
  limit: number,
  context: z.RefinementCtx,
  label: string,
) {
  try {
    canonicalJson(value, limit);
  } catch (error) {
    if (!(error instanceof CanonicalJsonByteLimitError)) throw error;
    addIssue(context, [], `${label} exceeds the ${limit}-byte v1 limit.`);
  }
}

function isExactUtf16Boundary(value: string, offset: number) {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function assertAggregateClaimSpanBudget(
  claims: readonly {
    startUtf16: number;
    endUtf16Exclusive: number;
  }[],
) {
  let aggregate = 0;
  for (const claim of claims) {
    const spanLength = claim.endUtf16Exclusive - claim.startUtf16;
    if (spanLength <= 0) {
      throw new Error("Claim UTF-16 span is empty or reversed.");
    }
    aggregate += spanLength;
    if (aggregate > MAX_AGGREGATE_CLAIM_UTF16_CODE_UNITS) {
      throw new Error(
        "Aggregate claim span length exceeds the v1 computation bound.",
      );
    }
  }
}

function preflightClaimEvidenceMapV1(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Claim evidence map must be a plain JSON object.");
  }
  const record = value as object;
  assertPreflightArray(
    readPreflightDataProperty(record, "evidenceUnits"),
    MAX_CLAIM_EVIDENCE_UNITS,
    "evidenceUnits",
  );
  assertPreflightArray(
    readPreflightDataProperty(record, "authorizationDecisions"),
    MAX_CLAIM_EVIDENCE_UNITS,
    "authorizationDecisions",
  );
  const assessments = assertPreflightArray(
    readPreflightDataProperty(record, "semanticAssessments"),
    MAX_CLAIM_SEMANTIC_ASSESSMENTS,
    "semanticAssessments",
  );
  const claims = assertPreflightArray(
    readPreflightDataProperty(record, "claims"),
    MAX_CLAIM_EVIDENCE_CLAIMS,
    "claims",
  );
  for (const assessment of assessments) {
    if (
      !assessment ||
      typeof assessment !== "object" ||
      Array.isArray(assessment)
    ) {
      continue;
    }
    const item = assessment as object;
    assertPreflightArray(
      readPreflightDataProperty(item, "evidenceBindings"),
      MAX_CLAIM_EVIDENCE_UNITS,
      "semanticAssessments[].evidenceBindings",
    );
    assertPreflightArray(
      readPreflightDataProperty(item, "inferenceParentClaimIds"),
      MAX_INFERENCE_PARENTS,
      "semanticAssessments[].inferenceParentClaimIds",
    );
  }
  for (const claim of claims) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      continue;
    }
    const item = claim as object;
    assertPreflightArray(
      readPreflightDataProperty(item, "inferenceParentClaimIds"),
      MAX_INFERENCE_PARENTS,
      "claims[].inferenceParentClaimIds",
    );
    assertPreflightArray(
      readPreflightDataProperty(item, "semanticAssessmentIds"),
      MAX_CLAIM_SEMANTIC_ASSESSMENTS,
      "claims[].semanticAssessmentIds",
    );
    for (const field of [
      "consideredEvidenceUnitIds",
      "currentSupportAssertionEvidenceUnitIds",
      "currentContradictionAssertionEvidenceUnitIds",
      "staleSupportAssertionEvidenceUnitIds",
      "staleContradictionAssertionEvidenceUnitIds",
    ]) {
      assertPreflightArray(
        readPreflightDataProperty(item, field),
        MAX_CLAIM_EVIDENCE_UNITS,
        `claims[].${field}`,
      );
    }
  }
  assertCanonicalJsonByteLimit(
    value,
    MAX_CLAIM_EVIDENCE_MAP_BYTES,
    "Claim evidence map",
  );
}

function preflightClaimSemanticAssessmentReceiptV1(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Claim semantic assessment must be a plain JSON object.");
  }
  const record = value as object;
  assertPreflightArray(
    readPreflightDataProperty(record, "evidenceBindings"),
    MAX_CLAIM_EVIDENCE_UNITS,
    "semantic-assessment evidence bindings",
  );
  assertPreflightArray(
    readPreflightDataProperty(record, "inferenceParentClaimIds"),
    MAX_INFERENCE_PARENTS,
    "semantic-assessment inference parents",
  );
  assertCanonicalJsonByteLimit(
    value,
    MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
    "Semantic assessment",
  );
}

function preflightEvidenceAuthorizationDecisionReceiptV1(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(
      "Evidence authorization decision must be a plain JSON object.",
    );
  }
  assertCanonicalJsonByteLimit(
    value,
    MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
    "Evidence authorization decision",
  );
}

function preflightEvidenceUnitSnapshotV1(value: unknown) {
  assertPlainBoundedContractObject(
    value,
    MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
    "Evidence snapshot",
  );
}

function preflightBuildEvidenceUnitSnapshotV1Input(value: unknown) {
  assertPlainBoundedContractObject(
    value,
    MAX_CLAIM_EVIDENCE_MAP_BYTES,
    "Evidence snapshot input",
  );
}

function preflightClaimSupportResultV1(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Claim-support result must be a plain JSON object.");
  }
  const record = value as object;
  assertPreflightArray(
    readPreflightDataProperty(record, "inferenceParentClaimIds"),
    MAX_INFERENCE_PARENTS,
    "claim-support inference parents",
  );
  assertPreflightArray(
    readPreflightDataProperty(record, "semanticAssessmentIds"),
    MAX_CLAIM_SEMANTIC_ASSESSMENTS,
    "claim-support semantic assessments",
  );
  for (const field of [
    "consideredEvidenceUnitIds",
    "currentSupportAssertionEvidenceUnitIds",
    "currentContradictionAssertionEvidenceUnitIds",
    "staleSupportAssertionEvidenceUnitIds",
    "staleContradictionAssertionEvidenceUnitIds",
  ]) {
    assertPreflightArray(
      readPreflightDataProperty(record, field),
      MAX_CLAIM_EVIDENCE_UNITS,
      `claim-support ${field}`,
    );
  }
  assertCanonicalJsonByteLimit(
    value,
    MAX_CLAIM_EVIDENCE_MAP_BYTES,
    "Claim-support result",
  );
}

function preflightStructuralVerificationReceiptV1(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(
      "Claim-map structural verification receipt must be a plain JSON object.",
    );
  }
  const record = value as object;
  assertPreflightArray(
    readPreflightDataProperty(record, "checks"),
    STRUCTURAL_CHECKS.length,
    "structural-verification checks",
  );
  assertCanonicalJsonByteLimit(
    value,
    MAX_CLAIM_EVIDENCE_RECEIPT_BYTES,
    "Structural verification receipt",
  );
}

function assertPlainBoundedContractObject(
  value: unknown,
  maximumBytes: number,
  label: string,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a plain JSON object.`);
  }
  assertCanonicalJsonByteLimit(value, maximumBytes, label);
}

function assertPreflightArray(
  value: unknown,
  maximum: number,
  label: string,
): readonly unknown[] {
  assertBoundedInputArray(
    value as readonly unknown[],
    maximum,
    label,
  );
  return value as readonly unknown[];
}

function readPreflightDataProperty(record: object, property: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, property);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new Error(
      `Claim-evidence ${property} must be an enumerable data property.`,
    );
  }
  return descriptor.value;
}

function assertCanonicalJsonByteLimit(
  value: unknown,
  maximum: number,
  label: string,
) {
  try {
    canonicalJson(value, maximum);
  } catch (error) {
    if (!(error instanceof CanonicalJsonByteLimitError)) throw error;
    throw new Error(`${label} exceeds the ${maximum}-byte v1 limit.`);
  }
}

class CanonicalJsonByteLimitError extends Error {}

function canonicalJson(
  value: unknown,
  maximumBytes = MAX_CANONICAL_JSON_BYTES,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Claim-evidence canonical JSON requires a positive byte bound.");
  }
  const ancestors = new WeakSet<object>();
  const state = { bytes: 0, nodes: 0 };
  const account = (fragment: string) => {
    state.bytes += Buffer.byteLength(fragment, "utf8");
    if (state.bytes > maximumBytes) {
      throw new CanonicalJsonByteLimitError(
        "Claim-evidence canonical JSON exceeds its byte bound.",
      );
    }
    return fragment;
  };
  const serialize = (item: unknown, depth: number): string => {
    state.nodes += 1;
    if (state.nodes > MAX_CANONICAL_JSON_NODES) {
      throw new Error("Claim-evidence canonical JSON exceeds its node bound.");
    }
    if (depth > MAX_CANONICAL_JSON_DEPTH) {
      throw new Error("Claim-evidence canonical JSON exceeds its depth bound.");
    }
    if (item === null || typeof item === "boolean") {
      const serialized = JSON.stringify(item);
      if (serialized === undefined) {
        throw new Error(
          "Claim-evidence contracts require JSON-compatible scalar values.",
        );
      }
      return account(serialized);
    }
    if (typeof item === "string") {
      if (item.length > MAX_CANONICAL_STRING_UTF16_CODE_UNITS) {
        throw new Error(
          "Claim-evidence canonical JSON string exceeds its UTF-16 bound.",
        );
      }
      if (Buffer.byteLength(item, "utf8") > maximumBytes - state.bytes) {
        throw new CanonicalJsonByteLimitError(
          "Claim-evidence canonical JSON exceeds its byte bound.",
        );
      }
      const serialized = JSON.stringify(item);
      if (serialized === undefined) {
        throw new Error(
          "Claim-evidence contracts require JSON-compatible string values.",
        );
      }
      return account(serialized);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new Error("Claim-evidence canonical JSON requires finite numbers.");
      }
      const serialized = JSON.stringify(item);
      if (serialized === undefined) {
        throw new Error(
          "Claim-evidence contracts require JSON-compatible numeric values.",
        );
      }
      return account(serialized);
    }
    if (!item || typeof item !== "object") {
      throw new Error("Claim-evidence contracts require JSON-compatible values.");
    }
    if (ancestors.has(item)) {
      throw new Error("Claim-evidence canonical JSON cannot contain cycles.");
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (
          Object.getPrototypeOf(item) !== Array.prototype ||
          item.length > MAX_CANONICAL_ARRAY_ITEMS
        ) {
          throw new Error(
            "Claim-evidence canonical JSON requires bounded plain arrays.",
          );
        }
        const keys = Reflect.ownKeys(item);
        if (
          keys.length !== item.length + 1 ||
          keys.some((key) => key !== "length" && typeof key !== "string")
        ) {
          throw new Error(
            "Claim-evidence canonical JSON arrays cannot be sparse or extended.",
          );
        }
        const values: string[] = [];
        account("[");
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw new Error(
              "Claim-evidence canonical JSON arrays require data items.",
            );
          }
          if (index > 0) account(",");
          values.push(serialize(descriptor.value, depth + 1));
        }
        account("]");
        return `[${values.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(
          "Claim-evidence canonical JSON requires plain objects.",
        );
      }
      const keys = Reflect.ownKeys(item);
      if (
        keys.length > MAX_CANONICAL_OBJECT_KEYS ||
        keys.some((key) => typeof key !== "string")
      ) {
        throw new Error(
          "Claim-evidence canonical JSON object keys exceed their bound.",
        );
      }
      const entries: string[] = [];
      account("{");
      for (const key of (keys as string[]).sort(compareIds)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(
            "Claim-evidence canonical JSON objects require enumerable data properties.",
          );
        }
        if (key.length > MAX_CANONICAL_STRING_UTF16_CODE_UNITS) {
          throw new Error(
            "Claim-evidence canonical JSON object key exceeds its UTF-16 bound.",
          );
        }
        if (entries.length > 0) account(",");
        const serializedKey = JSON.stringify(key);
        if (serializedKey === undefined) {
          throw new Error(
            "Claim-evidence canonical JSON requires string object keys.",
          );
        }
        account(serializedKey);
        account(":");
        entries.push(
          `${serializedKey}:${serialize(descriptor.value, depth + 1)}`,
        );
      }
      account("}");
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return serialize(value, 0);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const property of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}
