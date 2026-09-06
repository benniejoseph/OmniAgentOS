import {
  buildBuiltInAgentIdentityV1,
  parseAgentDefinitionV1,
  parseAgentPrincipalDefinitionV1,
  type ResolvedAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { WORKFLOW_EXECUTOR_TIMEOUT_MS, WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import {
  buildDelegationContractV1,
  type DelegationArtifactReferenceV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import { isBuiltInPromptAgentId } from "@/lib/orchestration/prompts";
import { runBudgetCountersV1Schema } from "@/lib/runs/budgets";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  workflowNodeAgentResultJsonSchema,
  workflowNodeInputSha256,
  type WorkflowNodeInputV1,
} from "@/lib/workflows/node-contract";
import type {
  WorkflowPlanNode,
  WorkflowPlanNodeExecutionRecord,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

const WORKFLOW_OUTPUT_ARTIFACT_KINDS = [
  "analysis",
  "result",
  "verification",
  "report",
  "memory",
  "control",
] as const;

export function buildWorkflowNodeDelegationContractV1(input: {
  detail: WorkflowRunDetail;
  planId: string;
  node: WorkflowPlanNode;
  nodeInput: WorkflowNodeInputV1;
  dependencyRecords: readonly WorkflowPlanNodeExecutionRecord[];
  parentExecutionScope?: ExecutionScope;
  remainingWallTimeMs: number;
  createdAt?: string;
}) {
  if (input.nodeInput.executor !== "agent") {
    throw new Error(`Workflow node ${input.node.id} is not an Agent delegation.`);
  }
  const tenantId = requiredId(input.detail.run.tenantId, "workflow tenant");
  const actorId = requiredId(
    input.parentExecutionScope?.initiatingActorId ||
      stringMetadata(input.detail, "actorId"),
    "workflow initiating actor",
  );
  const delegator = workflowDelegatorIdentity(input.detail, {
    tenantId,
    actorId,
    parentExecutionScope: input.parentExecutionScope,
  });
  const delegateAgentId = workflowDelegateAgentId(input.node.kind);
  const delegate = buildBuiltInAgentIdentityV1({
    agentId: delegateAgentId,
    tenantId,
    controllerActorId: actorId,
  });
  const verifier = buildBuiltInAgentIdentityV1({
    agentId: "sentinel",
    tenantId,
    controllerActorId: actorId,
  });
  const parentBudgets = runBudgetCountersV1Schema.parse(
    input.detail.run.input.budgetLimits || WORKFLOW_RUN_BUDGET_LIMITS,
  );
  const wallTimeMs = Math.floor(Math.min(
    WORKFLOW_EXECUTOR_TIMEOUT_MS,
    input.remainingWallTimeMs,
    parentBudgets.wallTimeMs,
  ));
  if (wallTimeMs < 101) {
    throw new Error(`Workflow node ${input.node.id} has no delegation time remaining.`);
  }
  const createdAt = input.createdAt || new Date().toISOString();
  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime)) {
    throw new Error("Workflow delegation creation time is invalid.");
  }
  const completeBy = new Date(createdTime + wallTimeMs).toISOString();
  const acceptBy = new Date(
    createdTime + Math.max(1, Math.min(1_000, Math.floor(wallTimeMs / 2))),
  ).toISOString();
  const delegationId = `delegation:${canonicalJsonSha256({
    schemaVersion: 1,
    workflowRunId: input.detail.run.id,
    planId: input.planId,
    nodeId: input.node.id,
    inputSha256: workflowNodeInputSha256(input.nodeInput),
  })}`;
  const parentGrants: DelegationContractV1["grants"] = {
    contextGrantIds: [...(input.parentExecutionScope?.contextGrantIds || [])],
    capabilityGrantIds: [...(input.parentExecutionScope?.capabilityGrantIds || [])],
    governedToolIds: unique([
      ...delegator.principal.toolGrantIds,
      ...input.nodeInput.grants.toolIds,
    ]),
    connectorTargets: unique(input.nodeInput.grants.connectorTargets),
  };
  const modelTokenBudget = budgetShare(parentBudgets.tokens, parentBudgets.modelTurns);
  const modelCostBudget = budgetShare(
    parentBudgets.costMicrousd,
    parentBudgets.modelTurns,
  );

  return buildDelegationContractV1({
    delegationId,
    scope: {
      tenantId,
      initiatingActorId: actorId,
      parentExecutionId: contractId(input.detail.run.id),
      parentPrincipalId: contractId(
        input.parentExecutionScope?.executingPrincipalId ||
          delegator.principal.principalId,
      ),
      parentDelegationId: input.parentExecutionScope?.delegationId
        ? contractId(input.parentExecutionScope.delegationId)
        : null,
      workspaceId: nullableContractId(input.parentExecutionScope?.workspaceId),
      projectId: nullableContractId(
        input.parentExecutionScope?.projectId || stringMetadata(input.detail, "projectId"),
      ),
      missionId: nullableContractId(
        input.parentExecutionScope?.missionId || stringMetadata(input.detail, "missionId"),
      ),
      correlationSha256: canonicalJsonSha256({
        correlationId: input.parentExecutionScope?.correlationId || input.detail.run.id,
      }),
    },
    delegator: {
      principalId: contractId(delegator.principal.principalId),
      agentId: contractId(delegator.definition.logicalAgentId),
      definitionVersion: delegator.definition.definitionVersion,
    },
    delegate: {
      principalId: contractId(delegate.principal.principalId),
      agentId: delegate.definition.logicalAgentId,
      definitionVersion: delegate.definition.definitionVersion,
    },
    purpose: `workflow.node.${input.node.kind}.execute`,
    idempotencyKeySha256: canonicalJsonSha256({
      tenantId,
      workflowRunId: input.detail.run.id,
      planId: input.planId,
      nodeId: input.node.id,
      inputSha256: workflowNodeInputSha256(input.nodeInput),
    }),
    objective: workflowDelegationObjective(input.nodeInput),
    acceptanceCriteria: workflowAcceptanceCriteria(input.nodeInput),
    inputArtifacts: workflowArtifactReferences(input.dependencyRecords),
    output: {
      schemaId: "workflow-node-result",
      schemaVersion: 1,
      schema: workflowNodeAgentResultJsonSchema as unknown as DelegationContractV1["output"]["schema"],
      artifactKinds: [...WORKFLOW_OUTPUT_ARTIFACT_KINDS],
      maxArtifacts: 8,
      maxBytes: input.nodeInput.limits.maxOutputChars * 4,
    },
    grants: {
      contextGrantIds: [],
      capabilityGrantIds: [],
      governedToolIds: [],
      connectorTargets: [],
    },
    parentAuthority: {
      grants: parentGrants,
      budgets: parentBudgets,
      completeBy,
    },
    budgets: {
      modelTurns: 1,
      tokens: modelTokenBudget,
      costMicrousd: modelCostBudget,
      wallTimeMs,
      toolCalls: 0,
      browserActions: 0,
      agents: 1,
      fanOut: 0,
      retries: 0,
      replans: 0,
    },
    deadline: { createdAt, acceptBy, completeBy },
    cancellation: {
      cancelable: true,
      signalId: `delegation-signal:${canonicalJsonSha256({ delegationId })}`,
      allowedInitiators: ["parent", "owner", "system"],
      acknowledgementDeadlineMs: Math.min(5_000, wallTimeMs),
    },
    retry: {
      maxAttempts: 1,
      backoffMs: [],
      retryableReasons: [],
      neverRetryReasons: [
        "authority_denied",
        "contract_invalid",
        "canceled",
        "deadline_expired",
      ],
    },
    verifier: {
      agentId: verifier.definition.logicalAgentId,
      definitionVersion: verifier.definition.definitionVersion,
      method: "deterministic_schema_and_evidence",
      requiredEvidenceKinds: [
        "artifact_digest",
        "model_receipt",
        "acceptance_check",
      ],
      acceptanceThreshold: 1,
      completionDisposition: "proposed_only",
      parentAcceptanceRequired: true,
    },
  });
}

function workflowDelegatorIdentity(
  detail: WorkflowRunDetail,
  input: {
    tenantId: string;
    actorId: string;
    parentExecutionScope?: ExecutionScope;
  },
): ResolvedAgentIdentityV1 {
  const storedIdentity = detail.run.input.metadata?.agentIdentity;
  if (storedIdentity !== undefined) {
    if (!storedIdentity || typeof storedIdentity !== "object" || Array.isArray(storedIdentity)) {
      throw new Error("Workflow Agent identity is invalid.");
    }
    const record = storedIdentity as Record<string, unknown>;
    const definition = parseAgentDefinitionV1(record.definition);
    const principal = parseAgentPrincipalDefinitionV1(record.principal);
    if (
      definition.tenantId !== input.tenantId ||
      definition.ownerActorId !== input.actorId ||
      principal.tenantId !== input.tenantId ||
      principal.controllerActorId !== input.actorId ||
      principal.logicalAgentId !== definition.logicalAgentId ||
      principal.definitionId !== definition.definitionId ||
      (input.parentExecutionScope?.executingPrincipalType === "agent" &&
        input.parentExecutionScope.executingPrincipalId !== principal.principalId)
    ) {
      throw new Error("Workflow Agent identity does not match its execution scope.");
    }
    return { definition, principal };
  }
  const configuredAgentId = stringMetadata(detail, "primaryAgentId");
  const agentId = configuredAgentId && isBuiltInPromptAgentId(configuredAgentId)
    ? configuredAgentId
    : "atlas";
  return buildBuiltInAgentIdentityV1({
    agentId,
    tenantId: input.tenantId,
    controllerActorId: input.actorId,
  });
}

function workflowDelegateAgentId(kind: WorkflowPlanNode["kind"]) {
  if (kind === "research") return "scout" as const;
  if (kind === "verify") return "sentinel" as const;
  if (kind === "memory") return "mnemosyne" as const;
  return "forge" as const;
}

function workflowDelegationObjective(input: WorkflowNodeInputV1) {
  return [
    input.task,
    `Parent outcome: ${input.objective}`,
    input.expectedOutputs.length
      ? `Required outputs: ${input.expectedOutputs.join("; ")}`
      : "Return the closed workflow-node result.",
  ].join("\n").slice(0, 4_000);
}

function workflowAcceptanceCriteria(input: WorkflowNodeInputV1) {
  const statements = input.acceptanceCriteria.length
    ? input.acceptanceCriteria
    : ["The output matches the closed workflow-node result schema."];
  return statements.map((statement, index) => ({
    criterionId: `criterion:${canonicalJsonSha256({
      nodeId: input.nodeId,
      index,
      statement,
    })}`,
    statement,
    verificationMethod: "parent_verifier" as const,
    required: true as const,
  }));
}

function workflowArtifactReferences(
  records: readonly WorkflowPlanNodeExecutionRecord[],
): DelegationArtifactReferenceV1[] {
  return records.flatMap((record) => {
    const nodeResult = record.output?.nodeResult;
    if (!nodeResult || typeof nodeResult !== "object" || Array.isArray(nodeResult)) return [];
    const artifacts = (nodeResult as Record<string, unknown>).artifacts;
    if (!Array.isArray(artifacts)) return [];
    return artifacts.flatMap((artifact, index) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return [];
      const candidate = artifact as Record<string, unknown>;
      const content = typeof candidate.content === "string" ? candidate.content : "";
      const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const kind = artifactKind(candidate.kind);
      if (!content || !name || !kind) return [];
      const contentSha256 = canonicalJsonSha256({ content });
      return [{
        artifactId: `artifact:${canonicalJsonSha256({
          sourceExecutionId: record.id,
          index,
          contentSha256,
        })}`,
        sourceExecutionId: contractId(record.id),
        name: name.slice(0, 160),
        kind,
        mediaType: "text/plain",
        contentSha256,
        byteCount: Buffer.byteLength(content, "utf8"),
        evidenceIds: Array.isArray(candidate.evidenceIds)
          ? unique(candidate.evidenceIds.map(String).filter((value) => value.trim())).slice(0, 32)
          : [],
      }];
    });
  }).slice(0, 32);
}

function artifactKind(value: unknown) {
  return WORKFLOW_OUTPUT_ARTIFACT_KINDS.find((kind) => kind === value);
}

function stringMetadata(detail: WorkflowRunDetail, key: string) {
  const value = detail.run.input.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredId(value: string | null | undefined, label: string) {
  if (!value?.trim()) throw new Error(`${label} is required for delegation.`);
  return contractId(value);
}

function nullableContractId(value: string | null | undefined) {
  return value?.trim() ? contractId(value) : null;
}

function contractId(value: string) {
  const normalized = value.trim();
  if (
    normalized.length <= 240 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)
  ) return normalized;
  return `opaque:${canonicalJsonSha256({ value: normalized })}`;
}

function unique(values: readonly string[]) {
  return [...new Set(values.map(contractId))];
}

function budgetShare(total: number, turns: number) {
  return Math.max(1, Math.floor(total / Math.max(1, turns)));
}
