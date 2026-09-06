import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import {
  buildDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import type { CouncilAgentId } from "@/lib/orchestration/council";
import type { AgentMode } from "@/lib/orchestration/types";
import {
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type CouncilDelegationAuthority = Readonly<{
  parentExecutionId: string;
  executionScope: ExecutionScope;
  delegator: Readonly<{
    principalId: string;
    agentId: string;
    definitionVersion: number;
  }>;
  parentBudgets: RunBudgetCountersV1;
  remainingWallTimeMs: number;
}>;

export const councilContributionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "risks", "recommendation", "evidenceIds", "confidence"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" }, maxItems: 8 },
    risks: { type: "array", items: { type: "string" }, maxItems: 6 },
    recommendation: { type: "string" },
    evidenceIds: { type: "array", items: { type: "string" }, maxItems: 12 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export function buildCouncilMemberDelegationContractV1(input: {
  authority: CouncilDelegationAuthority;
  agentId: CouncilAgentId;
  goal: string;
  mode: AgentMode;
  contextBlock: string;
  attempt: number;
  createdAt?: string;
}) {
  const scope = input.authority.executionScope;
  const parentBudgets = runBudgetCountersV1Schema.parse(
    input.authority.parentBudgets,
  );
  if (
    scope.executingPrincipalId !== input.authority.delegator.principalId ||
    !scope.initiatingActorId
  ) {
    throw new Error("Council delegator identity does not match its execution scope.");
  }
  const delegate = buildBuiltInAgentIdentityV1({
    agentId: input.agentId,
    tenantId: scope.tenantId,
    controllerActorId: scope.initiatingActorId,
  });
  const verifier = buildBuiltInAgentIdentityV1({
    agentId: "sentinel",
    tenantId: scope.tenantId,
    controllerActorId: scope.initiatingActorId,
  });
  const wallTimeMs = Math.floor(Math.min(
    input.authority.remainingWallTimeMs,
    parentBudgets.wallTimeMs,
    60_000,
  ));
  if (wallTimeMs < 101) {
    throw new Error(`Council member ${input.agentId} has no delegation time remaining.`);
  }
  const createdAt = input.createdAt || new Date().toISOString();
  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime)) {
    throw new Error("Council delegation creation time is invalid.");
  }
  const contextSha256 = canonicalJsonSha256({ content: input.contextBlock });
  const completeBy = new Date(createdTime + wallTimeMs).toISOString();
  const delegationId = `delegation:${canonicalJsonSha256({
    parentExecutionId: input.authority.parentExecutionId,
    agentId: input.agentId,
    attempt: input.attempt,
    goalSha256: canonicalJsonSha256({ goal: input.goal }),
    contextSha256,
  })}`;
  const parentGrants: DelegationContractV1["grants"] = {
    contextGrantIds: [...scope.contextGrantIds],
    capabilityGrantIds: [...scope.capabilityGrantIds],
    governedToolIds: [],
    connectorTargets: [],
  };

  return buildDelegationContractV1({
    delegationId,
    scope: {
      tenantId: contractId(scope.tenantId),
      initiatingActorId: contractId(scope.initiatingActorId),
      parentExecutionId: contractId(input.authority.parentExecutionId),
      parentPrincipalId: contractId(input.authority.delegator.principalId),
      parentDelegationId: nullableContractId(scope.delegationId),
      workspaceId: nullableContractId(scope.workspaceId),
      projectId: nullableContractId(scope.projectId),
      missionId: nullableContractId(scope.missionId),
      correlationSha256: canonicalJsonSha256({ correlationId: scope.correlationId }),
    },
    delegator: {
      principalId: contractId(input.authority.delegator.principalId),
      agentId: contractId(input.authority.delegator.agentId),
      definitionVersion: input.authority.delegator.definitionVersion,
    },
    delegate: {
      principalId: contractId(delegate.principal.principalId),
      agentId: delegate.definition.logicalAgentId,
      definitionVersion: delegate.definition.definitionVersion,
    },
    purpose: `council.member.${input.agentId}`,
    idempotencyKeySha256: canonicalJsonSha256({
      parentExecutionId: input.authority.parentExecutionId,
      agentId: input.agentId,
      attempt: input.attempt,
      goalSha256: canonicalJsonSha256({ goal: input.goal }),
      contextSha256,
    }),
    objective: [
      `Independently analyze the assigned goal as the ${input.agentId} specialist.`,
      `Goal: ${input.goal}`,
      `Mode: ${input.mode}`,
      "Return evidence-backed findings, risks, a recommendation, exact evidence IDs, and calibrated confidence.",
    ].join("\n").slice(0, 4_000),
    acceptanceCriteria: [
      criterion(delegationId, 0, "The contribution directly addresses the assigned goal.", "schema"),
      criterion(delegationId, 1, "Material findings cite exact supplied evidence IDs or state uncertainty.", "evidence"),
      criterion(delegationId, 2, "The parent verifier can independently accept or reject the proposed result.", "parent_verifier"),
    ],
    inputArtifacts: input.contextBlock
      ? [{
          artifactId: `artifact:${contextSha256}`,
          sourceExecutionId: contractId(input.authority.parentExecutionId),
          name: "authorized council context",
          kind: "analysis",
          mediaType: "text/plain",
          contentSha256: contextSha256,
          byteCount: Buffer.byteLength(input.contextBlock, "utf8"),
          evidenceIds: [],
        }]
      : [],
    output: {
      schemaId: "council-contribution",
      schemaVersion: 1,
      schema: councilContributionJsonSchema as unknown as DelegationContractV1["output"]["schema"],
      artifactKinds: ["analysis"],
      maxArtifacts: 1,
      maxBytes: 16_000,
    },
    grants: {
      contextGrantIds: [...scope.contextGrantIds],
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
      tokens: budgetShare(parentBudgets.tokens, parentBudgets.modelTurns),
      costMicrousd: budgetShare(
        parentBudgets.costMicrousd,
        parentBudgets.modelTurns,
      ),
      wallTimeMs,
      toolCalls: 0,
      browserActions: 0,
      agents: 1,
      fanOut: 0,
      retries: 0,
      replans: 0,
    },
    deadline: {
      createdAt,
      acceptBy: new Date(
        createdTime + Math.max(1, Math.min(1_000, Math.floor(wallTimeMs / 2))),
      ).toISOString(),
      completeBy,
    },
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
      method: "agent_then_deterministic",
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

function criterion(
  delegationId: string,
  index: number,
  statement: string,
  verificationMethod: DelegationContractV1["acceptanceCriteria"][number]["verificationMethod"],
) {
  return {
    criterionId: `criterion:${canonicalJsonSha256({ delegationId, index, statement })}`,
    statement,
    verificationMethod,
    required: true as const,
  };
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

function budgetShare(total: number, turns: number) {
  return Math.max(1, Math.floor(total / Math.max(1, turns)));
}
