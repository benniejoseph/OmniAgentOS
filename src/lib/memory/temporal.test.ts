import { describe, expect, it } from "vitest";
import {
  isTemporalIntervalActive,
  selectTemporalFactsAsOf,
} from "@/lib/memory/temporal";

describe("temporal fact selection", () => {
  it("uses half-open validity intervals", () => {
    const interval = {
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2026-01-12T00:00:00.000Z",
    };
    expect(isTemporalIntervalActive(interval, "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isTemporalIntervalActive(interval, "2026-01-11T23:59:59.999Z")).toBe(true);
    expect(isTemporalIntervalActive(interval, "2026-01-12T00:00:00.000Z")).toBe(false);
  });

  it("selects only the fact valid at the requested time", () => {
    const result = selectTemporalFactsAsOf([
      {
        id: "evidence:friday",
        value: "Friday",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-01-12T00:00:00.000Z",
      },
      {
        id: "evidence:monday",
        value: "Monday",
        validFrom: "2026-01-12T00:00:00.000Z",
        validTo: null,
      },
    ], "2026-01-10T12:00:00.000Z");

    expect(result).toEqual({
      facts: [{
        id: "evidence:friday",
        value: "Friday",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-01-12T00:00:00.000Z",
      }],
      uncertainty: "none",
    });
  });

  it("reports overlap instead of selecting an arbitrary current fact", () => {
    expect(selectTemporalFactsAsOf([
      { id: "fact:a", value: "A", validFrom: null, validTo: null },
      { id: "fact:b", value: "B", validFrom: null, validTo: null },
    ], "2026-01-10T12:00:00.000Z").uncertainty).toBe("overlapping_intervals");
  });
});
