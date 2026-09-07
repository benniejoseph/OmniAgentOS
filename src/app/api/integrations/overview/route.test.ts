import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), show: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: vi.fn(),
}));
vi.mock("@/lib/app-services/integrations", () => ({
  showTruthfulIntegrationsService: mocks.show,
}));

import { GET } from "@/app/api/integrations/overview/route";

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({
    tenantId: "tenant:test",
    actorId: "actor:test",
    role: "admin",
    source: "session",
  });
  mocks.show.mockReset().mockResolvedValue({
    data: { overview: { version: "p11.7-truthful-integrations:1" } },
    receipt: { operation: "app.integrations.overview.show" },
  });
});

describe("truthful Integrations route", () => {
  it("returns the private application-service projection", async () => {
    const response = await GET(new Request(
      "http://localhost/api/integrations/overview?workspaceId=workspace%3Atest",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "integrations_overview",
    }));
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), {
      workspaceId: "workspace:test",
    });
  });
});
