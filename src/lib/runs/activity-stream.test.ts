import { describe, expect, it } from "vitest";
import {
  buildBrowserActivityStreamSnapshot,
  encodeBrowserActivitySse,
} from "@/lib/runs/activity-stream";

describe("browser activity stream contract", () => {
  it("labels active runs live and terminal runs replay", () => {
    const live = buildBrowserActivityStreamSnapshot({
      runId: "run-a",
      runStatus: "waiting_approval",
      browserActivity: [],
      generatedAt: "2026-09-07T00:00:00.000Z",
    });
    const replay = buildBrowserActivityStreamSnapshot({
      runId: "run-a",
      runStatus: "completed",
      browserActivity: [],
      generatedAt: "2026-09-07T00:00:01.000Z",
    });

    expect(live.mode).toBe("live");
    expect(replay.mode).toBe("replay");
    expect(live.revision).not.toBe(replay.revision);
  });

  it("keeps a stable revision across transport timestamps", () => {
    const first = buildBrowserActivityStreamSnapshot({
      runId: "run-a",
      runStatus: "running",
      browserActivity: [],
      generatedAt: "2026-09-07T00:00:00.000Z",
    });
    const second = buildBrowserActivityStreamSnapshot({
      runId: "run-a",
      runStatus: "running",
      browserActivity: [],
      generatedAt: "2026-09-07T00:00:10.000Z",
    });

    expect(second.revision).toBe(first.revision);
    expect(encodeBrowserActivitySse(first)).toContain(`id: ${first.revision}`);
    expect(encodeBrowserActivitySse(first)).toContain("event: browser_activity");
  });
});
