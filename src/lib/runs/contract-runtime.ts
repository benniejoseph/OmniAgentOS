import { createHash } from "node:crypto";
import {
  buildAgentPrincipalV1,
  buildContextManifestV1,
  buildHarnessManifestV1,
  buildIntentSpecV1,
  buildOutcomeContractV1,
  buildRunContractEnvelopeV1,
  buildRunContractEventPayloadV1,
  type HarnessManifestV1,
  type IntentSpecV1,
  type RunBudgetsV1,
  type RunContractEnvelopeV1,
  type RunContractEventPayloadV1,
} from "@/lib/runs/contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export type ShadowRunContractSnapshot = Readonly<{
  envelope: RunContractEnvelopeV1;
  envelopeSha256: string;
  eventPayload: RunContractEventPayloadV1;
}>;

type ShadowRunBudgetInput = Readonly<{
  maxModelTurns: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxToolResultBytes: number;
  maxExternalEffects: number;
}>;

export type BuildInitialShadowRunContractInput = Readonly<{
  runId: string;
  tenantId: string;
  agentId?: string;
  executionScope: ExecutionScope;
  requestSha256: string;
  requestedOutcomeSha256: string;
  interactionMode: IntentSpecV1["interactionMode"];
  executionMode: HarnessManifestV1["executionMode"];
  autonomy: HarnessManifestV1["autonomy"];
  approvalPolicy: HarnessManifestV1["approvalPolicy"];
  budget: ShadowRunBudgetInput;
}>;

export type ResolveShadowRunContractInput = Readonly<{
  active: ShadowRunContractSnapshot;
  querySha256: string;
  retrievalTraceId?: string;
  scopeDecision:
    | "disabled"
    | "user_excluded"
    | "user_selected"
    | "automatic"
    | "hybrid"
    | "skipped"
    | "unassessed";
  selectedContext: ReadonlyArray<{
    id: string;
    score?: number;
    userIncluded?: boolean;
  }>;
  userInclusionIds: readonly string[];
  userExclusionIds: readonly string[];
  compiledContextSha256?: string;
  providerDisclosureBoundary:
    | "none"
    | "metadata_only"
    | "authorized_content"
    | "unassessed";
  providerId?: string;
  modelProvider: HarnessManifestV1["modelProvider"];
  modelId?: string;
  modelTier: HarnessManifestV1["modelTier"];
  modelRouteId?: string;
  toolIds: readonly string[];
  skillIds: readonly string[];
  policyIds: readonly string[];
  instructionsSha256: string;
  toolboxSha256: string;
}>;

/**
 * Builds the pre-execution P0.2 snapshot. Unknown compiler/model details stay
 * explicitly unassessed until the resolved harness is available.
 */
export function buildInitialShadowRunContract(
  input: BuildInitialShadowRunContractInput,
): ShadowRunContractSnapshot {
  const { executionScope, runId } = input;
  const budgets = assessedBudgets(input.budget);
  const agentPrincipal = buildAgentPrincipalV1({
    agentPrincipalId: `${runId}:principal:v1`,
    runId,
    tenantId: contractReferenceId("tenant", input.tenantId),
    principalType: executionScope.executingPrincipalType,
    executingPrincipalId: optionalContractReferenceId(
      "principal",
      executionScope.executingPrincipalId,
    ),
    authoritySource: authoritySourceFor(executionScope),
    ownerActorId: optionalContractReferenceId(
      "actor",
      executionScope.initiatingActorId,
    ),
    initiatingActorId: optionalContractReferenceId(
      "actor",
      executionScope.initiatingActorId,
    ),
    agentDefinitionId: optionalContractReferenceId("agent", input.agentId),
    agentDefinitionVersionId: null,
    workspaceId: optionalContractReferenceId(
      "workspace",
      executionScope.workspaceId,
    ),
    projectId: optionalContractReferenceId("project", executionScope.projectId),
    missionId: optionalContractReferenceId("mission", executionScope.missionId),
    delegationId: optionalContractReferenceId(
      "delegation",
      executionScope.delegationId,
    ),
    delegationChainIds: executionScope.delegationId
      ? [contractReferenceId("delegation", executionScope.delegationId)]
      : [],
    correlationId: contractReferenceId(
      "correlation",
      executionScope.correlationId,
    ),
    causationId: optionalContractReferenceId(
      "causation",
      executionScope.causationId,
    ),
    purposeSha256: createHash("sha256")
      .update(executionScope.purpose)
      .digest("hex"),
    contextGrantIds: contractReferenceIds(
      "context-grant",
      executionScope.contextGrantIds,
    ),
    capabilityGrantIds: contractReferenceIds(
      "capability-grant",
      executionScope.capabilityGrantIds,
    ),
    budgetPolicyId: null,
    budgets,
  });
  const intentSpec = buildIntentSpecV1({
    intentSpecId: `${runId}:intent:v1`,
    runId,
    correlationId: agentPrincipal.correlationId,
    requestSha256: input.requestSha256,
    requestedOutcomeSha256: input.requestedOutcomeSha256,
    targetIds: [],
    excludedTargetIds: [],
    constraintIds: [],
    ambiguityState: "unassessed",
    ambiguityIds: [],
    riskAssessmentState: "unassessed",
    riskTier: "unassessed",
    interactionMode: input.interactionMode,
  });
  const outcomeContract = buildOutcomeContractV1({
    outcomeContractId: `${runId}:outcome:v1`,
    runId,
    intentSpecId: intentSpec.intentSpecId,
    contractState: "unassessed",
    acceptanceCriteria: [],
    artifactRequirements: [],
    effectRequirements: [],
  });
  const agentPrincipalSha256 = sha256Json(agentPrincipal);
  const intentSpecSha256 = sha256Json(intentSpec);
  const outcomeContractSha256 = sha256Json(outcomeContract);
  const harnessManifest = buildHarnessManifestV1({
    harnessManifestId: `${runId}:harness:unassessed:v1`,
    runId,
    agentPrincipalId: agentPrincipal.agentPrincipalId,
    intentSpecId: intentSpec.intentSpecId,
    outcomeContractId: outcomeContract.outcomeContractId,
    manifestState: "unassessed",
    engineVersionId: null,
    agentDefinitionVersionId: null,
    promptContractVersionId: null,
    modelProvider: "unassessed",
    modelId: null,
    modelTier: "unassessed",
    modelRouteId: null,
    interactionMode: input.interactionMode,
    executionMode: input.executionMode,
    autonomy: input.autonomy,
    approvalPolicy: input.approvalPolicy,
    contextCompilerVersionId: null,
    initialContextManifestId: null,
    initialContextManifestSha256: null,
    tools: [],
    skills: [],
    policies: [],
    contextGrantIds: agentPrincipal.contextGrantIds,
    capabilityGrantIds: agentPrincipal.capabilityGrantIds,
    budgets,
    agentPrincipalSha256,
    intentSpecSha256,
    outcomeContractSha256,
    instructionsSha256: null,
    toolboxSha256: null,
    skillSetSha256: null,
    policySetSha256: null,
  });

  return snapshot(buildRunContractEnvelopeV1({
    envelopeId: `${runId}:contracts:v1`,
    runId,
    agentPrincipal,
    intentSpec,
    outcomeContract,
    contextManifests: [],
    harnessManifest,
    terminalReceipt: null,
  }));
}

/** Pins the effective context, model, toolbox, skills, policies, and budgets. */
export function resolveShadowRunContract(
  input: ResolveShadowRunContractInput,
): ShadowRunContractSnapshot {
  const active = input.active.envelope;
  const runId = active.runId;
  const contextManifestId = `${runId}:context:initial:v1`;
  const selectedItems = uniqueContextItems(input.selectedContext).map((item) => {
    const scoreBasisPoints = typeof item.score === "number" && Number.isFinite(item.score)
      ? Math.round(Math.min(Math.max(item.score, 0), 1) * 10_000)
      : null;
    return {
      itemType: "evidence" as const,
      itemId: contractReferenceId("evidence", item.id),
      sourceRevisionId: null,
      selectionReason: item.userIncluded
        ? "user_included" as const
        : "semantic_match" as const,
      scoreState: scoreBasisPoints === null
        ? "unassessed" as const
        : "scored" as const,
      scoreBasisPoints,
      freshness: "unknown" as const,
      conflictState: "unassessed" as const,
      conflictIds: [],
    };
  });
  const contextManifest = buildContextManifestV1({
    contextManifestId,
    runId,
    modelTurnId: `${runId}:turn:initial:v1`,
    retrievalTraceId: optionalContractReferenceId(
      "retrieval",
      input.retrievalTraceId,
    ),
    querySha256: input.querySha256,
    scopeDecision: input.scopeDecision,
    selectedItems,
    rejectedItems: [],
    userInclusionIds: contractReferenceIds(
      "evidence",
      input.userInclusionIds,
    ),
    userExclusionIds: contractReferenceIds(
      "evidence",
      input.userExclusionIds,
    ),
    allocations: [],
    providerDisclosureBoundary: input.providerDisclosureBoundary,
    providerId: input.providerDisclosureBoundary === "none"
      ? null
      : optionalContractReferenceId("provider", input.providerId),
    compilerVersionId: "context-compiler:v1",
    embeddingVersionId: null,
    rerankerVersionId: null,
    policyVersionId: null,
    compiledContextSha256: input.compiledContextSha256 || null,
  });
  const contextManifestSha256 = sha256Json(contextManifest);
  const toolIds = contractReferenceIds("tool", input.toolIds);
  const skillIds = contractReferenceIds("skill", input.skillIds);
  const policyIds = contractReferenceIds("policy", input.policyIds);
  const harnessManifest = buildHarnessManifestV1({
    harnessManifestId: `${runId}:harness:resolved:v1`,
    runId,
    agentPrincipalId: active.agentPrincipal.agentPrincipalId,
    intentSpecId: active.intentSpec.intentSpecId,
    outcomeContractId: active.outcomeContract.outcomeContractId,
    manifestState: "partially_pinned",
    engineVersionId: null,
    agentDefinitionVersionId: active.agentPrincipal.agentDefinitionVersionId,
    promptContractVersionId: null,
    modelProvider: input.modelProvider,
    modelId: input.modelProvider === "unassessed"
      ? null
      : optionalContractReferenceId("model", input.modelId),
    modelTier: input.modelTier,
    modelRouteId: optionalContractReferenceId("model-route", input.modelRouteId),
    interactionMode: active.intentSpec.interactionMode,
    executionMode: active.harnessManifest.executionMode,
    autonomy: active.harnessManifest.autonomy,
    approvalPolicy: active.harnessManifest.approvalPolicy,
    contextCompilerVersionId: contextManifest.compilerVersionId,
    initialContextManifestId: contextManifest.contextManifestId,
    initialContextManifestSha256: contextManifestSha256,
    tools: unassessedReferences(toolIds),
    skills: unassessedReferences(skillIds),
    policies: unassessedReferences(policyIds),
    contextGrantIds: active.agentPrincipal.contextGrantIds,
    capabilityGrantIds: active.agentPrincipal.capabilityGrantIds,
    budgets: active.agentPrincipal.budgets,
    agentPrincipalSha256: sha256Json(active.agentPrincipal),
    intentSpecSha256: sha256Json(active.intentSpec),
    outcomeContractSha256: sha256Json(active.outcomeContract),
    instructionsSha256: input.instructionsSha256,
    toolboxSha256: input.toolboxSha256,
    skillSetSha256: sha256Json(skillIds),
    policySetSha256: sha256Json(policyIds),
  });

  return snapshot(buildRunContractEnvelopeV1({
    envelopeId: `${runId}:manifests:v1`,
    runId,
    agentPrincipal: active.agentPrincipal,
    intentSpec: active.intentSpec,
    outcomeContract: active.outcomeContract,
    contextManifests: [contextManifest],
    harnessManifest,
    terminalReceipt: null,
  }));
}

function snapshot(envelope: RunContractEnvelopeV1): ShadowRunContractSnapshot {
  const envelopeSha256 = sha256Json(envelope);
  return Object.freeze({
    envelope,
    envelopeSha256,
    eventPayload: buildRunContractEventPayloadV1({ envelope, envelopeSha256 }),
  });
}

function assessedBudgets(input: ShadowRunBudgetInput): RunBudgetsV1 {
  return {
    assessmentState: "assessed",
    modelTurnBudget: bounded(input.maxModelTurns),
    toolCallBudget: bounded(input.maxToolCalls),
    tokenBudget: bounded(input.maxOutputTokens),
    toolResultByteBudget: bounded(input.maxToolResultBytes),
    externalEffectBudget: bounded(input.maxExternalEffects),
  };
}

function bounded(limitCount: number) {
  return {
    state: "bounded" as const,
    limitCount: Math.min(1_000_000_000, Math.max(0, Math.round(limitCount))),
  };
}

function authoritySourceFor(
  scope: ExecutionScope,
): "authenticated_actor" | "delegated" | "system" | "unassessed" {
  if (scope.delegationId) return "delegated";
  if (scope.executingPrincipalType === "system") return "system";
  if (scope.executingPrincipalType === "user" && scope.executingPrincipalId) {
    return "authenticated_actor";
  }
  return "unassessed";
}

function unassessedReferences(ids: readonly string[]) {
  return ids.map((id) => ({
    id,
    pinState: "unassessed" as const,
    versionId: null,
    sha256: null,
  }));
}

function uniqueContextItems(
  items: ResolveShadowRunContractInput["selectedContext"],
) {
  const byId = new Map<string, (typeof items)[number]>();
  items.forEach((item) => {
    if (!byId.has(item.id)) byId.set(item.id, item);
  });
  return [...byId.values()];
}

function contractReferenceIds(prefix: string, values: readonly string[]) {
  return [...new Set(values.map((value) => contractReferenceId(prefix, value)))];
}

function optionalContractReferenceId(
  prefix: string,
  value: string | null | undefined,
) {
  return value ? contractReferenceId(prefix, value) : null;
}

function contractReferenceId(prefix: string, value: string) {
  const normalized = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(normalized)) {
    return normalized;
  }
  return `${prefix}:${createHash("sha256").update(normalized).digest("hex")}`;
}

function sha256Json(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
