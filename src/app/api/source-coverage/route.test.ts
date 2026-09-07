import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), show: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: vi.fn(),
}));
vi.mock("@/lib/app-services/source-coverage", () => ({
  showSourceCoverageService: mocks.show,
}));

import { GET } from "@/app/api/source-coverage/route";

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({
    tenantId: "tenant:test",
    actorId: "actor:test",
    role: "admin",
    source: "session",
  });
  mocks.show.mockReset().mockResolvedValue({
    data: { coverage: { version: "p11.9-source-coverage:1" } },
    receipt: { operation: "app.sources.coverage.show" },
  });
});

describe("P11.9 source coverage route", () => {
  it("returns the private projection through the governed service", async () => {
    const response = await GET(new Request(
      "http://localhost/api/source-coverage?workspaceId=workspace%3Atest",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "source_coverage",
    }));
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), {
      workspaceId: "workspace:test",
    });
    expect(await response.json()).toMatchObject({
      coverage: { version: "p11.9-source-coverage:1" },
      serviceReceipt: { operation: "app.sources.coverage.show" },
    });
  });
});
