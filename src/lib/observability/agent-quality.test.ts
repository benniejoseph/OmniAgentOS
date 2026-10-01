import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("@/lib/observability/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/store")>()),
  recordRuntimeEventSafely: mocks.record,
}));

const { firstOutputTimer, getAgentQualityStats } = await import(
  "@/lib/observability/agent-quality"
);

afterEach(() => {
  mocks.record.mockReset();
  vi.unstubAllEnvs();
});

function timer(now: () => number) {
  return firstOutputTimer({
    tenantId: "tenant-a",
    actorId: "actor-a",
    correlationId: "req-1",
    receivedAtMs: 400,
    now,
  });
}

describe("timing an agent reply's first output", () => {
  it("records once how long the request waited for the first text", async () => {
    let finish!: () => void;
    mocks.record.mockReturnValue(new Promise<void>((resolve) => {
      finish = resolve;
    }));
    let nowMs = 1_000;
    const firstOutput = timer(() => nowMs);

    await firstOutput.settled();
    firstOutput.observe({ type: "status", label: "Thinking" });
    firstOutput.observe({ type: "delta", text: "" });
    expect(mocks.record).not.toHaveBeenCalled();
    nowMs = 1_750;
    firstOutput.observe({ type: "delta", text: "Hello" });
    nowMs = 9_000;
    firstOutput.observe({ type: "delta", text: " there" });

    expect(mocks.record.mock.calls).toEqual([[{
      category: "api",
      action: "agent.first_output",
      route: "/api/agent",
      method: "POST",
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "req-1",
      durationMs: 1_350,
      message: "Streamed the first text of an agent reply.",
      metadata: { sloExcluded: true },
    }]]);
    let settled = false;
    const settling = firstOutput.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    finish();
    await settling;
    expect(settled).toBe(true);
  });

  it("never records a negative wait", () => {
    mocks.record.mockResolvedValue(undefined);
    timer(() => 100).observe({ type: "delta", text: "Hello" });

    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 0 }));
  });
});

describe("reading agent quality", () => {
  it("counts nothing without a database", async () => {
    vi.stubEnv("DATABASE_URL", "");

    await expect(getAgentQualityStats({ tenantId: "tenant-a", since: new Date(0) }))
      .resolves.toEqual({
        runs: { finished: 0, completed: 0, successRate: 1, costPerRunUsd: 0 },
        tools: { finished: 0, failed: 0, failureRate: 0 },
        approvals: { decided: 0, latencyP95Ms: 0 },
      });
  });

  it("turns the database's counts into rates, dollars and whole milliseconds", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://quality.test/asael");
    const query = vi.fn(async () => [{
      finished_runs: 8,
      completed_runs: 6,
      average_run_cost_microusd: 125_000,
      finished_tools: 40,
      failed_tools: 3,
      decided_approvals: 5,
      approval_latency_p95_ms: 61_234.6,
    }]);
    const since = new Date("2026-09-30T00:00:00.000Z");

    await expect(getAgentQualityStats({
      tenantId: "tenant-a",
      since,
      sql: { query } as never,
    })).resolves.toEqual({
      runs: { finished: 8, completed: 6, successRate: 0.75, costPerRunUsd: 0.125 },
      tools: { finished: 40, failed: 3, failureRate: 0.075 },
      approvals: { decided: 5, latencyP95Ms: 61_235 },
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), ["tenant-a", since]);
  });
});
