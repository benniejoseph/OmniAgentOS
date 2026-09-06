import { describe, expect, it } from "vitest";

import {
  explainAgentMemoryGrantV1,
  parseAgentMemoryGrantDraftV1,
} from "@/lib/memory/agent-grant-editor";

describe("P7.4 Agent grant editor contract", () => {
  it("canonicalizes an exact context grant draft", () => {
    expect(parseAgentMemoryGrantDraftV1({
      schemaVersion: 1,
      grantKind: "context",
      purposeId: "memory.retrieve.v1",
      target: {
        visibility: "agent_private",
        resourceIds: ["memory:z", "memory:a", "memory:z"],
        workspaceId: null,
        projectId: null,
        missionId: null,
      },
      maxItems: 24,
      maxBytes: 48_000,
      expiresAt: "2026-09-08T12:00:00.000Z",
    }).target.resourceIds).toEqual(["memory:a", "memory:z"]);
  });

  it("rejects target drift and capabilities that omit their purpose", () => {
    expect(() => parseAgentMemoryGrantDraftV1({
      schemaVersion: 1,
      grantKind: "capability",
      purposeId: "memory.correct.v1",
      target: {
        visibility: "project_shared",
        resourceIds: ["memory:a"],
        workspaceId: null,
        projectId: "project:a",
        missionId: null,
      },
      operationIds: ["memory.read.v1"],
      maxInvocations: 5,
      maxCostMicrousd: 1_000_000,
      maxDurationMs: 60_000,
      expiresAt: "2026-09-08T12:00:00.000Z",
    })).toThrow();
  });

  it("explains exact visibility, budget, targets, expiry, and revocation", () => {
    const explanation = explainAgentMemoryGrantV1({
      schemaVersion: 1,
      tenantId: "tenant-one",
      grantKind: "capability",
      grantId: "capability:grant-one",
      grantGeneration: 1,
      granteeKind: "agent",
      granteeId: "agent:agent-one",
      granteePrincipalGeneration: 3,
      purposeId: "memory.correct.v1",
      target: {
        visibility: "user_private",
        ownerActorId: "actor:11111111-1111-4111-8111-111111111111",
        ownerAgentId: null,
        ownerAgentPrincipalGeneration: null,
        workspaceId: null,
        projectId: null,
        missionId: null,
        resourceIds: ["memory:a", "memory:b"],
      },
      operationIds: ["memory.correct.v1"],
      maxItems: null,
      maxBytes: null,
      maxInvocations: 5,
      maxCostMicrousd: 1_500_000,
      maxDurationMs: 60_000,
      notBefore: "2026-09-07T10:00:00.000Z",
      expiresAt: "2026-09-08T10:00:00.000Z",
      state: "revoked",
      lifecycleRevision: 2,
      createdByActorId: "actor:11111111-1111-4111-8111-111111111111",
      activatedByActorId: "actor:11111111-1111-4111-8111-111111111111",
      revokedByActorId: "actor:11111111-1111-4111-8111-111111111111",
      createdAt: "2026-09-07T10:00:00.000Z",
      activatedAt: "2026-09-07T10:00:01.000Z",
      revokedAt: "2026-09-07T11:00:00.000Z",
      updatedAt: "2026-09-07T11:00:00.000Z",
    });

    expect(explanation).toContain("correct it up to 5 times / $1.50");
    expect(explanation).toContain("your private memory");
    expect(explanation).toContain("2 exact targets");
    expect(explanation).toContain("revoked");
  });
});
