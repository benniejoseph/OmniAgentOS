import { describe, expect, it } from "vitest";
import {
  ConnectorInputValidationError,
  validateConnectorInput,
} from "@/lib/connectors/input-validation";

describe("connector input validation", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 20 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
  };

  it("accepts arguments that match the discovered contract", () => {
    expect(() =>
      validateConnectorInput(schema, { query: "status", limit: 3 }),
    ).not.toThrow();
  });

  it("rejects missing, mistyped, and undeclared arguments", () => {
    expect(() => validateConnectorInput(schema, { limit: 3 })).toThrow(
      ConnectorInputValidationError,
    );
    expect(() =>
      validateConnectorInput(schema, { query: "status", limit: "three" }),
    ).toThrow(ConnectorInputValidationError);
    expect(() =>
      validateConnectorInput(schema, { query: "status", unexpected: true }),
    ).toThrow(ConnectorInputValidationError);
  });

  it("fails closed for unresolved remote references", () => {
    expect(() =>
      validateConnectorInput(
        {
          type: "object",
          properties: {
            item: { $ref: "https://untrusted.example/schema.json" },
          },
        },
        { item: {} },
      ),
    ).toThrow(/not supported safely/i);
    expect(() =>
      validateConnectorInput(
        {
          type: "object",
          properties: { value: { type: "string", pattern: "(a+)+$" } },
        },
        { value: "a".repeat(100) },
      ),
    ).toThrow(/pattern.*not supported safely/i);
  });
});
