import { describe, expect, it } from "vitest";
import {
  resolveToolAuthority,
  toolAuthorityApprovalReason,
  toolAuthorityDescription,
  toolAuthorityEventMetadata,
  type ToolAuthorityCandidate,
  type ToolAuthoritySource,
} from "@/lib/tools/authority";

const REVIEWED: ToolAuthoritySource[] = [
  "persisted_approval",
  "direct_user",
  "policy_lease",
  "plan_grant",
];
const STANDING: ToolAuthoritySource[] = ["standing_mandate", "task_authority"];

function resolve(
  candidates: readonly ToolAuthorityCandidate[],
  overrides: Partial<Parameters<typeof resolveToolAuthority>[0]> = {},
) {
  return resolveToolAuthority({
    approved: true,
    claimed: true,
    forcedReview: false,
    riskLevel: 2,
    risk3Quorum: false,
    candidates,
    ...overrides,
  });
}

describe("tool authority", () => {
  it.each(REVIEWED)("lets a reviewed %s run only with the caller's approval", (source) => {
    expect(resolve([{ source }])).toEqual({
      source,
      approved: true,
      reviewed: true,
      forcedReview: false,
    });
    expect(resolve([{ source }], { approved: false })).toEqual({
      approved: false,
      reviewed: false,
      forcedReview: false,
    });
  });

  it.each(STANDING)("lets a standing %s run without the caller's approval", (source) => {
    expect(resolve([{ source }], { approved: false })).toEqual({
      source,
      approved: true,
      reviewed: false,
      forcedReview: false,
    });
  });

  it.each([...REVIEWED, ...STANDING])(
    "refuses %s for an existing record the approval store has not claimed",
    (source) => {
      expect(resolve([{ source }], { claimed: false }).approved).toBe(false);
    },
  );

  it.each(REVIEWED)("lets a reviewed %s reach risk 3 only with a quorum", (source) => {
    expect(resolve([{ source }], { riskLevel: 3 }).approved).toBe(false);
    expect(resolve([{ source }], { riskLevel: 3, risk3Quorum: true }))
      .toMatchObject({ approved: true, source });
  });

  it.each(STANDING)("never lets a standing %s reach risk 3", (source) => {
    expect(resolve([{ source }], { riskLevel: 3, risk3Quorum: true }).approved)
      .toBe(false);
  });

  it("lets the owner's charter, but not task authority, satisfy a forced review", () => {
    expect(resolve([{ source: "task_authority" }], { forcedReview: true }))
      .toEqual({ approved: false, reviewed: false, forcedReview: true });
    expect(resolve([{ source: "standing_mandate" }], { forcedReview: true }))
      .toEqual({
        source: "standing_mandate",
        approved: true,
        reviewed: false,
        forcedReview: true,
      });
    expect(resolve([{ source: "plan_grant" }], { forcedReview: true }))
      .toMatchObject({ source: "plan_grant", forcedReview: true });
  });

  it("names the first authority in precedence order, whatever order it came in", () => {
    const all = [...STANDING, ...REVIEWED].reverse().map((source) => ({ source }));
    const expected: ToolAuthoritySource[] = [
      "persisted_approval",
      "direct_user",
      "policy_lease",
      "plan_grant",
      "standing_mandate",
      "task_authority",
    ];

    for (const source of expected) {
      const remaining = all.filter((item) =>
        expected.indexOf(item.source) >= expected.indexOf(source),
      );
      expect(resolve(remaining).source).toBe(source);
    }
    // An approval-free call skips the reviewed sources for the owner's charter.
    expect(resolve(all, { approved: false }).source).toBe("standing_mandate");
    // A forced review skips task authority to refuse the action.
    expect(
      resolve([{ source: "task_authority" }, { source: "direct_user" }], {
        approved: false,
        forcedReview: true,
      }).approved,
    ).toBe(false);
    expect(resolve([]).approved).toBe(false);
  });

  it("carries the binding it decided on, frozen", () => {
    const decision = resolve([
      { source: "task_authority" },
      {
        source: "plan_grant",
        bindingId: "grant:1",
        bindingSha256: "a".repeat(64),
        expiresAt: "2026-09-29T12:00:00.000Z",
      },
    ]);

    expect(decision).toEqual({
      source: "plan_grant",
      bindingId: "grant:1",
      bindingSha256: "a".repeat(64),
      expiresAt: "2026-09-29T12:00:00.000Z",
      approved: true,
      reviewed: true,
      forcedReview: false,
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(resolve([]))).toBe(true);
    expect(toolAuthorityEventMetadata(decision)).toEqual({
      source: "plan_grant",
      reviewed: true,
      forcedReview: false,
      bindingId: "grant:1",
      bindingSha256: "a".repeat(64),
      expiresAt: "2026-09-29T12:00:00.000Z",
    });
    expect(toolAuthorityEventMetadata(resolve([{ source: "direct_user" }])))
      .toStrictEqual({ source: "direct_user", reviewed: true, forcedReview: false });
    expect(toolAuthorityEventMetadata(
      resolve([{ source: "standing_mandate" }], { approved: false, forcedReview: true }),
    )).toStrictEqual({ source: "standing_mandate", reviewed: false, forcedReview: true });
    expect(toolAuthorityEventMetadata(resolve([]))).toBeUndefined();
  });

  it("records the reason of the authority that let the action run", () => {
    const leaseId = `policy_lease_${"b".repeat(48)}`;

    expect(toolAuthorityApprovalReason(
      resolve([{ source: "task_authority" }], { approved: false }),
      "Owner approved.",
    )).toBe(
      "The initiating user explicitly authorized this bounded Computer Use task; this safe visual interaction is covered by that task authority.",
    );
    expect(toolAuthorityApprovalReason(
      resolve([{ source: "standing_mandate" }], { approved: false }),
      "Owner approved.",
    )).toBe("Owner-enabled Moltbook autonomy charter authorized this bounded public action.");
    expect(toolAuthorityApprovalReason(
      resolve([{ source: "policy_lease", bindingId: leaseId }]),
      "Owner approved.",
    )).toBe(`Single-use schedule PolicyLease ${leaseId} fenced this exact reviewed effect.`);
    // A reviewed approval keeps its own reason over any standing authority.
    expect(toolAuthorityApprovalReason(
      resolve([{ source: "task_authority" }, { source: "persisted_approval" }]),
      "Owner approved.",
    )).toBe("Owner approved.");
    expect(toolAuthorityApprovalReason(resolve([]), "Owner approved."))
      .toBe("Owner approved.");
    expect(toolAuthorityApprovalReason(resolve([]), undefined)).toBeUndefined();
  });

  it("describes every authority for an operator", () => {
    const sources: ToolAuthoritySource[] = [...REVIEWED, ...STANDING];
    const descriptions = sources.map(toolAuthorityDescription);

    expect(new Set(descriptions).size).toBe(sources.length);
    expect(toolAuthorityDescription("task_authority"))
      .toBe("the user's This Mac task authority");
  });
});
