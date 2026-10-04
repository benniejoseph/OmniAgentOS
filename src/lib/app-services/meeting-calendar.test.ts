import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ accept: vi.fn(), connection: vi.fn(), blocked: vi.fn(), read: vi.fn(), settle: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/connectors/meeting-calendar-sync-store", async (original) => ({
  ...await original<typeof import("@/lib/connectors/meeting-calendar-sync-store")>(),
  acceptMeetingCalendarSync: mocks.accept, readMeetingCalendarConnection: mocks.connection,
  readBlockedMeetingCalendarSync: mocks.blocked, readMeetingCalendarSync: mocks.read, settleMeetingCalendarSync: mocks.settle,
}));
vi.mock("@/lib/connectors/personal-sync", () => ({ syncPersonalProvider: mocks.sync }));
vi.mock("@/lib/connectors/oauth-providers", () => ({ googleConnectorAccountPolicyForIdentity: () => ({ email: "owner@example.test", purpose: "personal" }) }));
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { showMeetingCalendarService, inspectMeetingCalendarSyncService, syncMeetingCalendarService } from "@/lib/app-services/meeting-calendar";
import { MAIN_AGENT_APP_SERVICE_BINDINGS } from "@/lib/app-services/registry";
import { MEETING_CALENDAR_SYNC_CONTRACT, MEETING_CALENDAR_ACCEPTANCE_CONTRACT, meetingCalendarRequestSha256, meetingCalendarSyncId,
  nativeMeetingCalendarStatusResponseSchema, nativeMeetingCalendarSyncResponseSchema, nativeMeetingCalendarSyncReadResponseSchema,
  type MeetingCalendarSync } from "@/lib/mobile/meeting-calendar-contracts";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = { tenantId: "calendar-owner", actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "calendar-session", tenantName: "Private" } };
const scope = { tenantId: context.tenantId, ownerActorId: context.actorId, canonicalActorId: `actor:${context.auth!.userId}`, workspaceId: `workspace:personal:${context.auth!.userId}` };
const request = { contract: MEETING_CALENDAR_SYNC_CONTRACT, connectionId: "22222222-2222-4222-8222-222222222222", expectedAuthorizationGeneration: 3 };
const at = "2026-10-04T00:00:00.000Z", key = "calendar-request-one", keySha = createHash("sha256").update(key).digest("hex");
const coverage = { status: "healthy" as const, backfillState: "complete" as const, lastAttemptedAt: at, lastSuccessfulAt: at, failureCode: "none" as const };
const connection = { id: request.connectionId, tenantId: scope.tenantId, ownerActorId: scope.ownerActorId, accountEmail: context.actorId,
  authorizationGeneration: 3, status: "active", calendarReadAllowed: true, coverage, lastSyncedAt: at, retryAfter: null, updatedAt: at };
function accepted(): MeetingCalendarSync { return { acceptance: { contract: MEETING_CALENDAR_ACCEPTANCE_CONTRACT,
  id: meetingCalendarSyncId(scope, keySha), scope, connectionId: request.connectionId, authorizationGeneration: 3,
  idempotencyKeySha256: keySha, requestSha256: meetingCalendarRequestSha256(scope, request), acceptedAt: at },
  state: "accepted", settlement: null, updatedAt: at }; }
function caller(role = context.role) { return createRequestMutationAppServiceCaller(new Request("https://asael.test/api/meetings/calendar/sync", {
  method: "POST", headers: { "Idempotency-Key": key } }), { ...context, role }, { purpose: "api.meetings.calendar.sync", causationId: request.connectionId }); }
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.accept.mockResolvedValue({ sync: accepted(), newlyAccepted: true });
  mocks.connection.mockResolvedValue(connection); mocks.blocked.mockResolvedValue(null);
  mocks.sync.mockResolvedValue({ provider: "google", status: "healthy", imported: 2, removed: 0, cursorAdvanced: true,
    sources: [{ source: "calendar", ...coverage, imported: 2, removed: 0 }],
    grant: { id: connection.id, tenantId: scope.tenantId, actorId: scope.ownerActorId, accountEmail: context.actorId, authorizationGeneration: 3 } });
  mocks.settle.mockImplementation(async (_authority, _id, settlement) => ({ ...accepted(),
    state: settlement ? "settled" : "unconfirmed", settlement, updatedAt: settlement?.settledAt ?? at }));
});
describe("native Meeting Calendar service", () => {
  it("reads an exact-owner account projection without opening credentials or syncing", async () => {
    const result = await showMeetingCalendarService(createAppServiceCaller({ context }));
    expect(result.data.scope).toEqual(scope);
    expect(mocks.connection).toHaveBeenCalledWith(expect.objectContaining({ scope, accountEmail: context.actorId }));
    expect(nativeMeetingCalendarStatusResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt })).toBeTruthy();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("accepts before first effects and pins only Calendar, connection and authorization", async () => {
    const result = await syncMeetingCalendarService(caller(), request);
    expect(mocks.accept.mock.invocationCallOrder[0]).toBeLessThan(mocks.sync.mock.invocationCallOrder[0]);
    expect(mocks.sync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tenantId: scope.tenantId, actorId: scope.ownerActorId,
      provider: "google", connectionId: request.connectionId, sources: ["calendar"], expectedAuthorizationGeneration: 3, expectedAccountEmail: context.actorId }));
    expect(result.data.sync.state).toBe("settled");
    expect(nativeMeetingCalendarSyncResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt })).toBeTruthy();
    expect(result.receipt.idempotencyKeySha256).not.toBe(result.data.sync.acceptance.idempotencyKeySha256);
  });
  it.each(["accepted", "unconfirmed", "settled"] as const)("does not repeat %s acceptance effects on replay", async (state) => {
    const sync = { ...accepted(), state, settlement: state === "settled" ? { status: "healthy" as const, imported: 2, removed: 0, cursorAdvanced: true, coverage, settledAt: at } : null };
    mocks.accept.mockResolvedValue({ sync, newlyAccepted: false });
    const result = await syncMeetingCalendarService(caller(), request);
    expect(result.data).toMatchObject({ sync, replayed: true });
    expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
  });
  it("keeps accepted uncertainty when provider work throws and never retries", async () => {
    mocks.sync.mockRejectedValue(new Error("provider error with private details"));
    const result = await syncMeetingCalendarService(caller(), request);
    expect(result.data.sync.state).toBe("unconfirmed"); expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private details");
  });
  it("still returns durable acceptance when terminal evidence cannot be persisted", async () => {
    mocks.settle.mockRejectedValue(new Error("storage unavailable"));
    const result = await syncMeetingCalendarService(caller(), request);
    expect(result.data.sync).toEqual(accepted()); expect(mocks.sync).toHaveBeenCalledTimes(1);
  });
  it("fences changed authorization between acceptance and first network call", async () => {
    mocks.connection.mockResolvedValue({ ...connection, authorizationGeneration: 4 });
    const result = await syncMeetingCalendarService(caller(), request);
    expect(result.data.sync.state).toBe("unconfirmed"); expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("rejects a settlement with another source or owner", async () => {
    mocks.sync.mockResolvedValue({ provider: "google", status: "healthy", sources: [{ source: "mail" }], grant: {} });
    const result = await syncMeetingCalendarService(caller(), request);
    expect(result.data.sync.state).toBe("unconfirmed");
  });
  it("recovers through exact authenticated read even for a read-only role", async () => {
    mocks.read.mockResolvedValue(accepted());
    const result = await inspectMeetingCalendarSyncService(createAppServiceCaller({ context: { ...context, role: "viewer" } }), accepted().acceptance.id, { acceptanceKeySha256: keySha });
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ scope }), accepted().acceptance.id, keySha);
    expect(nativeMeetingCalendarSyncReadResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt })).toBeTruthy();
    expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("denies unbound identities and read-only mutations before acceptance", async () => {
    await expect(syncMeetingCalendarService(caller("viewer"), request)).rejects.toThrow();
    await expect(showMeetingCalendarService(createAppServiceCaller({ context: { ...context, auth: undefined } }))).rejects.toMatchObject({ status: 403 });
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it("does not enroll Calendar sync as an agent tool", () => {
    expect(MAIN_AGENT_APP_SERVICE_BINDINGS.some((entry) => entry.operation.startsWith("meetings.calendar."))).toBe(false);
  });
});
