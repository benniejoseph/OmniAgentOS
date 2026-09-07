import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  forbiddenResponse: vi.fn(() => new Response(null, { status: 403 })),
  resolveIdentity: vi.fn(),
  list: vi.fn(),
  observe: vi.fn(),
  evaluate: vi.fn(),
  activate: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: mocks.forbiddenResponse,
}));
vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext: () => ({
    canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
  }),
}));
vi.mock("@/lib/agents/identity-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/agents/identity-store")>(),
  resolveAgentIdentityForExecution: mocks.resolveIdentity,
}));
vi.mock("@/lib/agents/adaptation-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/agents/adaptation-store")>(),
  listAgentAdaptations: mocks.list,
  observeAgentAdaptationEvidence: mocks.observe,
  evaluateAgentAdaptation: mocks.evaluate,
  activateAgentAdaptation: mocks.activate,
  rollbackAgentAdaptation: mocks.rollback,
}));

import { GET, POST } from "@/app/api/agents/[id]/adaptations/route";

const auth = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  role: "operator",
};
const adaptations = [{ adaptationId: `agent-adaptation:${"a".repeat(64)}` }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(auth);
  mocks.resolveIdentity.mockResolvedValue({
    definition: { definitionVersion: 3 },
  });
  for (const handler of [
    mocks.list,
    mocks.observe,
    mocks.evaluate,
    mocks.activate,
    mocks.rollback,
  ]) handler.mockResolvedValue(adaptations);
});

describe("P7.6 Agent adaptation route", () => {
  it("returns exact-owner adaptations privately", async () => {
    const response = await GET(
      new Request("http://asael.test/api/agents/scout/adaptations"),
      { params: Promise.resolve({ id: "scout" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ definitionVersion: 3 });
    expect(mocks.list).toHaveBeenCalledWith(
      "scout",
      expect.objectContaining({
        canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("observes evidence only through an explicit refresh", async () => {
    const response = await post({ action: "refresh" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ definitionVersion: 3 });
    expect(mocks.observe).toHaveBeenCalledWith(
      "scout",
      3,
      expect.anything(),
    );
  });

  it("binds evaluation and activation to the current definition", async () => {
    const adaptationId = `agent-adaptation:${"b".repeat(64)}`;
    expect((await post({ action: "evaluate", adaptationId })).status).toBe(200);
    expect(mocks.evaluate).toHaveBeenCalledWith(
      "scout",
      adaptationId,
      3,
      expect.anything(),
    );
    expect((await post({ action: "activate", adaptationId })).status).toBe(200);
    expect(mocks.activate).toHaveBeenCalledWith(
      "scout",
      adaptationId,
      3,
      expect.anything(),
    );
    expect((await post({ action: "activate", adaptationId: "unsafe" })).status)
      .toBe(400);
  });

  it("exposes an explicit rollback action", async () => {
    const adaptationId = `agent-adaptation:${"c".repeat(64)}`;
    const response = await post({ action: "rollback", adaptationId });
    expect(response.status).toBe(200);
    expect(mocks.rollback).toHaveBeenCalledWith(
      "scout",
      adaptationId,
      3,
      expect.anything(),
    );
  });
});

function post(body: unknown) {
  return POST(new Request("http://asael.test/api/agents/scout/adaptations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "scout" }) });
}
