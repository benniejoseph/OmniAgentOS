import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  listMemories: vi.fn(),
  requestAccess: vi.fn(),
  saveMemory: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));

vi.mock("@/lib/memory/store", () => ({
  listMemories: mocks.listMemories,
  saveMemory: mocks.saveMemory,
}));

vi.mock("@/lib/openai/client", () => ({ embedTexts: mocks.embedTexts }));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  listSharedMemoryService,
  SharedContextWriteDeniedError,
  writeSharedMemoryService,
} from "@/lib/app-services/shared-memory";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const authUserId = "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const canonicalActorId = `actor:${authUserId}`;
const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
} satisfies SecurityContext;

function sharedAccess(canWrite = true) {
  const executionScope = createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: canonicalActorId,
    workspaceId: "workspace:team-a",
    projectId: "project:launch",
    correlationId: "shared-request-a",
    purpose: "app.memory.shared.write",
  });
  return {
    actorBinding: {
      version: 1 as const,
      kind: "auth_user" as const,
      authUserId,
      canonicalActorId,
      legacyOwnerActorIds: [context.actorId],
      readableOwnerActorIds: [canonicalActorId, context.actorId],
    },
    authority: {
      schemaVersion: 1 as const,
      policyVersion: "workspace-context-policy-v1" as const,
      tenantId: "tenant-a",
      scope: "project" as const,
      initiatingActorId: canonicalActorId,
      workspaceId: "workspace:team-a",
      projectId: "project:launch",
      requestedProjectId: "legacy-project-a",
      accessLevel: canWrite ? "manager" as const : "reader" as const,
      canWrite,
      authoritySha256: "a".repeat(64),
    },
    executionScope,
    databaseAccessScope: {
      version: 1 as const,
      tenantId: "tenant-a",
      initiatingActorId: canonicalActorId,
      executingPrincipalType: "user" as const,
      executingPrincipalId: canonicalActorId,
      workspaceId: "workspace:team-a",
      projectId: "project:launch",
      missionId: null,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purposeId: "memory.write.v1",
      purpose: "Write explicitly selected project knowledge.",
    },
  };
}

function memoryRecord() {
  return {
    id: "memory-shared-a",
    tenantId: "tenant-a",
    type: "knowledge" as const,
    tier: "semantic" as const,
    title: "Launch constraints",
    content: "Use the approved launch window.",
    tags: ["launch"],
    scope: "project" as const,
    source: "manual",
    importance: 0.8,
    confidence: 0.95,
    claimStatus: "active" as const,
    assertedBy: "user" as const,
    evidenceRefs: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestAccess.mockResolvedValue(sharedAccess());
  mocks.listMemories.mockResolvedValue([memoryRecord()]);
  mocks.embedTexts.mockResolvedValue([[0.1, 0.2]]);
  mocks.saveMemory.mockImplementation(async (input) => ({
    ...memoryRecord(),
    ...input,
    id: "memory-shared-a",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  }));
});

describe("shared-memory application service", () => {
  it("lists only through an exact membership-derived read scope", async () => {
    const result = await listSharedMemoryService(
      createAppServiceCaller({ context }),
      { scope: "project", projectId: "legacy-project-a", limit: 20 },
    );

    expect(mocks.requestAccess).toHaveBeenCalledWith(context, {
      scope: "project",
      projectId: "legacy-project-a",
      workspaceId: undefined,
      correlationId: expect.any(String),
      purposeId: "memory.read.v1",
      auditPurpose: "List explicitly selected project knowledge.",
    });
    expect(mocks.listMemories).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      accessScope: sharedAccess().databaseAccessScope,
    }));
    expect(result.data.memories).toHaveLength(1);
    expect(result.receipt.operation).toBe("app.memory.shared.list");
  });

  it("writes a project-bound record through the exact shared scope", async () => {
    const caller = createAppServiceCaller({
      context,
      idempotencyKey: "shared-write-a",
      executionScope: createExecutionScope({
        tenantId: "tenant-a",
        initiatingActorId: context.actorId,
        executingPrincipalType: "user",
        executingPrincipalId: context.actorId,
        correlationId: "shared-write-a",
        purpose: "api.memory.shared.write",
      }),
    });
    const result = await writeSharedMemoryService(caller, {
      scope: "project",
      projectId: "legacy-project-a",
      title: "Launch constraints",
      content: "Use the approved launch window.",
      type: "knowledge",
      tier: "semantic",
    });

    expect(mocks.embedTexts).toHaveBeenCalledOnce();
    expect(mocks.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      scope: "project",
      assertedBy: "user",
      databaseAccessScope: sharedAccess().databaseAccessScope,
      accessBinding: expect.objectContaining({
        visibility: "project_shared",
        ownerActorId: canonicalActorId,
        workspaceId: "workspace:team-a",
        projectId: "project:launch",
      }),
    }));
    expect(result.receipt.operation).toBe("app.memory.shared.write");
  });

  it("rejects reader writes before embedding or persistence", async () => {
    mocks.requestAccess.mockResolvedValueOnce(sharedAccess(false));
    const caller = createAppServiceCaller({
      context,
      idempotencyKey: "shared-write-denied",
      executionScope: createExecutionScope({
        tenantId: "tenant-a",
        initiatingActorId: context.actorId,
        executingPrincipalType: "user",
        executingPrincipalId: context.actorId,
        correlationId: "shared-write-denied",
        purpose: "api.memory.shared.write",
      }),
    });

    await expect(writeSharedMemoryService(caller, {
      scope: "project",
      projectId: "legacy-project-a",
      title: "Denied",
      content: "Do not persist this.",
    })).rejects.toBeInstanceOf(SharedContextWriteDeniedError);
    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(mocks.saveMemory).not.toHaveBeenCalled();
  });
});
