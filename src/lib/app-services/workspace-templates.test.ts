import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  listTemplates: vi.fn(),
  publishTemplate: vi.fn(),
  getTemplate: vi.fn(),
  findInstantiation: vi.fn(),
  recordInstantiation: vi.fn(),
  createProject: vi.fn(),
  createTasks: vi.fn(),
  getProject: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));

vi.mock("@/lib/workspace-templates/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-templates/store")>()),
  listWorkspaceTemplates: mocks.listTemplates,
  publishWorkspaceTemplate: mocks.publishTemplate,
  getWorkspaceTemplateVersion: mocks.getTemplate,
  findWorkspaceTemplateInstantiation: mocks.findInstantiation,
  recordWorkspaceTemplateInstantiation: mocks.recordInstantiation,
}));

vi.mock("@/lib/projects/store", () => ({
  createProject: mocks.createProject,
  createProjectTasks: mocks.createTasks,
  getOwnedProject: mocks.getProject,
  listProjectTasks: mocks.listTasks,
}));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  instantiateWorkspaceTemplateService,
  listWorkspaceTemplatesService,
  publishWorkspaceTemplateService,
} from "@/lib/app-services/workspace-templates";
import { projectTaskIdForIdempotencyKey } from "@/lib/projects/events";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildWorkspaceTemplateVersion } from "@/lib/workspace-templates/contracts";

const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const workspaceId = `workspace:personal:${authUserId}`;
const context = {
  tenantId: "tenant-template",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-template",
    tenantName: "Template tenant",
  },
} satisfies SecurityContext;

const template = buildWorkspaceTemplateVersion({
  tenantId: context.tenantId,
  workspaceId,
  templateId: "workspace-template:22222222-2222-4222-8222-222222222222",
  version: 1,
  ownerActorId: canonicalActorId,
  publishedAt: "2026-09-07T11:00:00.000Z",
  definition: {
    name: "Release",
    project: {
      title: "Release project",
      objective: "Ship safely",
      status: "draft",
      tasks: [
        { key: "verify", title: "Verify", agentId: "sentinel" },
        { key: "publish", title: "Publish", dependsOnKeys: ["verify"] },
      ],
    },
    playbook: {
      aliases: ["Run release"],
      toolBindings: [{ toolId: "app.projects.list", input: { limit: 5 } }],
      acceptanceCriteria: ["Release is verified."],
    },
  },
});

function sharedAccess(canWrite = true) {
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
      tenantId: context.tenantId,
      scope: "workspace" as const,
      initiatingActorId: canonicalActorId,
      workspaceId,
      projectId: null,
      requestedProjectId: null,
      accessLevel: canWrite ? "manager" as const : "reader" as const,
      canWrite,
      authoritySha256: "a".repeat(64),
    },
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: canonicalActorId,
      executingPrincipalType: "user",
      executingPrincipalId: canonicalActorId,
      workspaceId,
      correlationId: "template-access",
      purpose: "app.memory.shared.write",
    }),
    databaseAccessScope: {
      version: 1 as const,
      tenantId: context.tenantId,
      initiatingActorId: canonicalActorId,
      executingPrincipalType: "user" as const,
      executingPrincipalId: canonicalActorId,
      workspaceId,
      projectId: null,
      missionId: null,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purposeId: "memory.write.v1",
      purpose: "Manage versioned workspace templates.",
    },
  };
}

function mutationCaller(idempotencyKey: string) {
  return createAppServiceCaller({
    context,
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId: idempotencyKey,
      purpose: "api.workspace_template.mutation",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestAccess.mockResolvedValue(sharedAccess());
  mocks.listTemplates.mockResolvedValue([{ ...template, active: true, activeVersion: 1 }]);
  mocks.publishTemplate.mockResolvedValue({ ...template, active: true, activeVersion: 1 });
  mocks.getTemplate.mockResolvedValue({ ...template, active: true, activeVersion: 1 });
  mocks.findInstantiation.mockResolvedValue(undefined);
  mocks.createProject.mockResolvedValue({
    id: "project-template",
    tenantId: context.tenantId,
    actorId: context.actorId,
    title: template.project.title,
    objective: template.project.objective,
    status: "draft",
    autonomyMode: "manual",
    executionStatus: "idle",
    taskBudget: 12,
    tasksDispatched: 0,
    maxParallelTasks: 1,
    requireApproval: true,
    createdAt: "2026-09-07T11:01:00.000Z",
    updatedAt: "2026-09-07T11:01:00.000Z",
  });
  mocks.createTasks.mockImplementation(async (projectId, [task], options) => [{
    id: projectTaskIdForIdempotencyKey(context.tenantId, projectId, options.mutation.idempotencyKey),
    tenantId: context.tenantId,
    projectId,
    ...task,
    detail: task.detail || "",
    status: "open",
    priority: task.priority || "medium",
    agentId: task.agentId || "atlas",
    position: 0,
    origin: "manual",
    dependsOn: task.dependsOn || [],
    dispatchAttempt: 0,
    createdAt: "2026-09-07T11:01:00.000Z",
    updatedAt: "2026-09-07T11:01:00.000Z",
  }]);
  mocks.recordInstantiation.mockImplementation(async ({ authority, template: exactTemplate, projectSnapshot }) => ({
    schemaVersion: 1,
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    instantiationId: "workspace-template-instantiation:33333333-3333-4333-8333-333333333333",
    templateId: exactTemplate.templateId,
    templateVersionId: exactTemplate.templateVersionId,
    templateVersion: exactTemplate.version,
    templateSha256: exactTemplate.templateSha256,
    projectId: projectSnapshot.projectId,
    projectSnapshotSha256: canonicalJsonSha256(projectSnapshot),
    instantiatedByActorId: authority.canonicalActorId,
    instantiatedAt: "2026-09-07T11:01:00.000Z",
  }));
});

describe("workspace-template application service", () => {
  it("lists active versions through exact workspace membership authority", async () => {
    const result = await listWorkspaceTemplatesService(
      createAppServiceCaller({ context }),
      {},
    );
    expect(mocks.listTemplates).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      workspaceId,
      canonicalActorId,
    }, { activeOnly: true, limit: 100 });
    expect(result.receipt.operation).toBe("app.workspace_templates.list");
    expect(result.data.templates).toHaveLength(1);
  });

  it("publishes under a canonical event scope without changing the caller principal", async () => {
    const result = await publishWorkspaceTemplateService(mutationCaller("publish-template"), {
      name: template.name,
      description: template.description,
      project: template.project,
      playbook: template.playbook,
    });
    const authority = mocks.publishTemplate.mock.calls[0][0].authority;
    expect(authority).toMatchObject({
      canonicalActorId,
      workspaceId,
      idempotencyKey: "publish-template",
      executionScope: {
        initiatingActorId: canonicalActorId,
        executingPrincipalType: "user",
        executingPrincipalId: canonicalActorId,
        purpose: "workspace.template.publish",
      },
    });
    expect(result.receipt.operation).toBe("app.workspace_templates.publish");
  });

  it("copies project tasks and exact dependency IDs before sealing the instantiation", async () => {
    const result = await instantiateWorkspaceTemplateService(
      mutationCaller("instantiate-template"),
      { templateId: template.templateId },
    );
    expect(mocks.createProject).toHaveBeenCalledOnce();
    expect(mocks.createTasks).toHaveBeenCalledTimes(2);
    const verifyId = mocks.createTasks.mock.results[0].value
      ? (await mocks.createTasks.mock.results[0].value)[0].id
      : "";
    expect(mocks.createTasks.mock.calls[1][1][0].dependsOn).toEqual([verifyId]);
    expect(mocks.recordInstantiation).toHaveBeenCalledWith(expect.objectContaining({
      template: expect.objectContaining({ templateVersionId: template.templateVersionId }),
      projectSnapshot: expect.objectContaining({
        projectId: "project-template",
        templateVersionId: template.templateVersionId,
        tasks: expect.arrayContaining([expect.objectContaining({ title: "Publish", dependsOn: [verifyId] })]),
      }),
    }));
    expect(result.receipt.operation).toBe("app.workspace_templates.instantiate");
  });
});
