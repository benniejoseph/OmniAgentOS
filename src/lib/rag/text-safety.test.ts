import { describe, expect, it } from "vitest";
import {
  jsonbSafeStringify,
  jsonbSafeText,
  jsonbSafeTruncate,
} from "@/lib/rag/text-safety";

describe("jsonbSafeText", () => {
  it("replaces PostgreSQL jsonb-incompatible code units", () => {
    expect(jsonbSafeText("before\u0000after\ud800middle\udc00end")).toBe(
      "before\uFFFDafter\uFFFDmiddle\uFFFDend",
    );
  });

  it("preserves valid Unicode surrogate pairs", () => {
    expect(jsonbSafeText("Email update 🚀 complete")).toBe(
      "Email update 🚀 complete",
    );
  });

  it("does not split an emoji at a bounded graph-summary boundary", () => {
    const content = `${"a".repeat(359)}🚀 after`;
    const summary = jsonbSafeTruncate(content, 360);

    expect(summary).toBe("a".repeat(359));
    expect(jsonbSafeStringify({ summary })).toBe(
      JSON.stringify({ summary: "a".repeat(359) }),
    );
  });

  it("normalizes nested strings at the jsonb serialization boundary", () => {
    expect(jsonbSafeStringify({ summary: "before\ud800after" })).toBe(
      JSON.stringify({ summary: "before\uFFFDafter" }),
    );
  });
});
