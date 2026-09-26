import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRunTerminatedError,
  createAgentRunCancellationWatch,
} from "@/lib/runs/cancellation";
import type { RunStatus } from "@/lib/runs/types";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function statusSequence(...statuses: Array<RunStatus | undefined | Error>) {
  const calls: Array<{ runId: string; tenantId?: string }> = [];
  let index = 0;
  const readStatus = async (input: { runId: string; tenantId?: string }) => {
    calls.push(input);
    const next = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, readStatus };
}

describe("agent run cancellation watch", () => {
  it("aborts with the terminated run once another request cancels it", async () => {
    const { calls, readStatus } = statusSequence("running", "resuming", "canceled");
    const watch = createAgentRunCancellationWatch({ intervalMs: 50, readStatus });
    watch.watch({ runId: "run-a", tenantId: "tenant-a" });

    await vi.advanceTimersByTimeAsync(100);
    expect(watch.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(50);

    expect(watch.signal.aborted).toBe(true);
    expect(watch.signal.reason).toBeInstanceOf(AgentRunTerminatedError);
    expect(watch.signal.reason).toMatchObject({
      code: "agent_run_terminated",
      runId: "run-a",
      runStatus: "canceled",
    });
    expect(calls).toEqual([
      { runId: "run-a", tenantId: "tenant-a" },
      { runId: "run-a", tenantId: "tenant-a" },
      { runId: "run-a", tenantId: "tenant-a" },
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(3);
  });

  it.each(["completed", "failed"] as const)(
    "stops polling without aborting when the run is %s",
    async (finalStatus) => {
      const { calls, readStatus } = statusSequence("running", finalStatus, "canceled");
      const watch = createAgentRunCancellationWatch({ intervalMs: 50, readStatus });
      watch.watch({ runId: "run-b" });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(watch.signal.aborted).toBe(false);
      expect(calls).toHaveLength(2);
    },
  );

  it("keeps polling through read errors and a missing row", async () => {
    const { calls, readStatus } = statusSequence(
      new Error("database unavailable"),
      undefined,
      "waiting_approval",
      "canceled",
    );
    const watch = createAgentRunCancellationWatch({ intervalMs: 50, readStatus });
    watch.watch({ runId: "run-c" });

    await vi.advanceTimersByTimeAsync(150);
    expect(watch.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(4);
    expect(watch.signal.aborted).toBe(true);
  });

  it("does not poll before watch, honors only the first watch, and stops for good", async () => {
    const { calls, readStatus } = statusSequence("running");
    const watch = createAgentRunCancellationWatch({ intervalMs: 50, readStatus });

    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0);

    watch.watch({ runId: "run-d" });
    watch.watch({ runId: "run-other" });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.map((call) => call.runId)).toEqual(["run-d", "run-d"]);

    watch.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    expect(watch.signal.aborted).toBe(false);

    watch.watch({ runId: "run-after-stop" });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
  });

  it("ignores a cancel that is read after the watch stopped", async () => {
    let release: ((status: RunStatus) => void) | undefined;
    const watch = createAgentRunCancellationWatch({
      intervalMs: 50,
      readStatus: () => new Promise<RunStatus>((resolve) => {
        release = resolve;
      }),
    });
    watch.watch({ runId: "run-e" });
    await vi.advanceTimersByTimeAsync(50);
    expect(release).toBeDefined();

    watch.stop();
    release?.("canceled");
    await vi.advanceTimersByTimeAsync(0);

    expect(watch.signal.aborted).toBe(false);
  });
});
