import { describe, expect, it } from "vitest";
import {
  formatTodayDate,
  formatTodayDue,
  formatTodayRelative,
  formatTodayTime,
} from "@/lib/today/presentation";

describe("Today timestamp presentation", () => {
  it("keeps the date heading usable while a timezone preference is being edited", () => {
    const instant = new Date("2026-10-03T19:00:00.000Z");
    expect(formatTodayDate(instant, "UTC")).toBe("Saturday, October 3");
    expect(formatTodayDate(instant, "Asia/Kolkata")).toBe("Sunday, October 4");
    for (const draft of ["", "Asia/", "not/a-timezone"]) {
      expect(formatTodayDate(instant, draft)).toBe("Saturday, October 3");
    }
    expect(formatTodayDate(new Date("invalid"), "UTC")).toBe("Your day");
  });

  it("formats the same instant in the explicitly selected timezone", () => {
    const instant = "2026-08-26T08:04:00.000Z";

    expect(formatTodayTime(instant, "UTC")).toBe("8:04 AM");
    expect(formatTodayTime(instant, "Asia/Kolkata")).toBe("1:34 PM");
    expect(formatTodayTime(instant, "America/New_York")).toBe("4:04 AM");
  });

  it("formats due dates deterministically across a local date boundary", () => {
    expect(formatTodayDue("2026-08-26T19:13:00.000Z", "Asia/Kolkata"))
      .toBe("Aug 27, 12:43 AM");
  });

  it("falls back safely for invalid dates and timezones", () => {
    expect(formatTodayTime("2026-08-26T08:04:00.000Z", "not/a-timezone"))
      .toBe("8:04 AM");
    expect(formatTodayTime("invalid", "UTC")).toBe("Recently");
    expect(formatTodayDue("invalid", "UTC")).toBe("Unscheduled");
  });

  it("uses the supplied snapshot clock for relative labels", () => {
    expect(formatTodayRelative(
      "2026-08-26T10:00:00.000Z",
      Date.parse("2026-08-26T12:00:00.000Z"),
    )).toBe("2h ago");
    expect(formatTodayRelative("invalid", 0)).toBe("Recently");
  });
});
