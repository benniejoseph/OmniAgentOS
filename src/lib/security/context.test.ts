import { describe, expect, it } from "vitest";
import {
  canPerform,
  redactSensitive,
  validateConnectorSecretEnvName,
  validateSecretEnvName,
  validateTriggerSecretEnvName,
} from "@/lib/security/context";

describe("RBAC rules", () => {
  it("lets viewers read but not execute", () => {
    expect(canPerform("viewer", "read")).toBe(true);
    expect(canPerform("viewer", "execute.tool")).toBe(false);
    expect(canPerform("viewer", "run.agent")).toBe(false);
  });

  it("lets operators run agents and tools but not manage identity", () => {
    expect(canPerform("operator", "run.agent")).toBe(true);
    expect(canPerform("operator", "execute.tool")).toBe(true);
    expect(canPerform("operator", "manage.identity")).toBe(false);
  });

  it("denies unknown actions for every role", () => {
    expect(canPerform("admin", "not.a.real.action")).toBe(false);
    expect(canPerform("system", "not.a.real.action")).toBe(false);
  });

  it("reserves controlled security maintenance for the system role", () => {
    expect(canPerform("admin", "manage.security")).toBe(false);
    expect(canPerform("system", "manage.security")).toBe(true);
  });
});

describe("redactSensitive", () => {
  it("redacts secret-looking keys recursively", () => {
    const result = redactSensitive({
      apiKey: "sk-12345",
      nested: { authorization: "Bearer abc", safe: "visible" },
      list: [{ password: "hunter2" }],
    }) as Record<string, unknown>;

    expect(result.apiKey).toBe("[redacted]");
    expect((result.nested as Record<string, unknown>).authorization).toBe("[redacted]");
    expect((result.nested as Record<string, unknown>).safe).toBe("visible");
    expect(((result.list as unknown[])[0] as Record<string, unknown>).password).toBe("[redacted]");
  });

  it("preserves ordinary token accounting metadata", () => {
    expect(
      redactSensitive({
        maxTokens: 2_000,
        tokenCount: 120,
        inputTokens: 80,
        accessToken: "sensitive",
      }),
    ).toEqual({
      maxTokens: 2_000,
      tokenCount: 120,
      inputTokens: 80,
      accessToken: "[redacted]",
    });
  });

  it("redacts secret-shaped string values", () => {
    expect(redactSensitive("sk-abcdefghijklmnopqrstuvwxyz")).toBe("[redacted-api-key]");
    expect(redactSensitive("postgresql://user:pass@host:5432/db")).toBe("[redacted-connection-url]");
    expect(
      redactSensitive("Connector failed with Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
    ).toBe("Connector failed with Authorization: Bearer [redacted]");
    expect(redactSensitive("request password=super-secret-value failed")).toBe(
      "request password=[redacted] failed",
    );
    expect(redactSensitive("github_pat_abcdefghijklmnopqrstuvwxyz123456")).toBe(
      "[redacted-github-token]",
    );
    expect(redactSensitive("https://operator:super-secret@example.test/hook")).toBe(
      "[redacted-credential-url]",
    );
    expect(redactSensitive("a plain sentence")).toBe("a plain sentence");
  });

  it("bounds deeply nested and circular audit values", () => {
    const circular: Record<string, unknown> = { safe: "visible" };
    circular.self = circular;
    expect(redactSensitive(circular)).toEqual({
      safe: "visible",
      self: "[circular]",
    });

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 80; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(JSON.stringify(redactSensitive(deep))).toContain("[truncated-depth]");
  });
});

describe("connector secret env validation", () => {
  it("rejects platform secrets and public env names", () => {
    expect(validateConnectorSecretEnvName("OPENAI_API_KEY")).toBe(false);
    expect(validateConnectorSecretEnvName("DATABASE_URL")).toBe(false);
    expect(validateSecretEnvName("NEXT_PUBLIC_TOKEN")).toBe(false);
  });

  it("accepts the connector prefix", () => {
    expect(validateConnectorSecretEnvName("OMNIAGENT_CONNECTOR_GITHUB_TOKEN")).toBe(true);
  });

  it("rejects names outside the prefix and allowlist", () => {
    expect(validateConnectorSecretEnvName("MY_RANDOM_SECRET")).toBe(false);
  });

  it("keeps trigger HMAC keys separate from platform secrets", () => {
    expect(validateTriggerSecretEnvName("OMNIAGENT_TRIGGER_GITHUB")).toBe(true);
    expect(validateTriggerSecretEnvName("DATABASE_URL")).toBe(false);
    expect(validateTriggerSecretEnvName("OMNIAGENT_INTERNAL_AUTH_SECRET")).toBe(
      false,
    );
    expect(
      validateTriggerSecretEnvName("OMNIAGENT_TRIGGER_SECRET_ALLOWLIST"),
    ).toBe(false);
  });

  it("treats empty values as valid (no secret configured)", () => {
    expect(validateConnectorSecretEnvName(undefined)).toBe(true);
  });
});
