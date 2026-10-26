import { describe, expect, it } from "vitest";

import { getGovernedTool } from "@/lib/tools/registry";
import { localComputerOpenAsaelInputSchema } from "@/lib/local-computer/contracts";

describe("local Mac browser navigation registry", () => {
  it("exposes only fixed Asael destinations as a real governed UI mutation", () => {
    const tool = getGovernedTool("local.macos.open_asael");
    expect(tool).toMatchObject({ status: "active", riskLevel: 1, approvalRequired: false, operationClass: "mutation" });
    expect(tool?.inputSchema.required).toEqual(["destination"]);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect(tool?.inputSchema.properties).toEqual({ destination: {
      type: "string", enum: ["today", "assistant", "work", "library", "history", "watches"],
    } });
    expect(tool?.description).toContain("does not read its contents");
    expect(tool?.description).toContain("keeping an active voice conversation open");
    expect(tool?.description).toContain("v60 for Watches");
  });

  it("accepts the advertised Watches destination without granting arbitrary routes or approval authority", () => {
    expect(localComputerOpenAsaelInputSchema.safeParse({ destination: "watches" }).success).toBe(true);
    for (const input of [
      { destination: "/app/watches" }, { destination: "settings" }, { destination: "approvals" },
      { destination: "watches", approve: true }, { destination: "watches", route: "/app/improvement" },
    ]) expect(localComputerOpenAsaelInputSchema.safeParse(input).success).toBe(false);
  });

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
    expect(properties?.presentScreenshot).toMatchObject({
      type: "boolean",
      default: false,
      description: expect.stringContaining("explicit request"),
    });
    expect(tool?.description).toContain("fresh post-navigation screenshot");
    expect(tool?.description).toContain("does not claim that the page finished loading");
  });

  it("makes screenshot coordinates explicit and keeps element clicks preferred", () => {
    const observe = getGovernedTool("local.macos.observe");
    const click = getGovernedTool("local.macos.click");
    const properties = click?.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const alternatives = click?.inputSchema.oneOf as
      | Array<Record<string, unknown>>
      | undefined;

    expect(observe?.description).toContain("exact pixel width, height");
    expect(click?.description).toContain("Prefer elementId");
    expect(click?.description).toContain("upper-left corner");
    expect(click?.description).toContain("Never pass macOS global coordinates");
    expect(properties?.coordinateSpace).toMatchObject({
      type: "string",
      enum: ["screenshot_pixel"],
    });
    expect(alternatives).toHaveLength(2);
    expect(alternatives?.[1]).toMatchObject({
      required: ["coordinateSpace", "x", "y"],
      not: { required: ["elementId"] },
    });
  });
});
