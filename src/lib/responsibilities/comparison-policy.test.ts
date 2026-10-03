import { describe, expect, it } from "vitest";
import { changedComparisonCategories, comparisonDigests, normalizeComparisonText, RESPONSIBILITY_MEETING_COMPARISON_POLICY, type ComparisonProjection } from "./comparison-policy";
import { projectionFixture as projection } from "./observation-test-fixtures";
describe("Pinned deterministic meeting comparison", () => {
  it("documents material, cosmetic and unsupported owner-facing examples under an immutable policy digest", () => {
    expect(RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(RESPONSIBILITY_MEETING_COMPARISON_POLICY.materialExamples).toHaveLength(4);
    expect(RESPONSIBILITY_MEETING_COMPARISON_POLICY.unsupportedExamples).toContain("An Agent response or a caller-authored JSON value has no authoritative stored evidence.");
    expect(Object.isFrozen(RESPONSIBILITY_MEETING_COMPARISON_POLICY.materialExamples)).toBe(true);
  });
  it("treats bounded display markup, whitespace, ordering and duplicate imports as equivalent", () => {
    const before = comparisonDigests([projection]);
    const cosmetic = { ...projection, meeting: { ...projection.meeting!, agenda: ["- **Release planning**", "# Budget   review", "Budget review"], participantKeys: ["participant-b", "participant-a", "participant-a"] },
      commitments: [{ ...projection.commitments[0], value: " Owner\n prepares\t briefing " }, projection.commitments[0]] };
    expect(comparisonDigests([cosmetic, cosmetic])).toEqual(before);
    expect(normalizeComparisonText("Cafe\u0301\r\n  meeting")).toBe("Café meeting");
  });
  it.each([
    ["meeting_time", { ...projection, meeting: { ...projection.meeting!, startsAt: "2026-10-05T09:30:00.000Z" } }],
    ["meeting_state", { ...projection, meeting: { ...projection.meeting!, status: "cancelled" as const } }],
    ["agenda", { ...projection, meeting: { ...projection.meeting!, agenda: [...projection.meeting!.agenda, "Security review"] } }],
    ["participants", { ...projection, meeting: { ...projection.meeting!, participantKeys: ["participant-a"] } }],
    ["facts", { ...projection, facts: [{ ...projection.facts[0], value: 200 }] }],
    ["commitments", { ...projection, commitments: [{ ...projection.commitments[0], value: "Owner prepares cost estimate" }] }],
  ] satisfies Array<[string, ComparisonProjection]>)("identifies exact %s changes", (category, changed) => {
    expect(changedComparisonCategories(comparisonDigests([projection]), comparisonDigests([changed]))).toEqual([category]);
  });
  it("binds each meeting's fields so swapping times between meetings is material", () => {
    const second = { ...projection, meeting: { ...projection.meeting!, key: "meeting-b", startsAt: "2026-10-05T11:00:00.000Z", endsAt: "2026-10-05T12:00:00.000Z" } };
    const swapped = [{ ...projection, meeting: { ...second.meeting, key: "meeting-a" } }, { ...second, meeting: { ...projection.meeting!, key: "meeting-b" } }];
    expect(changedComparisonCategories(comparisonDigests([projection, second]), comparisonDigests(swapped))).toEqual(["meeting_time"]);
  });
  it("does not collapse meaningful case or conflicting structured facts into equivalence", () => {
    expect(normalizeComparisonText("US")).not.toBe(normalizeComparisonText("us"));
    expect(() => comparisonDigests([{ ...projection, facts: [...projection.facts, { ...projection.facts[0], value: 200 }] }])).toThrow(/conflicting/);
    expect(() => comparisonDigests([{ ...projection, comparisonState: "unresolved" }])).toThrow(/deterministic/);
  });
});
