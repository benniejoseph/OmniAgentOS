import { describe, expect, it } from "vitest";
import { cognitionDecisionBody, cognitionQuery } from "./native-http";
describe("native source-map strict ingress", () => {
  it("rejects repeated and unadvertised query inputs", () => {
    expect(() => cognitionQuery(new Request("https://example.test/reviews?limit=1&limit=2"), ["limit"])).toThrow();
    expect(() => cognitionQuery(new Request("https://example.test/reviews?id=other"))).toThrow();
    expect(cognitionQuery(new Request("https://example.test/reviews?status=pending_review&limit=25"), ["status","limit"]))
      .toEqual({ status: "pending_review", limit: "25" });
  });
  it("bounds actual UTF-8 bytes before parsing a decision", async () => {
    await expect(cognitionDecisionBody(new Request("https://example.test/reviews", { method: "PATCH", body: JSON.stringify({ text: "界".repeat(5500) }) })))
      .rejects.toMatchObject({ status: 413 });
    await expect(cognitionDecisionBody(new Request("https://example.test/reviews", { method: "PATCH", body: "{" })))
      .rejects.toMatchObject({ status: 400 });
  });
});
