import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <T>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));

import { GET } from "@/app/api/agents/cards/route";

describe("internal Agent Card discovery route", () => {
  beforeEach(() => {
    mocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "member",
    });
  });

  it("returns the authenticated internal cards without authority material", async () => {
    const response = await GET(new Request("http://localhost/api/agents/cards"));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.cards).toHaveLength(5);
    expect(body.cards[0]).toMatchObject({
      version: "p8.5-agent-card:1",
      externalA2AEnabled: false,
    });
    expect(serialized).not.toContain("principalId");
    expect(serialized).not.toContain("actor-one");
    expect(serialized).not.toContain("tenant-one");
  });

  it("returns deterministic compatibility-ranked discovery", async () => {
    const response = await GET(new Request(
      "http://localhost/api/agents/cards?query=compare%20primary%20sources&taskKind=research",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.discovery).toMatchObject({
      version: "p8.5-agent-discovery-receipt:1",
      matches: [{ agentId: "scout" }],
      authorityImpact: "none",
    });
  });

  it("fails closed when the caller is not authorized", async () => {
    mocks.authorizeRequest.mockRejectedValue(new Error("denied"));
    const response = await GET(new Request("http://localhost/api/agents/cards"));
    expect(response.status).toBe(403);
  });
});
