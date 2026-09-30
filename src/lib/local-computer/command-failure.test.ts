import { readFile } from "node:fs/promises";

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
    expect(message).toContain("was on top of the target");
    expect(message).toContain("Observe again before clicking.");
  });

  it("names any other failure by its code", () => {
    expect(localComputerCommandFailureMessage("helper_timeout")).toBe(
      "The installed Mac did not complete the action (helper_timeout).",
    );
    expect(localComputerCommandFailureMessage("expired")).toBe(
      "The installed Mac did not complete the action (expired).",
    );
  });

  it("is the message a failed command reports", async () => {
    const store = await readFile("src/lib/local-computer/store.ts", "utf8");

    expect(store).toContain(
      "const code = String(row.error_code || row.state);\n" +
        "      throw new LocalComputerCommandError(code, " +
        "localComputerCommandFailureMessage(code));",
    );
    expect(store).not.toContain("did not complete the action");
  });
});
