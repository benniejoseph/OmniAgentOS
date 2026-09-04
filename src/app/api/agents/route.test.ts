import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class AgentSkillAssignmentError extends Error {
    readonly code = "agent_skill_assignment_invalid";

    constructor() {
      super("One or more selected skills are unavailable for this agent.");
      this.name = "AgentSkillAssignmentError";
    }
  }
  return {
    AgentSkillAssignmentError,
    authorizeRequest: vi.fn(),
    createCustomAgent: vi.fn(),
    deleteCustomAgent: vi.fn(),
    getCustomAgent: vi.fn(),
    listCustomAgents: vi.fn(),
    updateCustomAgent: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/skills/store", () => ({
  AgentSkillAssignmentError: routeMocks.AgentSkillAssignmentError,
  createCustomAgent: routeMocks.createCustomAgent,
  deleteCustomAgent: routeMocks.deleteCustomAgent,
  getCustomAgent: routeMocks.getCustomAgent,
  listCustomAgents: routeMocks.listCustomAgents,
  updateCustomAgent: routeMocks.updateCustomAgent,
}));

import { PATCH as PATCHAgent } from "@/app/api/agents/[id]/route";
import { POST as POSTAgent } from "@/app/api/agents/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const agent = {
  id: "agent-a",
  tenantId: context.tenantId,
  actorId: context.actorId,
  slug: "agent-a",
  ...agentInput(["custom-skill"]),
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.createCustomAgent.mockReset().mockResolvedValue(agent);
  routeMocks.deleteCustomAgent.mockReset().mockResolvedValue(true);
  routeMocks.getCustomAgent.mockReset().mockResolvedValue(agent);
  routeMocks.listCustomAgents.mockReset().mockResolvedValue([agent]);
  routeMocks.updateCustomAgent.mockReset().mockResolvedValue(agent);
});

describe("custom Agent Skill integrity route responses", () => {
  it("maps an invalid Skill assignment on create to a private generic conflict", async () => {
    routeMocks.createCustomAgent.mockRejectedValueOnce(
      new routeMocks.AgentSkillAssignmentError(),
    );
    const response = await POSTAgent(jsonRequest(
      "http://localhost/api/agents",
      "POST",
      agentInput(["unavailable-skill"]),
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "One or more selected skills are unavailable for this agent.",
    });
  });

  it("maps an invalid final Skill assignment on update to the same private conflict", async () => {
    routeMocks.updateCustomAgent.mockRejectedValueOnce(
      new routeMocks.AgentSkillAssignmentError(),
    );
    const response = await PATCHAgent(
      jsonRequest("http://localhost/api/agents/agent-a", "PATCH", {
        skillIds: ["unavailable-skill"],
      }),
      { params: Promise.resolve({ id: "agent-a" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "One or more selected skills are unavailable for this agent.",
    });
  });

  it("preserves the duplicate-slug conflict response", async () => {
    routeMocks.createCustomAgent.mockRejectedValueOnce(
      new Error("An agent with this name already exists."),
    );
    const response = await POSTAgent(jsonRequest(
      "http://localhost/api/agents",
      "POST",
      agentInput([]),
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "An agent with this name already exists.",
    });

    routeMocks.updateCustomAgent.mockRejectedValueOnce(
      new Error("duplicate key value violates unique constraint"),
    );
    const updated = await PATCHAgent(
      jsonRequest("http://localhost/api/agents/agent-a", "PATCH", {
        name: "Existing Agent",
      }),
      { params: Promise.resolve({ id: "agent-a" }) },
    );
    expect(updated.status).toBe(409);
    expect(updated.headers.get("cache-control")).toBe("private, no-store");
    expect(await updated.json()).toEqual({
      error: "An agent with this name already exists.",
    });
  });
});

function agentInput(skillIds: string[]) {
  return {
    name: "Agent A",
    role: "Specialist",
    description: "A focused custom agent.",
    instructions: "Use approved skills and stay within the requested scope.",
    status: "ready" as const,
    accent: "emerald" as const,
    modelPolicy: "auto" as const,
    autonomy: "governed" as const,
    approvalPolicy: "risk_based" as const,
    memoryScope: "all" as const,
    skillIds,
    toolIds: [],
  };
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
