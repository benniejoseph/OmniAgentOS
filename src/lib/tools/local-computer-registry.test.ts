import { describe, expect, it } from "vitest";

import { getGovernedTool } from "@/lib/tools/registry";

describe("local Mac browser navigation registry", () => {
  it("exposes one approval-gated Chrome HTTP(S) navigation contract", () => {
    const tool = getGovernedTool("local.macos.open_url");
    const properties = tool?.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;

    expect(tool).toMatchObject({
      status: "active",
      riskLevel: 2,
      approvalRequired: true,
      operationClass: "mutation",
      reversible: false,
    });
    expect(tool?.inputSchema.required).toEqual(["browser", "url"]);
    expect(properties?.browser).toMatchObject({
      type: "string",
      enum: ["chrome"],
    });
    expect(properties?.url).toMatchObject({
      type: "string",
      format: "uri",
      maxLength: 4_096,
    });
    expect(properties?.loadWaitSeconds).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 15,
      default: 3,
    });
    expect(tool?.description).toContain("does not claim that the page finished loading");
  });
});
