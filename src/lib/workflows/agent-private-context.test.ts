import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAgentIdentityForExecution: vi.fn(),
}));

vi.mock("@/lib/agents/identity-store", () => ({
  resolveAgentIdentityForExecution: mocks.resolveAgentIdentityForExecution,
}));

import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  parseWorkflowPlanContextBoundary,
  workflowPlanContextBoundariesEqual,
} from "@/lib/workflows/shared-context";
import {
  createWorkflowAgentPrivateContextBinding,
  parseWorkflowAgentPrivateContextBinding,
  resolveWorkflowAgentPrivateContextAccess,
  workflowAgentPrivateDatabaseAccessScope,
  workflowAgentPrivatePlanContextBoundary,
} from "@/lib/workflows/agent-private-context";

const actorId = "owner@example.test";
const identity = buildBuiltInAgentIdentityV1({
  agentId: "atlas",
  tenantId: "tenant-a",
  controllerActorId: actorId,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentIdentityForExecution.mockResolvedValue(identity);
});

describe("durable workflow Agent-private context", () => {
  it("binds exact Agent authority while keeping task coordinates out of memory access", async () => {
    const workflowExecutionScope = rootExecutionScope();
    const binding = createWorkflowAgentPrivateContextBinding({
      identity,
      requestingActorId: actorId,
      workflowExecutionScope,
    });

    expect(parseWorkflowAgentPrivateContextBinding(binding)).toEqual(binding);
    expect(binding.databaseAccessScope).toMatchObject({
      tenantId: "tenant-a",
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: identity.principal.principalId,
      workspaceId: null,
      projectId: null,
      missionId: null,
      purposeId: "memory.retrieve.v1",
    });
    const contextBoundary = workflowAgentPrivatePlanContextBoundary(identity);
    expect(contextBoundary).toEqual({
      schemaVersion: 1,
      policyVersion: "workflow-agent-private-context-v1",
      contextScope: "agent_private",
      agentId: "atlas",
      authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(parseWorkflowPlanContextBoundary(contextBoundary)).toEqual(
      contextBoundary,
    );
    expect(workflowPlanContextBoundariesEqual(
      contextBoundary,
      contextBoundary,
    )).toBe(true);
    await expect(resolveWorkflowAgentPrivateContextAccess({
      binding,
      workflowExecutionScope,
    })).resolves.toMatchObject({
      databaseAccessScope: binding.databaseAccessScope,
      contextBoundary: {
        contextScope: "agent_private",
        agentId: "atlas",
        authoritySha256: binding.authoritySha256,
      },
    });
    expect(mocks.resolveAgentIdentityForExecution).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId,
      agentId: "atlas",
    });
  });

  it("rejects root authority drift before resolving memory", async () => {
    const binding = createWorkflowAgentPrivateContextBinding({
      identity,
      requestingActorId: actorId,
      workflowExecutionScope: rootExecutionScope(),
    });

    await expect(resolveWorkflowAgentPrivateContextAccess({
      binding,
      workflowExecutionScope: createExecutionScope({
        ...rootExecutionScope(),
        correlationId: "workflow-request-b",
      }),
    })).rejects.toThrow(/root authority/i);
    expect(mocks.resolveAgentIdentityForExecution).not.toHaveBeenCalled();
  });

  it("fails closed when the active Agent identity changes", async () => {
    const workflowExecutionScope = rootExecutionScope();
    const binding = createWorkflowAgentPrivateContextBinding({
      identity,
      requestingActorId: actorId,
      workflowExecutionScope,
    });
    mocks.resolveAgentIdentityForExecution.mockResolvedValue(
      buildBuiltInAgentIdentityV1({
        agentId: "scout",
        tenantId: "tenant-a",
        controllerActorId: actorId,
      }),
    );

    await expect(resolveWorkflowAgentPrivateContextAccess({
      binding,
      workflowExecutionScope,
    })).rejects.toThrow(/identity or grants changed/i);
  });

  it("does not accept an Agent-private scope with Project coordinates", () => {
    expect(workflowAgentPrivateDatabaseAccessScope({
      identity,
      requestingActorId: actorId,
      correlationId: "workflow-request-a",
    })).toMatchObject({
      workspaceId: null,
      projectId: null,
      missionId: null,
    });
  });
});

function rootExecutionScope() {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: identity.principal.principalId,
    workspaceId: "workspace:one",
    projectId: "project:one",
    missionId: "mission:one",
    correlationId: "workflow-request-a",
    contextGrantIds: identity.principal.contextGrantIds,
    capabilityGrantIds: identity.principal.capabilityGrantIds,
    purpose: "workflow.run",
  });
}
