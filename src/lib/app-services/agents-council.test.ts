import { describe, expect, it, vi } from "vitest";

import { showAgentCouncilMapService } from "@/lib/app-services/agents";

const caller = {
  context: {
    tenantId: "tenant:test",
    actorId: "owner@example.test",
    role: "admin" as const,
    source: "session" as const,
    auth: {
      userId: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      sessionId: "session:test",
      tenantName: "Test",
    },
  },
};

describe("Agent Council application service", () => {
  it("reads only the canonical/current owner scope", async () => {
    const loadSource = vi.fn().mockResolvedValue({
      state: "available", tasks: [], runs: [], authorityEvents: [], identities: [],
      memberEvents: [], channels: [], memberUsage: [], verifierUsage: [],
    });
    const result = await showAgentCouncilMapService(caller, {}, { loadSource });

    expect(loadSource).toHaveBeenCalledWith({
      tenantId: "tenant:test",
      ownerActorIds: [
        "actor:00000000-0000-4000-8000-000000000001",
        "owner@example.test",
      ],
      limit: 60,
    });
    expect(result.receipt.operation).toBe("app.agents.council.show");
    expect(result.data.map.state).toBe("empty");
  });
});
