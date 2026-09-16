import { describe, expect, it, vi } from "vitest";

import { startProgressiveThreadLoad } from "@/lib/command/progressive-thread-load";

describe("progressive Command conversation loading", () => {
  it("publishes the conversation before its latest run finishes loading", async () => {
    let finishRun!: (value: { id: string }) => void;
    const run = new Promise<{ id: string }>((resolve) => {
      finishRun = resolve;
    });
    const events: string[] = [];
    const controller = new AbortController();

    await startProgressiveThreadLoad({
      readThread: async () => ({ id: "thread-one", latestRunId: "run-one" }),
      latestRunId: (thread) => thread.latestRunId,
      readRun: async () => run,
      isCurrent: () => true,
      onThreadReady: () => events.push("thread"),
      onRunReady: () => events.push("run"),
      signal: controller.signal,
    });

    expect(events).toEqual(["thread"]);
    finishRun({ id: "run-one" });
    await vi.waitFor(() => expect(events).toEqual(["thread", "run"]));
  });

  it("discards a late run after the selected conversation changes", async () => {
    let current = true;
    let finishRun!: (value: { id: string }) => void;
    const run = new Promise<{ id: string }>((resolve) => {
      finishRun = resolve;
    });
    const onRunReady = vi.fn();

    await startProgressiveThreadLoad({
      readThread: async () => ({ latestRunId: "run-one" }),
      latestRunId: (thread) => thread.latestRunId,
      readRun: async () => run,
      isCurrent: () => current,
      onThreadReady: () => undefined,
      onRunReady,
      signal: new AbortController().signal,
    });
    current = false;
    finishRun({ id: "run-one" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onRunReady).not.toHaveBeenCalled();
  });
});
