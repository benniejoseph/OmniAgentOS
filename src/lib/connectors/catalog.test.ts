import { describe, expect, it } from "vitest";
import { connectionCatalog } from "@/lib/connectors/catalog";

describe("connection catalog", () => {
  it("models Google personal sources as native read-only connectors", () => {
    const googleSources = connectionCatalog.filter((connector) =>
      ["gmail", "google-drive", "google-calendar"].includes(connector.id),
    );

    expect(googleSources).toHaveLength(3);
    expect(googleSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gmail", adapter: "native", riskLevel: 0 }),
        expect.objectContaining({ id: "google-drive", adapter: "native", riskLevel: 0 }),
        expect.objectContaining({ id: "google-calendar", adapter: "native", riskLevel: 0 }),
      ]),
    );
    expect(googleSources.every((connector) => connector.status === "ready")).toBe(true);
    expect(googleSources.every((connector) => !connector.approvalRequired)).toBe(true);
  });

  it("offers Browser Use Cloud through its official governed MCP endpoint", () => {
    const browserUse = connectionCatalog.find(
      (connector) => connector.id === "browser-automation",
    );

    expect(browserUse).toMatchObject({
      name: "Browser Use",
      adapter: "mcp",
      endpoint: "https://api.browser-use.com/v3/mcp",
      credentialMode: "app_vault",
      authHeaderName: "x-browser-use-api-key",
      riskLevel: 2,
      approvalRequired: false,
    });
  });
});
