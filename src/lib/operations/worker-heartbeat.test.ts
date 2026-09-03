import { describe, expect, it } from "vitest";
import {
  selectLatestWorkerHeartbeats,
  type WorkerHeartbeat,
} from "@/lib/operations/worker-heartbeat";

describe("worker heartbeat selection", () => {
  it("ignores a newer delayed heartbeat from the replaced worker", () => {
    const currentTarget = "https://omniagent-current.vercel.app";
    const candidates: WorkerHeartbeat[] = [
      heartbeat({
        instanceId: "replacement",
        revision: "current-release",
        target: currentTarget,
        recordedAt: "2026-08-26T16:52:56.000Z",
      }),
      heartbeat({
        instanceId: "replaced",
        revision: "old-release",
        target: "https://asael.bennierichard.com",
        recordedAt: "2026-08-26T16:53:25.000Z",
      }),
    ];

    expect(selectLatestWorkerHeartbeats(candidates, {
      protocol: "1",
      revision: "current-release",
      target: `${currentTarget}/`,
    })).toEqual([candidates[0]]);
  });

  it("returns the newest matching heartbeat for each lane", () => {
    const candidates: WorkerHeartbeat[] = [
      heartbeat({ recordedAt: "2026-08-26T16:52:00.000Z" }),
      heartbeat({ recordedAt: "2026-08-26T16:54:00.000Z" }),
      heartbeat({
        lane: "background",
        recordedAt: "2026-08-26T16:53:00.000Z",
      }),
    ];

    expect(selectLatestWorkerHeartbeats(candidates, {
      protocol: "1",
      revision: "current-release",
      target: "https://omniagent-current.vercel.app",
    })).toEqual([candidates[1], candidates[2]]);
  });

  it("fails closed when the requested target is invalid", () => {
    const candidate = heartbeat({});

    expect(selectLatestWorkerHeartbeats([candidate], {
      target: "not-a-valid-origin",
    })).toEqual([]);
  });
});

function heartbeat(
  overrides: Partial<WorkerHeartbeat>,
): WorkerHeartbeat {
  return {
    instanceId: "current-worker",
    lane: "fast",
    phase: "active",
    protocol: "1",
    revision: "current-release",
    target: "https://omniagent-current.vercel.app",
    recordedAt: "2026-08-26T16:52:00.000Z",
    ...overrides,
  };
}
