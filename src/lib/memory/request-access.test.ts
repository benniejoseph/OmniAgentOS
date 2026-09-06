import { describe, expect, it } from "vitest";

import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  agentPromptMemoryAccessFromSecurityContext,
  requestMemoryAccessFromSecurityContext,
  resolveAgentPromptMemoryAccess,
} from "@/lib/memory/request-access";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const sessionContext = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
} satisfies SecurityContext;

describe("request memory access", () => {
  it("uses the canonical auth actor for an exact private-memory scope", () => {
    const access = requestMemoryAccessFromSecurityContext(sessionContext, {
      purposeId: MEMORY_PURPOSE_IDS.read,
      auditPurpose: "api.memory.read",
      correlationId: "memory_read_test",
    });

    expect(access).toMatchObject({
      actorBinding: {
        canonicalActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      },
      executionScope: {
        initiatingActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        workspaceId: null,
      },
      databaseAccessScope: {
        purposeId: MEMORY_PURPOSE_IDS.read,
        executingPrincipalType: "user",
      },
    });
    expect(Object.isFrozen(access)).toBe(true);
  });

  it("keeps non-session compatibility contexts unbound", () => {
    expect(requestMemoryAccessFromSecurityContext({
      ...sessionContext,
      source: "headers",
      auth: undefined,
    }, {
      purposeId: MEMORY_PURPOSE_IDS.read,
      auditPurpose: "api.memory.read",
      correlationId: "memory_read_test",
    })).toBeUndefined();
  });

  it("binds an explicit owner selection to the matching direct agent run", () => {
    const promptAccess = agentPromptMemoryAccessFromSecurityContext(
      sessionContext,
      { correlationId: "agent_request_a" },
    );
    const agentExecutionScope = createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "owner@example.test",
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: "agent_request_a",
      purpose: "agent.run",
    });

    expect(resolveAgentPromptMemoryAccess(promptAccess, {
      agentExecutionScope,
      explicitEvidenceCount: 2,
      memoryMode: "all",
    })).toEqual(promptAccess?.databaseAccessScope);
  });

  it("rejects ambient, cross-request, and non-personal prompt access", () => {
    const promptAccess = agentPromptMemoryAccessFromSecurityContext(
      sessionContext,
      { correlationId: "agent_request_a" },
    );
    const agentExecutionScope = createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "owner@example.test",
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: "agent_request_a",
      purpose: "agent.run",
    });

    expect(() => resolveAgentPromptMemoryAccess(promptAccess, {
      agentExecutionScope,
      explicitEvidenceCount: 0,
      memoryMode: "all",
    })).toThrow("Explicit private-memory prompt access is invalid.");
    expect(() => resolveAgentPromptMemoryAccess(promptAccess, {
      agentExecutionScope,
      explicitEvidenceCount: 1,
      memoryMode: "project",
    })).toThrow("Explicit private-memory prompt access is invalid.");
    expect(() => resolveAgentPromptMemoryAccess(promptAccess, {
      agentExecutionScope: createExecutionScope({
        ...agentExecutionScope,
        correlationId: "agent_request_b",
      }),
      explicitEvidenceCount: 1,
      memoryMode: "all",
    })).toThrow("Explicit private-memory prompt access is invalid.");
  });
});
