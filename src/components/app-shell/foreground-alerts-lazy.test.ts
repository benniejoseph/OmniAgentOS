import { afterEach, expect, it, vi } from "vitest";
import { ForegroundAlerts, isCurrentWatchAlert } from "./foreground-alerts";

const lazy = vi.hoisted(() => {
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  return { loaded: false, started, release, startedPromise, releasePromise };
});
vi.mock("@/lib/availability-watches/contracts", async importOriginal => {
  lazy.loaded = true;
  lazy.started();
  await lazy.releasePromise;
  return importOriginal();
});
afterEach(() => vi.useRealTimers());

it("keeps full watch validation out of routine alerts, and rechecks the clock after its deferred load", async () => {
  const ledger = new ForegroundAlerts();
  const input = { notices: [] as { id: string; kind: "reminder"; status: string }[], enabled: true, notificationsEnabled: true,
    quietHoursActive: false, signal: new AbortController().signal, verifyWatch: vi.fn(), show: vi.fn() };
  await ledger.observe(input);
  input.notices = [{ id: "routine", kind: "reminder", status: "unread" }];
  await ledger.observe(input);
  expect(input.show).toHaveBeenCalledTimes(1);
  expect(lazy.loaded).toBe(false);

  const notice = { id: "opening-notice", sourceType: "availability_watch", sourceId: `watch_${"a".repeat(48)}`, occurrenceKey: `availability-opening:${"b".repeat(64)}` };
  const createdAt = "2026-10-21T00:00:00.000Z";
  const sourceUrl = "https://www.district.in/movies/synthetic-cinema-CD1022272";
  const payload = { schemaVersion: 1, contract: "asael-availability-watches:1", watch: {
    schemaVersion: 1, id: notice.sourceId, revision: 2, generation: 1, state: "fulfilled",
    config: { source: { provider: "district", cinemaId: "1022272", cinemaName: "Synthetic cinema", sourceUrl },
      target: { date: "2026-10-22", timezone: "Asia/Kolkata", movieTitle: "Synthetic movie", language: "Tamil", seatClass: "gold", earliestTime: null, latestTime: "12:00" },
      intervalMinutes: 5, expiresAt: "2026-10-22T06:30:00.000Z", maxChecks: 500,
      notification: { destination: "owner_in_app", push: true, quietOnNoChange: true } },
    lastCheckedAt: createdAt, lastSuccessfulAt: createdAt, nextCheckAt: null, checksUsed: 1, consecutiveFailures: 0,
    lastError: null, lastObservation: null, openingId: notice.occurrenceKey,
    notification: { state: "recorded", notificationId: notice.id, dispositionId: null, pushDeliveryIds: [], nextAttemptAt: null },
    createdAt, updatedAt: createdAt, matches: [{ sessionId: "synthetic", movieTitle: "Synthetic movie", language: "Tamil", format: "2D",
      startsAt: "2026-10-22T05:00:00.000Z", localTime: "10:30", seatClass: "GOLD", availableSeats: 3, price: 100, currency: "INR", bookingUrl: sourceUrl }],
  } };
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-22T04:59:59.999Z");
  const result = isCurrentWatchAlert(notice, payload);
  await lazy.startedPromise;
  // A chunk can finish downloading after the final matching show has begun.
  vi.setSystemTime("2026-10-22T05:00:00.000Z");
  lazy.release();
  expect(await result).toBe(false);
  expect(await isCurrentWatchAlert(notice, payload, "2026-10-22T04:59:59.999Z")).toBe(true);
});
