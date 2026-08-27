import { describe, expect, it } from "vitest";
import {
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
