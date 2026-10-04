import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), show: vi.fn(), sync: vi.fn(), exact: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/app-services/meeting-calendar", () => ({ showMeetingCalendarService: mocks.show, syncMeetingCalendarService: mocks.sync, inspectMeetingCalendarSyncService: mocks.exact }));
import { GET as status } from "./route";
import { POST } from "./sync/route";
import { GET as exact } from "./sync/[id]/route";
const context = { tenantId: "calendar-owner", actorId: "owner@example.test", role: "admin" as const, source: "mobile" as const };
const id = `meeting-calendar-sync:${"a".repeat(64)}`;
const body = { contract: "asael-meeting-calendar-sync:1", connectionId: "11111111-1111-4111-8111-111111111111", expectedAuthorizationGeneration: 2 };
function post(value: unknown = body, query = "", key: string | null = "calendar-one") {
  return POST(new Request(`https://asael.test/api/meetings/calendar/sync${query}`, { method: "POST", headers: {
    "content-type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }),
  }, body: JSON.stringify(value) }));
}
function recover(query = `?acceptanceKeySha256=${"b".repeat(64)}`, target = id) {
  return exact(new Request(`https://asael.test/api/meetings/calendar/sync/${target}${query}`), { params: Promise.resolve({ id: target }) });
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset(); mocks.authorize.mockResolvedValue(context);
  mocks.show.mockResolvedValue({ data: { connection: null }, receipt: {} });
  mocks.exact.mockResolvedValue({ data: { sync: { acceptance: { id } } }, receipt: {} });
  mocks.sync.mockResolvedValue({ data: { sync: { state: "accepted", acceptance: { id, idempotencyKeySha256: "b".repeat(64) } } }, receipt: {} });
});
describe("Calendar native routes", () => {
  it("serves private connection status without an implicit sync", async () => {
    const response = await status(new Request("https://asael.test/api/meetings/calendar"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("dispatches only the strict stable-key command with its narrow capability", async () => {
    const response = await post(); expect(response.status).toBe(202);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "write.memory", nativeMutationCapability: "meetings.calendar.sync" }));
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "calendar-one", executionScope: expect.objectContaining({ purpose: "api.meetings.calendar.sync", causationId: body.connectionId }) }), body, expect.any(AbortSignal));
    expect(response.headers.get("location")).toContain("acceptanceKeySha256=");
  });
  it("refuses an absent key before authorization or work", async () => {
    expect((await post(body, "", null)).status).toBe(400); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.sync).not.toHaveBeenCalled();
  });
  it.each(["?source=calendar", "?connectionId=other", "?contract=x&contract=y"])("rejects POST query %s", async (query) => {
    expect((await post(body, query)).status).toBe(400); expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("rejects generic, altered and oversized requests before service execution", async () => {
    expect((await post({ ...body, sources: ["mail"] })).status).toBe(400);
    expect((await post({ ...body, expectedAuthorizationGeneration: 0 })).status).toBe(400);
    expect((await post({ ...body, payload: "x".repeat(4_096) })).status).toBe(413);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("recovers an exact receipt with its raw key hash and read authority only", async () => {
    expect((await recover()).status).toBe(200);
    expect(mocks.exact).toHaveBeenCalledWith(expect.objectContaining({ context }), id, { acceptanceKeySha256: "b".repeat(64) });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it.each(["", "?acceptanceKeySha256=bad", `?acceptanceKeySha256=${"b".repeat(64)}&acceptanceKeySha256=${"b".repeat(64)}`, `?acceptanceKeySha256=${"b".repeat(64)}&owner=other`])("rejects ambiguous recovery query %s", async (query) => {
    expect((await recover(query)).status).toBe(400); expect(mocks.exact).not.toHaveBeenCalled();
  });
  it("keeps authorization errors private", async () => {
    mocks.authorize.mockRejectedValue(new Error("forbidden"));
    for (const response of [await status(new Request("https://asael.test/api/meetings/calendar")), await post(), await recover()]) {
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
