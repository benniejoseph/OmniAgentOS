import { describe, expect, it } from "vitest";
import {
  canPerform,
  redactSensitive,
  validateConnectorSecretEnvName,
  validateSecretEnvName,
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

  it("redacts secret-shaped string values", () => {
    expect(redactSensitive("sk-abcdefghijklmnopqrstuvwxyz")).toBe("[redacted]");
    expect(redactSensitive("postgresql://user:pass@host:5432/db")).toBe("[redacted]");
    expect(redactSensitive("a plain sentence")).toBe("a plain sentence");
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

  it("treats empty values as valid (no secret configured)", () => {
    expect(validateConnectorSecretEnvName(undefined)).toBe(true);
  });
});
