import { describe, expect, it } from "vitest";

import {
  buildMemoryOperationPolicyEventV1,
  parseMemoryOperationPolicyRecordV1,
} from "@/lib/memory/operation-policy-contracts";

const ACTOR = "actor:00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-05T10:00:00.000Z";

describe("memory operation policy contracts", () => {
  it("binds an operation to its exact purpose and minimum risk", () => {
    expect(parseMemoryOperationPolicyRecordV1(policyRecord())).toMatchObject({
      purposeId: "memory.retrieve.v1",
      operationClass: "retrieve",
      riskClass: "low",
    });
    expect(() => parseMemoryOperationPolicyRecordV1({
      ...policyRecord(),
      purposeId: "memory.read.v1",
    })).toThrow(/purpose/i);
  });

  it("never permits an operation without a capability grant", () => {
    expect(() => parseMemoryOperationPolicyRecordV1({
      ...policyRecord(),
      requiresCapabilityGrant: false,
    })).toThrow();
  });

  it("requires request binding and human approval for data rights", () => {
    const forget = parseMemoryOperationPolicyRecordV1({
      ...policyRecord(),
      policyId: "memory-policy:forget",
      purposeId: "memory.forget.v1",
      operationClass: "forget",
      riskClass: "critical",
      requiresContextGrant: false,
      requiresRequestBinding: true,
      requiresHumanApproval: true,
    });
    expect(forget.requiresRequestBinding).toBe(true);
    expect(() => parseMemoryOperationPolicyRecordV1({
      ...forget,
      requiresHumanApproval: false,
    })).toThrow(/approval gate/i);
  });

  it("emits metadata-only lifecycle events", () => {
    expect(buildMemoryOperationPolicyEventV1(
      policyRecord(),
      "governance:operation-policy-hold",
    )).toMatchObject({
      type: "memory.operation_policy.held",
      payload: {
        policyId: "memory-policy:retrieve",
        operationClass: "retrieve",
        decisionActorId: ACTOR,
      },
    });
  });
});

function policyRecord() {
  return {
    schemaVersion: 1,
    tenantId: "tenant:one",
    policyId: "memory-policy:retrieve",
    policyGeneration: 1,
    purposeId: "memory.retrieve.v1",
    operationClass: "retrieve",
    riskClass: "low",
    allowedPrincipalKinds: ["agent", "system", "user"],
    allowedVisibilities: [
      "agent_private",
      "mission_shared",
      "project_shared",
      "user_private",
      "workspace_shared",
    ],
    allowedSensitivities: ["confidential", "internal", "public", "restricted"],
    requiresContextGrant: true,
    requiresCapabilityGrant: true,
    requiresRequestBinding: false,
    requiresHumanApproval: false,
    state: "held",
    lifecycleRevision: 0,
    createdByActorId: ACTOR,
    activatedByActorId: null,
    revokedByActorId: null,
    createdAt: CREATED_AT,
    activatedAt: null,
    revokedAt: null,
    updatedAt: CREATED_AT,
  } as const;
}
