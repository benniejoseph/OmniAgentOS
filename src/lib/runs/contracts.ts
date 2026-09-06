import { z } from "zod";

/**
 * Run contracts contain observable metadata only. They deliberately have no
 * field that can hold prompt text, model output, retrieved content, tool
 * input/output, persona or skill instructions, or error text.
 */
export const RUN_CONTRACT_SCHEMA_VERSION = 1 as const;
export const MAX_RUN_CONTRACT_IDS = 256;
export const MAX_OUTCOME_REQUIREMENTS = 128;
export const MAX_CONTEXT_ITEMS = 128;
export const MAX_CONTEXT_MANIFESTS = 32;
export const MAX_CONTEXT_CONFLICT_IDS = 16;
export const MAX_RUN_CONTRACT_ENVELOPE_BYTES = 256_000;
export const MAX_RUN_CONTRACT_EVENT_PAYLOAD_BYTES = 16_000;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export const runContractIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(idPattern, "Expected an opaque ID, not free-form text.");

export const runContractSha256Schema = z
  .string()
  .regex(sha256Pattern, "Expected a lowercase hexadecimal SHA-256 digest.");

const nullableIdSchema = runContractIdSchema.nullable();
const nullableSha256Schema = runContractSha256Schema.nullable();
const boundedCountSchema = z.number().int().min(0).max(1_000_000_000);
const basisPointsSchema = z.number().int().min(0).max(10_000);

function uniqueIdList(max = MAX_RUN_CONTRACT_IDS) {
  return z.array(runContractIdSchema).max(max).superRefine((ids, context) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          message: "IDs must be unique.",
          path: [index],
        });
      }
      seen.add(id);
    });
  });
}

export const countLimitV1Schema = z.object({
  state: z.enum(["bounded", "unbounded", "unassessed"]),
  limitCount: boundedCountSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === "bounded" && value.limitCount === null) {
    context.addIssue({
      code: "custom",
      message: "A bounded limit requires limitCount.",
      path: ["limitCount"],
    });
  }
  if (value.state !== "bounded" && value.limitCount !== null) {
    context.addIssue({
      code: "custom",
      message: "Only a bounded limit may include limitCount.",
      path: ["limitCount"],
    });
  }
});

export const runBudgetsV1Schema = z.object({
  assessmentState: z.enum(["assessed", "unassessed"]),
  modelTurnBudget: countLimitV1Schema,
  toolCallBudget: countLimitV1Schema,
  tokenBudget: countLimitV1Schema,
  toolResultByteBudget: countLimitV1Schema,
  externalEffectBudget: countLimitV1Schema,
}).strict().superRefine((value, context) => {
  const states = [
    value.modelTurnBudget.state,
    value.toolCallBudget.state,
    value.tokenBudget.state,
    value.toolResultByteBudget.state,
    value.externalEffectBudget.state,
  ];
  if (
    value.assessmentState === "unassessed" &&
    states.some((state) => state !== "unassessed")
  ) {
    context.addIssue({
      code: "custom",
      message: "Unassessed budgets cannot contain assessed limits.",
      path: ["assessmentState"],
    });
  }
  if (
    value.assessmentState === "assessed" &&
    states.some((state) => state === "unassessed")
  ) {
    context.addIssue({
      code: "custom",
      message: "Assessed budgets require every limit to be assessed.",
      path: ["assessmentState"],
    });
  }
});

export type CountLimitV1 = z.infer<typeof countLimitV1Schema>;
export type RunBudgetsV1 = z.infer<typeof runBudgetsV1Schema>;

export const runBudgetsV2Schema = z.object({
  schemaVersion: z.literal(2),
  assessmentState: z.enum(["assessed", "unassessed"]),
  modelTurnBudget: countLimitV1Schema,
  tokenBudget: countLimitV1Schema,
  costMicrousdBudget: countLimitV1Schema,
  wallClockMsBudget: countLimitV1Schema,
  toolCallBudget: countLimitV1Schema,
  browserActionBudget: countLimitV1Schema,
  agentBudget: countLimitV1Schema,
  fanOutBudget: countLimitV1Schema,
  retryBudget: countLimitV1Schema,
  replanBudget: countLimitV1Schema,
  toolResultByteBudget: countLimitV1Schema,
  externalEffectBudget: countLimitV1Schema,
}).strict().superRefine((value, context) => {
  const states = [
    value.modelTurnBudget.state,
    value.tokenBudget.state,
    value.costMicrousdBudget.state,
    value.wallClockMsBudget.state,
    value.toolCallBudget.state,
    value.browserActionBudget.state,
    value.agentBudget.state,
    value.fanOutBudget.state,
    value.retryBudget.state,
    value.replanBudget.state,
    value.toolResultByteBudget.state,
    value.externalEffectBudget.state,
  ];
  if (
    value.assessmentState === "unassessed"
    && states.some((state) => state !== "unassessed")
  ) {
    context.addIssue({
      code: "custom",
      message: "Unassessed budgets cannot contain assessed limits.",
      path: ["assessmentState"],
    });
  }
  if (
    value.assessmentState === "assessed"
    && states.some((state) => state === "unassessed")
  ) {
    context.addIssue({
      code: "custom",
      message: "Assessed budgets require every limit to be assessed.",
      path: ["assessmentState"],
    });
  }
});

export const runBudgetsSchema = z.union([
  runBudgetsV2Schema,
  runBudgetsV1Schema,
]);

export type RunBudgetsV2 = z.infer<typeof runBudgetsV2Schema>;
export type RunBudgets = z.infer<typeof runBudgetsSchema>;

export const agentPrincipalV1Schema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  agentPrincipalId: runContractIdSchema,
  runId: runContractIdSchema,
  tenantId: runContractIdSchema,
  principalType: z.enum(["user", "agent", "system"]),
  executingPrincipalId: nullableIdSchema,
  authoritySource: z.enum([
    "authenticated_actor",
    "delegated",
    "system",
    "unassessed",
  ]),
  ownerActorId: nullableIdSchema,
  initiatingActorId: nullableIdSchema,
  agentDefinitionId: nullableIdSchema,
  agentDefinitionVersionId: nullableIdSchema,
  workspaceId: nullableIdSchema,
  projectId: nullableIdSchema,
  missionId: nullableIdSchema,
  delegationId: nullableIdSchema,
  delegationChainIds: uniqueIdList(),
  correlationId: runContractIdSchema,
  causationId: nullableIdSchema,
  purposeSha256: runContractSha256Schema,
  contextGrantIds: uniqueIdList(),
  capabilityGrantIds: uniqueIdList(),
  budgetPolicyId: nullableIdSchema,
  budgets: runBudgetsSchema,
}).strict().superRefine((value, context) => {
  if (
    value.agentDefinitionVersionId !== null &&
    value.agentDefinitionId === null
  ) {
    context.addIssue({
      code: "custom",
      message: "An agent definition version requires an agent definition ID.",
      path: ["agentDefinitionVersionId"],
    });
  }
  if (
    value.authoritySource === "delegated" &&
    (value.delegationId === null || value.delegationChainIds.length === 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Delegated authority requires a delegation and its chain.",
      path: ["delegationId"],
    });
  }
  if (
    value.authoritySource === "authenticated_actor" &&
    (value.principalType !== "user" || value.executingPrincipalId === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Authenticated actor authority requires a user principal ID.",
      path: ["authoritySource"],
    });
  }
  if (
    value.authoritySource === "system" &&
    value.principalType !== "system"
  ) {
    context.addIssue({
      code: "custom",
      message: "System authority requires a system principal.",
      path: ["authoritySource"],
    });
  }
});

export type AgentPrincipalV1 = z.infer<typeof agentPrincipalV1Schema>;
export type AgentPrincipal = AgentPrincipalV1;
export type BuildAgentPrincipalV1Input = Omit<AgentPrincipalV1, "schemaVersion">;

export function buildAgentPrincipalV1(
  input: BuildAgentPrincipalV1Input,
): AgentPrincipalV1 {
  return agentPrincipalV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    ...input,
  });
}

export const intentAmbiguityStateSchema = z.enum([
  "unassessed",
  "none",
  "detected",
  "resolved",
]);

export const intentRiskTierSchema = z.enum([
  "unassessed",
  "none",
  "low",
  "medium",
  "high",
  "critical",
]);

export const intentInteractionModeSchema = z.enum([
  "unassessed",
  "inform",
  "clarify",
  "preview",
  "execute",
  "orchestrate",
]);

export const runExecutionModeSchema = z.enum([
  "live",
  "dry_run",
  "preview",
  "unassessed",
]);

export const intentSpecV1Schema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  intentSpecId: runContractIdSchema,
  runId: runContractIdSchema,
  correlationId: runContractIdSchema,
  requestSha256: runContractSha256Schema,
  requestedOutcomeSha256: runContractSha256Schema,
  targetIds: uniqueIdList(),
  excludedTargetIds: uniqueIdList(),
  constraintIds: uniqueIdList(),
  ambiguityState: intentAmbiguityStateSchema,
  ambiguityIds: uniqueIdList(),
  riskAssessmentState: z.enum(["assessed", "unassessed"]),
  riskTier: intentRiskTierSchema,
  interactionMode: intentInteractionModeSchema,
}).strict().superRefine((value, context) => {
  const exclusions = new Set(value.excludedTargetIds);
  value.targetIds.forEach((targetId, index) => {
    if (exclusions.has(targetId)) {
      context.addIssue({
        code: "custom",
        message: "A target cannot also be excluded.",
        path: ["targetIds", index],
      });
    }
  });
  if (value.ambiguityState === "none" && value.ambiguityIds.length > 0) {
    context.addIssue({
      code: "custom",
      message: "An unambiguous intent cannot include ambiguity IDs.",
      path: ["ambiguityIds"],
    });
  }
  if (
    value.ambiguityState === "detected" &&
    value.ambiguityIds.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Detected ambiguity requires at least one ambiguity ID.",
      path: ["ambiguityIds"],
    });
  }
  if (
    (value.riskAssessmentState === "unassessed") !==
    (value.riskTier === "unassessed")
  ) {
    context.addIssue({
      code: "custom",
      message: "Risk assessment state and risk tier must agree.",
      path: ["riskTier"],
    });
  }
});

export type IntentSpecV1 = z.infer<typeof intentSpecV1Schema>;
export type IntentSpec = IntentSpecV1;
export type BuildIntentSpecV1Input = Omit<IntentSpecV1, "schemaVersion">;

export function buildIntentSpecV1(input: BuildIntentSpecV1Input): IntentSpecV1 {
  return intentSpecV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    ...input,
  });
}

export const requirementLevelSchema = z.enum(["required", "optional"]);

export const verificationMethodSchema = z.enum([
  "deterministic",
  "provider_receipt",
  "read_after_write",
  "signed_evidence",
  "human_attestation",
  "model_assertion",
  "generated_summary",
  "citation_id_match",
  "none",
  "unassessed",
]);

const acceptanceCriterionV1Schema = z.object({
  criterionId: runContractIdSchema,
  criterionSha256: runContractSha256Schema,
  requirementLevel: requirementLevelSchema,
  verificationMethod: verificationMethodSchema,
  verifierId: nullableIdSchema,
}).strict();

const artifactRequirementV1Schema = z.object({
  artifactRequirementId: runContractIdSchema,
  requirementSha256: runContractSha256Schema,
  artifactKind: z.enum([
    "text",
    "document",
    "spreadsheet",
    "presentation",
    "image",
    "audio",
    "video",
    "code",
    "structured_data",
    "external_record",
    "other",
  ]),
  requirementLevel: requirementLevelSchema,
  verificationMethod: verificationMethodSchema,
  verifierId: nullableIdSchema,
}).strict();

const effectRequirementV1Schema = z.object({
  effectRequirementId: runContractIdSchema,
  requirementSha256: runContractSha256Schema,
  effectKind: z.enum([
    "create",
    "update",
    "delete",
    "send",
    "publish",
    "purchase",
    "other",
  ]),
  effectMode: z.enum(["live", "dry_run", "preview", "unassessed"]),
  targetId: runContractIdSchema,
  toolContractId: runContractIdSchema,
  requirementLevel: requirementLevelSchema,
  verificationMethod: verificationMethodSchema,
  verifierId: nullableIdSchema,
}).strict();

const outcomeContractBaseSchema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  outcomeContractId: runContractIdSchema,
  runId: runContractIdSchema,
  intentSpecId: runContractIdSchema,
  contractState: z.enum(["declared", "unassessed"]),
  acceptanceCriteria: z.array(acceptanceCriterionV1Schema)
    .max(MAX_OUTCOME_REQUIREMENTS),
  artifactRequirements: z.array(artifactRequirementV1Schema)
    .max(MAX_OUTCOME_REQUIREMENTS),
  effectRequirements: z.array(effectRequirementV1Schema)
    .max(MAX_OUTCOME_REQUIREMENTS),
  requiredCriterionCount: boundedCountSchema,
  requiredArtifactCount: boundedCountSchema,
  requiredEffectCount: boundedCountSchema,
}).strict();

export const outcomeContractV1Schema = outcomeContractBaseSchema.superRefine(
  (value, context) => {
    addDuplicateEntryIssues(value.acceptanceCriteria, "criterionId", context, [
      "acceptanceCriteria",
    ]);
    addDuplicateEntryIssues(
      value.artifactRequirements,
      "artifactRequirementId",
      context,
      ["artifactRequirements"],
    );
    addDuplicateEntryIssues(
      value.effectRequirements,
      "effectRequirementId",
      context,
      ["effectRequirements"],
    );
    const requirementIds = [
      ...value.acceptanceCriteria.map((entry, index) => ({
        id: entry.criterionId,
        path: ["acceptanceCriteria", index, "criterionId"] as Array<
          string | number
        >,
      })),
      ...value.artifactRequirements.map((entry, index) => ({
        id: entry.artifactRequirementId,
        path: ["artifactRequirements", index, "artifactRequirementId"] as Array<
          string | number
        >,
      })),
      ...value.effectRequirements.map((entry, index) => ({
        id: entry.effectRequirementId,
        path: ["effectRequirements", index, "effectRequirementId"] as Array<
          string | number
        >,
      })),
    ];
    const seenRequirementIds = new Set<string>();
    requirementIds.forEach((entry) => {
      if (seenRequirementIds.has(entry.id)) {
        context.addIssue({
          code: "custom",
          message: "Requirement IDs must be unique across all requirement kinds.",
          path: entry.path,
        });
      }
      seenRequirementIds.add(entry.id);
    });

    const requiredCriterionCount = value.acceptanceCriteria.filter(
      (entry) => entry.requirementLevel === "required",
    ).length;
    const requiredArtifactCount = value.artifactRequirements.filter(
      (entry) => entry.requirementLevel === "required",
    ).length;
    const requiredEffectCount = value.effectRequirements.filter(
      (entry) => entry.requirementLevel === "required",
    ).length;
    const expectedCounts = [
      ["requiredCriterionCount", requiredCriterionCount],
      ["requiredArtifactCount", requiredArtifactCount],
      ["requiredEffectCount", requiredEffectCount],
    ] as const;
    expectedCounts.forEach(([field, expected]) => {
      if (value[field] !== expected) {
        context.addIssue({
          code: "custom",
          message: `${field} must match the declared requirements.`,
          path: [field],
        });
      }
    });
    if (
      value.contractState === "unassessed" &&
      (
        value.acceptanceCriteria.length > 0 ||
        value.artifactRequirements.length > 0 ||
        value.effectRequirements.length > 0
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "An unassessed outcome contract cannot declare requirements.",
        path: ["contractState"],
      });
    }
  },
);

export type AcceptanceCriterionV1 = z.infer<
  typeof acceptanceCriterionV1Schema
>;
export type ArtifactRequirementV1 = z.infer<
  typeof artifactRequirementV1Schema
>;
export type EffectRequirementV1 = z.infer<typeof effectRequirementV1Schema>;
export type OutcomeContractV1 = z.infer<typeof outcomeContractV1Schema>;
export type OutcomeContract = OutcomeContractV1;
export type BuildOutcomeContractV1Input = Omit<
  OutcomeContractV1,
  | "schemaVersion"
  | "requiredCriterionCount"
  | "requiredArtifactCount"
  | "requiredEffectCount"
>;

export function buildOutcomeContractV1(
  input: BuildOutcomeContractV1Input,
): OutcomeContractV1 {
  return outcomeContractV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    ...input,
    requiredCriterionCount: input.acceptanceCriteria.filter(
      (entry) => entry.requirementLevel === "required",
    ).length,
    requiredArtifactCount: input.artifactRequirements.filter(
      (entry) => entry.requirementLevel === "required",
    ).length,
    requiredEffectCount: input.effectRequirements.filter(
      (entry) => entry.requirementLevel === "required",
    ).length,
  });
}

export const contextItemTypeSchema = z.enum([
  "evidence",
  "claim",
  "summary",
]);

export const contextSelectionReasonSchema = z.enum([
  "user_included",
  "user_excluded",
  "scope_match",
  "semantic_match",
  "freshness",
  "conflict",
  "policy_excluded",
  "budget_excluded",
  "duplicate",
  "unassessed",
]);

const contextItemV1Schema = z.object({
  itemType: contextItemTypeSchema,
  itemId: runContractIdSchema,
  sourceRevisionId: nullableIdSchema,
  selectionReason: contextSelectionReasonSchema,
  scoreState: z.enum(["scored", "unassessed"]),
  scoreBasisPoints: basisPointsSchema.nullable(),
  freshness: z.enum(["fresh", "stale", "unknown", "unassessed"]),
  conflictState: z.enum(["none", "possible", "confirmed", "unassessed"]),
  conflictIds: uniqueIdList(MAX_CONTEXT_CONFLICT_IDS),
}).strict().superRefine((value, context) => {
  if ((value.scoreState === "scored") !== (value.scoreBasisPoints !== null)) {
    context.addIssue({
      code: "custom",
      message: "A scored item requires basis points; an unassessed item uses null.",
      path: ["scoreBasisPoints"],
    });
  }
  if (value.conflictState === "none" && value.conflictIds.length > 0) {
    context.addIssue({
      code: "custom",
      message: "An item with no conflict cannot include conflict IDs.",
      path: ["conflictIds"],
    });
  }
  if (value.conflictState === "unassessed" && value.conflictIds.length > 0) {
    context.addIssue({
      code: "custom",
      message: "An unassessed conflict state cannot include conflict IDs.",
      path: ["conflictIds"],
    });
  }
  if (
    (value.conflictState === "possible" || value.conflictState === "confirmed") &&
    value.conflictIds.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "A possible or confirmed conflict requires a conflict ID.",
      path: ["conflictIds"],
    });
  }
});

const tokenAllocationV1Schema = z.object({
  tier: z.enum([
    "system",
    "instructions",
    "conversation",
    "context",
    "evidence",
    "memory",
    "tools",
    "reserve",
  ]),
  tokenCount: boundedCountSchema,
}).strict();

const contextManifestBaseSchema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  contextManifestId: runContractIdSchema,
  runId: runContractIdSchema,
  modelTurnId: runContractIdSchema,
  retrievalTraceId: nullableIdSchema,
  querySha256: runContractSha256Schema,
  scopeDecision: z.enum([
    "disabled",
    "user_excluded",
    "user_selected",
    "automatic",
    "hybrid",
    "skipped",
    "unassessed",
  ]),
  selectedItems: z.array(contextItemV1Schema).max(MAX_CONTEXT_ITEMS),
  rejectedItems: z.array(contextItemV1Schema).max(MAX_CONTEXT_ITEMS),
  userInclusionIds: uniqueIdList(MAX_CONTEXT_ITEMS),
  userExclusionIds: uniqueIdList(MAX_CONTEXT_ITEMS),
  allocations: z.array(tokenAllocationV1Schema).max(8),
  providerDisclosureBoundary: z.enum([
    "none",
    "metadata_only",
    "authorized_content",
    "unassessed",
  ]),
  providerId: nullableIdSchema,
  compilerVersionId: nullableIdSchema,
  embeddingVersionId: nullableIdSchema,
  rerankerVersionId: nullableIdSchema,
  policyVersionId: nullableIdSchema,
  compiledContextSha256: nullableSha256Schema,
  selectedItemCount: boundedCountSchema,
  rejectedItemCount: boundedCountSchema,
  conflictCount: boundedCountSchema,
  tokenCount: boundedCountSchema,
}).strict();

export const contextManifestV1Schema = contextManifestBaseSchema.superRefine(
  (value, context) => {
    addDuplicateContextItemIssues(value.selectedItems, context, ["selectedItems"]);
    addDuplicateContextItemIssues(value.rejectedItems, context, ["rejectedItems"]);
    const selectedKeys = new Set(
      value.selectedItems.map((item) => contextItemKey(item)),
    );
    value.rejectedItems.forEach((item, index) => {
      if (selectedKeys.has(contextItemKey(item))) {
        context.addIssue({
          code: "custom",
          message: "A context item cannot be both selected and rejected.",
          path: ["rejectedItems", index],
        });
      }
    });
    addDuplicateEntryIssues(value.allocations, "tier", context, [
      "allocations",
    ]);

    const conflicts = new Set(
      [...value.selectedItems, ...value.rejectedItems]
        .flatMap((item) => item.conflictIds),
    );
    const expectedCounts = [
      ["selectedItemCount", value.selectedItems.length],
      ["rejectedItemCount", value.rejectedItems.length],
      ["conflictCount", conflicts.size],
      [
        "tokenCount",
        value.allocations.reduce(
          (total, allocation) => total + allocation.tokenCount,
          0,
        ),
      ],
    ] as const;
    expectedCounts.forEach(([field, expected]) => {
      if (value[field] !== expected) {
        context.addIssue({
          code: "custom",
          message: `${field} must match the manifest metadata.`,
          path: [field],
        });
      }
    });
    if (
      value.providerDisclosureBoundary !== "none" &&
      value.providerDisclosureBoundary !== "unassessed" &&
      value.providerId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "A provider disclosure requires a provider ID.",
        path: ["providerId"],
      });
    }
    if (
      value.providerDisclosureBoundary === "none" &&
      value.providerId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A manifest with no provider disclosure uses a null provider ID.",
        path: ["providerId"],
      });
    }
    if (
      value.providerDisclosureBoundary === "unassessed" &&
      value.providerId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "An unassessed disclosure boundary uses a null provider ID.",
        path: ["providerId"],
      });
    }
    const userExclusions = new Set(value.userExclusionIds);
    value.userInclusionIds.forEach((id, index) => {
      if (userExclusions.has(id)) {
        context.addIssue({
          code: "custom",
          message: "A user context reference cannot be both included and excluded.",
          path: ["userInclusionIds", index],
        });
      }
    });
  },
);

export type ContextItemV1 = z.infer<typeof contextItemV1Schema>;
export type TokenAllocationV1 = z.infer<typeof tokenAllocationV1Schema>;
export type ContextManifestV1 = z.infer<typeof contextManifestV1Schema>;
export type ContextManifest = ContextManifestV1;
export type BuildContextManifestV1Input = Omit<
  ContextManifestV1,
  | "schemaVersion"
  | "selectedItemCount"
  | "rejectedItemCount"
  | "conflictCount"
  | "tokenCount"
>;

export function buildContextManifestV1(
  input: BuildContextManifestV1Input,
): ContextManifestV1 {
  const conflictIds = new Set(
    [...input.selectedItems, ...input.rejectedItems]
      .flatMap((item) => item.conflictIds),
  );
  return contextManifestV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    ...input,
    selectedItemCount: input.selectedItems.length,
    rejectedItemCount: input.rejectedItems.length,
    conflictCount: conflictIds.size,
    tokenCount: input.allocations.reduce(
      (total, allocation) => total + allocation.tokenCount,
      0,
    ),
  });
}

const pinnedContractRefV1Schema = z.object({
  id: runContractIdSchema,
  pinState: z.enum(["pinned", "unassessed"]),
  versionId: nullableIdSchema,
  sha256: nullableSha256Schema,
}).strict().superRefine((value, context) => {
  const hasPin = value.versionId !== null && value.sha256 !== null;
  if (value.pinState === "pinned" && !hasPin) {
    context.addIssue({
      code: "custom",
      message: "A pinned contract requires a version ID and SHA-256 digest.",
      path: ["pinState"],
    });
  }
  if (
    value.pinState === "unassessed" &&
    (value.versionId !== null || value.sha256 !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "An unassessed contract reference uses null pin fields.",
      path: ["pinState"],
    });
  }
});

const harnessManifestBaseSchema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  harnessManifestId: runContractIdSchema,
  runId: runContractIdSchema,
  agentPrincipalId: runContractIdSchema,
  intentSpecId: runContractIdSchema,
  outcomeContractId: runContractIdSchema,
  manifestState: z.enum(["pinned", "partially_pinned", "unassessed"]),
  engineVersionId: nullableIdSchema,
  agentDefinitionVersionId: nullableIdSchema,
  promptContractVersionId: nullableIdSchema,
  modelProvider: z.enum([
    "openai",
    "google",
    "anthropic",
    "aws_bedrock",
    "local",
    "fallback",
    "unassessed",
  ]),
  modelId: nullableIdSchema,
  modelTier: z.enum(["fast", "reasoning", "unassessed"]),
  modelRouteId: nullableIdSchema,
  interactionMode: intentInteractionModeSchema,
  executionMode: runExecutionModeSchema,
  autonomy: z.enum(["assist", "governed", "execute", "unassessed"]),
  approvalPolicy: z.enum([
    "always",
    "risk_based",
    "read_only",
    "unassessed",
  ]),
  contextCompilerVersionId: nullableIdSchema,
  initialContextManifestId: nullableIdSchema,
  initialContextManifestSha256: nullableSha256Schema,
  tools: z.array(pinnedContractRefV1Schema).max(MAX_RUN_CONTRACT_IDS),
  skills: z.array(pinnedContractRefV1Schema).max(MAX_RUN_CONTRACT_IDS),
  policies: z.array(pinnedContractRefV1Schema).max(MAX_RUN_CONTRACT_IDS),
  contextGrantIds: uniqueIdList(),
  capabilityGrantIds: uniqueIdList(),
  budgets: runBudgetsSchema,
  agentPrincipalSha256: runContractSha256Schema,
  intentSpecSha256: runContractSha256Schema,
  outcomeContractSha256: runContractSha256Schema,
  instructionsSha256: nullableSha256Schema,
  toolboxSha256: nullableSha256Schema,
  skillSetSha256: nullableSha256Schema,
  policySetSha256: nullableSha256Schema,
  toolContractCount: boundedCountSchema,
  skillCount: boundedCountSchema,
  policyCount: boundedCountSchema,
  contextGrantCount: boundedCountSchema,
  capabilityGrantCount: boundedCountSchema,
}).strict();

export const harnessManifestV1Schema = harnessManifestBaseSchema.superRefine(
  (value, context) => {
    addDuplicateEntryIssues(value.tools, "id", context, ["tools"]);
    addDuplicateEntryIssues(value.skills, "id", context, ["skills"]);
    addDuplicateEntryIssues(value.policies, "id", context, ["policies"]);
    const expectedCounts = [
      ["toolContractCount", value.tools.length],
      ["skillCount", value.skills.length],
      ["policyCount", value.policies.length],
      ["contextGrantCount", value.contextGrantIds.length],
      ["capabilityGrantCount", value.capabilityGrantIds.length],
    ] as const;
    expectedCounts.forEach(([field, expected]) => {
      if (value[field] !== expected) {
        context.addIssue({
          code: "custom",
          message: `${field} must match the manifest metadata.`,
          path: [field],
        });
      }
    });
    if (
      (value.initialContextManifestId === null) !==
      (value.initialContextManifestSha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "The initial context manifest ID and digest must appear together.",
        path: ["initialContextManifestId"],
      });
    }
    if (
      value.modelProvider !== "unassessed" &&
      value.modelId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "An assessed model provider requires a model ID.",
        path: ["modelId"],
      });
    }
    if (
      value.modelProvider === "unassessed" &&
      (value.modelId !== null || value.modelTier !== "unassessed")
    ) {
      context.addIssue({
        code: "custom",
        message: "An unassessed provider uses a null model ID and unassessed tier.",
        path: ["modelProvider"],
      });
    }
  },
);

export type PinnedContractRefV1 = z.infer<typeof pinnedContractRefV1Schema>;
export type HarnessManifestV1 = z.infer<typeof harnessManifestV1Schema>;
export type HarnessManifest = HarnessManifestV1;
export type BuildHarnessManifestV1Input = Omit<
  HarnessManifestV1,
  | "schemaVersion"
  | "toolContractCount"
  | "skillCount"
  | "policyCount"
  | "contextGrantCount"
  | "capabilityGrantCount"
>;

export function buildHarnessManifestV1(
  input: BuildHarnessManifestV1Input,
): HarnessManifestV1 {
  return harnessManifestV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    ...input,
    toolContractCount: input.tools.length,
    skillCount: input.skills.length,
    policyCount: input.policies.length,
    contextGrantCount: input.contextGrantIds.length,
    capabilityGrantCount: input.capabilityGrantIds.length,
  });
}

export const terminalDispositionSchema = z.enum([
  "succeeded",
  "partial",
  "waiting_approval",
  "blocked",
  "unverified",
  "failed",
  "canceled",
]);

export const terminalVerificationStateSchema = z.enum([
  "verified",
  "partially_verified",
  "unverified",
  "not_applicable",
  "unassessed",
]);

export const terminalReceiptSourceSchema = z.enum([
  "outcome_evaluator",
  "legacy_adapter",
]);

export const terminalReasonCodeSchema = z.enum([
  "all_requirements_verified",
  "requirements_unmet",
  "approval_required",
  "external_dependency",
  "verification_inconclusive",
  "execution_failed",
  "authorized_cancellation",
  "legacy_completed_without_verification",
  "legacy_failed",
  "legacy_canceled",
  "legacy_waiting_approval",
]);

export const legacyTerminalStatusSchema = z.enum([
  "waiting_approval",
  "completed",
  "failed",
  "canceled",
]);

const requirementVerificationV1Schema = z.object({
  requirementId: runContractIdSchema,
  requirementKind: z.enum(["criterion", "artifact", "effect"]),
  requirementLevel: requirementLevelSchema,
  state: z.enum(["verified", "failed", "unverified", "not_assessed"]),
  verificationMethod: verificationMethodSchema,
  verifierId: nullableIdSchema,
  verificationReceiptId: nullableIdSchema,
}).strict().superRefine((value, context) => {
  if (
    value.state === "verified" &&
    (value.verifierId === null || value.verificationReceiptId === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Verified requirements need a verifier and receipt ID.",
      path: ["state"],
    });
  }
});

const terminalReceiptBaseSchema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  terminalReceiptId: runContractIdSchema,
  runId: runContractIdSchema,
  outcomeContractId: nullableIdSchema,
  source: terminalReceiptSourceSchema,
  legacyStatus: legacyTerminalStatusSchema.nullable(),
  disposition: terminalDispositionSchema,
  executionMode: runExecutionModeSchema,
  verificationState: terminalVerificationStateSchema,
  reasonCode: terminalReasonCodeSchema,
  requirementResults: z.array(requirementVerificationV1Schema)
    .max(MAX_OUTCOME_REQUIREMENTS * 3),
  requiredRequirementCount: boundedCountSchema,
  verifiedRequirementCount: boundedCountSchema,
  failedRequirementCount: boundedCountSchema,
  unverifiedRequirementCount: boundedCountSchema,
  usefulWorkUnitCount: boundedCountSchema,
  artifactReceiptIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  effectReceiptIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  verifierReceiptIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS * 3),
  pendingApprovalIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  blockingDependencyIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  outputSha256: nullableSha256Schema,
}).strict();

export const terminalReceiptV1Schema = terminalReceiptBaseSchema.superRefine(
  (value, context) => {
    addDuplicateEntryIssues(
      value.requirementResults,
      "requirementId",
      context,
      ["requirementResults"],
    );
    const required = value.requirementResults.filter(
      (entry) => entry.requirementLevel === "required",
    );
    const expectedCounts = [
      ["requiredRequirementCount", required.length],
      [
        "verifiedRequirementCount",
        required.filter((entry) => entry.state === "verified").length,
      ],
      [
        "failedRequirementCount",
        required.filter((entry) => entry.state === "failed").length,
      ],
      [
        "unverifiedRequirementCount",
        required.filter(
          (entry) =>
            entry.state === "unverified" || entry.state === "not_assessed",
        ).length,
      ],
    ] as const;
    expectedCounts.forEach(([field, expected]) => {
      if (value[field] !== expected) {
        context.addIssue({
          code: "custom",
          message: `${field} must match required requirement results.`,
          path: [field],
        });
      }
    });
    const listedVerifierReceipts = new Set(value.verifierReceiptIds);
    value.requirementResults.forEach((result, index) => {
      if (
        result.verificationReceiptId !== null &&
        !listedVerifierReceipts.has(result.verificationReceiptId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Requirement verification receipts must be listed on the terminal receipt.",
          path: ["requirementResults", index, "verificationReceiptId"],
        });
      }
    });

    validateLegacyTerminalReceipt(value, context);
    validateTerminalDisposition(value, context);
  },
);

export type TerminalDisposition = z.infer<typeof terminalDispositionSchema>;
export type RunExecutionMode = z.infer<typeof runExecutionModeSchema>;
export type TerminalVerificationState = z.infer<
  typeof terminalVerificationStateSchema
>;
export type RequirementVerificationV1 = z.infer<
  typeof requirementVerificationV1Schema
>;
export type TerminalReceiptV1 = z.infer<typeof terminalReceiptV1Schema>;
export type TerminalReceipt = TerminalReceiptV1;
export type BuildTerminalReceiptV1Input = Omit<
  TerminalReceiptV1,
  | "schemaVersion"
  | "requiredRequirementCount"
  | "verifiedRequirementCount"
  | "failedRequirementCount"
  | "unverifiedRequirementCount"
>;

export function buildTerminalReceiptV1(
  input: BuildTerminalReceiptV1Input,
): TerminalReceiptV1 {
  const required = input.requirementResults.filter(
    (entry) => entry.requirementLevel === "required",
  );
  return terminalReceiptV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    ...input,
    requiredRequirementCount: required.length,
    verifiedRequirementCount: required.filter(
      (entry) => entry.state === "verified",
    ).length,
    failedRequirementCount: required.filter(
      (entry) => entry.state === "failed",
    ).length,
    unverifiedRequirementCount: required.filter(
      (entry) =>
        entry.state === "unverified" || entry.state === "not_assessed",
    ).length,
  });
}

export type LegacyTerminalStatus = z.infer<typeof legacyTerminalStatusSchema>;
export type BuildLegacyTerminalReceiptV1Input = {
  terminalReceiptId: string;
  runId: string;
  legacyStatus: LegacyTerminalStatus;
  pendingApprovalIds?: readonly string[];
  outputSha256?: string | null;
};

/**
 * Legacy completion proves only that the old state machine stopped. It does
 * not prove an outcome contract, so it can never construct `succeeded`.
 */
export function buildLegacyTerminalReceiptV1(
  input: BuildLegacyTerminalReceiptV1Input,
): TerminalReceiptV1 {
  const mapping: Record<
    LegacyTerminalStatus,
    Pick<TerminalReceiptV1, "disposition" | "reasonCode">
  > = {
    waiting_approval: {
      disposition: "waiting_approval",
      reasonCode: "legacy_waiting_approval",
    },
    completed: {
      disposition: "unverified",
      reasonCode: "legacy_completed_without_verification",
    },
    failed: { disposition: "failed", reasonCode: "legacy_failed" },
    canceled: { disposition: "canceled", reasonCode: "legacy_canceled" },
  };
  const mapped = mapping[input.legacyStatus];
  return buildTerminalReceiptV1({
    terminalReceiptId: input.terminalReceiptId,
    runId: input.runId,
    outcomeContractId: null,
    source: "legacy_adapter",
    legacyStatus: input.legacyStatus,
    disposition: mapped.disposition,
    executionMode: "unassessed",
    verificationState: "unassessed",
    reasonCode: mapped.reasonCode,
    requirementResults: [],
    usefulWorkUnitCount: input.legacyStatus === "completed" ? 1 : 0,
    artifactReceiptIds: [],
    effectReceiptIds: [],
    verifierReceiptIds: [],
    pendingApprovalIds: [...(input.pendingApprovalIds || [])],
    blockingDependencyIds: [],
    outputSha256: input.outputSha256 ?? null,
  });
}

const runContractEnvelopeBaseSchema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  envelopeId: runContractIdSchema,
  runId: runContractIdSchema,
  agentPrincipal: agentPrincipalV1Schema,
  intentSpec: intentSpecV1Schema,
  outcomeContract: outcomeContractV1Schema,
  contextManifests: z.array(contextManifestV1Schema)
    .max(MAX_CONTEXT_MANIFESTS),
  harnessManifest: harnessManifestV1Schema,
  terminalReceipt: terminalReceiptV1Schema.nullable(),
}).strict();

export const runContractEnvelopeV1Schema = runContractEnvelopeBaseSchema
  .superRefine((value, context) => {
    const runBindings = [
      ["agentPrincipal", value.agentPrincipal.runId],
      ["intentSpec", value.intentSpec.runId],
      ["outcomeContract", value.outcomeContract.runId],
      ["harnessManifest", value.harnessManifest.runId],
      ...value.contextManifests.map(
        (manifest, index) => [`contextManifests.${index}`, manifest.runId],
      ),
      ...(value.terminalReceipt
        ? [["terminalReceipt", value.terminalReceipt.runId]]
        : []),
    ] as Array<[string, string]>;
    runBindings.forEach(([field, runId]) => {
      if (runId !== value.runId) {
        context.addIssue({
          code: "custom",
          message: `${field} is bound to a different run.`,
          path: field.split("."),
        });
      }
    });
    if (value.outcomeContract.intentSpecId !== value.intentSpec.intentSpecId) {
      context.addIssue({
        code: "custom",
        message: "The outcome contract is bound to a different intent.",
        path: ["outcomeContract", "intentSpecId"],
      });
    }
    if (value.agentPrincipal.correlationId !== value.intentSpec.correlationId) {
      context.addIssue({
        code: "custom",
        message: "The principal and intent must share a correlation ID.",
        path: ["intentSpec", "correlationId"],
      });
    }
    const harnessRefs = [
      [
        "agentPrincipalId",
        value.harnessManifest.agentPrincipalId,
        value.agentPrincipal.agentPrincipalId,
      ],
      [
        "intentSpecId",
        value.harnessManifest.intentSpecId,
        value.intentSpec.intentSpecId,
      ],
      [
        "outcomeContractId",
        value.harnessManifest.outcomeContractId,
        value.outcomeContract.outcomeContractId,
      ],
    ] as const;
    harnessRefs.forEach(([field, actual, expected]) => {
      if (actual !== expected) {
        context.addIssue({
          code: "custom",
          message: `${field} does not match its envelope contract.`,
          path: ["harnessManifest", field],
        });
      }
    });
    if (
      value.harnessManifest.interactionMode !== "unassessed" &&
      value.intentSpec.interactionMode !== "unassessed" &&
      value.harnessManifest.interactionMode !== value.intentSpec.interactionMode
    ) {
      context.addIssue({
        code: "custom",
        message: "The harness interaction mode does not match the intent.",
        path: ["harnessManifest", "interactionMode"],
      });
    }
    if (
      value.harnessManifest.agentDefinitionVersionId !== null &&
      value.harnessManifest.agentDefinitionVersionId !==
        value.agentPrincipal.agentDefinitionVersionId
    ) {
      context.addIssue({
        code: "custom",
        message: "The harness pins a different agent definition version.",
        path: ["harnessManifest", "agentDefinitionVersionId"],
      });
    }
    addGrantBroadeningIssue(
      value.agentPrincipal.contextGrantIds,
      value.harnessManifest.contextGrantIds,
      context,
      "contextGrantIds",
    );
    addGrantBroadeningIssue(
      value.agentPrincipal.capabilityGrantIds,
      value.harnessManifest.capabilityGrantIds,
      context,
      "capabilityGrantIds",
    );
    addBudgetBroadeningIssues(
      value.agentPrincipal.budgets,
      value.harnessManifest.budgets,
      context,
    );
    addDuplicateEntryIssues(
      value.contextManifests,
      "contextManifestId",
      context,
      ["contextManifests"],
    );
    if (
      value.harnessManifest.initialContextManifestId !== null &&
      !value.contextManifests.some(
        (manifest) =>
          manifest.contextManifestId ===
          value.harnessManifest.initialContextManifestId,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "The pinned initial context manifest is missing.",
        path: ["harnessManifest", "initialContextManifestId"],
      });
    }
    const terminalReceipt = value.terminalReceipt;
    if (
      terminalReceipt !== null &&
      terminalReceipt.outcomeContractId !== null &&
      terminalReceipt.outcomeContractId !== value.outcomeContract.outcomeContractId
    ) {
      context.addIssue({
        code: "custom",
        message: "The terminal receipt is bound to a different outcome contract.",
        path: ["terminalReceipt", "outcomeContractId"],
      });
    }
    if (terminalReceipt?.disposition === "succeeded") {
      if (
        value.intentSpec.interactionMode === "preview" ||
        value.harnessManifest.executionMode !== "live" ||
        terminalReceipt.executionMode !== "live"
      ) {
        context.addIssue({
          code: "custom",
          message: "Preview, dry-run, and unassessed execution cannot succeed.",
          path: ["terminalReceipt", "executionMode"],
        });
      }
      validateSucceededReceiptAgainstOutcome(
        terminalReceipt,
        value.outcomeContract,
        context,
      );
    }
    addJsonByteLimitIssue(
      value,
      MAX_RUN_CONTRACT_ENVELOPE_BYTES,
      context,
      "Run contract envelope",
    );
  });

export type RunContractEnvelopeV1 = z.infer<
  typeof runContractEnvelopeV1Schema
>;
export type RunContractEnvelope = RunContractEnvelopeV1;
export type BuildRunContractEnvelopeV1Input = Omit<
  RunContractEnvelopeV1,
  "schemaVersion"
>;

export function buildRunContractEnvelopeV1(
  input: BuildRunContractEnvelopeV1Input,
): RunContractEnvelopeV1 {
  return runContractEnvelopeV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    ...input,
  });
}

/**
 * Only an absent field is legacy compatibility. A present malformed envelope
 * is rejected instead of being silently downgraded to legacy behavior.
 */
export function parseRunContractEnvelopeV1(
  value: unknown,
): RunContractEnvelopeV1 | undefined {
  if (value === undefined) return undefined;
  return runContractEnvelopeV1Schema.parse(value);
}

const runContractEventPayloadBaseSchema = z.object({
  schemaVersion: z.literal(RUN_CONTRACT_SCHEMA_VERSION),
  payloadKind: z.literal("run_contract_envelope"),
  runId: runContractIdSchema,
  envelopeId: runContractIdSchema,
  envelopeSha256: runContractSha256Schema,
  agentPrincipalId: runContractIdSchema,
  agentPrincipalSha256: runContractSha256Schema,
  intentSpecId: runContractIdSchema,
  intentSpecSha256: runContractSha256Schema,
  outcomeContractId: runContractIdSchema,
  outcomeContractSha256: runContractSha256Schema,
  harnessManifestId: runContractIdSchema,
  contextManifestCount: boundedCountSchema,
  toolContractCount: boundedCountSchema,
  skillCount: boundedCountSchema,
  policyCount: boundedCountSchema,
  terminalState: z.enum(["not_emitted", "emitted"]),
  terminalReceiptId: nullableIdSchema,
  terminalDisposition: terminalDispositionSchema.nullable(),
  terminalExecutionMode: runExecutionModeSchema.nullable(),
  terminalVerificationState: terminalVerificationStateSchema.nullable(),
  terminalSource: terminalReceiptSourceSchema.nullable(),
  terminalReasonCode: terminalReasonCodeSchema.nullable(),
  legacyStatus: legacyTerminalStatusSchema.nullable(),
  requiredRequirementCount: boundedCountSchema,
  verifiedRequirementCount: boundedCountSchema,
  failedRequirementCount: boundedCountSchema,
  unverifiedRequirementCount: boundedCountSchema,
  usefulWorkUnitCount: boundedCountSchema,
  artifactReceiptCount: boundedCountSchema,
  effectReceiptCount: boundedCountSchema,
  verifierReceiptCount: boundedCountSchema,
  pendingApprovalCount: boundedCountSchema,
  blockingDependencyCount: boundedCountSchema,
}).strict();

export const runContractEventPayloadV1Schema = runContractEventPayloadBaseSchema
  .superRefine((value, context) => {
    const terminalValues = [
      value.terminalReceiptId,
      value.terminalDisposition,
      value.terminalExecutionMode,
      value.terminalVerificationState,
      value.terminalSource,
      value.terminalReasonCode,
      value.legacyStatus,
    ];
    if (
      value.terminalState === "not_emitted" &&
      (
        terminalValues.some((entry) => entry !== null) ||
        value.requiredRequirementCount !== 0 ||
        value.verifiedRequirementCount !== 0 ||
        value.failedRequirementCount !== 0 ||
        value.unverifiedRequirementCount !== 0 ||
        value.usefulWorkUnitCount !== 0 ||
        value.artifactReceiptCount !== 0 ||
        value.effectReceiptCount !== 0 ||
        value.verifierReceiptCount !== 0 ||
        value.pendingApprovalCount !== 0 ||
        value.blockingDependencyCount !== 0
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "A non-terminal payload must use null terminal fields and zero counts.",
        path: ["terminalState"],
      });
    }
    const requiredTerminalValues = [
      value.terminalReceiptId,
      value.terminalDisposition,
      value.terminalExecutionMode,
      value.terminalVerificationState,
      value.terminalSource,
      value.terminalReasonCode,
    ];
    if (
      value.terminalState === "emitted" &&
      requiredTerminalValues.some((entry) => entry === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A terminal payload requires receipt metadata.",
        path: ["terminalState"],
      });
    }
    if (
      value.terminalState === "emitted" &&
      ((value.terminalSource === "legacy_adapter") !==
        (value.legacyStatus !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a legacy terminal payload carries legacyStatus.",
        path: ["legacyStatus"],
      });
    }
    addJsonByteLimitIssue(
      value,
      MAX_RUN_CONTRACT_EVENT_PAYLOAD_BYTES,
      context,
      "Run contract event payload",
    );
  });

export type RunContractEventPayloadV1 = z.infer<
  typeof runContractEventPayloadV1Schema
>;
export type RunContractEventPayload = RunContractEventPayloadV1;
export type BuildRunContractEventPayloadV1Input = {
  envelope: RunContractEnvelopeV1;
  envelopeSha256: string;
};

/** Builds a compact event projection; it never spreads full contracts. */
export function buildRunContractEventPayloadV1(
  input: BuildRunContractEventPayloadV1Input,
): RunContractEventPayloadV1 {
  const envelope = runContractEnvelopeV1Schema.parse(input.envelope);
  const receipt = envelope.terminalReceipt;
  return runContractEventPayloadV1Schema.parse({
    schemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
    payloadKind: "run_contract_envelope",
    runId: envelope.runId,
    envelopeId: envelope.envelopeId,
    envelopeSha256: input.envelopeSha256,
    agentPrincipalId: envelope.agentPrincipal.agentPrincipalId,
    agentPrincipalSha256: envelope.harnessManifest.agentPrincipalSha256,
    intentSpecId: envelope.intentSpec.intentSpecId,
    intentSpecSha256: envelope.harnessManifest.intentSpecSha256,
    outcomeContractId: envelope.outcomeContract.outcomeContractId,
    outcomeContractSha256: envelope.harnessManifest.outcomeContractSha256,
    harnessManifestId: envelope.harnessManifest.harnessManifestId,
    contextManifestCount: envelope.contextManifests.length,
    toolContractCount: envelope.harnessManifest.toolContractCount,
    skillCount: envelope.harnessManifest.skillCount,
    policyCount: envelope.harnessManifest.policyCount,
    terminalState: receipt ? "emitted" : "not_emitted",
    terminalReceiptId: receipt?.terminalReceiptId || null,
    terminalDisposition: receipt?.disposition || null,
    terminalExecutionMode: receipt?.executionMode || null,
    terminalVerificationState: receipt?.verificationState || null,
    terminalSource: receipt?.source || null,
    terminalReasonCode: receipt?.reasonCode || null,
    legacyStatus: receipt?.legacyStatus || null,
    requiredRequirementCount: receipt?.requiredRequirementCount || 0,
    verifiedRequirementCount: receipt?.verifiedRequirementCount || 0,
    failedRequirementCount: receipt?.failedRequirementCount || 0,
    unverifiedRequirementCount: receipt?.unverifiedRequirementCount || 0,
    usefulWorkUnitCount: receipt?.usefulWorkUnitCount || 0,
    artifactReceiptCount: receipt?.artifactReceiptIds.length || 0,
    effectReceiptCount: receipt?.effectReceiptIds.length || 0,
    verifierReceiptCount: receipt?.verifierReceiptIds.length || 0,
    pendingApprovalCount: receipt?.pendingApprovalIds.length || 0,
    blockingDependencyCount: receipt?.blockingDependencyIds.length || 0,
  });
}

function validateLegacyTerminalReceipt(
  value: z.infer<typeof terminalReceiptBaseSchema>,
  context: z.RefinementCtx,
) {
  if (value.source === "outcome_evaluator" && value.legacyStatus !== null) {
    context.addIssue({
      code: "custom",
      message: "An evaluated receipt cannot include a legacy status.",
      path: ["legacyStatus"],
    });
  }
  if (
    value.source === "outcome_evaluator" &&
    value.requirementResults.length > 0 &&
    value.outcomeContractId === null
  ) {
    context.addIssue({
      code: "custom",
      message: "Evaluated requirement results require an outcome contract ID.",
      path: ["outcomeContractId"],
    });
  }
  if (value.source !== "legacy_adapter") return;

  if (value.legacyStatus === null) {
    context.addIssue({
      code: "custom",
      message: "A legacy receipt requires its original status.",
      path: ["legacyStatus"],
    });
    return;
  }
  const expectedDisposition: Record<LegacyTerminalStatus, TerminalDisposition> = {
    waiting_approval: "waiting_approval",
    completed: "unverified",
    failed: "failed",
    canceled: "canceled",
  };
  const expectedReason: Record<
    LegacyTerminalStatus,
    z.infer<typeof terminalReasonCodeSchema>
  > = {
    waiting_approval: "legacy_waiting_approval",
    completed: "legacy_completed_without_verification",
    failed: "legacy_failed",
    canceled: "legacy_canceled",
  };
  if (value.disposition !== expectedDisposition[value.legacyStatus]) {
    context.addIssue({
      code: "custom",
      message: "Legacy status cannot claim a stronger terminal disposition.",
      path: ["disposition"],
    });
  }
  if (value.reasonCode !== expectedReason[value.legacyStatus]) {
    context.addIssue({
      code: "custom",
      message: "Legacy status requires its matching compatibility reason.",
      path: ["reasonCode"],
    });
  }
  if (
    value.outcomeContractId !== null ||
    value.executionMode !== "unassessed" ||
    value.verificationState !== "unassessed" ||
    value.requirementResults.length > 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Legacy receipts cannot synthesize outcome verification.",
      path: ["source"],
    });
  }
}

function validateTerminalDisposition(
  value: z.infer<typeof terminalReceiptBaseSchema>,
  context: z.RefinementCtx,
) {
  const successCapableMethods = new Set<
    z.infer<typeof verificationMethodSchema>
  >([
    "deterministic",
    "provider_receipt",
    "read_after_write",
    "signed_evidence",
    "human_attestation",
  ]);

  if (value.disposition === "succeeded") {
    const invalid =
      value.source !== "outcome_evaluator" ||
      value.outcomeContractId === null ||
      value.executionMode !== "live" ||
      value.verificationState !== "verified" ||
      value.reasonCode !== "all_requirements_verified" ||
      value.requiredRequirementCount === 0 ||
      value.verifiedRequirementCount !== value.requiredRequirementCount ||
      value.failedRequirementCount !== 0 ||
      value.unverifiedRequirementCount !== 0 ||
      value.pendingApprovalIds.length > 0 ||
      value.blockingDependencyIds.length > 0 ||
      value.requirementResults.some(
        (entry) =>
          entry.requirementLevel === "required" &&
          !successCapableMethods.has(entry.verificationMethod),
      );
    if (invalid) {
      context.addIssue({
        code: "custom",
        message: "Succeeded requires every required outcome to have strong verification.",
        path: ["disposition"],
      });
    }
  }
  if (
    value.disposition === "partial" &&
    (
      value.usefulWorkUnitCount === 0 ||
      value.failedRequirementCount + value.unverifiedRequirementCount === 0 ||
      value.reasonCode !== "requirements_unmet"
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Partial requires useful work and an unmet required outcome.",
      path: ["disposition"],
    });
  }
  if (
    value.disposition === "waiting_approval" &&
    (value.pendingApprovalIds.length === 0 ||
      !["approval_required", "legacy_waiting_approval"].includes(value.reasonCode))
  ) {
    context.addIssue({
      code: "custom",
      message: "Waiting approval requires a bound approval ID.",
      path: ["pendingApprovalIds"],
    });
  }
  if (
    value.disposition === "blocked" &&
    (value.blockingDependencyIds.length === 0 ||
      value.reasonCode !== "external_dependency")
  ) {
    context.addIssue({
      code: "custom",
      message: "Blocked requires a bound dependency ID.",
      path: ["blockingDependencyIds"],
    });
  }
  if (
    value.disposition === "unverified" &&
    value.source !== "legacy_adapter" &&
    (
      value.verificationState === "verified" ||
      value.reasonCode !== "verification_inconclusive"
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "An evaluated unverified receipt must record inconclusive verification.",
      path: ["verificationState"],
    });
  }
  if (
    value.disposition === "failed" &&
    !["execution_failed", "requirements_unmet", "legacy_failed"].includes(
      value.reasonCode,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Failed requires a failure reason code.",
      path: ["reasonCode"],
    });
  }
  if (
    value.disposition === "canceled" &&
    !["authorized_cancellation", "legacy_canceled"].includes(value.reasonCode)
  ) {
    context.addIssue({
      code: "custom",
      message: "Canceled requires an authorized cancellation reason.",
      path: ["reasonCode"],
    });
  }
}

function validateSucceededReceiptAgainstOutcome(
  receipt: TerminalReceiptV1,
  outcome: OutcomeContractV1,
  context: z.RefinementCtx,
) {
  if (outcome.contractState !== "declared") {
    context.addIssue({
      code: "custom",
      message: "An unassessed outcome contract cannot succeed.",
      path: ["terminalReceipt", "disposition"],
    });
    return;
  }
  const declared = new Map<string, {
    kind: RequirementVerificationV1["requirementKind"];
    method: z.infer<typeof verificationMethodSchema>;
    effectMode: EffectRequirementV1["effectMode"] | null;
  }>();
  outcome.acceptanceCriteria
    .filter((entry) => entry.requirementLevel === "required")
    .forEach((entry) => declared.set(entry.criterionId, {
      kind: "criterion",
      method: entry.verificationMethod,
      effectMode: null,
    }));
  outcome.artifactRequirements
    .filter((entry) => entry.requirementLevel === "required")
    .forEach((entry) => declared.set(entry.artifactRequirementId, {
      kind: "artifact",
      method: entry.verificationMethod,
      effectMode: null,
    }));
  outcome.effectRequirements
    .filter((entry) => entry.requirementLevel === "required")
    .forEach((entry) => declared.set(entry.effectRequirementId, {
      kind: "effect",
      method: entry.verificationMethod,
      effectMode: entry.effectMode,
    }));

  const receiptResults = new Map(
    receipt.requirementResults
      .filter((entry) => entry.requirementLevel === "required")
      .map((entry) => [entry.requirementId, entry]),
  );
  declared.forEach((requirement, requirementId) => {
    const result = receiptResults.get(requirementId);
    if (
      !result ||
      result.requirementKind !== requirement.kind ||
      result.state !== "verified" ||
      result.verificationMethod !== requirement.method ||
      requirement.effectMode === "dry_run" ||
      requirement.effectMode === "preview" ||
      requirement.effectMode === "unassessed"
    ) {
      context.addIssue({
        code: "custom",
        message: "A required outcome is missing valid live verification.",
        path: ["terminalReceipt", "requirementResults"],
      });
    }
  });
  if (receiptResults.size !== declared.size) {
    context.addIssue({
      code: "custom",
      message: "Terminal required-result count does not match the outcome contract.",
      path: ["terminalReceipt", "requiredRequirementCount"],
    });
  }
}

function addDuplicateEntryIssues<
  Key extends string,
  Entry extends Record<Key, string>,
>(
  entries: readonly Entry[],
  key: Key,
  context: z.RefinementCtx,
  path: Array<string | number>,
) {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const value = entry[key];
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `${String(key)} values must be unique.`,
        path: [...path, index, key],
      });
    }
    seen.add(value);
  });
}

function contextItemKey(item: ContextItemV1) {
  return `${item.itemType}:${item.itemId}`;
}

function addGrantBroadeningIssue(
  principalGrantIds: readonly string[],
  harnessGrantIds: readonly string[],
  context: z.RefinementCtx,
  field: "contextGrantIds" | "capabilityGrantIds",
) {
  const allowed = new Set(principalGrantIds);
  harnessGrantIds.forEach((id, index) => {
    if (!allowed.has(id)) {
      context.addIssue({
        code: "custom",
        message: "A harness manifest cannot broaden principal grants.",
        path: ["harnessManifest", field, index],
      });
    }
  });
}

function addBudgetBroadeningIssues(
  principal: RunBudgets,
  harness: RunBudgets,
  context: z.RefinementCtx,
) {
  const fields = [
    "modelTurnBudget",
    "tokenBudget",
    "costMicrousdBudget",
    "wallClockMsBudget",
    "toolCallBudget",
    "browserActionBudget",
    "agentBudget",
    "fanOutBudget",
    "retryBudget",
    "replanBudget",
    "toolResultByteBudget",
    "externalEffectBudget",
  ] as const;
  fields.forEach((field) => {
    const authority = budgetLimit(principal, field);
    const effective = budgetLimit(harness, field);
    if (!authority) return;
    if (!effective) {
      if (authority.state === "bounded") {
        context.addIssue({
          code: "custom",
          message: "A harness budget cannot omit a bounded principal budget.",
          path: ["harnessManifest", "budgets", field],
        });
      }
      return;
    }
    if (authority.state !== "bounded" || effective.state === "unassessed") {
      return;
    }
    if (
      effective.state !== "bounded" ||
      effective.limitCount === null ||
      authority.limitCount === null ||
      effective.limitCount > authority.limitCount
    ) {
      context.addIssue({
        code: "custom",
        message: "A harness budget cannot exceed its principal budget.",
        path: ["harnessManifest", "budgets", field],
      });
    }
  });
}

function budgetLimit(
  budgets: RunBudgets,
  field: string,
): CountLimitV1 | undefined {
  const candidate = (budgets as unknown as Record<string, unknown>)[field];
  const parsed = countLimitV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function addDuplicateContextItemIssues(
  items: readonly ContextItemV1[],
  context: z.RefinementCtx,
  path: Array<string | number>,
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = contextItemKey(item);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Context item references must be unique.",
        path: [...path, index],
      });
    }
    seen.add(key);
  });
}

function addJsonByteLimitIssue(
  value: unknown,
  maxBytes: number,
  context: z.RefinementCtx,
  label: string,
) {
  const serialized = JSON.stringify(value);
  const byteCount = serialized === undefined
    ? Number.POSITIVE_INFINITY
    : new TextEncoder().encode(serialized).byteLength;
  if (byteCount > maxBytes) {
    context.addIssue({
      code: "custom",
      message: `${label} exceeds ${maxBytes} UTF-8 bytes.`,
    });
  }
}
