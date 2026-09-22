import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  show: vi.fn(),
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
  showAgentTaskService: mocks.show,
}));

import { GET } from "@/app/api/agents/tasks/[id]/route";
import { DelegationExecutionConflictError } from "@/lib/delegation/execution-store";

const routeContext = { params: Promise.resolve({ id: "run-child" }) };

describe("delegated task detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "session",
    });
    mocks.show.mockResolvedValue({
      data: {
        task: {
          executionId: "run-child",
          authority: {
            immutable: true,
            validation: {
              status: "not_checked",
              category: null,
              validatedAt: null,
            },
          },
          controls: {
            grantsImmutable: true,
            allowedActions: ["cancel"],
          },
        },
      },
      receipt: { operation: "app.agents.tasks.show" },
    });
  });

  it("returns only the authenticated actor's private task projection", async () => {
    const response = await GET(
      new Request("http://asael.test/api/agents/tasks/run-child"),
      routeContext,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "delegation_execution",
      resourceId: "run-child",
    }));
    expect(mocks.show).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          tenantId: "tenant-one",
          actorId: "actor-one",
        }),
      }),
      { executionId: "run-child" },
    );
    expect(body).toMatchObject({
      task: { executionId: "run-child", authority: { immutable: true } },
      serviceReceipt: { operation: "app.agents.tasks.show" },
    });
  });

  it("hides cross-actor or missing task identifiers", async () => {
    mocks.show.mockRejectedValueOnce(
      new DelegationExecutionConflictError("Delegation execution was not found."),
    );
    const response = await GET(
      new Request("http://asael.test/api/agents/tasks/run-other"),
      { params: Promise.resolve({ id: "run-other" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Delegated task not found." });
  });
});
