import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateA2ARequest: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/a2a/auth", () => ({
  A2AAccessError: class A2AAccessError extends Error {},
  a2aBearerChallenge: () => "Bearer",
  assertTrustedA2ANetworkBoundary: () => undefined,
  authenticateA2ARequest: mocks.authenticateA2ARequest,
}));

import { GET } from "@/app/api/a2a/extendedAgentCard/route";

describe("A2A extended Agent Card", () => {
  beforeEach(() => {
    mocks.authenticateA2ARequest.mockReset();
  });

  it("advertises only the rollout's Agents that take inbound tasks", async () => {
    mocks.authenticateA2ARequest.mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      peer: { allowedInboundAgentIds: ["scout", "sentinel"] },
    });
    const response = await GET(new Request("http://asael.test/api/a2a/extendedAgentCard", {
      headers: { "A2A-Version": "1.0" },
    }));

    expect(response.status).toBe(200);
    const card = await response.json() as { skills: { id: string }[] };
    const agents = new Set(card.skills.map((skill) => skill.id.split(".")[1]));
    expect([...agents]).toEqual(["scout"]);
  });
});
