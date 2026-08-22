import { describe, expect, it } from "vitest";
import { redactExactSecrets } from "@/lib/security/secret-redaction";

describe("exact connector secret redaction", () => {
  it("removes raw, encoded, and base64 secret reflections", () => {
    const secret = "opaque-secret-value-12345";
    const result = redactExactSecrets(
      {
        raw: `Bearer ${secret}`,
        encoded: encodeURIComponent(secret),
        base64: Buffer.from(secret).toString("base64"),
        safe: "visible",
      },
      [secret],
    );

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({
      raw: "Bearer [redacted-secret]",
      encoded: "[redacted-secret]",
      base64: "[redacted-secret]",
      safe: "visible",
    });
  });

  it("does not apply unsafe single-character replacements", () => {
    expect(redactExactSecrets("a normal sentence", ["a"])).toBe(
      "a normal sentence",
    );
  });
});
