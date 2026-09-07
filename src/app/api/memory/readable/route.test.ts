import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), show: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: vi.fn(),
}));
vi.mock("@/lib/app-services/readable-memory", () => ({
  showReadableMemoryService: mocks.show,
}));

import { GET } from "@/app/api/memory/readable/route";

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({
    tenantId: "tenant:test",
    actorId: "actor:test",
    role: "admin",
    source: "session",
  });
  mocks.show.mockReset().mockResolvedValue({
    data: { overview: { version: "p11.6-readable-memory:1" } },
    receipt: { operation: "app.memory.readable.show" },
  });
});

describe("readable Memory route", () => {
  it("returns a private bounded projection", async () => {
    const response = await GET(
      new Request("http://localhost/api/memory/readable?limit=25"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "memory_overview",
    }));
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), { limit: 25 });
  });
});
