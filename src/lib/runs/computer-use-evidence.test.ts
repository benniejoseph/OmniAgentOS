import { describe, expect, it } from "vitest";
import {
  projectComputerUseEvidence,
} from "@/lib/runs/computer-use-evidence";
import type { BrowserActivityItem } from "@/lib/runs/activity";

describe("Computer Use evidence projection", () => {
  it("reconstructs a private frame route and drops connector-supplied paths", () => {
    const result = projectComputerUseEvidence("run-safe", [{
      id: "execution-safe",
      sequence: 7,
      at: "2026-09-16T10:00:00.000Z",
      action: "Open website",
      operation: "browser_navigate",
      status: "executed",
      targetOrigin: "https://example.com",
      summary: "Executed.",
      frame: {
        id: "frame-safe",
        at: "2026-09-16T10:00:00.000Z",
        mimeType: "image/png",
        byteCount: 2048,
        executionId: "execution-safe",
        operation: "browser_navigate",
        contentUrl: "https://untrusted.example/private.png",
      },
    }]);

    expect(result).toEqual([expect.objectContaining({
      executionId: "execution-safe",
      targetOrigin: "https://example.com",
      frame: expect.objectContaining({
        id: "frame-safe",
        filename: "computer-use-0007.png",
        contentUrl: "/api/runs/run-safe/activity/frames/frame-safe",
      }),
    })]);
    expect(JSON.stringify(result)).not.toContain("untrusted.example");
  });

  it("fails closed for invalid IDs, non-image frames, and credentialed origins", () => {
    const base: BrowserActivityItem = {
      id: "execution-safe",
      sequence: 1,
      at: "2026-09-16T10:00:00.000Z",
      action: "Read page",
      operation: "browser_snapshot",
      status: "executed",
      targetOrigin: "https://user:secret@example.com",
      summary: "Executed.",
      frame: {
        id: "frame-safe",
        at: "2026-09-16T10:00:00.000Z",
        mimeType: "image/png",
        byteCount: 64,
        executionId: "execution-safe",
        operation: "browser_snapshot",
        contentUrl: "/ignored",
      },
    };

    expect(projectComputerUseEvidence("run-safe", [base])[0]).not.toHaveProperty(
      "targetOrigin",
    );
    expect(projectComputerUseEvidence("../run", [base])).toEqual([]);
    expect(projectComputerUseEvidence("run-safe", [{
      ...base,
      frame: { ...base.frame!, mimeType: "text/html" },
    }])).toEqual([]);
  });
});
