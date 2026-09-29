import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  processDurableSpecialistQueue: vi.fn(async () => undefined),
  drainWorkflowQueue: vi.fn(async () => undefined),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));
vi.mock("@/lib/subagents/worker", () => ({
  DURABLE_SPECIALIST_BUDGET_MS: 240_000,
  processDurableSpecialistQueue: mocks.processDurableSpecialistQueue,
}));
vi.mock("@/lib/workflows/queue", () => ({
  drainWorkflowQueue: mocks.drainWorkflowQueue,
}));

import { runWithRequestTiming } from "@/lib/observability/request-timing";
import { scheduleDurableSpecialistDrain } from "@/lib/subagents/scheduler";

const scheduledAt = Date.parse("2026-09-30T12:00:00.000Z");

describe("durable specialist drain after a response", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(scheduledAt);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [50_000, true],
    [50_001, false],
  ])("after %i ms of a 300 second route, starts specialists: %s", async (
    elapsedMs,
    startsSpecialists,
  ) => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1_000).mockReturnValue(1_000 + elapsedMs);
    try {
      await runWithRequestTiming(() =>
        scheduleDurableSpecialistDrain("tenant-specialists", 2, {
          routeMaxDurationSeconds: 300,
        }),
      );
    } finally {
      now.mockRestore();
    }
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();

    // The route's 300 seconds, less the time already spent and a 10 second margin.
    const deadlineAt = scheduledAt + 290_000 - elapsedMs;
    expect(mocks.processDurableSpecialistQueue.mock.calls).toEqual(
      startsSpecialists
        ? [[{ tenantId: "tenant-specialists", limit: 2, deadline: deadlineAt }]]
        : [],
    );
    expect(mocks.drainWorkflowQueue.mock.calls).toEqual([
      [{ tenantId: "tenant-specialists", limit: 1, deadlineAt }],
    ]);
  });
});
