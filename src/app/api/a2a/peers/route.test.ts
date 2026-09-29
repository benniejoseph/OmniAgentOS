import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  discoverExternalA2APeerV1: vi.fn(),
  registerA2APeer: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => new Response(null, { status: 403 }),
}));
vi.mock("@/lib/a2a/client", () => ({
  discoverExternalA2APeerV1: mocks.discoverExternalA2APeerV1,
}));
vi.mock("@/lib/a2a/store", () => ({
  A2APeerStoreError: class A2APeerStoreError extends Error {},
  listA2APeers: vi.fn(),
  registerA2APeer: mocks.registerA2APeer,
}));

import { POST } from "@/app/api/a2a/peers/route";

describe("A2A peer registration", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.authorizeRequest.mockRejectedValue(new Error("Stop after validation."));
  });

  it("refuses a rollout that routes inbound work to Sentinel", async () => {
    const response = await POST(registration(["scout", "sentinel"]));

    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.discoverExternalA2APeerV1).not.toHaveBeenCalled();
    expect(mocks.registerA2APeer).not.toHaveBeenCalled();
  });

  it("accepts every Agent that takes inbound tasks", async () => {
    const response = await POST(registration(["atlas", "scout", "forge", "mnemosyne"]));

    expect(response.status).toBe(403);
    expect(mocks.authorizeRequest).toHaveBeenCalledTimes(1);
  });
});

function registration(allowedInboundAgentIds: string[]) {
  return new Request("http://asael.test/api/a2a/peers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      peerId: "peer-one",
      baseUrl: "https://peer.example",
      direction: "inbound",
      inboundServiceApiKeyId: "key-one",
      allowedSkillIds: ["peer.identity"],
      allowedInboundAgentIds,
    }),
  });
}
