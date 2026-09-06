import { describe, expect, it } from "vitest";

import {
  buildAgentPrivateMemoryAccessBindingV1,
  buildUserPrivateMemoryAccessBindingV1,
  memoryAccessBindingAllows,
  memoryAccessBindingV1Schema,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";

const binding = buildUserPrivateMemoryAccessBindingV1({
  tenantId: "tenant:alpha",
  ownerActorId: "actor:owner",
  originPurpose: "api.memory.write",
  accessBoundAt: "2026-09-06T00:00:00.000Z",
});

function scope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    tenantId: "tenant:alpha",
    initiatingActorId: "actor:owner",
    executingPrincipalType: "user" as const,
    executingPrincipalId: "actor:owner",
    workspaceId: null,
    projectId: null,
    missionId: null,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purposeId: MEMORY_PURPOSE_IDS.read,
    purpose: "api.memory.read",
    ...overrides,
  };
}

describe("memory access binding v1", () => {
  it("builds an immutable canonical user-private binding", () => {
    expect(memoryAccessBindingV1Schema.parse(binding)).toEqual(binding);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding.allowedPurposeIds).toEqual([
      "memory.correct.v1",
      "memory.export.v1",
      "memory.forget.v1",
      "memory.read.v1",
      "memory.retrieve.v1",
      "memory.write.v1",
    ]);
  });

  it("allows only the exact owner, tenant, and declared purpose", () => {
    expect(memoryAccessBindingAllows(scope(), binding)).toBe(true);
    expect(memoryAccessBindingAllows(scope({
      initiatingActorId: "actor:sibling",
      executingPrincipalId: "actor:sibling",
    }), binding)).toBe(false);
    expect(memoryAccessBindingAllows(scope({ tenantId: "tenant:other" }), binding))
      .toBe(false);
    expect(memoryAccessBindingAllows(scope({
      purposeId: MEMORY_PURPOSE_IDS.maintenance,
    }), binding)).toBe(false);
  });

  it("rejects tampering with an authenticated binding field", () => {
    expect(memoryAccessBindingV1Schema.safeParse({
      ...binding,
      ownerActorId: "actor:sibling",
    }).success).toBe(false);
  });

  it("binds agent-private memory to the exact owner and logical agent", () => {
    const agentBinding = buildAgentPrivateMemoryAccessBindingV1({
      tenantId: "tenant:alpha",
      ownerActorId: "actor:owner",
      ownerAgentId: "agent:atlas",
      originPurpose: "memory.verified_effect",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    });
    const agentScope = scope({
      executingPrincipalType: "agent",
      executingPrincipalId: "agent:atlas",
      purposeId: MEMORY_PURPOSE_IDS.retrieve,
    });

    expect(memoryAccessBindingV1Schema.parse(agentBinding)).toEqual(
      agentBinding,
    );
    expect(Object.isFrozen(agentBinding)).toBe(true);
    expect(agentBinding).toMatchObject({
      visibility: "agent_private",
      ownerActorId: "actor:owner",
      ownerAgentId: "agent:atlas",
    });
    expect(memoryAccessBindingAllows(agentScope, agentBinding)).toBe(true);
    expect(memoryAccessBindingAllows({
      ...agentScope,
      executingPrincipalId: "agent:sibling",
    }, agentBinding)).toBe(false);
    expect(memoryAccessBindingAllows({
      ...agentScope,
      initiatingActorId: "actor:sibling",
    }, agentBinding)).toBe(false);
  });
});
