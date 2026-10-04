import { describe, expect, it } from "vitest";
import { sourceDeletionBody, sourceDeletionFailure, sourceDeletionQuery } from "./native-http";
describe("native local source deletion HTTP bounds", () => {
  it("rejects hidden query selection and counts actual UTF-8 bytes", async () => {
    expect(() => sourceDeletionQuery(new Request("https://asael.test/api/knowledge/sources/mail?source=google%3A"))).toThrow();
    const error = await sourceDeletionBody(new Request("https://asael.test", { method: "DELETE", body: JSON.stringify({ text: "é".repeat(5000) }) })).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 413 });
    expect(sourceDeletionFailure(error).headers.get("cache-control")).toBe("private, no-store");
  });
  it("keeps uncertain failures explicit and private without exposing their internals", async () => {
    const response = sourceDeletionFailure(new Error("database connection details"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Local source deletion could not be confirmed. Read its exact acceptance before another request.", code: "knowledge_source_unavailable" });
  });
});
