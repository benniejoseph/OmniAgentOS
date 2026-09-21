import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunContinuation, AgentRunRecord } from "@/lib/runs/types";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({ getRunPin: vi.fn() }));

vi.mock("@/lib/runs/store", () => ({
  getAgentRunIdentityPin: mocks.getRunPin,
}));

import {
  continuationAuthUserBinding,
  resolveContinuationAuthAuthority,
} from "@/lib/orchestration/continuation-authority";

const authUserId = "11111111-1111-4111-8111-111111111111";
const email = "owner@example.test";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRunPin.mockResolvedValue({
    runId: "run-moltbook-resume",
    tenantId: "tenant-one",
    actorId: `actor:${authUserId}`,
    logicalAgentId: "agent-moltbook",
    principalId: "agent:agent-moltbook",
    principalGeneration: 3,
  });
});

describe("approval continuation owner authority", () => {
  it("persists only the reduced non-secret mobile/session owner binding", () => {
    const binding = continuationAuthUserBinding({
      tenantId: "tenant-one",
      actorId: email,
      role: "admin",
      source: "mobile",
      auth: {
        userId: authUserId,
        email,
        sessionId: "native-secret-session",
        tenantName: "Tenant one",
      },
    });
    expect(binding).toEqual({
      version: 1,
      source: "mobile",
      authUserId,
      email,
      canonicalActorId: `actor:${authUserId}`,
    });
    expect(JSON.stringify(binding)).not.toContain("native-secret-session");
  });

  it("reconstructs separate service and canonical authority for a Moltbook resume", async () => {
    const result = await resolveContinuationAuthAuthority(
      run(),
      continuation(),
      scope(),
    );
    expect(result.securityContext).toEqual({
      tenantId: "tenant-one",
      actorId: email,
      role: "admin",
      source: "service",
    });
    expect(result.actorBinding).toMatchObject({
      authUserId,
      canonicalActorId: `actor:${authUserId}`,
      legacyOwnerActorIds: [email],
    });
  });

  it("rejects missing or tampered Moltbook continuation authority", async () => {
    const missing = continuation();
    delete missing.context.authUserBinding;
    await expect(resolveContinuationAuthAuthority(run(), missing, scope()))
      .rejects.toThrow("lost its authenticated Agent owner binding");

    const tampered = continuation();
    tampered.context.authUserBinding!.canonicalActorId =
      "actor:22222222-2222-4222-8222-222222222222";
    await expect(resolveContinuationAuthAuthority(run(), tampered, scope()))
      .rejects.toThrow("lost its authenticated Agent owner binding");
  });

  it("leaves unrelated legacy approvals on their existing fail-closed context", async () => {
    const unrelated = continuation();
    unrelated.pendingToolCall.toolId = "runs.list";
    unrelated.toolPolicy = {
      allowedToolIds: ["runs.list"],
      readOnly: true,
      forceApproval: false,
    };
    delete unrelated.context.authUserBinding;
    await expect(resolveContinuationAuthAuthority(run(), unrelated, scope()))
      .resolves.toEqual({
        securityContext: {
          tenantId: "tenant-one",
          actorId: email,
          role: "admin",
          source: "default",
        },
      });
    expect(mocks.getRunPin).not.toHaveBeenCalled();
  });
});

function run(): AgentRunRecord {
  return {
    id: "run-moltbook-resume",
    tenantId: "tenant-one",
    ownerActorId: email,
    agentId: "agent-moltbook",
    mode: "execute",
    status: "waiting_approval",
    prompt: "Read Moltbook after approval.",
    messages: [{ role: "user", content: "Continue." }],
    memoryContextCount: 0,
    startedAt: "2026-09-21T00:00:00.000Z",
  };
}

function continuation(): AgentRunContinuation {
  return {
    executionScope: scope(),
    conversationItems: [],
    instructions: "Continue safely.",
    response: "",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call-one",
      toolId: "moltbook.post.vote",
      toolName: "Vote",
      executionId: "execution-one",
    },
    context: {
      tenantId: "tenant-one",
      actorId: email,
      role: "admin",
      authUserBinding: {
        version: 1,
        source: "session",
        authUserId,
        email,
        canonicalActorId: `actor:${authUserId}`,
      },
    },
    toolPolicy: {
      allowedToolIds: ["moltbook.home.read", "moltbook.post.vote"],
      readOnly: false,
      forceApproval: true,
    },
    createdAt: "2026-09-21T00:00:00.000Z",
  };
}

function scope() {
  return createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId: email,
    executingPrincipalType: "agent",
    executingPrincipalId: "agent:agent-moltbook",
    correlationId: "request-moltbook-resume",
    purpose: "agent.run",
  });
}
