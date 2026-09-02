import { describe, expect, it } from "vitest";
import { jsonbSafeText } from "@/lib/rag/text-safety";

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
});
