import { describe, expect, it } from "vitest";
import { extractRedactedAccessibilitySnapshot } from "@/lib/browser/frames";

describe("browser accessibility snapshot redaction", () => {
  it("extracts a bounded Playwright page snapshot without page metadata", () => {
    const snapshot = extractRedactedAccessibilitySnapshot({
      result: {
        content: [{
          type: "text",
          text: [
            "### Page state",
            "- Page URL: https://example.test/private?token=hidden",
            "- Page Title: Account",
            "- Page Snapshot:",
            "```yaml",
            "- heading \"Account\" [level=1]",
            "- button \"Continue\" [ref=e7]",
            "```",
          ].join("\n"),
        }],
      },
    });

    expect(snapshot).toBe([
      "- heading \"Account\" [level=1]",
      "- button \"Continue\" [ref=e7]",
    ].join("\n"));
    expect(snapshot).not.toContain("token=hidden");
  });

  it("redacts sensitive controls, entered values, and credential-shaped text", () => {
    const snapshot = extractRedactedAccessibilitySnapshot({
      content: [{
        type: "text",
        text: [
          "- Page Snapshot:",
          "- textbox \"Password\" [ref=e1] value=correct-horse-battery-staple",
          "- textbox \"Search\" [ref=e2] value=quarterly-report",
          "- text: access_token=abcdefghijklmnopqrstuvwxyz123456",
        ].join("\n"),
      }],
    });

    expect(snapshot).toContain("[redacted sensitive control]");
    expect(snapshot).toContain("value=[redacted]");
    expect(snapshot).toContain("access_token=[redacted]");
    expect(snapshot).not.toContain("correct-horse");
    expect(snapshot).not.toContain("quarterly-report");
    expect(snapshot).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("rejects ordinary tool text that is not a structured snapshot", () => {
    expect(extractRedactedAccessibilitySnapshot({
      content: [{ type: "text", text: "Clicked the requested element." }],
    })).toBeUndefined();
  });
});
