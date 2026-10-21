import { describe, expect, it, vi } from "vitest";
import { ForegroundAlerts, isCurrentWatchAlert } from "./foreground-alerts";
import { buildNotificationDecisionV1 } from "@/lib/mobile/notification-decision";
import { AVAILABILITY_WATCH_CONTRACT, resolveAvailabilityWatchConfig } from "@/lib/availability-watches/contracts";

const notice = (id: string, kind: "reminder" | "availability_watch" = "reminder") => ({ id, kind, status: "unread" });
const options = () => ({ notices: [] as ReturnType<typeof notice>[], enabled: false, notificationsEnabled: true,
  quietHoursActive: false, signal: new AbortController().signal, verifyWatch: vi.fn().mockResolvedValue(true), show: vi.fn() });

describe("foreground alert delivery", () => {
  it("uses the current opt-in and does not replay the initial Inbox", async () => {
    const ledger = new ForegroundAlerts(); const input = options();
    input.notices = [notice("old")];
    await ledger.observe(input);
    input.enabled = true; input.notices.push(notice("new"));
    await ledger.observe(input);
    expect(input.show).toHaveBeenCalledExactlyOnceWith(notice("new"));
    await ledger.observe(input);
    expect(input.show).toHaveBeenCalledTimes(1);
  });
  it("matches the server watch quiet-hours bypass but respects notification opt-out", async () => {
    const server = buildNotificationDecisionV1({ candidate: { kind: "availability_opened", candidateId: "watch", occurrenceSha256: "a".repeat(64) },
      evaluatedAt: "2026-10-21T20:00:00.000Z", quietHoursActive: true, cooldownActive: false, digestEnabled: true });
    expect(server.outcome).toBe("send"); expect(server.bypassedQuietHours).toBe(true);
    const ledger = new ForegroundAlerts(); const input = options();
    await ledger.observe(input);
    Object.assign(input, { enabled: true, quietHoursActive: true, notificationsEnabled: false, notices: [notice("watch", "availability_watch"), notice("reminder")] });
    await ledger.observe(input); expect(input.show).not.toHaveBeenCalled();
    input.notificationsEnabled = true;
    await ledger.observe(input); expect(input.show).toHaveBeenCalledExactlyOnceWith(notice("watch", "availability_watch"));
    input.quietHoursActive = false;
    await ledger.observe(input); expect(input.show).toHaveBeenLastCalledWith(notice("reminder"));
  });
  it("retries failed watch verification and browser display without duplicate successful alerts", async () => {
    const ledger = new ForegroundAlerts(); const input = options(); await ledger.observe(input);
    input.enabled = true; input.notices = [notice("watch", "availability_watch")];
    input.verifyWatch.mockResolvedValueOnce(false);
    await ledger.observe(input); expect(input.show).not.toHaveBeenCalled();
    input.show.mockImplementationOnce(() => { throw new Error("OS refused"); });
    await ledger.observe(input); await ledger.observe(input); await ledger.observe(input);
    expect(input.show).toHaveBeenCalledTimes(2);
  });
  it("defers overflow instead of silently consuming alerts after the first three", async () => {
    const ledger = new ForegroundAlerts(); const input = options(); await ledger.observe(input);
    input.enabled = true; input.notices = [1,2,3,4,5].map(id => notice(String(id)));
    await ledger.observe(input); expect(input.show).toHaveBeenCalledTimes(3);
    await ledger.observe(input); expect(input.show).toHaveBeenCalledTimes(5);
  });
  it("never displays a watch after its owner read is aborted", async () => {
    const ledger = new ForegroundAlerts(); const input = options(); await ledger.observe(input);
    const controller = new AbortController(); input.signal = controller.signal;
    input.enabled = true; input.notices = [notice("watch", "availability_watch")];
    input.verifyWatch.mockImplementation(async () => { controller.abort(); return true; });
    await ledger.observe(input); expect(input.show).not.toHaveBeenCalled();
  });
  it("does not redisplay delivered notices that temporarily leave the Inbox page", async () => {
    const ledger = new ForegroundAlerts(); const input = options(); await ledger.observe(input);
    input.enabled = true; input.notices = [notice("delivered")];
    await ledger.observe(input);
    input.notices = []; await ledger.observe(input);
    input.notices = [notice("delivered")]; await ledger.observe(input);
    expect(input.show).toHaveBeenCalledTimes(1);
  });
});

describe("foreground watch opening validation", () => {
  const createdAt = "2026-10-21T00:00:00.000Z";
  const config = resolveAvailabilityWatchConfig({ source: { provider: "district", cinemaId: "1022272", cinemaName: "Synthetic cinema", sourceUrl: "https://www.district.in/movies/synthetic-cinema-CD1022272" },
    target: { date: "2026-10-22", timezone: "Asia/Kolkata", movieTitle: "Synthetic movie", language: "Tamil", seatClass: "gold", latestTime: "12:00" } }, createdAt);
  const currentNotice = { id: "notification-opening", sourceType: "availability_watch", sourceId: `watch_${"a".repeat(48)}`, occurrenceKey: `availability-opening:${"b".repeat(64)}` };
  const payload = { schemaVersion: 1, contract: AVAILABILITY_WATCH_CONTRACT, watch: {
    schemaVersion: 1, id: currentNotice.sourceId, revision: 2, generation: 1, state: "fulfilled", config,
    lastCheckedAt: createdAt, lastSuccessfulAt: createdAt, nextCheckAt: null, checksUsed: 1, consecutiveFailures: 0, lastError: null,
    lastObservation: null, openingId: currentNotice.occurrenceKey, notification: { state: "recorded", notificationId: currentNotice.id, dispositionId: null, pushDeliveryIds: [], nextAttemptAt: null },
    createdAt, updatedAt: createdAt, matches: [{ sessionId: "synthetic", movieTitle: "Synthetic movie", language: "Tamil", format: "2D", startsAt: "2026-10-22T05:00:00.000Z",
      localTime: "10:30", seatClass: "GOLD", availableSeats: 3, price: 100, currency: "INR", bookingUrl: config.source.sourceUrl }],
  } };
  it("stops a delayed foreground alert after the final show starts even before the configured expiry", () => {
    expect(isCurrentWatchAlert(currentNotice, payload, "2026-10-22T04:59:59.999Z")).toBe(true);
    expect(isCurrentWatchAlert(currentNotice, payload, "2026-10-22T05:00:00.000Z")).toBe(false);
  });
  it("requires the exact current watch, opening and notification receipt", () => {
    const now = "2026-10-22T04:59:59.999Z";
    expect(isCurrentWatchAlert({ ...currentNotice, occurrenceKey: `availability-opening:${"c".repeat(64)}` }, payload, now)).toBe(false);
    expect(isCurrentWatchAlert({ ...currentNotice, id: "another-notice" }, payload, now)).toBe(false);
    expect(isCurrentWatchAlert({ ...currentNotice, sourceId: `watch_${"c".repeat(48)}` }, payload, now)).toBe(false);
  });
});
