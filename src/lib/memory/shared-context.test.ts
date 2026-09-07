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

import {
  requestSharedMemoryAccessFromSecurityContext,
  resolveSharedAgentPromptMemoryAccess,
  sharedContextAuthorityV1Schema,
} from "@/lib/memory/shared-context";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

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
    const query = parts.join(" ");
    if (query.includes("FROM omni_work_projects")) {
      return [{
        workspace_id: workspaceId,
        project_id: "project:launch",
        access_level: "manager",
      }];
    }
    if (query.includes("FROM omni_tenant_workspaces")) {
      return [{ workspace_id: workspaceId, access_level: "manager" }];
    }
    return [];
  });
});

describe("shared context authority", () => {
  it("binds project context to canonical membership and a user retrieval scope", async () => {
    const access = await requestSharedMemoryAccessFromSecurityContext(context, {
      scope: "project",
      projectId: "legacy-project-a",
      correlationId: "agent-request-a",
    });

    expect(sharedContextAuthorityV1Schema.parse(access.authority)).toEqual(
      access.authority,
    );
    expect(access.authority).toMatchObject({
      scope: "project",
      initiatingActorId: canonicalActorId,
      workspaceId,
      projectId: "project:launch",
      requestedProjectId: "legacy-project-a",
      accessLevel: "manager",
      canWrite: true,
    });
    expect(access.databaseAccessScope).toMatchObject({
      executingPrincipalType: "user",
      executingPrincipalId: canonicalActorId,
      workspaceId,
      projectId: "project:launch",
      purposeId: "memory.retrieve.v1",
    });
  });

  it("keeps workspace context outside every project coordinate", async () => {
    const access = await requestSharedMemoryAccessFromSecurityContext(context, {
      scope: "workspace",
      correlationId: "agent-request-a",
    });

    expect(access.authority).toMatchObject({
      scope: "workspace",
      workspaceId,
      projectId: null,
      requestedProjectId: null,
    });
  });

  it("hands only the matching shared user scope to the direct agent compiler", async () => {
    const access = await requestSharedMemoryAccessFromSecurityContext(context, {
      scope: "project",
      projectId: "legacy-project-a",
      correlationId: "agent-request-a",
    });
    const agentScope = createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "owner@example.test",
      executingPrincipalType: "agent",
      executingPrincipalId: "agent:atlas",
      workspaceId,
      projectId: "project:launch",
      correlationId: "agent-request-a",
      purpose: "agent.run",
    });

    expect(resolveSharedAgentPromptMemoryAccess(access, {
      agentExecutionScope: agentScope,
      contextScope: "project",
      memoryMode: "all",
    })).toEqual(access.databaseAccessScope);
    expect(() => resolveSharedAgentPromptMemoryAccess(access, {
      agentExecutionScope: createExecutionScope({
        ...agentScope,
        projectId: "project:other",
      }),
      contextScope: "project",
      memoryMode: "all",
    })).toThrow("Shared-memory prompt access is invalid.");
    expect(() => resolveSharedAgentPromptMemoryAccess(access, {
      agentExecutionScope: agentScope,
      contextScope: "workspace",
      memoryMode: "all",
    })).toThrow("Shared-memory prompt access is invalid.");
  });
});
