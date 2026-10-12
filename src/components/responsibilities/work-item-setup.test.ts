import { describe, expect, it } from "vitest";
import { emptyDraft, sourceKey, workItemTrackingDraft, WORK_ITEM_PROCEDURE } from "./model";
import { source, validDraft } from "./client";
import { responsibilityDraftSchema } from "@/lib/responsibilities/contracts";
import { incompleteDraft } from "@/lib/responsibilities/state";

const work = { workspaceId: "workspace:owner", projectId: "project-a", workItemId: "work-a" };
describe("work-item tracking setup", () => {
  it("creates a bounded, valid inactive draft without inventing saved memory", () => {
    const draft = workItemTrackingDraft({ ...emptyDraft(), work }, "Finish proposal", new Date("2026-10-12T10:03:45Z"));
    expect(draft).toMatchObject({ procedureId: WORK_ITEM_PROCEDURE, agentId: "atlas",
      sources: [{ kind: "work_item", id: work.workItemId, workspaceId: work.workspaceId, projectId: work.projectId }],
      cadence: { startsAt: "2026-10-12T10:03:00.000Z", expiresAt: "2026-10-19T10:03:00.000Z" },
      limits: { maxChecks: 7, maxNotifications: 7, cumulative: { modelTurns: 0, costMicrousd: 0 } } });
    expect(validDraft(draft)).toBe(true);
    expect(responsibilityDraftSchema.safeParse(draft).success).toBe(true);
    expect(incompleteDraft(draft, "2026-10-12T10:03:45.000Z")).toEqual([]);
    expect(draft.successCondition).toContain("do not verify");
  });
  it("preserves chosen intent, schedule and limits, and requires a selected work item", () => {
    const empty = emptyDraft(); expect(workItemTrackingDraft(empty, "")).toBe(empty);
    const first = workItemTrackingDraft({ ...empty, work }, "task");
    const next = workItemTrackingDraft({ ...first, purpose: "My commitment", cadence: { ...first.cadence!, interval: 2 },
      limits: { ...first.limits!, maxChecks: 3 } }, "renamed");
    expect(next.purpose).toBe("My commitment"); expect(next.cadence!.interval).toBe(2); expect(next.limits!.maxChecks).toBe(3);
  });
  it("keeps project scope in source identity and rejects incomplete sources", () => {
    const ref = { kind: "work_item" as const, id: work.workItemId, workspaceId: work.workspaceId, projectId: work.projectId };
    expect(source(ref)).toBe(true); expect(source({ ...ref, projectId: undefined })).toBe(false);
    expect(sourceKey(ref)).not.toBe(sourceKey({ ...ref, projectId: "other" }));
  });
});
