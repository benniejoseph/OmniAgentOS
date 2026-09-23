import { createHash } from "node:crypto";

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import {
  buildDelegationContextCapsuleV1,
} from "@/lib/delegation/context-capsule";
import {
  buildDelegationExecutionContractV2,
  buildDelegationRuntimeAssignmentReceiptV1,
} from "@/lib/delegation/execution-contract";
import {
  buildDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import { delegatedPrincipalIdV1 } from "@/lib/delegation/principal";
import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export function buildContract(
  overrides: Partial<Parameters<typeof buildDelegationContractV1>[0]> = {},
) {
  return buildDelegationContractV1({
    delegationId: "delegation:one",
    scope: {
      tenantId: "tenant-one",
      initiatingActorId: "actor-one",
      parentExecutionId: "run-one",
      parentPrincipalId: "principal:atlas:1",
      parentDelegationId: null,
      workspaceId: null,
      projectId: null,
      missionId: null,
      correlationSha256: "a".repeat(64),
    },
    delegator: {
      principalId: "principal:atlas:1",
      agentId: "atlas",
      definitionVersion: 1,
    },
    delegate: {
      principalId: delegatedPrincipalIdV1({
        delegationId: "delegation:one",
        parentPrincipalId: "principal:atlas:1",
        agentId: "sentinel",
        definitionVersion: 1,
      }),
      agentId: "sentinel",
      definitionVersion: 1,
    },
    purpose: "delegation.result.verify",
    idempotencyKeySha256: "c".repeat(64),
    objective: "Verify the governed result against its acceptance criterion.",
    acceptanceCriteria: [{
      criterionId: "criterion:one",
      statement: "The result is supported by its governed receipt.",
      verificationMethod: "governed_receipt",
      required: true,
    }],
    inputArtifacts: [],
    output: {
      schemaId: "delegated-result",
      schemaVersion: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      artifactKinds: ["result"],
      maxArtifacts: 2,
      maxBytes: 12_000,
    },
    grants,
    parentAuthority: {
      grants,
      budgets: parentBudgets,
      completeBy: "2026-09-07T07:00:00.000Z",
    },
    budgets: childBudgets,
    deadline: {
      createdAt: "2026-09-07T06:00:00.000Z",
      acceptBy: "2026-09-07T06:01:00.000Z",
      completeBy: "2026-09-07T06:05:00.000Z",
    },
    cancellation: {
      cancelable: true,
      signalId: "delegation-signal:one",
      allowedInitiators: ["parent", "owner", "system"],
      acknowledgementDeadlineMs: 5_000,
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
      agentId: "sentinel",
      definitionVersion: 1,
      method: "deterministic_schema_and_evidence",
      requiredEvidenceKinds: ["artifact_digest", "tool_receipt"],
      acceptanceThreshold: 1,
      completionDisposition: "proposed_only",
      parentAcceptanceRequired: true,
    },
    ...overrides,
  });
}

export function buildExecutionContract(
  overrides: Partial<Parameters<typeof buildDelegationExecutionContractV2>[0]> = {},
) {
  const tenantId = "tenant-one";
  const actorId = "actor-one";
  const rootExecutionId = "run-root";
  const childRunId = "run-child";
  const verifierRunId = "run-verifier";
  const delegationId = "delegation:execution:one";
  const delegatorIdentityPin = buildAgentRunIdentityPinV1({
    runId: rootExecutionId,
    identity: buildBuiltInAgentIdentityV1({
      agentId: "atlas",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const delegateIdentityPin = buildAgentRunIdentityPinV1({
    runId: childRunId,
    identity: buildBuiltInAgentIdentityV1({
      agentId: "scout",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const verifierIdentityPin = buildAgentRunIdentityPinV1({
    runId: verifierRunId,
    identity: buildBuiltInAgentIdentityV1({
      agentId: "sentinel",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const lineage = {
    tenantId,
    initiatingActorId: actorId,
    rootExecutionId,
    rootPrincipalId: delegatorIdentityPin.principalId,
    parentExecutionId: rootExecutionId,
    parentPrincipalId: delegatorIdentityPin.principalId,
    parentDelegationId: null,
    depth: 1 as const,
    maxDepth: 1 as const,
    workspaceId: null,
    projectId: null,
    workItemId: null,
    correlationSha256: "a".repeat(64),
    parentOwnerActorIdSha256: createHash("sha256")
      .update(actorId, "utf8")
      .digest("hex"),
  };
  const mode = overrides.mode || "isolated";
  const contextCapsule = buildDelegationContextCapsuleV1({
    mode,
    scope: {
      tenantId,
      initiatingActorId: actorId,
      rootExecutionId,
      rootPrincipalId: delegatorIdentityPin.principalId,
      parentExecutionId: rootExecutionId,
      parentPrincipalId: delegatorIdentityPin.principalId,
      delegationId,
    },
  });
  const runtimeAssignment = buildDelegationRuntimeAssignmentReceiptV1({
    executionId: childRunId,
    providerId: "configured-provider",
    modelId: "configured-research-model",
    modelTier: "reasoning",
    reasoningProfileId: "configured-reasoning-profile",
    normalizedReasoningEffort: "high",
    routingPolicyId: "model-route:council:v1",
    routingPolicySha256: "b".repeat(64),
    assignedAt: "2026-09-22T12:00:00.000Z",
  });
  const verifierRuntimeAssignment = buildDelegationRuntimeAssignmentReceiptV1({
    executionId: verifierRunId,
    providerId: "configured-provider",
    modelId: "configured-verifier-model",
    modelTier: "reasoning",
    reasoningProfileId: "configured-verifier-reasoning-profile",
    normalizedReasoningEffort: "high",
    routingPolicyId: "model-route:verifier:v1",
    routingPolicySha256: "f".repeat(64),
    assignedAt: "2026-09-22T12:00:00.000Z",
  });
  const noGrants: DelegationContractV1["grants"] = {
    contextGrantIds: [],
    capabilityGrantIds: [],
    governedToolIds: [],
    connectorTargets: [],
  };
  const executionGrants = {
    grantRequestSha256: canonicalJsonSha256({
      governedReadToolIds: [],
      skillIds: [],
      plugins: [],
      mcpServers: [],
    }),
    ...noGrants,
    skills: [],
    mcpServers: [],
    plugins: [],
  };
  return buildDelegationExecutionContractV2({
    delegationId,
    mode,
    lineage,
    delegatorIdentityPin,
    delegateIdentityPin,
    runtimeAssignment,
    contextCapsule,
    purpose: "delegation.research.execute",
    objective: "Research the bounded question and return evidence-backed findings.",
    idempotencyKeySha256: "c".repeat(64),
    acceptance: {
      acceptanceId: "acceptance:execution:one",
      criteria: [{
        criterionId: "criterion:execution:one",
        statement: "The bounded result satisfies its exact acceptance contract.",
        criterionSha256: canonicalJsonSha256({
          statement: "The bounded result satisfies its exact acceptance contract.",
        }),
        verificationMethod: "parent_verifier",
        required: true,
      }],
    },
    output: {
      outputContractId: "output-contract:execution:one",
      schemaId: "delegated-research-result",
      schemaVersion: 1,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["completed", "blocked"] },
        },
      },
      artifactKinds: ["result"],
      maxArtifacts: 4,
      maxBytes: 32_000,
    },
    verifier: {
      verifierContractId: "verifier-contract:execution:one",
      verifierPolicyId: "verifier-policy:execution:one",
      verifierPolicySha256: "e".repeat(64),
      identityPin: verifierIdentityPin,
      runtimeAssignment: verifierRuntimeAssignment,
      method: "agent_then_deterministic",
      requiredEvidenceKinds: ["artifact_digest", "acceptance_check"],
      acceptanceThreshold: 0.8,
      completionDisposition: "proposed_only",
      parentAcceptanceRequired: true,
    },
    grants: executionGrants,
    resourceClaims: [],
    parentAuthority: {
      grants: noGrants,
      budgets: executionParentBudgets,
      completeBy: "2026-09-22T12:30:00.000Z",
    },
    budgets: executionChildBudgets,
    deadline: {
      createdAt: "2026-09-22T12:00:00.000Z",
      acceptBy: "2026-09-22T12:01:00.000Z",
      completeBy: "2026-09-22T12:05:00.000Z",
    },
    cancellation: {
      cancelable: true,
      signalId: "delegation-signal:execution:one",
      allowedInitiators: ["parent", "owner", "system"],
      acknowledgementDeadlineMs: 5_000,
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
    ...overrides,
  });
}

const grants: DelegationContractV1["grants"] = {
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  governedToolIds: ["knowledge.search"],
  connectorTargets: [],
};

const parentBudgets: RunBudgetCountersV1 = {
  modelTurns: 4,
  tokens: 20_000,
  costMicrousd: 500_000,
  wallTimeMs: 180_000,
  toolCalls: 10,
  browserActions: 0,
  agents: 3,
  fanOut: 2,
  retries: 2,
  replans: 0,
};

const childBudgets: RunBudgetCountersV1 = {
  modelTurns: 1,
  tokens: 4_000,
  costMicrousd: 100_000,
  wallTimeMs: 60_000,
  toolCalls: 1,
  browserActions: 0,
  agents: 1,
  fanOut: 0,
  retries: 0,
  replans: 0,
};

export const executionParentBudgets: RunBudgetCountersV1 = {
  modelTurns: 8,
  tokens: 64_000,
  costMicrousd: 2_500_000,
  wallTimeMs: 240_000,
  toolCalls: 30,
  browserActions: 12,
  agents: 5,
  fanOut: 4,
  retries: 2,
  replans: 1,
};

export const executionChildBudgets: RunBudgetCountersV1 = {
  modelTurns: 2,
  tokens: 12_000,
  costMicrousd: 400_000,
  wallTimeMs: 60_000,
  toolCalls: 6,
  browserActions: 0,
  agents: 1,
  fanOut: 0,
  retries: 0,
  replans: 0,
};
