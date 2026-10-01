import { describe, expect, it } from "vitest";
import {
  catalogConnectorInstalled,
  isConnectorReviewable,
  mcpConnectorRow,
  quarantinedJobAction,
  quarantinedJobRow,
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
    ];

    expect(catalogConnectorInstalled({ id: "github" }, installed)).toBe(true);
    expect(catalogConnectorInstalled({ id: "slack" }, installed)).toBe(false);
  });
});

describe("quarantined job presentation", () => {
  it("shows a quarantined job with its attempts, lapses and ID", () => {
    expect(quarantinedJobRow({
      id: "job-7",
      type: "memory.index",
      attempt: 3,
      maxAttempts: 5,
      leaseLapses: 3,
      updatedAt: "2026-10-01T12:00:00.000Z",
    })).toEqual({
      title: "memory.index",
      status: "quarantined",
      meta: "attempt 3/5 · 3 lapsed leases · job-7",
      time: "2026-10-01T12:00:00.000Z",
      tone: "danger",
    });
    expect(quarantinedJobRow({ id: "job-8", leaseLapses: 1 }).meta)
      .toBe("attempt 0/? · 1 lapsed lease · job-8");
  });

  it("posts a release or discard decision to the job it names", () => {
    expect(quarantinedJobAction.buildPath?.({ jobId: " job/7 " }))
      .toBe("/api/operations/jobs/job%2F7");
    expect(() => quarantinedJobAction.buildPath?.({ jobId: " " }))
      .toThrow("Quarantined job ID is required.");
    expect(quarantinedJobAction.buildPayload?.({ action: "release", reason: "ignored" }))
      .toEqual({ action: "release", reason: undefined });
    expect(quarantinedJobAction.buildPayload?.({ action: "discard", reason: " poison input " }))
      .toEqual({ action: "discard", reason: "poison input" });
    expect(quarantinedJobAction.buildPayload?.({ action: "discard", reason: "" }))
      .toEqual({ action: "discard", reason: undefined });
  });
});
