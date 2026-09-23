import { describe, expect, it } from "vitest";

import { buildExecutionContract } from "@/lib/delegation/test-fixtures";
import {
  DELEGATION_EXECUTION_JOB_KIND,
  parseDelegationExecutionJobPayload,
} from "@/lib/delegation/runtime-job";
import { executionScopeFromDelegationContract } from "@/lib/delegation/runtime";

describe("delegation execution job payload", () => {
  it("accepts the exact contracted child scope", () => {
    const contract = buildExecutionContract();
    const executionScope = executionScopeFromDelegationContract(contract);

    expect(parseDelegationExecutionJobPayload({
      schemaVersion: 1,
      kind: DELEGATION_EXECUTION_JOB_KIND,
      actorId: contract.lineage.initiatingActorId,
      parentOwnerActorId: contract.lineage.initiatingActorId,
      executionId: contract.delegateIdentity.runId,
      runId: contract.delegateIdentity.runId,
      agentId: contract.delegateIdentity.logicalAgentId,
      contractSha256: contract.contractSha256,
      contextCapsuleSha256: contract.contextCapsule.capsuleSha256,
      runtimeAssignmentSha256: contract.runtimeAssignment.assignmentSha256,
      executionScope,
      queuedAt: contract.deadline.createdAt,
    })).toEqual(expect.objectContaining({
      kind: DELEGATION_EXECUTION_JOB_KIND,
      actorId: contract.lineage.initiatingActorId,
      parentOwnerActorId: contract.lineage.initiatingActorId,
      executionScope,
    }));
  });

  it.each([
    ["actor drift", { actorId: "another-actor" }],
    ["root scope", {
      executionScope: {
        ...executionScopeFromDelegationContract(buildExecutionContract()),
        delegationId: null,
      },
    }],
    ["human principal", {
      executionScope: {
        ...executionScopeFromDelegationContract(buildExecutionContract()),
        executingPrincipalType: "human",
      },
    }],
  ])("rejects an incomplete or attenuated envelope: %s", (_label, override) => {
    const contract = buildExecutionContract();
    const executionScope = executionScopeFromDelegationContract(contract);

    expect(() => parseDelegationExecutionJobPayload({
      schemaVersion: 1,
      kind: DELEGATION_EXECUTION_JOB_KIND,
      actorId: contract.lineage.initiatingActorId,
      parentOwnerActorId: contract.lineage.initiatingActorId,
      executionId: contract.delegateIdentity.runId,
      runId: contract.delegateIdentity.runId,
      agentId: contract.delegateIdentity.logicalAgentId,
      contractSha256: contract.contractSha256,
      contextCapsuleSha256: contract.contextCapsule.capsuleSha256,
      runtimeAssignmentSha256: contract.runtimeAssignment.assignmentSha256,
      executionScope,
      queuedAt: contract.deadline.createdAt,
      ...override,
    })).toThrow();
  });

  it("rejects unknown fields so a job cannot smuggle legacy authority", () => {
    const contract = buildExecutionContract();

    expect(() => parseDelegationExecutionJobPayload({
      schemaVersion: 1,
      kind: DELEGATION_EXECUTION_JOB_KIND,
      actorId: contract.lineage.initiatingActorId,
      executionId: contract.delegateIdentity.runId,
      runId: contract.delegateIdentity.runId,
      agentId: contract.delegateIdentity.logicalAgentId,
      contractSha256: contract.contractSha256,
      contextCapsuleSha256: contract.contextCapsule.capsuleSha256,
      runtimeAssignmentSha256: contract.runtimeAssignment.assignmentSha256,
      executionScope: executionScopeFromDelegationContract(contract),
      queuedAt: contract.deadline.createdAt,
      capabilityGrantIds: ["grant:write:anything"],
    })).toThrow();
  });
});
