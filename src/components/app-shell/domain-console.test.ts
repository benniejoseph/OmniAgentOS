import { describe, expect, it } from "vitest";
import {
  catalogConnectorInstalled,
  isConnectorReviewable,
  mcpConnectorRow,
} from "@/components/app-shell/domain-console";

describe("MCP connector presentation", () => {
  it("keeps a failed connector visibly errored even when stale contracts are pending", () => {
    const connector = {
      id: "failed-mcp",
      name: "Failed MCP",
      endpoint: "https://mcp.example.test/mcp",
      status: "error",
      review: {
        pendingCount: 2,
        contracts: [{ name: "old-tool" }, { name: "other-tool" }],
      },
    };

    expect(mcpConnectorRow(connector)).toMatchObject({
      title: "Failed MCP",
      status: "error",
      meta: "https://mcp.example.test/mcp",
      tone: "danger",
    });
    expect(isConnectorReviewable(connector)).toBe(false);
  });

  it("shows successful discoveries with pending contracts in the review queue", () => {
    const connector = {
      id: "ready-mcp",
      name: "Ready MCP",
      endpoint: "https://mcp.example.test/mcp",
      status: "active",
      review: {
        pendingCount: 1,
        contracts: [{ name: "query-docs" }],
      },
    };

    expect(mcpConnectorRow(connector)).toMatchObject({
      status: "review required",
      tone: "warning",
    });
    expect(isConnectorReviewable(connector)).toBe(true);
  });
});

describe("integration catalog presentation", () => {
  it("does not suggest connectors that are already installed", () => {
    const installed = [
      { id: "mcp-github", name: "GitHub", endpoint: "https://github.example/mcp" },
      { id: "mcp-browser", name: "Playwright", endpoint: "https://browser.example/mcp" },
    ];

    expect(catalogConnectorInstalled({ id: "github" }, installed)).toBe(true);
    expect(catalogConnectorInstalled({ id: "browser-automation" }, installed)).toBe(true);
    expect(catalogConnectorInstalled({ id: "slack" }, installed)).toBe(false);
  });
});
