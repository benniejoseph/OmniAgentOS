import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  list: vi.fn(),
  show: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));

vi.mock("@/lib/app-services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/meetings")>()),
  listMeetingsService: mocks.list,
  showMeetingService: mocks.show,
  createMeetingService: mocks.create,
  updateMeetingService: mocks.update,
}));

import { GET as GETMeeting, PATCH as PATCHMeeting } from "@/app/api/meetings/[id]/route";
import { GET as GETMeetings, POST as POSTMeeting } from "@/app/api/meetings/route";

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
});

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
        headers: { "content-type": "application/json" },
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
});
