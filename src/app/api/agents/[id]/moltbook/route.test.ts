import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalBinding: vi.fn(),
  resolveOwner: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  resolveIdentity: vi.fn(),
  identityPin: vi.fn(),
  refresh: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  listAutonomy: vi.fn(),
  insertAuthority: vi.fn(),
  enableAutonomy: vi.fn(),
  pauseAutonomy: vi.fn(),
  resumeAutonomy: vi.fn(),
  revokeAutonomy: vi.fn(),
  runAutonomyOnce: vi.fn(),
  getCustomAgent: vi.fn(),
  updateCustomAgent: vi.fn(),
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
  refreshMoltbookConnection: mocks.refresh,
  pauseMoltbookConnection: mocks.pause,
  resumeMoltbookConnection: mocks.resume,
}));
vi.mock("@/lib/agents/identity-store", () => ({
  resolveAgentIdentityForExecution: mocks.resolveIdentity,
}));
vi.mock("@/lib/moltbook/identity-boundary", () => ({
  moltbookConnectionIdentityPinFromIdentity: mocks.identityPin,
}));
vi.mock("@/lib/moltbook/autonomy-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/moltbook/autonomy-store")>(),
  listMoltbookAutonomyProjection: mocks.listAutonomy,
  insertCurrentMoltbookAuthorityVersion: mocks.insertAuthority,
  enableMoltbookAutonomy: mocks.enableAutonomy,
  pauseMoltbookAutonomy: mocks.pauseAutonomy,
  resumeMoltbookAutonomy: mocks.resumeAutonomy,
  revokeMoltbookAutonomy: mocks.revokeAutonomy,
}));
vi.mock("@/lib/moltbook/autonomy-runner", () => ({
  MOLTBOOK_AUTONOMY_CHARTER_SHA256: "4".repeat(64),
  runMoltbookAutonomyOnce: mocks.runAutonomyOnce,
}));
vi.mock("@/lib/skills/store", () => ({
  getCustomAgent: mocks.getCustomAgent,
  updateCustomAgent: mocks.updateCustomAgent,
}));

import { GET, POST } from "@/app/api/agents/[id]/moltbook/route";
import { MoltbookConnectionError } from "@/lib/moltbook/store";
import {
  MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
  MOLTBOOK_DISCLOSURE_VERSION,
  MOLTBOOK_LEGACY_TOOL_IDS,
  MOLTBOOK_TOOL_IDS,
} from "@/lib/moltbook/contracts";

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
  disclosureAccepted: true,
  disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};
const autonomy = {
  executable: true,
  enrollment: { id: "moltbook_enrollment_test", status: "paused" },
  interests: [],
  recentCycles: [],
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
  mocks.resolveIdentity.mockResolvedValue({ definition: {}, principal: {} });
  mocks.identityPin.mockReturnValue({
    logicalAgentId: "agent_molty",
    principalId: "agent:agent_molty",
    principalGeneration: 7,
    principalSha256: "1".repeat(64),
    definitionVersion: 3,
    definitionSha256: "2".repeat(64),
    policyBoundarySha256: "3".repeat(64),
  });
  mocks.list.mockResolvedValue({ connection, activities: [], nextCursor: null });
  mocks.listAutonomy.mockResolvedValue(autonomy);
  mocks.getCustomAgent.mockResolvedValue({
    id: "agent_molty",
    toolIds: [...MOLTBOOK_LEGACY_TOOL_IDS],
  });
  mocks.updateCustomAgent.mockResolvedValue({
    id: "agent_molty",
    toolIds: [...MOLTBOOK_TOOL_IDS],
  });
  mocks.insertAuthority.mockResolvedValue({ authorityVersion: 2 });
  mocks.enableAutonomy.mockResolvedValue({ status: "enabled" });
  mocks.pauseAutonomy.mockResolvedValue({ status: "paused" });
  mocks.resumeAutonomy.mockResolvedValue({ status: "enabled" });
  mocks.revokeAutonomy.mockResolvedValue({ status: "revoked" });
  mocks.runAutonomyOnce.mockResolvedValue({
    cycleId: "moltbook_cycle_test",
    status: "succeeded",
    interestsObserved: 2,
    paused: false,
  });
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
    expect(await response.json()).toMatchObject({ autonomy });
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

  it("rejects registration retry because no provider non-effect receipt exists", async () => {
    const response = await post({
      action: "retry_registration",
      externalName: "AsaelMolty2",
      description: "A corrected private Asael Agent identity.",
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_DISCLOSURE_VERSION,
    });
    expect(response.status).toBe(400);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("routes pause and resume as explicit human configuration actions", async () => {
    expect((await post({ action: "pause" })).status).toBe(200);
    expect(mocks.pause).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
    });
    expect(mocks.pauseAutonomy).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
    });
    expect(mocks.pauseAutonomy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pause.mock.invocationCallOrder[0]!,
    );
    expect((await post({ action: "resume" })).status).toBe(200);
    expect(mocks.resume).toHaveBeenCalled();
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      nativeMutationCapability: "agents.moltbook.manage",
    }));
  });

  it("keeps autonomy paused when the connection pause step fails", async () => {
    mocks.pause.mockRejectedValueOnce(new Error("connection pause unavailable"));

    const response = await post({ action: "pause" });

    expect(response.status).toBe(500);
    expect(mocks.pauseAutonomy).toHaveBeenCalledTimes(1);
    expect(mocks.pause).toHaveBeenCalledTimes(1);
    expect(mocks.pauseAutonomy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pause.mock.invocationCallOrder[0]!,
    );
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("upgrades the exact Agent boundary before enabling autonomy", async () => {
    const response = await post({
      action: "enable_autonomy",
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
    });
    expect(response.status).toBe(200);
    expect(mocks.updateCustomAgent).toHaveBeenCalledWith(
      "agent_molty",
      { toolIds: [...MOLTBOOK_TOOL_IDS] },
      { tenantId: "tenant-one", actorId: storedOwner },
    );
    expect(mocks.insertAuthority).toHaveBeenCalledWith(expect.objectContaining({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
      pin: expect.objectContaining({ principalGeneration: 7 }),
      changeRequestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(mocks.enableAutonomy).toHaveBeenCalledWith(expect.objectContaining({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
      authorizedByCanonicalActorId: owner,
      charterSha256: "4".repeat(64),
    }));
    expect(mocks.list.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pause.mock.invocationCallOrder[0]!,
    );
    expect(mocks.pause.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateCustomAgent.mock.invocationCallOrder[0]!,
    );
    expect(mocks.insertAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resume.mock.invocationCallOrder[0]!,
    );
    expect(mocks.resume.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enableAutonomy.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["paused connection", { status: "paused" }],
    ["unclaimed connection", { claimState: "pending" }],
    ["missing credential", { credentialConfigured: false }],
  ])("refuses autonomy enablement for a %s", async (_label, override) => {
    mocks.list.mockResolvedValue({
      connection: { ...connection, ...override },
      activities: [],
      nextCursor: null,
    });

    const response = await post({
      action: "enable_autonomy",
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "autonomy_connection_unavailable",
    });
    expect(mocks.getCustomAgent).not.toHaveBeenCalled();
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.updateCustomAgent).not.toHaveBeenCalled();
    expect(mocks.insertAuthority).not.toHaveBeenCalled();
    expect(mocks.enableAutonomy).not.toHaveBeenCalled();
  });

  it("leaves both gates paused when authority persistence fails", async () => {
    mocks.insertAuthority.mockRejectedValue(new Error("authority unavailable"));

    const response = await post({
      action: "enable_autonomy",
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
    });

    expect(response.status).toBe(500);
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.enableAutonomy).not.toHaveBeenCalled();
    expect(mocks.pauseAutonomy).toHaveBeenCalledTimes(1);
    expect(mocks.pause).toHaveBeenCalledTimes(2);
    expect(mocks.insertAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pauseAutonomy.mock.invocationCallOrder[0]!,
    );
    expect(mocks.pauseAutonomy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pause.mock.invocationCallOrder[1]!,
    );
  });

  it("re-pauses both gates when autonomy enrollment fails after resume", async () => {
    mocks.enableAutonomy.mockRejectedValue(new Error("enrollment unavailable"));

    const response = await post({
      action: "enable_autonomy",
      disclosureAccepted: true,
      disclosureVersion: MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
    });

    expect(response.status).toBe(500);
    expect(mocks.resume).toHaveBeenCalledTimes(1);
    expect(mocks.enableAutonomy).toHaveBeenCalledTimes(1);
    expect(mocks.pauseAutonomy).toHaveBeenCalledTimes(1);
    expect(mocks.pause).toHaveBeenCalledTimes(2);
    expect(mocks.enableAutonomy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pauseAutonomy.mock.invocationCallOrder[0]!,
    );
    expect(mocks.pauseAutonomy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pause.mock.invocationCallOrder[1]!,
    );
  });

  it("keeps autonomy controls separate from connection resume", async () => {
    expect((await post({ action: "pause_autonomy" })).status).toBe(200);
    expect((await post({ action: "resume_autonomy" })).status).toBe(200);
    expect((await post({ action: "revoke_autonomy" })).status).toBe(200);
    expect(mocks.pauseAutonomy).toHaveBeenCalledTimes(1);
    expect(mocks.resumeAutonomy).toHaveBeenCalledTimes(1);
    expect(mocks.revokeAutonomy).toHaveBeenCalledTimes(1);

    await post({ action: "resume" });
    expect(mocks.resume).toHaveBeenCalled();
    expect(mocks.resumeAutonomy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["paused connection", { status: "paused" }],
    ["unclaimed connection", { claimState: "pending" }],
    ["missing credential", { credentialConfigured: false }],
  ])("refuses autonomy resume for a %s", async (_label, override) => {
    mocks.list.mockResolvedValue({
      connection: { ...connection, ...override },
      activities: [],
      nextCursor: null,
    });

    const response = await post({ action: "resume_autonomy" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "autonomy_connection_unavailable",
    });
    expect(mocks.resumeAutonomy).not.toHaveBeenCalled();
  });

  it("refuses autonomy resume when the standing authority is unavailable", async () => {
    mocks.listAutonomy.mockResolvedValue({
      ...autonomy,
      executable: false,
      blockedReason: "authority_unavailable",
    });

    const response = await post({ action: "resume_autonomy" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_authority" });
    expect(mocks.listAutonomy).toHaveBeenCalledWith({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
    });
    expect(mocks.resumeAutonomy).not.toHaveBeenCalled();
  });

  it("runs an owner-requested bounded autonomy cycle", async () => {
    const response = await post({ action: "run_autonomy_once" });
    expect(response.status).toBe(200);
    expect(mocks.runAutonomyOnce).toHaveBeenCalledWith(expect.objectContaining({
      owner: { tenantId: "tenant-one", actorId: storedOwner },
      agentId: "agent_molty",
    }));
    expect(await response.json()).toMatchObject({
      cycle: { cycleId: "moltbook_cycle_test", status: "succeeded" },
    });
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
