import { describe, expect, it } from "vitest";
import { changedComparisonCategories, comparisonDigests, normalizeComparisonText, RESPONSIBILITY_MEETING_COMPARISON_POLICY, RESPONSIBILITY_WORK_ITEM_COMPARISON_POLICY, type ComparisonProjection } from "./comparison-policy";
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

describe("existing WorkItem comparison with explicit commitment metadata", () => {
  const legacy: ComparisonProjection = { comparisonState: "deterministic", meeting: null, facts: [], commitments: [], uninterpretedText: [],
    workItem: { key: "work-a", canonicalStatus: "waiting", sourceStatus: "open", dueAt: null, overdue: false, priority: "high",
      ownerActorIds: ["actor-a"], dependencies: [], outputReferences: [], evidenceIds: ["evidence-a"] } };

  it("preserves the deployed reviewed policy and legacy baseline digest when no new metadata exists", () => {
    expect(RESPONSIBILITY_WORK_ITEM_COMPARISON_POLICY.policySha256).toBe("0d72f2f1e9c827a2d33fdf0efd3d3b48f65e4399c2722cbb6255286dfb0bc96e");
    expect(comparisonDigests([legacy])).toMatchObject({
      work_deadline: "3dbb446672ffc67a061983bd150e32566667f3a1bffc5e568a33f63374ec160d",
      work_owners: "2038ef01aa1ba7f1bbb2bbb627f6ed5930d7173c3a6e23edd0a7fac056088192",
      semanticSha256: "98fce7932ad7d616bd5af97f42134336740aab3c1411bb5476ef9554734682fe",
    });
  });

  it("compares a named human owner separately from the unchanged authenticated owner", () => {
    const named: ComparisonProjection = { ...legacy, workItem: { ...legacy.workItem!, humanOwner: "Elena Ruiz" } };
    expect(changedComparisonCategories(comparisonDigests([legacy]), comparisonDigests([named]))).toEqual(["work_owners"]);
    expect(changedComparisonCategories(comparisonDigests([named]), comparisonDigests([
      { ...named, workItem: { ...named.workItem!, humanOwner: "Elena   Ruiz" } },
    ]))).toEqual([]);
    expect(changedComparisonCategories(comparisonDigests([named]), comparisonDigests([legacy]))).toEqual(["work_owners"]);
    expect(named.workItem?.ownerActorIds).toEqual(["actor-a"]);
  });

  it("compares calendar dates and explicit zones without equating them to a manufactured instant", () => {
    const dated: ComparisonProjection = { ...legacy, workItem: { ...legacy.workItem!, dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata", deadlineState: "date_only" } };
    const unknownZone: ComparisonProjection = { ...dated, workItem: { ...dated.workItem!, dueTimeZone: null, deadlineState: "date_only_timezone_unknown", overdue: null } };
    expect(changedComparisonCategories(comparisonDigests([legacy]), comparisonDigests([dated]))).toEqual(["work_deadline"]);
    expect(changedComparisonCategories(comparisonDigests([dated]), comparisonDigests([unknownZone]))).toEqual(["work_deadline", "work_overdue"]);
    expect(() => comparisonDigests([{ ...dated, workItem: { ...dated.workItem!, dueAt: "2026-10-17T00:00:00.000Z" } }])).toThrow();
    expect(() => comparisonDigests([{ ...legacy, workItem: { ...legacy.workItem!, overdue: null } }])).toThrow();
    expect(() => comparisonDigests([{ ...dated, workItem: { ...dated.workItem!, dueDate: "2026-02-30" } }])).toThrow();
  });
});
