import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: () => mocks.sql,
  hasDatabaseUrl: () => true,
}));

import { requestSharedMemoryAccessFromSecurityContext } from "@/lib/memory/shared-context";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import {
  createWorkflowSharedContextBinding,
  parseWorkflowSharedContextBinding,
  resolveWorkflowSharedContextAccess,
  workflowPlanContextBoundary,
} from "@/lib/workflows/shared-context";

const canonicalActorId = "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const workspaceId = "workspace:personal:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const context = {
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

beforeEach(() => {
  mocks.ensureDatabaseSchema.mockReset().mockResolvedValue(undefined);
  mocks.sql.mockReset().mockImplementation((parts: TemplateStringsArray) => {
    if (parts.join(" ").includes("FROM omni_work_projects")) {
      return [{
        workspace_id: workspaceId,
        project_id: "project:launch",
        access_level: "manager",
      }];
    }
    return [];
  });
});

describe("durable workflow shared context", () => {
  it("binds a reviewed Project authority and revalidates it before retrieval", async () => {
    const access = await requestSharedMemoryAccessFromSecurityContext(context, {
      scope: "project",
      projectId: "legacy-project-a",
      correlationId: "workflow-request-a",
    });
    const executionScope = workflowExecutionScope();
    const binding = createWorkflowSharedContextBinding({
      access,
      contextScope: "project",
      workflowExecutionScope: executionScope,
    });

    expect(parseWorkflowSharedContextBinding(binding)).toEqual(binding);
    expect(workflowPlanContextBoundary(access, "project")).toEqual({
      schemaVersion: 1,
      policyVersion: "workflow-shared-context-v1",
      contextScope: "project",
      authoritySha256: access.authority.authoritySha256,
    });
    await expect(resolveWorkflowSharedContextAccess({
      binding,
      workflowExecutionScope: executionScope,
    })).resolves.toMatchObject({
      databaseAccessScope: {
        tenantId: "tenant-a",
        initiatingActorId: canonicalActorId,
        projectId: "project:launch",
        purposeId: "memory.retrieve.v1",
      },
      contextBoundary: {
        contextScope: "project",
        authoritySha256: access.authority.authoritySha256,
      },
    });
    expect(mocks.sql).toHaveBeenCalledTimes(2);
  });

  it("rejects a root-authority change before reopening shared context", async () => {
    const access = await requestSharedMemoryAccessFromSecurityContext(context, {
      scope: "project",
      projectId: "legacy-project-a",
      correlationId: "workflow-request-a",
    });
    const binding = createWorkflowSharedContextBinding({
      access,
      contextScope: "project",
      workflowExecutionScope: workflowExecutionScope(),
    });

    await expect(resolveWorkflowSharedContextAccess({
      binding,
      workflowExecutionScope: createExecutionScope({
        ...workflowExecutionScope(),
        correlationId: "workflow-request-b",
      }),
    })).rejects.toThrow(/root authority/i);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("rejects membership revocation instead of trusting the stored envelope", async () => {
    const access = await requestSharedMemoryAccessFromSecurityContext(context, {
      scope: "project",
      projectId: "legacy-project-a",
      correlationId: "workflow-request-a",
    });
    const executionScope = workflowExecutionScope();
    const binding = createWorkflowSharedContextBinding({
      access,
      contextScope: "project",
      workflowExecutionScope: executionScope,
    });
    mocks.sql.mockResolvedValue([]);

    await expect(resolveWorkflowSharedContextAccess({
      binding,
      workflowExecutionScope: executionScope,
    })).rejects.toThrow(/unavailable to this actor/i);
  });
});

function workflowExecutionScope() {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "owner@example.test",
    executingPrincipalType: "user",
    executingPrincipalId: "owner@example.test",
    workspaceId,
    projectId: "project:launch",
    correlationId: "workflow-request-a",
    purpose: "workflow.run",
  });
}
