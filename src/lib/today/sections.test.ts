import { describe, expect, it } from "vitest";
import { DEFAULT_TODAY_SECTIONS, normalizeTodaySections, TODAY_SECTION_KEYS } from "./sections";

describe("Today section preferences", () => {
  it("starts with focus, agenda, approvals, and work when no valid preference exists", () => {
    expect(DEFAULT_TODAY_SECTIONS).toEqual(["focus", "agenda", "approvals", "work"]);
    for (const value of [undefined, null, {}, [], ["unknown"]]) {
      expect(normalizeTodaySections(value)).toEqual(DEFAULT_TODAY_SECTIONS);
    }
  });

  it("preserves an existing person's sections and their order, including all active optional sections", () => {
    expect(normalizeTodaySections(TODAY_SECTION_KEYS)).toEqual(TODAY_SECTION_KEYS);
    expect(normalizeTodaySections(["consumption", "customers", "memory", "active_agents", "conversations"]))
      .toEqual(["consumption", "memory", "active_agents", "conversations"]);
  });

  it("removes invalid and duplicate entries without changing valid preferences", () => {
    expect(normalizeTodaySections(["memory", "unknown", null, "memory", "focus"]))
      .toEqual(["memory", "focus"]);
  });
});
