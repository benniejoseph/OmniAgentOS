import { NATIVE_API_CURRENT_VERSION } from "@/lib/mobile/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  list: vi.fn(),
  show: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listCommitments: vi.fn(),
  proposeCommitment: vi.fn(),
  resolveCommitment: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));

vi.mock("@/lib/app-services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/meetings")>()),
  listMeetingsService: mocks.list,
  showMeetingService: mocks.show,
  createMeetingService: mocks.create,
  updateMeetingService: mocks.update,
  listMeetingCommitmentsService: mocks.listCommitments,
  proposeMeetingCommitmentService: mocks.proposeCommitment,
  resolveMeetingCommitmentService: mocks.resolveCommitment,
}));

import { GET as GETMeeting, PATCH as PATCHMeeting } from "@/app/api/meetings/[id]/route";
import {
  GET as GETCommitments,
  PATCH as PATCHCommitment,
  POST as POSTCommitment,
} from "@/app/api/meetings/[id]/commitments/route";
import { GET as GETMeetings, POST as POSTMeeting } from "@/app/api/meetings/route";
import { MeetingWriteDeniedError } from "@/lib/app-services/meetings";
import type { AppServiceCaller } from "@/lib/app-services/contracts";
import { assertTrustedSessionMutation, type authorizeRequest } from "@/lib/security/guard";
import { requirePermission } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";

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
const meetingId = "meeting:22222222-2222-4222-8222-222222222222";
const meeting = { meetingId, revision: 1, title: "Customer review" };
const receipt = { operation: "app.meetings.list" };

function draft() {
  return {
    title: "Customer review",
    status: "scheduled",
    scheduledStartAt: "2026-09-08T10:00:00.000Z",
    scheduledEndAt: "2026-09-08T11:00:00.000Z",
    timezone: "Asia/Kolkata",
    projectId: null,
    declaredAccessClass: "owner_private",
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost");
  vi.stubEnv("OMNIAGENT_NATIVE_MIN_MACOS_VERSION", "1.0.0");
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.list.mockReset().mockResolvedValue({
    data: { context: {}, meetings: [meeting] },
    receipt,
  });
  mocks.show.mockReset().mockResolvedValue({
    data: { context: {}, meeting },
    receipt: { operation: "app.meetings.show" },
  });
  mocks.create.mockReset().mockResolvedValue({
    data: { context: {}, meeting },
    receipt: { operation: "app.meetings.create" },
  });
  mocks.update.mockReset().mockResolvedValue({
    data: { context: {}, meeting: { ...meeting, revision: 2 } },
    receipt: { operation: "app.meetings.update" },
  });
  mocks.listCommitments.mockReset().mockResolvedValue({
    data: { context: {}, meeting, commitments: [], eligiblePolicies: [] },
    receipt: { operation: "app.meetings.commitments.list" },
  });
  mocks.proposeCommitment.mockReset().mockResolvedValue({
    data: { context: {}, commitment: { proposal: { proposalId: "proposal-1" } } },
    receipt: { operation: "app.meetings.commitments.propose" },
  });
  mocks.resolveCommitment.mockReset().mockResolvedValue({
    data: { context: {}, commitment: { resolution: { decision: "dismissed" } } },
    receipt: { operation: "app.meetings.commitments.resolve" },
  });
});
afterEach(() => vi.unstubAllEnvs());

function nativeContext(version: number = NATIVE_API_CURRENT_VERSION, role: SecurityContext["role"] = "operator"): SecurityContext {
  return {
    ...context, role, source: "mobile",
    native: { deviceId: "meeting-native-device", platform: "macos", appVersion: "1.0.0", buildNumber: 1,
      clientContractVersion: version, clientAttestedAt: new Date().toISOString() },
  };
}

/** Exercise the real origin, capability and role policies at the route's
 * authorization seam; authentication and all domain effects remain mocked. */
function authorizeAs(principal: SecurityContext) {
  mocks.authorizeRequest.mockImplementation(async (input: Parameters<typeof authorizeRequest>[0]) => {
    assertTrustedSessionMutation(input.request, principal, input.nativeMutationCapability);
    requirePermission(principal, input.action);
    return principal;
  });
}

const routeContext = () => ({ params: Promise.resolve({ id: encodeURIComponent(meetingId) }) });
const mutations = [
  { name: "create", method: "POST", path: "/api/meetings", capability: "meetings.records.manage", action: "manage.workflow", expectedStatus: 201,
    body: () => ({ ...draft(), workspaceId: "workspace-a" }), call: (request: Request) => POSTMeeting(request), service: mocks.create },
  { name: "update", method: "PATCH", path: `/api/meetings/${encodeURIComponent(meetingId)}`, capability: "meetings.records.manage", action: "manage.workflow", expectedStatus: 200,
    body: () => ({ ...draft(), workspaceId: "workspace-a", expectedRevision: 1 }), call: (request: Request) => PATCHMeeting(request, routeContext()), service: mocks.update },
  { name: "propose", method: "POST", path: `/api/meetings/${encodeURIComponent(meetingId)}/commitments`, capability: "meetings.commitments.propose", action: "run.agent", expectedStatus: 201,
    body: () => ({ workspaceId: "workspace-a", mediaRevisionId: "recording-1:media:v1", actionItemId: `media-action:${"a".repeat(64)}` }), call: (request: Request) => POSTCommitment(request, routeContext()), service: mocks.proposeCommitment },
  { name: "resolve", method: "PATCH", path: `/api/meetings/${encodeURIComponent(meetingId)}/commitments`, capability: "meetings.commitments.resolve", action: "manage.workflow", expectedStatus: 200,
    body: () => ({ workspaceId: "workspace-a", proposalId: `meeting-commitment-proposal:${"b".repeat(64)}`, expectedProposalSha256: "c".repeat(64), decision: "dismissed" }), call: (request: Request) => PATCHCommitment(request, routeContext()), service: mocks.resolveCommitment },
];
function mutationRequest(route: typeof mutations[number], body: unknown = route.body(), key: string | undefined = `native-${route.name}`, origin?: string) {
  return new Request(`http://localhost${route.path}`, { method: route.method,
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(body) });
}

describe("meeting routes", () => {
  it("lists with private no-store response semantics", async () => {
    const response = await GETMeetings(new Request(
      "http://localhost/api/meetings?status=scheduled&limit=20",
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith(
      expect.any(Object),
      { status: "scheduled", limit: 20 },
    );
  });

  it("creates through a request-bound mutation caller", async () => {
    const response = await POSTMeeting(new Request(
      "http://localhost/api/meetings",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "meeting-create-1" },
        body: JSON.stringify(draft()),
      },
    ));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const caller = mocks.create.mock.calls[0][0];
    expect(caller).toMatchObject({ idempotencyKey: "meeting-create-1" });
    expect(caller.executionScope).toMatchObject({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      purpose: "api.meeting.create",
    });
  });

  it("awaits dynamic params and requires the exact expected revision", async () => {
    const routeContext = { params: Promise.resolve({ id: encodeURIComponent(meetingId) }) };
    const show = await GETMeeting(
      new Request(`http://localhost/api/meetings/${encodeURIComponent(meetingId)}`),
      routeContext,
    );
    const update = await PATCHMeeting(
      new Request(`http://localhost/api/meetings/${encodeURIComponent(meetingId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "meeting-update-1" },
        body: JSON.stringify({ ...draft(), expectedRevision: 1 }),
      }),
      routeContext,
    );
    expect(show.status).toBe(200);
    expect(update.status).toBe(200);
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), { meetingId });
    expect(mocks.update).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      meetingId,
      expectedRevision: 1,
    }));
  });

  it("rejects invalid access and consent shapes before mutation", async () => {
    const response = await POSTMeeting(new Request(
      "http://localhost/api/meetings",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "meeting-invalid" },
        body: JSON.stringify({
          ...draft(),
          declaredAccessClass: "public",
          participants: [{ displayName: "Missing consent" }],
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lists, proposes, and resolves exact commitment evidence privately", async () => {
    const routeContext = { params: Promise.resolve({ id: encodeURIComponent(meetingId) }) };
    const actionItemId = `media-action:${"a".repeat(64)}`;
    const proposalId = `meeting-commitment-proposal:${"b".repeat(64)}`;
    const list = await GETCommitments(
      new Request(`http://localhost/api/meetings/${encodeURIComponent(meetingId)}/commitments`),
      routeContext,
    );
    const propose = await POSTCommitment(
      new Request(`http://localhost/api/meetings/${encodeURIComponent(meetingId)}/commitments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "proposal-1" },
        body: JSON.stringify({ mediaRevisionId: "recording-1:media:v1", actionItemId }),
      }),
      routeContext,
    );
    const resolve = await PATCHCommitment(
      new Request(`http://localhost/api/meetings/${encodeURIComponent(meetingId)}/commitments`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "resolution-1" },
        body: JSON.stringify({
          proposalId,
          expectedProposalSha256: "c".repeat(64),
          decision: "dismissed",
        }),
      }),
      routeContext,
    );

    expect([list.status, propose.status, resolve.status]).toEqual([200, 201, 200]);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.proposeCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "proposal-1" }),
      expect.objectContaining({ meetingId, actionItemId }),
    );
    expect(mocks.resolveCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "resolution-1" }),
      expect.objectContaining({ meetingId, proposalId, decision: "dismissed" }),
    );
  });

  it.each(mutations)("enrolls $name only with its exact v33 capability and request scope", async (route) => {
    const principal = nativeContext(); authorizeAs(principal);
    const request = mutationRequest(route), response = await route.call(request);
    expect(response.status).toBe(route.expectedStatus);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      request, action: route.action, nativeMutationCapability: route.capability,
    }));
    expect(route.service).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      context: principal, idempotencyKey: `native-${route.name}`,
      executionScope: expect.objectContaining({ tenantId: principal.tenantId, initiatingActorId: principal.actorId,
        executingPrincipalType: "user", executingPrincipalId: principal.actorId, workspaceId: "workspace-a" }),
    }), expect.objectContaining({ workspaceId: "workspace-a" }));
  });

  it.each(mutations)("keeps $name held for rollback v32, viewer and stale native attestations", async (route) => {
    const stale = nativeContext(); stale.native!.clientAttestedAt = "2020-01-01T00:00:00.000Z";
    for (const principal of [nativeContext(32), nativeContext(NATIVE_API_CURRENT_VERSION, "viewer"), stale]) {
      authorizeAs(principal);
      const response = await route.call(mutationRequest(route));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(route.service).not.toHaveBeenCalled();
  });

  it.each(mutations)("preserves trusted web origin enforcement and exact key requirement for $name", async (route) => {
    authorizeAs(context);
    expect((await route.call(mutationRequest(route, route.body(), "web-key", "https://untrusted.example"))).status).toBe(403);
    expect(route.service).not.toHaveBeenCalled();
    mocks.authorizeRequest.mockClear();
    const missing = await route.call(mutationRequest(route, route.body(), "", "http://localhost"));
    expect(missing.status).toBe(400); expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect((await route.call(mutationRequest(route, route.body(), "web-key", "http://localhost"))).status).toBe(route.expectedStatus);
  });

  it.each(mutations)("rejects body-selected identity and authority on $name before authorization", async (route) => {
    for (const extra of [{ meetingId }, { meetingId: "another-meeting" }, { tenantId: "foreign" }, { actorId: "foreign" }]) {
      const response = await route.call(mutationRequest(route, { ...route.body(), ...extra }));
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled(); expect(route.service).not.toHaveBeenCalled();
  });

  it("returns private bounded path errors for all detail and commitment methods", async () => {
    for (const id of ["%", "%E0%A4%A", "x".repeat(721), "%20", " meeting-1 "]) {
      const params = { params: Promise.resolve({ id }) };
      const path = `http://localhost/api/meetings/${id}`;
      const responses = [
        await GETMeeting(new Request(path), params),
        await GETCommitments(new Request(`${path}/commitments`), params),
        await PATCHMeeting(mutationRequest(mutations[1]), params),
        await POSTCommitment(mutationRequest(mutations[2]), params),
        await PATCHCommitment(mutationRequest(mutations[3]), params),
      ];
      for (const response of responses) {
        expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    for (const call of [mocks.show, mocks.listCommitments, mocks.update, mocks.proposeCommitment, mocks.resolveCommitment]) expect(call).not.toHaveBeenCalled();
  });

  it("preserves private body media/size failures without reaching authority or effects", async () => {
    for (const route of mutations) {
      const contentType = mutationRequest(route); contentType.headers.set("content-type", "text/plain");
      const typeResponse = await route.call(contentType);
      const oversized = mutationRequest(route); oversized.headers.set("content-length", "250001");
      const sizeResponse = await route.call(oversized);
      expect([typeResponse.status, sizeResponse.status]).toEqual([415, 413]);
      expect(typeResponse.headers.get("cache-control")).toBe("private, no-store");
      expect(sizeResponse.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });

  it("passes current authenticated scope anew and preserves a downstream workspace revocation", async () => {
    const route = mutations[1]; authorizeAs(nativeContext());
    expect((await route.call(mutationRequest(route))).status).toBe(200);
    const replacement = { ...nativeContext(), tenantId: "tenant-b", actorId: "replacement@example.test",
      auth: { ...context.auth, userId: "33333333-3333-4333-8333-333333333333", email: "replacement@example.test" } };
    authorizeAs(replacement); mocks.update.mockRejectedValueOnce(new MeetingWriteDeniedError());
    const response = await route.call(mutationRequest(route));
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const caller = mocks.update.mock.calls[1][0] as AppServiceCaller;
    expect(caller.context).toEqual(replacement);
    expect(caller.executionScope).toMatchObject({ tenantId: replacement.tenantId, initiatingActorId: replacement.actorId, workspaceId: "workspace-a" });
    await expect(response.json()).resolves.toEqual({ error: "Meeting contributor access is required." });
  });
});
