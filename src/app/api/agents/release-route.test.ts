import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  forbiddenResponse: vi.fn(() => new Response(null, { status: 403 })),
  getAgentRelease: vi.fn(),
  evaluateAgentRelease: vi.fn(),
  promoteAgentRelease: vi.fn(),
  rollbackAgentRelease: vi.fn(),
  retireAgentRelease: vi.fn(),
  previewAgentRetirementService: vi.fn(),
  retireAgentReleaseService: vi.fn(),
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
vi.mock("@/lib/app-services/agent-governance", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/app-services/agent-governance")>(),
  previewAgentRetirementService: mocks.previewAgentRetirementService,
  retireAgentReleaseService: mocks.retireAgentReleaseService,
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
  mocks.previewAgentRetirementService.mockResolvedValue({
    data: { target: { agentId: "agent-one" }, targetSha256: "f".repeat(64) },
    receipt: { operation: "app.agents.release.retire.preview" },
  });
  mocks.retireAgentReleaseService.mockResolvedValue({
    data: { release },
    receipt: { operation: "app.agents.release.retire" },
  });
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
    expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nativeMutationCapability: "agents.release.manage",
        metadata: expect.objectContaining({ releaseAction: "evaluate" }),
      }),
    );
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

  it("requires confirmation and retires only through the exact-target app service", async () => {
    expect((await post({ action: "retire", confirmation: "retire" })).status)
      .toBe(400);
    const response = await post({
      action: "retire",
      confirmation: "RETIRE AGENT",
    });
    expect(response.status).toBe(200);
    expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ nativeMutationCapability: expect.anything() }),
    );
    expect(mocks.previewAgentRetirementService).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        executionScope: expect.objectContaining({
          tenantId: "tenant-one",
          initiatingActorId: "owner@example.test",
          purpose: "agent.release.retire",
        }),
      }),
      { agentId: "agent-one" },
    );
    expect(mocks.retireAgentReleaseService).toHaveBeenCalledWith(
      expect.anything(),
      {
        agentId: "agent-one",
        expectedTargetSha256: "f".repeat(64),
      },
    );
    expect(mocks.retireAgentRelease).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      serviceReceipt: { operation: "app.agents.release.retire" },
    });
  });
});

function post(body: unknown) {
  return POST(new Request("http://asael.test/api/agents/agent-one/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "agent-one" }) });
}
