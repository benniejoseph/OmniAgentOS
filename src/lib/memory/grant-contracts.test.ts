import { describe, expect, it } from "vitest";

import {
  buildMemoryAccessGrantEventV1,
  parseMemoryAccessGrantRecordV1,
} from "@/lib/memory/grant-contracts";

const ACTOR = "actor:00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-09-05T10:00:00.000Z";

describe("memory access grant contracts", () => {
  it("requires explicit context targets, purpose, bounds, and expiry", () => {
    expect(parseMemoryAccessGrantRecordV1(contextGrant())).toMatchObject({
      grantKind: "context",
      grantId: "context:memory-one",
      granteeKind: "user",
      purposeId: "memory.retrieve.v1",
      maxItems: 10,
      maxBytes: 65_536,
    });
    expect(() => parseMemoryAccessGrantRecordV1({
      ...contextGrant(),
      expiresAt: CREATED_AT,
    })).toThrow(/timestamps/i);
  });

  it("separates capability operations and budgets from context bounds", () => {
    const capability = parseMemoryAccessGrantRecordV1({
      ...contextGrant(),
      grantKind: "capability",
      grantId: "capability:memory-read",
      granteeKind: "agent",
      granteeId: "agent:researcher",
      granteePrincipalGeneration: 2,
      operationIds: ["memory.read"],
      maxItems: null,
      maxBytes: null,
      maxInvocations: 5,
      maxCostMicrousd: 100_000,
      maxDurationMs: 60_000,
    });
    expect(capability).toMatchObject({ grantKind: "capability", maxInvocations: 5 });
    expect(() => parseMemoryAccessGrantRecordV1({
      ...capability,
      operationIds: ["memory.write", "memory.read"],
    })).toThrow(/sorted/i);
  });

  it("rejects visibility coordinates that could widen a target", () => {
    expect(() => parseMemoryAccessGrantRecordV1({
      ...contextGrant(),
      target: {
        ...contextGrant().target,
        visibility: "workspace_shared",
        workspaceId: null,
      },
    })).toThrow(/target coordinates/i);
  });

  it("emits metadata-only held events", () => {
    const grant = parseMemoryAccessGrantRecordV1(contextGrant());
    expect(buildMemoryAccessGrantEventV1(grant, "governance:memory-grant-hold"))
      .toMatchObject({
        type: "memory.access_grant.held",
        payload: {
          grantKind: "context",
          resourceIds: ["memory:one"],
          decisionActorId: ACTOR,
        },
      });
  });
});

function contextGrant() {
  return {
    schemaVersion: 1,
    tenantId: "tenant:one",
    grantKind: "context",
    grantId: "context:memory-one",
    grantGeneration: 1,
    granteeKind: "user",
    granteeId: ACTOR,
    granteePrincipalGeneration: null,
    purposeId: "memory.retrieve.v1",
    target: {
      visibility: "user_private",
      ownerActorId: ACTOR,
      ownerAgentId: null,
      ownerAgentPrincipalGeneration: null,
      workspaceId: null,
      projectId: null,
      missionId: null,
      resourceIds: ["memory:one"],
    },
    operationIds: null,
    maxItems: 10,
    maxBytes: 65_536,
    maxInvocations: null,
    maxCostMicrousd: null,
    maxDurationMs: null,
    notBefore: CREATED_AT,
    expiresAt: "2026-09-06T10:00:00.000Z",
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
