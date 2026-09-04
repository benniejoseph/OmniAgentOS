import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestMissionSummary } from "@/lib/missions/types";

const routeMocks = vi.hoisted(() => {
  class MissionReadConflictError extends Error {
    constructor(message = "Mission ownership is ambiguous.") {
      super(message);
      this.name = "MissionReadConflictError";
    }
  }
  return {
    MissionReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    createMission: vi.fn(),
    listMissions: vi.fn(),
    listMissionSummariesForRequest: vi.fn(),
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

vi.mock("@/lib/missions/store", () => ({
  MissionReadConflictError: routeMocks.MissionReadConflictError,
  createMission: routeMocks.createMission,
  listMissions: routeMocks.listMissions,
  listMissionSummariesForRequest: routeMocks.listMissionSummariesForRequest,
}));

import { GET, POST } from "@/app/api/missions/route";

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
  authUserId: context.auth.userId,
  canonicalActorId: `actor:${context.auth.userId}`,
  legacyOwnerActorIds: [context.actorId],
  readableOwnerActorIds: [
    `actor:${context.auth.userId}`,
    context.actorId,
  ],
};
const exactMission = {
  id: "11111111-2222-4333-8444-555555555555",
  tenantId: context.tenantId,
  actorId: context.actorId,
  title: "Exact mission",
  objective: "Keep exact-owner execution semantics.",
  status: "draft" as const,
  priority: "normal" as const,
  source: "user",
  sourceKey: "mission:exact",
  metadata: {},
  createdAt: "2026-09-05T10:00:00.000Z",
  updatedAt: "2026-09-05T10:01:00.000Z",
};
const readableSummary: RequestMissionSummary = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  title: "Retained mission",
  objective: "Show retained history without widening execution authority.",
  status: "running",
  canonicalStatus: {
    schemaVersion: 1,
    status: "running",
    domain: "mission",
    basis: "legacy_status",
    source: "legacy_adapter",
    sourceStatus: "running",
    verificationState: "unassessed",
  },
  priority: "high",
  source: "talk",
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
  detailAvailable: false,
  manageable: false,
  runnable: false,
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.createMission.mockReset().mockResolvedValue(exactMission);
  routeMocks.listMissions.mockReset().mockResolvedValue([exactMission]);
  routeMocks.listMissionSummariesForRequest.mockReset().mockResolvedValue([
    readableSummary,
  ]);
});

describe("Mission collection route", () => {
  it("keeps a bare GET on the exact-owner reader with exact capabilities", async () => {
    const response = await GET(
      new Request("http://localhost/api/missions?limit=6"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith({
      request: expect.any(Request),
      action: "read",
      resourceType: "missions",
    });
    expect(routeMocks.listMissions).toHaveBeenCalledWith(6, {
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    await expect(response.json()).resolves.toMatchObject({
      missions: [{
        id: exactMission.id,
        detailAvailable: true,
        manageable: true,
        runnable: true,
      }],
      requestReadContracts: { missions: "exact_v1" },
    });
    expect(routeMocks.listMissionSummariesForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("binds only the literal readable summary collection", async () => {
    const response = await GET(new Request(
      "http://localhost/api/missions?limit=6&ownerScope=readable",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
    expect(routeMocks.listMissionSummariesForRequest).toHaveBeenCalledWith(6, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    await expect(response.json()).resolves.toEqual({
      missions: [readableSummary],
      requestReadContracts: { missions: "readable_v1" },
    });
    expect(routeMocks.listMissions).not.toHaveBeenCalled();
  });

  it("does not widen similar unsupported owner scopes", async () => {
    const response = await GET(new Request(
      "http://localhost/api/missions?ownerScope=Readable",
    ));

    expect(response.status).toBe(200);
    expect(routeMocks.listMissions).toHaveBeenCalledWith(50, {
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    expect(routeMocks.listMissionSummariesForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      requestReadContracts: { missions: "exact_v1" },
    });
  });

  it("maps a typed readable conflict to a private generic 409", async () => {
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);
    routeMocks.listMissionSummariesForRequest.mockRejectedValueOnce(
      new routeMocks.MissionReadConflictError("sensitive collision detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/missions?ownerScope=readable",
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json();
    expect(payload).toEqual({ error: "Mission history could not be verified." });
    expect(JSON.stringify(payload)).not.toContain("sensitive collision detail");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("logs only the error class for an unexpected readable failure", async () => {
    const consoleError = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);
    routeMocks.listMissionSummariesForRequest.mockRejectedValueOnce(
      new Error("sensitive database detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/missions?ownerScope=readable",
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Mission history is temporarily unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Mission history read failed.",
      "Error",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    consoleError.mockRestore();
  });

  it("preserves the existing throw behavior for an unexpected exact failure", async () => {
    const failure = new Error("exact reader failure");
    routeMocks.listMissions.mockRejectedValueOnce(failure);

    await expect(GET(new Request("http://localhost/api/missions")))
      .rejects.toBe(failure);
    expect(routeMocks.listMissionSummariesForRequest).not.toHaveBeenCalled();
  });

  it("keeps POST exact even when ownerScope is present", async () => {
    const response = await POST(new Request(
      "http://localhost/api/missions?ownerScope=readable",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: exactMission.title,
          objective: exactMission.objective,
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith({
      request: expect.any(Request),
      action: "run.agent",
      resourceType: "mission",
    });
    expect(routeMocks.createMission).toHaveBeenCalledWith({
      title: exactMission.title,
      objective: exactMission.objective,
      tenantId: context.tenantId,
      actorId: context.actorId,
      source: "user",
    });
    const payload = await response.json();
    expect(payload).toMatchObject({
      mission: {
        id: exactMission.id,
        detailAvailable: true,
        manageable: true,
        runnable: true,
      },
    });
    expect(payload).not.toHaveProperty("requestReadContracts");
    expect(routeMocks.listMissionSummariesForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });
});
