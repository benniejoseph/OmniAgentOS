import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  createAgentSkill: vi.fn(),
  deleteAgentSkill: vi.fn(),
  getAgentSkillForRequest: vi.fn(),
  listAgentSkillsForRequest: vi.fn(),
  updateAgentSkill: vi.fn(),
}));

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
  createAgentSkill: routeMocks.createAgentSkill,
  deleteAgentSkill: routeMocks.deleteAgentSkill,
  getAgentSkillForRequest: routeMocks.getAgentSkillForRequest,
  listAgentSkillsForRequest: routeMocks.listAgentSkillsForRequest,
  updateAgentSkill: routeMocks.updateAgentSkill,
}));

import {
  GET as GETSkill,
  PATCH as PATCHSkill,
  DELETE as DELETESkill,
} from "@/app/api/skills/[id]/route";
import { GET as GETSkills, POST as POSTSkill } from "@/app/api/skills/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "skill-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const context = {
  tenantId: "tenant-a",
  actorId,
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: actorId,
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: [actorId],
  readableOwnerActorIds: [canonicalActorId, actorId],
};
const customSkill = {
  id: "custom-skill",
  tenantId: context.tenantId,
  actorId,
  slug: "custom-skill",
  name: "Custom skill",
  description: "A custom skill.",
  instructions: "Use the custom skill safely.",
  category: "personal",
  status: "active",
  version: 1,
  toolIds: [],
  tags: [],
  knowledgeTags: [],
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.createAgentSkill.mockReset().mockResolvedValue(customSkill);
  routeMocks.deleteAgentSkill.mockReset().mockResolvedValue(true);
  routeMocks.getAgentSkillForRequest.mockReset().mockResolvedValue(customSkill);
  routeMocks.listAgentSkillsForRequest.mockReset().mockResolvedValue([customSkill]);
  routeMocks.updateAgentSkill.mockReset().mockResolvedValue(customSkill);
});

describe("request-bound custom Skill routes", () => {
  it("passes the authenticated actor binding only to the Skill collection read", async () => {
    const response = await GETSkills(new Request("http://localhost/api/skills"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
    expect(routeMocks.listAgentSkillsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
  });

  it("binds custom Skill detail reads and keeps success and 404 private", async () => {
    const success = await GETSkill(
      new Request("http://localhost/api/skills/custom-skill"),
      { params: Promise.resolve({ id: "custom-skill" }) },
    );

    expect(success.status).toBe(200);
    expect(success.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getAgentSkillForRequest).toHaveBeenCalledWith(
      "custom-skill",
      {
        tenantId: context.tenantId,
        actorId,
        requestActorBinding,
      },
    );

    routeMocks.getAgentSkillForRequest.mockResolvedValueOnce(undefined);
    const missing = await GETSkill(
      new Request("http://localhost/api/skills/missing"),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps POST, PATCH, and DELETE on exact mutation helpers", async () => {
    const created = await POSTSkill(jsonRequest("http://localhost/api/skills", "POST", {
      name: "Custom skill",
      description: "A custom skill.",
      instructions: "Use the custom skill safely.",
      category: "personal",
    }));
    expect(created.status).toBe(201);
    expect(routeMocks.createAgentSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Custom skill" }),
      { tenantId: context.tenantId, actorId },
    );

    const updated = await PATCHSkill(
      jsonRequest("http://localhost/api/skills/custom-skill", "PATCH", {
        description: "Updated custom skill.",
      }),
      { params: Promise.resolve({ id: "custom-skill" }) },
    );
    expect(updated.status).toBe(200);
    expect(routeMocks.updateAgentSkill).toHaveBeenCalledWith(
      "custom-skill",
      { description: "Updated custom skill." },
      { tenantId: context.tenantId, actorId },
    );

    const deleted = await DELETESkill(
      new Request("http://localhost/api/skills/custom-skill", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "custom-skill" }) },
    );
    expect(deleted.status).toBe(200);
    expect(routeMocks.deleteAgentSkill).toHaveBeenCalledWith(
      "custom-skill",
      { tenantId: context.tenantId, actorId },
    );
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
    expect(routeMocks.listAgentSkillsForRequest).not.toHaveBeenCalled();
    expect(routeMocks.getAgentSkillForRequest).not.toHaveBeenCalled();
  });
});

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
