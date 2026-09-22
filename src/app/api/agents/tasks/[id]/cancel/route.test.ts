import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <T>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/app-services/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/agents")>()),
  cancelAgentTaskService: mocks.cancel,
}));

import { POST } from "@/app/api/agents/tasks/[id]/cancel/route";
import { DelegationExecutionConflictError } from "@/lib/delegation/execution-store";

const routeContext = { params: Promise.resolve({ id: "run-child" }) };

describe("delegated task cancellation route", () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "session",
    });
    mocks.cancel.mockReset().mockResolvedValue({
      data: {
        task: { executionId: "run-child", state: "canceled", lifecycleRevision: 3 },
        canceledChildRun: true,
        canceledDeliveryCount: 1,
        idempotent: false,
      },
      receipt: { operation: "app.agents.tasks.cancel" },
    });
  });

  it("authorizes and returns a private bounded cancellation projection", async () => {
    const response = await POST(request({ expectedRevision: 2 }), routeContext);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.agent",
      resourceType: "delegation_execution",
      resourceId: "run-child",
      metadata: expect.objectContaining({ signal: "cancel", expectedRevision: 2 }),
    }));
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "cancel-one" }),
      { executionId: "run-child", expectedRevision: 2, reason: "Canceled by the operator." },
    );
    expect(body.task).toEqual(expect.objectContaining({ state: "canceled" }));
    expect(JSON.stringify(body)).not.toMatch(/contract|contextCapsule|principal|grant/i);
  });

  it("requires stable idempotency and exact revision input", async () => {
    const missingKey = await POST(request({ expectedRevision: 2 }, false), routeContext);
    const invalidRevision = await POST(request({ expectedRevision: -1 }), routeContext);

    expect(missingKey.status).toBe(400);
    expect(invalidRevision.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("reports a revision race without retrying or broadening authority", async () => {
    mocks.cancel.mockRejectedValue(new DelegationExecutionConflictError());
    const response = await POST(request({ expectedRevision: 2 }), routeContext);

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("delegation_execution_conflict");
  });
});

function request(body: unknown, withKey = true) {
  return new Request("http://localhost/api/agents/tasks/run-child/cancel", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withKey ? { "idempotency-key": "cancel-one" } : {}),
    },
    body: JSON.stringify(body),
  });
}
