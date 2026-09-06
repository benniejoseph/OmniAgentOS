import { describe, expect, it } from "vitest";

import { buildAgentGrantDraft } from "@/components/agents/agent-grant-editor";

describe("P7.4 Agent grant editor request", () => {
  it("builds a canonical bounded context grant without client authority fields", () => {
    const draft = buildAgentGrantDraft({
      grantKind: "context",
      purposeId: "memory.retrieve.v1",
      visibility: "agent_private",
      resourceIds: "memory:z, memory:a\nmemory:z",
      workspaceId: "",
      projectId: "",
      missionId: "",
      expiryHours: 24,
      maxItems: 12,
      maxBytes: 48_000,
      maxInvocations: 10,
      maxCostUsd: 1,
      maxDurationMs: 60_000,
    }, Date.parse("2026-09-07T10:00:00.000Z"));

    expect(draft).toEqual({
      schemaVersion: 1,
      grantKind: "context",
      purposeId: "memory.retrieve.v1",
      target: {
        visibility: "agent_private",
        resourceIds: ["memory:a", "memory:z"],
        workspaceId: null,
        projectId: null,
        missionId: null,
      },
      maxItems: 12,
      maxBytes: 48_000,
      expiresAt: "2026-09-08T10:00:00.000Z",
    });
    expect(draft).not.toHaveProperty("ownerActorId");
    expect(draft).not.toHaveProperty("granteeId");
  });

  it("converts a capability cost budget to integer microdollars", () => {
    const draft = buildAgentGrantDraft({
      grantKind: "capability",
      purposeId: "memory.correct.v1",
      visibility: "project_shared",
      resourceIds: "memory:one",
      workspaceId: "workspace:one",
      projectId: "project:one",
      missionId: "ignored",
      expiryHours: 1,
      maxItems: 12,
      maxBytes: 48_000,
      maxInvocations: 3,
      maxCostUsd: 1.25,
      maxDurationMs: 30_000,
    }, Date.parse("2026-09-07T10:00:00.000Z"));

    expect(draft).toMatchObject({
      grantKind: "capability",
      operationIds: ["memory.correct.v1"],
      maxInvocations: 3,
      maxCostMicrousd: 1_250_000,
      maxDurationMs: 30_000,
      target: {
        workspaceId: "workspace:one",
        projectId: "project:one",
        missionId: null,
      },
    });
  });
});
