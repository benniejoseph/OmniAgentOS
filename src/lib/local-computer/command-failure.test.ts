import { describe, expect, it } from "vitest";

import { localComputerCommandFailureMessage } from "@/lib/local-computer/command-failure";

describe("local computer command failures", () => {
  it("tells the run that typing stopped partway and to observe first", () => {
    const message = localComputerCommandFailureMessage("typing_interrupted");

    expect(message).toContain("(typing_interrupted)");
    expect(message).toContain("part of the text may already be typed");
    expect(message).toContain("Observe before typing again.");
  });

  it("tells the run that a covered target was not clicked", () => {
    const message = localComputerCommandFailureMessage("click_target_covered");

    expect(message).toContain("did not click (click_target_covered)");
    expect(message).toContain("target was not verified");
    expect(message).toContain("Observe again");
    expect(message).not.toContain("was on top of the target");
  });

  it("names any other failure by its code", () => {
    expect(localComputerCommandFailureMessage("helper_timeout")).toBe(
      "The installed Mac did not complete the action (helper_timeout).",
    );
    expect(localComputerCommandFailureMessage("expired")).toBe(
      "The installed Mac did not complete the action (expired).",
    );
  });

  it("tells a phone run to observe an indeterminate action without replaying it", () => {
    const message = localComputerCommandFailureMessage("execution_indeterminate", "android");

    expect(message).toBe("The phone action may already have happened. Observe the current screen; this action will not be replayed automatically.");
    expect(message).not.toContain("Mac");
  });

});
