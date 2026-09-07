import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  forbiddenResponse: vi.fn(() => new Response(null, { status: 403 })),
  getAgentRelease: vi.fn(),
  evaluateAgentRelease: vi.fn(),
  promoteAgentRelease: vi.fn(),
  rollbackAgentRelease: vi.fn(),
  retireAgentRelease: vi.fn(),
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
vi.mock("@/lib/agents/release-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/agents/release-store")>(),
  getAgentRelease: mocks.getAgentRelease,
  evaluateAgentRelease: mocks.evaluateAgentRelease,
  promoteAgentRelease: mocks.promoteAgentRelease,
  rollbackAgentRelease: mocks.rollbackAgentRelease,
  retireAgentRelease: mocks.retireAgentRelease,
}));

import { GET, POST } from "@/app/api/agents/[id]/release/route";

const auth = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  role: "operator",
};
const release = {
  agentId: "agent-one",
  state: "active",
  activeDefinitionVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(auth);
  for (const handler of [
    mocks.getAgentRelease,
    mocks.evaluateAgentRelease,
    mocks.promoteAgentRelease,
    mocks.rollbackAgentRelease,
    mocks.retireAgentRelease,
  ]) handler.mockResolvedValue(release);
});

describe("P7.5 Agent release route", () => {
  it("returns the owner release privately", async () => {
    const response = await GET(
      new Request("http://asael.test/api/agents/agent-one/release"),
      { params: Promise.resolve({ id: "agent-one" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getAgentRelease).toHaveBeenCalledWith(
      "agent-one",
      expect.objectContaining({
        actorId: "owner@example.test",
        canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("evaluates and promotes only strict version-bound requests", async () => {
    const evaluated = await post({ action: "evaluate", definitionVersion: 2 });
    expect(evaluated.status).toBe(200);
    expect(mocks.evaluateAgentRelease).toHaveBeenCalledWith(
      "agent-one",
      2,
      expect.objectContaining({ tenantId: "tenant-one" }),
    );
    const evaluationId = `agent-release-evaluation:${"a".repeat(64)}`;
    const promoted = await post({ action: "promote", evaluationId });
    expect(promoted.status).toBe(200);
    expect(mocks.promoteAgentRelease).toHaveBeenCalledWith(
      "agent-one",
      evaluationId,
      expect.anything(),
    );
    expect((await post({ action: "promote", evaluationId: "unsafe" })).status)
      .toBe(400);
  });

  it("requires the explicit retirement confirmation", async () => {
    expect((await post({ action: "retire", confirmation: "retire" })).status)
      .toBe(400);
    const response = await post({
      action: "retire",
      confirmation: "RETIRE AGENT",
    });
    expect(response.status).toBe(200);
    expect(mocks.retireAgentRelease).toHaveBeenCalledOnce();
  });
});

function post(body: unknown) {
  return POST(new Request("http://asael.test/api/agents/agent-one/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "agent-one" }) });
}
