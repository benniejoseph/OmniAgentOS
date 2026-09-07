import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listSharedMemoryService: vi.fn(),
  writeSharedMemoryService: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));

vi.mock("@/lib/app-services/shared-memory", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/app-services/shared-memory")
  >()),
  listSharedMemoryService: mocks.listSharedMemoryService,
  writeSharedMemoryService: mocks.writeSharedMemoryService,
}));

import { GET, POST } from "@/app/api/memory/shared/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(context);
  mocks.listSharedMemoryService.mockResolvedValue({
    data: { context: { scope: "project" }, memories: [] },
    receipt: { operation: "app.memory.shared.list" },
  });
  mocks.writeSharedMemoryService.mockResolvedValue({
    data: { context: { scope: "project" }, record: { id: "memory-a" } },
    receipt: { operation: "app.memory.shared.write" },
  });
});

describe("shared-memory route", () => {
  it("requires a project coordinate and forwards a bounded private read", async () => {
    const invalid = await GET(new Request(
      "http://localhost/api/memory/shared?scope=project",
    ));
    const response = await GET(new Request(
      "http://localhost/api/memory/shared?scope=project&projectId=project-a&limit=25",
    ));

    expect(invalid.status).toBe(400);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listSharedMemoryService).toHaveBeenCalledWith(
      expect.objectContaining({ context }),
      { scope: "project", projectId: "project-a", limit: 25 },
    );
  });

  it("authorizes and forwards a governed shared-memory mutation", async () => {
    const request = new Request("http://localhost/api/memory/shared", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "shared-write-a",
      },
      body: JSON.stringify({
        scope: "project",
        projectId: "project-a",
        title: "Launch constraints",
        content: "Use the approved launch window.",
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      request,
      action: "write.memory",
      resourceType: "shared_memory",
    }));
    expect(mocks.writeSharedMemoryService).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        idempotencyKey: "shared-write-a",
      }),
      expect.objectContaining({ projectId: "project-a" }),
    );
  });
});
