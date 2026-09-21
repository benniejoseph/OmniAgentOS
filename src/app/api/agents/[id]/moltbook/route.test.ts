import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalBinding: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  refresh: vi.fn(),
  heartbeat: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => new Response(null, { status: 403 }),
}));
vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext: mocks.canonicalBinding,
}));
vi.mock("@/lib/moltbook/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/moltbook/store")>(),
  listMoltbookConnection: mocks.list,
  registerMoltbookConnection: mocks.register,
  refreshMoltbookConnection: mocks.refresh,
  heartbeatMoltbookConnection: mocks.heartbeat,
  pauseMoltbookConnection: mocks.pause,
  resumeMoltbookConnection: mocks.resume,
}));

import { GET, POST } from "@/app/api/agents/[id]/moltbook/route";

const context = { params: Promise.resolve({ id: "agent_molty" }) };
const auth = { tenantId: "tenant-one", actorId: "legacy@example.test" };
const owner = "actor:11111111-1111-4111-8111-111111111111";
const connection = {
  agentId: "agent_molty",
  status: "claimed",
  health: "healthy",
  externalName: "AsaelMolty",
  claimState: "claimed",
  heartbeatEnabled: true,
  consecutiveFailures: 0,
  credentialConfigured: true,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(auth);
  mocks.canonicalBinding.mockReturnValue({ canonicalActorId: owner });
  mocks.list.mockResolvedValue({ connection, activities: [], nextCursor: null });
  for (const fn of [mocks.refresh, mocks.heartbeat, mocks.pause, mocks.resume]) {
    fn.mockResolvedValue(connection);
  }
});

describe("Moltbook Agent route", () => {
  it("lists only through the exact canonical owner and disables caching", async () => {
    const response = await GET(new Request(
      "https://asael.test/api/agents/agent_molty/moltbook?limit=25",
    ), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: owner },
      agentId: "agent_molty",
      limit: 25,
      cursor: undefined,
    });
  });

  it("rejects requests when canonical actor ownership is unavailable", async () => {
    mocks.canonicalBinding.mockReturnValue(undefined);
    const response = await GET(new Request(
      "https://asael.test/api/agents/agent_molty/moltbook",
    ), context);
    expect(response.status).toBe(409);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns only the safe registration projection and claim handoff", async () => {
    mocks.register.mockResolvedValue({
      connection: { ...connection, status: "pending_claim", claimState: "pending" },
      claim: {
        url: "https://www.moltbook.com/claim/claim_123",
        verificationCode: "reef-X4B2",
      },
    });
    const response = await post({
      action: "register",
      externalName: "AsaelMolty",
      description: "A private Asael Agent.",
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("sealed");
    expect(JSON.parse(text)).toMatchObject({
      claim: { verificationCode: "reef-X4B2" },
    });
  });

  it("routes pause and resume as explicit human configuration actions", async () => {
    expect((await post({ action: "pause" })).status).toBe(200);
    expect(mocks.pause).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: owner },
      agentId: "agent_molty",
    });
    expect((await post({ action: "resume" })).status).toBe(200);
    expect(mocks.resume).toHaveBeenCalled();
  });
});

function post(body: unknown) {
  return POST(new Request(
    "https://asael.test/api/agents/agent_molty/moltbook",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ), context);
}
