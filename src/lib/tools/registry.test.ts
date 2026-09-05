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
});
