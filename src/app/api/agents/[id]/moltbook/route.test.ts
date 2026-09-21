import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalBinding: vi.fn(),
  resolveOwner: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  retryRegistration: vi.fn(),
  refresh: vi.fn(),
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
  resolveMoltbookAgentOwner: mocks.resolveOwner,
  listMoltbookConnection: mocks.list,
  registerMoltbookConnection: mocks.register,
  retryMoltbookRegistration: mocks.retryRegistration,
  refreshMoltbookConnection: mocks.refresh,
  pauseMoltbookConnection: mocks.pause,
  resumeMoltbookConnection: mocks.resume,
}));

import { GET, POST } from "@/app/api/agents/[id]/moltbook/route";
import { MoltbookConnectionError } from "@/lib/moltbook/store";
import { MOLTBOOK_DISCLOSURE_VERSION } from "@/lib/moltbook/contracts";

const context = { params: Promise.resolve({ id: "agent_molty" }) };
const auth = { tenantId: "tenant-one", actorId: "legacy@example.test" };
const owner = "actor:11111111-1111-4111-8111-111111111111";
const storedOwner = "legacy@example.test";
const connection = {
  agentId: "agent_molty",
  status: "claimed",
  health: "healthy",
  externalName: "AsaelMolty",
  claimState: "claimed",
  heartbeatEnabled: true,
  consecutiveFailures: 0,
  credentialConfigured: true,
  registrationRetryable: false,
  disclosureAccepted: true,
  disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(auth);
  mocks.canonicalBinding.mockReturnValue({
    canonicalActorId: owner,
    readableOwnerActorIds: [owner, storedOwner],
  });
  mocks.resolveOwner.mockResolvedValue({
    tenantId: "tenant-one",
    actorId: storedOwner,
  });
  mocks.list.mockResolvedValue({ connection, activities: [], nextCursor: null });
  for (const fn of [mocks.refresh, mocks.pause, mocks.resume]) {
    fn.mockResolvedValue(connection);
  }
});

describe("Moltbook Agent route", () => {
  it("resolves and preserves the exact stored physical owner", async () => {
    const response = await GET(new Request(
      "https://asael.test/api/agents/agent_molty/moltbook?limit=25",
    ), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.resolveOwner).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      agentId: "agent_molty",
      readableOwnerActorIds: [owner, storedOwner],
    });
    expect(mocks.list).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
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
    expect(mocks.resolveOwner).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("fails closed when no single stored owner resolves", async () => {
    mocks.resolveOwner.mockRejectedValue(new MoltbookConnectionError(
      "The exact stored owner for this Moltbook Agent could not be resolved.",
      { code: "agent_owner_unresolved" },
    ));
    const response = await GET(new Request(
      "https://asael.test/api/agents/agent_molty/moltbook",
    ), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "agent_owner_unresolved" });
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
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
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

  it("routes an explicit safe registration retry with corrected details", async () => {
    mocks.retryRegistration.mockResolvedValue({
      connection: { ...connection, status: "pending_claim", claimState: "pending" },
      claim: {
        url: "https://www.moltbook.com/claim/claim_456",
        verificationCode: "reef-Y7C9",
      },
    });
    const response = await post({
      action: "retry_registration",
      externalName: "AsaelMolty2",
      description: "A corrected private Asael Agent identity.",
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
    });
    expect(response.status).toBe(200);
    expect(mocks.retryRegistration).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
      externalName: "AsaelMolty2",
      description: "A corrected private Asael Agent identity.",
      heartbeatEnabled: undefined,
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
    });
  });

  it("routes pause and resume as explicit human configuration actions", async () => {
    expect((await post({ action: "pause" })).status).toBe(200);
    expect(mocks.pause).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
    });
    expect((await post({ action: "resume" })).status).toBe(200);
    expect(mocks.resume).toHaveBeenCalled();
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      nativeMutationCapability: "agents.moltbook.manage",
    }));
  });

  it("does not expose an executor-bypassing home heartbeat action", async () => {
    const response = await post({ action: "heartbeat" });
    expect(response.status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("requires the pinned human disclosure before registration", async () => {
    const response = await post({
      action: "register",
      externalName: "AsaelMolty",
      description: "A private Asael Agent.",
    });
    expect(response.status).toBe(400);
    expect(mocks.register).not.toHaveBeenCalled();
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
