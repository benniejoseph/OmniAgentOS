import { describe, expect, it } from "vitest";

import { getGovernedTool } from "@/lib/tools/registry";

describe("governed native tool schemas", () => {
  it("keeps memory.correct compatible with OpenAI function schemas", () => {
    const tool = getGovernedTool("memory.correct");

    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        confidence: { type: "number" },
        validTo: { type: "string" },
        contradiction: { type: "boolean" },
      },
    });
    expect(tool?.inputSchema).not.toHaveProperty("anyOf");
  });

  it("requires an exact deletion preview receipt before forgetting", () => {
    const preview = getGovernedTool("memory.forget.preview");
    const forget = getGovernedTool("memory.forget");

    expect(preview).toMatchObject({
      riskLevel: 0,
      approvalRequired: false,
      operationClass: "read_only",
    });
    expect(forget?.inputSchema).toMatchObject({
      required: ["id", "expectedReceiptManifestSha256"],
      properties: {
        id: { type: "string" },
        expectedReceiptManifestSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          pattern: "^[a-f0-9]{64}$",
        },
      },
    });
  });

  it("exposes inspect, lifecycle, and transcript-safe export controls", () => {
    expect(getGovernedTool("memory.inspect")).toMatchObject({
      riskLevel: 0,
      operationClass: "read_only",
    });
    expect(getGovernedTool("memory.lifecycle")).toMatchObject({
      riskLevel: 1,
      operationClass: "mutation",
      reversible: true,
    });
    expect(getGovernedTool("memory.export")).toMatchObject({
      riskLevel: 0,
      operationClass: "read_only",
    });
  });
});
