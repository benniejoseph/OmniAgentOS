import { describe, expect, it } from "vitest";
import {
  workflowControlRunsFrom,
  workflowControlSignals,
} from "@/lib/workflows/client-controls";

describe("workflowControlSignals", () => {
  it("does not offer pause while a workflow waits for approval", () => {
    expect(workflowControlSignals("waiting_approval")).toEqual([
      "approve",
      "cancel",
    ]);
  });

  it.each([
    ["queued", ["pause", "cancel"]],
    ["running", ["pause", "cancel"]],
    ["paused", ["resume", "cancel"]],
    ["failed", ["retry"]],
    ["completed", []],
    ["canceled", []],
  ] as const)("maps %s to its valid controls", (status, signals) => {
    expect(workflowControlSignals(status)).toEqual(signals);
  });
});

describe("workflowControlRunsFrom", () => {
  it("keeps only runs with a recognized status and usable id", () => {
    expect(
      workflowControlRunsFrom([
        { id: "run-1", goal: "Review release", status: "waiting_approval" },
        { id: "", goal: "Missing id", status: "queued" },
        { id: "run-2", goal: "Unknown", status: "mystery" },
      ]),
    ).toEqual([
      { id: "run-1", goal: "Review release", status: "waiting_approval" },
    ]);
  });
});
