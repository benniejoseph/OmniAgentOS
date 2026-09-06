import {
  buildDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import { delegatedPrincipalIdV1 } from "@/lib/delegation/principal";
import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";

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
