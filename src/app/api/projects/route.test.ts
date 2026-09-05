import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  createProject: vi.fn(),
  getOwnedProject: vi.fn(),
  listProjectArtifacts: vi.fn(),
  listProjectCollections: vi.fn(),
  listProjects: vi.fn(),
  listProjectSummaries: vi.fn(),
  listProjectTasks: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: routeMocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));

vi.mock("@/lib/projects/store", () => ({
  createProject: routeMocks.createProject,
  getOwnedProject: routeMocks.getOwnedProject,
  listProjectArtifacts: routeMocks.listProjectArtifacts,
  listProjectCollections: routeMocks.listProjectCollections,
  listProjects: routeMocks.listProjects,
  listProjectSummaries: routeMocks.listProjectSummaries,
  listProjectTasks: routeMocks.listProjectTasks,
  ProjectTransitionError: class ProjectTransitionError extends Error {},
  updateProject: vi.fn(),
}));

import { GET as GETProject } from "@/app/api/projects/[id]/route";
import { GET as GETProjects, POST as POSTProject } from "@/app/api/projects/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "project-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const context = {
  tenantId: "tenant-a",
  actorId,
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: actorId,
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: [actorId],
  readableOwnerActorIds: [canonicalActorId, actorId],
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.createProject.mockReset();
  routeMocks.getOwnedProject.mockReset();
  routeMocks.listProjectArtifacts.mockReset().mockResolvedValue([]);
  routeMocks.listProjectCollections.mockReset().mockResolvedValue({
    tasksByProject: new Map(),
    artifactsByProject: new Map(),
  });
  routeMocks.listProjects.mockReset().mockResolvedValue([]);
  routeMocks.listProjectSummaries.mockReset().mockResolvedValue([]);
  routeMocks.listProjectTasks.mockReset().mockResolvedValue([]);
});

describe("request-bound project routes", () => {
  it("binds project creation to the authenticated principal and request id", async () => {
    routeMocks.createProject.mockResolvedValue({
      id: "project-a",
      tenantId: context.tenantId,
      actorId,
      title: "Project A",
      objective: "Complete project A",
    });

    const response = await POSTProject(new Request(
      "http://localhost/api/projects",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "project-create-a",
        },
        body: JSON.stringify({
          title: "Project A",
          objective: "Complete project A",
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(routeMocks.createProject).toHaveBeenCalledWith({
      title: "Project A",
      objective: "Complete project A",
      tenantId: context.tenantId,
      actorId,
      mutation: {
        idempotencyKey: "project-create-a",
        executionScope: expect.objectContaining({
          tenantId: context.tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          correlationId: "project-create-a",
          purpose: "project.create",
        }),
      },
    });
  });

  it("passes the authenticated actor binding to full and summary lists", async () => {
    const listResponse = await GETProjects(
      new Request("http://localhost/api/projects"),
    );
    const summaryResponse = await GETProjects(
      new Request("http://localhost/api/projects?view=summary&limit=20"),
    );

    expect(listResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(summaryResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listProjects).toHaveBeenCalledWith(80, {
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
    expect(routeMocks.listProjectSummaries).toHaveBeenCalledWith(20, {
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
  });

  it("resolves the owner before loading project children", async () => {
    routeMocks.getOwnedProject.mockResolvedValue({
      id: "project-a",
      tenantId: context.tenantId,
      actorId,
      title: "Project A",
      objective: "Complete project A",
    });

    const response = await GETProject(
      new Request("http://localhost/api/projects/project-a"),
      { params: Promise.resolve({ id: "project-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getOwnedProject).toHaveBeenCalledWith("project-a", {
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
    expect(routeMocks.listProjectTasks).toHaveBeenCalledWith("project-a", {
      tenantId: context.tenantId,
      limit: 30,
    });
    expect(routeMocks.listProjectArtifacts).toHaveBeenCalledWith("project-a", {
      tenantId: context.tenantId,
      limit: 100,
    });
    expect(routeMocks.getOwnedProject.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.listProjectTasks.mock.invocationCallOrder[0],
    );
  });

  it("does not load children when the owner-scoped project is absent", async () => {
    routeMocks.getOwnedProject.mockResolvedValue(undefined);

    const response = await GETProject(
      new Request("http://localhost/api/projects/missing"),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listProjectTasks).not.toHaveBeenCalled();
    expect(routeMocks.listProjectArtifacts).not.toHaveBeenCalled();
  });
});
