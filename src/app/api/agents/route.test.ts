import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class AgentSkillAssignmentError extends Error {
    readonly code = "agent_skill_assignment_invalid";

    constructor() {
      super("One or more selected skills are unavailable for this agent.");
      this.name = "AgentSkillAssignmentError";
    }
  }
  class CustomAgentReadConflictError extends Error {
    constructor() {
      super("Custom Agent ownership is ambiguous.");
      this.name = "CustomAgentReadConflictError";
    }
  }
  return {
    AgentSkillAssignmentError,
    CustomAgentReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    createCustomAgent: vi.fn(),
    deleteCustomAgent: vi.fn(),
    getCustomAgent: vi.fn(),
    getCustomAgentForRequest: vi.fn(),
    listCustomAgents: vi.fn(),
    listCustomAgentsForRequest: vi.fn(),
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

vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext:
    routeMocks.canonicalRequestActorBindingFromSecurityContext,
}));

vi.mock("@/lib/skills/store", () => ({
  AgentSkillAssignmentError: routeMocks.AgentSkillAssignmentError,
  CustomAgentReadConflictError: routeMocks.CustomAgentReadConflictError,
  createCustomAgent: routeMocks.createCustomAgent,
  deleteCustomAgent: routeMocks.deleteCustomAgent,
  getCustomAgent: routeMocks.getCustomAgent,
  getCustomAgentForRequest: routeMocks.getCustomAgentForRequest,
  listCustomAgents: routeMocks.listCustomAgents,
  listCustomAgentsForRequest: routeMocks.listCustomAgentsForRequest,
  updateCustomAgent: routeMocks.updateCustomAgent,
}));

import {
  DELETE as DELETEAgent,
  GET as GETAgent,
  PATCH as PATCHAgent,
} from "@/app/api/agents/[id]/route";
import {
  GET as GETAgents,
  POST as POSTAgent,
} from "@/app/api/agents/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId: "11111111-1111-4111-8111-111111111111",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
  legacyOwnerActorIds: [context.actorId],
  readableOwnerActorIds: [
    "actor:11111111-1111-4111-8111-111111111111",
    context.actorId,
  ],
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
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.createCustomAgent.mockReset().mockResolvedValue(agent);
  routeMocks.deleteCustomAgent.mockReset().mockResolvedValue(true);
  routeMocks.getCustomAgent.mockReset().mockResolvedValue(agent);
  routeMocks.getCustomAgentForRequest.mockReset().mockResolvedValue({
    ...agent,
    selectable: true,
    manageable: true,
  });
  routeMocks.listCustomAgents.mockReset().mockResolvedValue([agent]);
  routeMocks.listCustomAgentsForRequest.mockReset().mockResolvedValue([{
    ...agent,
    selectable: true,
    manageable: true,
  }]);
  routeMocks.updateCustomAgent.mockReset().mockResolvedValue(agent);
});

describe("custom Agent Skill integrity route responses", () => {
  it("keeps the bare custom Agent list exact with explicit capabilities", async () => {
    const response = await GETAgents(
      new Request("http://localhost/api/agents"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listCustomAgentsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding: undefined,
    });
    expect(routeMocks.listCustomAgents).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
    const payload = await response.json();
    expect(payload.agents).toEqual([
      expect.objectContaining({
        id: agent.id,
        selectable: true,
        manageable: true,
      }),
    ]);
  });

  it("binds only the opt-in readable Agent list and publishes built-in capabilities", async () => {
    const response = await GETAgents(
      new Request("http://localhost/api/agents?ownerScope=readable"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
    expect(routeMocks.listCustomAgentsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    const payload = await response.json();
    expect(payload.agents).toEqual([
      expect.objectContaining({
        id: agent.id,
        selectable: true,
        manageable: true,
      }),
    ]);
    expect(payload.builtIns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "atlas",
          builtIn: true,
          selectable: true,
          manageable: false,
        }),
      ]),
    );
    expect(routeMocks.listCustomAgents).not.toHaveBeenCalled();
  });

  it("maps a typed custom Agent list conflict to a controlled private response", async () => {
    routeMocks.listCustomAgentsForRequest.mockRejectedValueOnce(
      new routeMocks.CustomAgentReadConflictError(),
    );
    const response = await GETAgents(
      new Request("http://localhost/api/agents?ownerScope=readable"),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "Custom Agent ownership could not be verified.",
    });
  });

  it("binds only the custom Agent detail GET and keeps success and 404 private", async () => {
    const success = await GETAgent(
      new Request("http://localhost/api/agents/agent-a"),
      { params: Promise.resolve({ id: "agent-a" }) },
    );
    expect(success.status).toBe(200);
    expect(success.headers.get("cache-control")).toBe("private, no-store");
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
    expect(routeMocks.getCustomAgentForRequest).toHaveBeenCalledWith(
      "agent-a",
      {
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestActorBinding,
      },
    );

    routeMocks.getCustomAgentForRequest.mockResolvedValueOnce(undefined);
    const missing = await GETAgent(
      new Request("http://localhost/api/agents/missing"),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
  });

  it("maps a typed custom Agent read conflict to a controlled private response", async () => {
    routeMocks.getCustomAgentForRequest.mockRejectedValueOnce(
      new routeMocks.CustomAgentReadConflictError(),
    );
    const response = await GETAgent(
      new Request("http://localhost/api/agents/atlas"),
      { params: Promise.resolve({ id: "atlas" }) },
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "Custom Agent ownership could not be verified.",
    });
  });

  it("keeps custom Agent deletion exact and outside the request-read binding", async () => {
    const response = await DELETEAgent(
      new Request("http://localhost/api/agents/agent-a", { method: "DELETE" }),
      { params: Promise.resolve({ id: "agent-a" }) },
    );
    expect(response.status).toBe(200);
    expect(routeMocks.deleteCustomAgent).toHaveBeenCalledWith("agent-a", {
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    expect(routeMocks.getCustomAgentForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

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
    expect(routeMocks.updateCustomAgent).toHaveBeenCalledWith(
      "agent-a",
      { skillIds: ["unavailable-skill"] },
      { tenantId: context.tenantId, actorId: context.actorId },
    );
    expect(routeMocks.getCustomAgent).not.toHaveBeenCalled();
    expect(routeMocks.getCustomAgentForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
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
