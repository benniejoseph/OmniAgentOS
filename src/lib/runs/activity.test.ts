import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listStreamEvents: vi.fn(),
  getToolExecutionsByIds: vi.fn(),
  listMcpConnectors: vi.fn(),
  parseMcpToolId: vi.fn(),
  listRunBrowserFrames: vi.fn(),
  listRunBrowserAccessibilitySnapshots: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listStreamEvents,
}));

vi.mock("@/lib/tools/audit-store", () => ({
  getToolExecutionsByIds: mocks.getToolExecutionsByIds,
}));

vi.mock("@/lib/connectors/store", () => ({
  listMcpConnectors: mocks.listMcpConnectors,
  parseMcpToolId: mocks.parseMcpToolId,
}));

vi.mock("@/lib/browser/frames", () => ({
  listRunBrowserFrames: mocks.listRunBrowserFrames,
  listRunBrowserAccessibilitySnapshots:
    mocks.listRunBrowserAccessibilitySnapshots,
}));

import { listRunBrowserActivity } from "@/lib/runs/activity";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMcpConnectors.mockResolvedValue([{
    id: "connector-a",
    endpoint: "https://omniagent-os-browser.fly.dev/mcp",
  }]);
  mocks.parseMcpToolId.mockReturnValue({
    connectorId: "connector-a",
    toolName: "browser_click",
  });
});

describe("run browser activity observations", () => {
  it("joins owner-scoped frames and accessibility snapshots by execution", async () => {
    mocks.listStreamEvents.mockResolvedValue([{
      id: "event-a",
      seq: 42,
      type: "run.tool",
      at: "2026-09-07T00:00:00.000Z",
      payload: { executionId: "execution-a" },
    }]);
    mocks.getToolExecutionsByIds.mockResolvedValue([{
      id: "execution-a",
      actorId: "actor-a",
      toolId: "mcp-tool-a",
      status: "executed",
      input: {},
      createdAt: "2026-09-07T00:00:00.000Z",
      completedAt: "2026-09-07T00:00:01.000Z",
    }]);
    mocks.listRunBrowserFrames.mockResolvedValue([{
      id: "frame-a",
      at: "2026-09-07T00:00:01.000Z",
      mimeType: "image/webp",
      byteCount: 128,
      executionId: "execution-a",
      operation: "browser_click",
    }]);
    mocks.listRunBrowserAccessibilitySnapshots.mockResolvedValue([{
      id: "snapshot-a",
      at: "2026-09-07T00:00:01.000Z",
      mimeType: "text/plain",
      byteCount: 64,
      contentSha256: "a".repeat(64),
      executionId: "execution-a",
      operation: "browser_click",
    }]);

    const [activity] = await listRunBrowserActivity("run-a", {
      tenantId: "tenant-a",
      actorId: "actor-a",
    });

    expect(activity).toMatchObject({
      id: "execution-a",
      frameStatus: "captured",
      accessibilitySnapshotStatus: "captured",
      frame: {
        id: "frame-a",
        contentUrl: "/api/runs/run-a/activity/frames/frame-a",
      },
      accessibilitySnapshot: {
        id: "snapshot-a",
        contentUrl: "/api/runs/run-a/activity/snapshots/snapshot-a",
      },
    });
  });

  it("projects sensitive-entry suppression without exposing captured content", async () => {
    mocks.listStreamEvents.mockResolvedValue([
      {
        id: "event-a",
        seq: 42,
        type: "run.tool",
        at: "2026-09-07T00:00:00.000Z",
        payload: { executionId: "execution-a" },
      },
      {
        id: "event-b",
        seq: 43,
        type: "browser.frame.suppressed",
        at: "2026-09-07T00:00:01.000Z",
        payload: { executionId: "execution-a" },
      },
      {
        id: "event-c",
        seq: 44,
        type: "browser.snapshot.suppressed",
        at: "2026-09-07T00:00:01.000Z",
        payload: { executionId: "execution-a" },
      },
    ]);
    mocks.getToolExecutionsByIds.mockResolvedValue([{
      id: "execution-a",
      actorId: "actor-a",
      toolId: "mcp-tool-a",
      status: "executed",
      input: {},
      createdAt: "2026-09-07T00:00:00.000Z",
      completedAt: "2026-09-07T00:00:01.000Z",
    }]);
    mocks.listRunBrowserFrames.mockResolvedValue([]);
    mocks.listRunBrowserAccessibilitySnapshots.mockResolvedValue([]);

    const [activity] = await listRunBrowserActivity("run-a", {
      tenantId: "tenant-a",
      actorId: "actor-a",
    });

    expect(activity).toMatchObject({
      frameStatus: "suppressed",
      accessibilitySnapshotStatus: "suppressed",
    });
    expect(activity.frame).toBeUndefined();
    expect(activity.accessibilitySnapshot).toBeUndefined();
  });
});
