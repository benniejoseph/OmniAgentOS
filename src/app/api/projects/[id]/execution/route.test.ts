import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  controlProjectExecutionService: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: routeMocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));

vi.mock("@/lib/app-services/projects", () => ({
  controlProjectExecutionService: routeMocks.controlProjectExecutionService,
}));

import { POST } from "@/app/api/projects/[id]/execution/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.controlProjectExecutionService.mockReset().mockResolvedValue({
    data: { snapshot: { project: { id: "project-a" }, tasks: [] } },
  });
});

describe("project execution commands", () => {
  it("accepts the canonical project task id used by project responses", async () => {
    const taskId = `project_task_${"a".repeat(40)}`;
    const response = await POST(new Request(
      "http://localhost/api/projects/project-a/execution",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "approve-project-task-a",
        },
        body: JSON.stringify({ action: "approve", taskId }),
      },
    ), { params: Promise.resolve({ id: "project-a" }) });

    expect(response.status).toBe(200);
    expect(routeMocks.controlProjectExecutionService).toHaveBeenCalledWith(
      expect.anything(),
      {
        projectId: "project-a",
        action: "approve",
        workItemId: taskId,
      },
    );
  });

  it("keeps legacy UUID task ids compatible during migration", async () => {
    const taskId = "22222222-2222-4222-8222-222222222222";
    const response = await POST(new Request(
      "http://localhost/api/projects/project-a/execution",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retry", taskId }),
      },
    ), { params: Promise.resolve({ id: "project-a" }) });

    expect(response.status).toBe(200);
    expect(routeMocks.controlProjectExecutionService).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "retry", workItemId: taskId }),
    );
  });

  it("rejects malformed task ids before authorization or mutation", async () => {
    const response = await POST(new Request(
      "http://localhost/api/projects/project-a/execution",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", taskId: "project_task_bad" }),
      },
    ), { params: Promise.resolve({ id: "project-a" }) });

    expect(response.status).toBe(400);
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.controlProjectExecutionService).not.toHaveBeenCalled();
  });
});
