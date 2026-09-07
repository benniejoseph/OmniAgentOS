import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), show: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: vi.fn() }));
vi.mock("@/lib/app-services/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/agents")>()),
  showAgentCouncilMapService: mocks.show,
}));

import { GET } from "@/app/api/agents/council/route";

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({
    tenantId: "tenant:test", actorId: "actor:test", role: "admin", source: "session",
  });
  mocks.show.mockReset().mockResolvedValue({
    data: { map: { version: "p11.5-agent-council-map:1" } },
    receipt: { operation: "app.agents.council.show" },
  });
});

describe("Agent Council route", () => {
  it("returns a private bounded Council projection", async () => {
    const response = await GET(new Request("http://localhost/api/agents/council?limit=25"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "agent_council",
    }));
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), { limit: 25 });
  });

  it("rejects invalid limits before authorization", async () => {
    const response = await GET(new Request("http://localhost/api/agents/council?limit=101"));
    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
