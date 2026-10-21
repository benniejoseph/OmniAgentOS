import { describe, expect, it } from "vitest";
import { AvailabilityWatchProjectionSchema, availabilityOpeningActionable, availabilityWatchDeadline, resolveAvailabilityWatchConfig } from "./contracts";

const request = {
  source: { provider: "district", cinemaId: "1022272", cinemaName: "Synthetic cinema", sourceUrl: "https://www.district.in/movies/synthetic-cinema-CD1022272" },
  target: { date: "2026-10-22", timezone: "Asia/Kolkata", movieTitle: "Synthetic movie", language: "Tamil", seatClass: "gold", latestTime: "12:00" },
  intervalMinutes: 5,
};
const beforeNoon = "2026-10-22T06:29:59.999Z";
const noon = "2026-10-22T06:30:00.000Z";

describe("watch opportunity deadlines", () => {
  it("retains a noon show until its start and stops funding checks afterwards", () => {
    expect(resolveAvailabilityWatchConfig(request, beforeNoon)).toMatchObject({ expiresAt: noon, maxChecks: 2 });
    expect(() => resolveAvailabilityWatchConfig(request, noon)).toThrow("showtime window has not ended");
    expect(() => resolveAvailabilityWatchConfig(request, "2026-10-22T07:00:00.000Z")).toThrow();
  });
  it("caps an explicit later expiry at the requested showtime", () => {
    expect(resolveAvailabilityWatchConfig({ ...request, expiresAt: "2026-10-22T18:29:59.999Z" }, beforeNoon).expiresAt).toBe(noon);
  });
  it("honors a narrower user expiry", () => {
    const expiresAt = "2026-10-22T05:00:00.000Z";
    expect(resolveAvailabilityWatchConfig({ ...request, expiresAt }, "2026-10-21T00:00:00.000Z").expiresAt).toBe(expiresAt);
  });
  it("compares timestamp instants when an explicit expiry omits fractional seconds", () => {
    expect(() => resolveAvailabilityWatchConfig({ ...request, expiresAt: "2026-10-22T05:00:00Z" }, "2026-10-22T05:00:00.000Z")).toThrow();
  });
  it("retains day-end for unrestricted showtimes", () => {
    expect(resolveAvailabilityWatchConfig({ ...request, target: { ...request.target, latestTime: null } }, beforeNoon).expiresAt)
      .toBe("2026-10-22T18:29:59.999Z");
  });
  it("converts a midnight India cutoff onto the preceding UTC date", () => {
    expect(resolveAvailabilityWatchConfig({ ...request, target: { ...request.target, latestTime: "00:15" } }, "2026-10-21T00:00:00.000Z").expiresAt)
      .toBe("2026-10-21T18:45:00.000Z");
  });
  it("enforces the opportunity for historical saved configs without mutating their digest inputs", () => {
    const config = { ...resolveAvailabilityWatchConfig(request, beforeNoon), expiresAt: "2026-10-22T18:29:59.999Z" };
    expect(availabilityWatchDeadline(config)).toBe(noon);
    expect(config.expiresAt).toBe("2026-10-22T18:29:59.999Z");
  });
  it("does not present a delayed opening once all observed shows have started", () => {
    const config = resolveAvailabilityWatchConfig(request, beforeNoon);
    const watch = AvailabilityWatchProjectionSchema.parse({ schemaVersion: 1, id: `watch_${"a".repeat(48)}`, revision: 2, generation: 1, state: "fulfilled", config,
      lastCheckedAt: beforeNoon, lastSuccessfulAt: beforeNoon, nextCheckAt: null, checksUsed: 1, consecutiveFailures: 0, lastError: null,
      lastObservation: null, openingId: `availability-opening:${"b".repeat(64)}`, notification: null, createdAt: beforeNoon, updatedAt: beforeNoon,
      matches: [{ sessionId: "synthetic", movieTitle: "Synthetic movie", language: "Tamil", format: "2D", startsAt: "2026-10-22T05:00:00.000Z",
        localTime: "10:30", seatClass: "GOLD", availableSeats: 3, price: 100, currency: "INR", bookingUrl: request.source.sourceUrl }] });
    expect(availabilityOpeningActionable(watch, "2026-10-22T04:59:59.999Z")).toBe(true);
    expect(availabilityOpeningActionable(watch, "2026-10-22T05:00:00.000Z")).toBe(false);
    expect(availabilityOpeningActionable({ ...watch, state: "stopped" }, "2026-10-22T04:00:00.000Z")).toBe(false);
  });
});
