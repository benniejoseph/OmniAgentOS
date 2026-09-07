import { describe, expect, it } from "vitest";
import { taskActionsFor } from "@/components/missions/mission-workspace";

describe("Mission WorkItem execution controls", () => {
  it("starts assigned work through the Agent and yields active status control", () => {
    const assigned = {
      status: "pending",
      metadata: { assigneeKey: "atlas" },
    } as never;

    expect(taskActionsFor("ready", assigned).map((action) => action.label))
      .toContain("Start assigned Agent");
    expect(taskActionsFor("ready", assigned, true)).toEqual([]);
    expect(taskActionsFor("working", assigned, true)).toEqual([]);
  });

  it("retains manual progress controls for unassigned human work", () => {
    const unassigned = {
      status: "running",
      metadata: {},
    } as never;

    expect(taskActionsFor("working", unassigned).map((action) => action.label))
      .toContain("Complete");
  });
});
