import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationContext as context, notificationEnableRequest as request, notificationHead, notificationNow as now, notificationRecord as record, notificationRuntime as runtime } from "./notification-test-fixtures";
import { buildNotificationReceipt } from "./notification-state";
import { ResponsibilityError } from "./state";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), clock: vi.fn(), draft: vi.fn(), runtime: vi.fn(), head: vi.fn(), prior: vi.fn(), persist: vi.fn(), references: vi.fn(), stop: vi.fn() }));
vi.mock("./lifecycle-store", () => ({ withResponsibilityRuntimeTransaction: mocks.transaction, runtimeDatabaseNow: mocks.clock, readRuntimeDraft: mocks.draft, readRuntimeHead: mocks.runtime }));
vi.mock("./notification-store", () => ({ readNotificationAdmission: mocks.head, readNotificationReceipt: mocks.prior, persistNotificationTransition: mocks.persist, candidateFromRow: vi.fn(), stopNotificationAdmissionWithSql: mocks.stop }));
vi.mock("./notification-references", () => ({ resolveNotificationReferences: mocks.references }));
import { changeResponsibilityNotifications, enableResponsibilityNotifications, getResponsibilityNotifications } from "./notification-service";
const sql = vi.fn(async () => []);
beforeEach(() => {
  vi.clearAllMocks(); mocks.transaction.mockImplementation(async (_owner, work) => work(sql)); mocks.clock.mockResolvedValue(now);
  mocks.draft.mockResolvedValue(record); mocks.runtime.mockResolvedValue(runtime); mocks.head.mockResolvedValue(null); mocks.prior.mockResolvedValue(null);
  mocks.references.mockResolvedValue({}); mocks.persist.mockImplementation(async (_sql, input) => buildNotificationReceipt(input));
});
describe("Separate Responsibility inbox admission", () => {
  it("keeps history and a ready preview read-only, without creating preferences or admission", async () => {
    const history = await getResponsibilityNotifications(context, record.id);
    expect(history).toMatchObject({ current: null, candidates: [], receipts: [], externalDelivery: false, coverage: { total: null, limit: 40 } });
    expect(mocks.references).not.toHaveBeenCalled();
    expect(await getResponsibilityNotifications(context, record.id, true)).toMatchObject({ preview: { state: "ready", authorityEffect: "none", expectedRuntimeRevision: runtime.revision } });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("requires manage.workflow and an exact canonical request binding before storage", async () => {
    await expect(enableResponsibilityNotifications({ ...context, role: "viewer" }, record.id, request, "key")).rejects.toMatchObject({ status: 403 });
    await expect(enableResponsibilityNotifications({ ...context, actorId: "someone-else@example.test" }, record.id, request, "key")).rejects.toMatchObject({ code: "responsibility_owner_unbound" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("accepts only the exact current preview and returns a separate immutable receipt", async () => {
    await expect(enableResponsibilityNotifications(context, record.id, { ...request, expectedRuntimeGeneration: 99 }, "stale")).rejects.toMatchObject({ code: "responsibility_notification_preview_changed" });
    expect(mocks.persist).not.toHaveBeenCalled();
    const accepted = await enableResponsibilityNotifications(context, record.id, request, "accepted");
    expect(accepted).toMatchObject({ replayed: false, current: { state: "enabled", used: 0, reserved: 0 }, receipt: { action: "enable", candidate: null } });
    expect(runtime.configuration.notificationAuthority).toBe("none");
  });
  it("retains an accepted receipt on retry even when current state or preferences changed", async () => {
    const head = notificationHead(); const receipt = buildNotificationReceipt({ previous: null, current: head, action: "enable", key: "accepted", request: { responsibilityId: record.id, ...request } });
    mocks.head.mockResolvedValue({ ...head, revision: 2, generation: 2, state: "paused", reason: "runtime_paused" }); mocks.prior.mockResolvedValue(receipt);
    mocks.references.mockRejectedValue(new ResponsibilityError("Disabled", 409, "responsibility_notification_notifications_disabled"));
    const replay = await enableResponsibilityNotifications(context, record.id, request, "accepted");
    expect(replay.receipt).toEqual(receipt); expect(replay).toMatchObject({ replayed: true, current: { state: "paused" } });
    expect(mocks.references).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("reports missing saved preferences as blocked without silently enabling defaults", async () => {
    mocks.references.mockRejectedValue(new ResponsibilityError("Unavailable", 409, "responsibility_notification_preferences_unavailable"));
    expect(await getResponsibilityNotifications(context, record.id, true)).toMatchObject({ preview: { state: "blocked", reason: "responsibility_notification_preferences_unavailable", authorityEffect: "none" } });
    await expect(enableResponsibilityNotifications(context, record.id, request, "key")).rejects.toMatchObject({ code: "responsibility_notification_preferences_unavailable" });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("stops only the exact separately admitted generation even after runtime exhaustion", async () => {
    const head = { ...notificationHead(), state: "draining" as const, reason: "checks_exhausted" as const };
    mocks.head.mockResolvedValue(head); mocks.stop.mockResolvedValue({ current: { ...head, state: "ended", reason: "owner_stopped" }, receipt: { action: "stop" } });
    const stop = { action: "stop", expectedRevision: head.revision, expectedGeneration: head.generation };
    await expect(changeResponsibilityNotifications(context, record.id, { ...stop, expectedGeneration: 99 }, "stale")).rejects.toMatchObject({ code: "responsibility_notification_changed" });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(await changeResponsibilityNotifications(context, record.id, stop, "stop")).toMatchObject({ current: { reason: "owner_stopped" }, receipt: { action: "stop" }, replayed: false });
    expect(mocks.stop).toHaveBeenCalledWith(sql, head, "stop", { responsibilityId: record.id, ...stop }, now);
    expect(mocks.references).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("recovers an accepted stop with the same key before stale CAS or revoked source reads", async () => {
    const previous = notificationHead(); const current = { ...previous, revision: 2, generation: 2, state: "ended" as const, reason: "owner_stopped" as const };
    const stop = { action: "stop", expectedRevision: 1, expectedGeneration: 1 };
    const receipt = buildNotificationReceipt({ previous, current, action: "stop", key: "stop", request: { responsibilityId: record.id, ...stop } });
    mocks.head.mockResolvedValue(current); mocks.prior.mockResolvedValue(receipt);
    expect(await changeResponsibilityNotifications(context, record.id, stop, "stop")).toMatchObject({ current, receipt, replayed: true });
    expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.references).not.toHaveBeenCalled();
    await expect(changeResponsibilityNotifications({ ...context, role: "viewer" }, record.id, stop, "stop")).rejects.toMatchObject({ status: 403 });
  });
});
