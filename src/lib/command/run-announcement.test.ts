import { describe, expect, it } from "vitest";
import { runStreamAnnouncement } from "@/lib/command/run-announcement";

describe("what a run's stream announces", () => {
  it("announces each change of phase", () => {
    expect(runStreamAnnouncement({ type: "delegated" }))
      .toBe("Task moved to a durable background workflow.");
    expect(runStreamAnnouncement({ type: "clarification" }))
      .toBe("The agent needs an exact target before it can continue.");
    expect(runStreamAnnouncement({ type: "waiting_approval", message: "Waiting for approval: email.send" }))
      .toBe("Agent run paused for approval.");
    expect(runStreamAnnouncement({ type: "done" }))
      .toBe("Agent run completed. Review the result and evidence.");
    expect(runStreamAnnouncement({ type: "error", message: "The model is unavailable." }))
      .toBe("Agent run failed.");
  });

  it("says why a run stopped, when the stream says", () => {
    expect(runStreamAnnouncement({ type: "canceled", message: "Stopped from another tab." }))
      .toBe("Stopped from another tab.");
    expect(runStreamAnnouncement({ type: "canceled" })).toBe("Agent run stopped.");
    expect(runStreamAnnouncement({ type: "canceled", message: "" })).toBe("Agent run stopped.");
  });

  it("says nothing for the steps between phases", () => {
    for (const type of [
      "status",
      "run",
      "delta",
      "model",
      "tool",
      "memory",
      "harness",
      "council_member",
      "council_verdict",
      "model_route_degraded",
      // An error event follows, and announces the failure.
      "budget_exhausted",
    ]) {
      expect(runStreamAnnouncement({ type, message: "Reading the inbox." })).toBeUndefined();
    }
  });
});
