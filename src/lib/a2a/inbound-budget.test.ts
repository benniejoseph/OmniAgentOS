import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkSharedRateLimit: vi.fn(),
  loadTenantAiUsageSince: vi.fn(),
}));

vi.mock("@/lib/http/rate-limit", () => ({
  checkSharedRateLimit: mocks.checkSharedRateLimit,
}));
vi.mock("@/lib/usage/allowance", () => ({
  loadTenantAiUsageSince: mocks.loadTenantAiUsageSince,
}));

import type { AuthorizedA2APrincipal } from "@/lib/a2a/auth";
import {
  admitInboundA2ATask,
  inboundA2AUsageStreamId,
} from "@/lib/a2a/inbound-budget";
import {
  A2A_PEER_DAILY_MAX_COST_MICROUSD,
  A2A_PEER_DAILY_MAX_TOKENS,
  A2A_PEER_TASKS_PER_HOUR,
  TENANT_DAILY_MAX_COST_MICROUSD,
  TENANT_DAILY_MAX_TOKENS,
} from "@/lib/config";

const now = new Date("2026-09-30T12:00:00.000Z");
const taskBudget = { tokens: 12_000, costMicrousd: 500_000 };
const none = { tokens: 0, costMicrousd: 0 };

function principal(peerId = "peer:one") {
  return {
    tenantId: "tenant:one",
    actorId: "actor:one",
    peer: { peerId },
  } as unknown as AuthorizedA2APrincipal;
}

function usage(peer: typeof none, workspace: typeof none = none) {
  mocks.loadTenantAiUsageSince.mockImplementation(async (input) =>
    input.sourceStreamId === undefined ? workspace : peer);
}

describe("inbound A2A task admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.checkSharedRateLimit.mockReset().mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
    mocks.loadTenantAiUsageSince.mockReset();
    usage(none);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a start and reads the peer's and the workspace's last 24 hours", async () => {
    await expect(admitInboundA2ATask(principal(), taskBudget)).resolves.toBeUndefined();

    expect(mocks.checkSharedRateLimit).toHaveBeenCalledWith({
      key: "a2a-task:tenant:one:peer:one",
      limit: A2A_PEER_TASKS_PER_HOUR,
      windowMs: 3_600_000,
    });
    const since = new Date(now.getTime() - 86_400_000);
    expect(mocks.loadTenantAiUsageSince.mock.calls).toEqual([
      [{
        tenantId: "tenant:one",
        since,
        sourceStreamId: inboundA2AUsageStreamId(principal()),
      }],
      [{ tenantId: "tenant:one", since }],
    ]);
  });

  it("refuses a peer's start past its hourly limit before reading usage", async () => {
    mocks.checkSharedRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });

    await expect(admitInboundA2ATask(principal(), taskBudget)).rejects.toMatchObject({
      status: 429,
      code: "resource_exhausted",
      message: "This peer has started as many A2A tasks as it may this hour. Try again later.",
    });
    expect(mocks.loadTenantAiUsageSince).not.toHaveBeenCalled();
  });

  it("admits a task that exactly fills the peer's window and refuses one past it", async () => {
    const room = {
      tokens: A2A_PEER_DAILY_MAX_TOKENS - taskBudget.tokens,
      costMicrousd: A2A_PEER_DAILY_MAX_COST_MICROUSD - taskBudget.costMicrousd,
    };
    usage(room);
    await expect(admitInboundA2ATask(principal(), taskBudget)).resolves.toBeUndefined();

    for (const over of [
      { ...room, tokens: room.tokens + 1 },
      { ...room, costMicrousd: room.costMicrousd + 1 },
    ]) {
      mocks.loadTenantAiUsageSince.mockClear();
      usage(over);
      await expect(admitInboundA2ATask(principal(), taskBudget), JSON.stringify(over))
        .rejects.toMatchObject({
          status: 429,
          code: "resource_exhausted",
          message: "This peer's AI usage over the last 24 hours leaves no room for another task.",
        });
      expect(mocks.loadTenantAiUsageSince).toHaveBeenCalledOnce();
    }
  });

  it("admits a task that exactly fills the workspace's window and refuses one past it", async () => {
    const room = {
      tokens: TENANT_DAILY_MAX_TOKENS - taskBudget.tokens,
      costMicrousd: TENANT_DAILY_MAX_COST_MICROUSD - taskBudget.costMicrousd,
    };
    usage(none, room);
    await expect(admitInboundA2ATask(principal(), taskBudget)).resolves.toBeUndefined();

    for (const over of [
      { ...room, tokens: room.tokens + 1 },
      { ...room, costMicrousd: room.costMicrousd + 1 },
    ]) {
      usage(none, over);
      await expect(admitInboundA2ATask(principal(), taskBudget), JSON.stringify(over))
        .rejects.toMatchObject({
          status: 429,
          code: "resource_exhausted",
          message: "The workspace's AI usage over the last 24 hours leaves no room for another A2A task.",
        });
    }
  });

  it("refuses the task when a limit cannot be checked", async () => {
    const unavailable = {
      status: 503,
      code: "unavailable",
      message: "The A2A task budget could not be checked. Try again shortly.",
    };
    mocks.checkSharedRateLimit.mockRejectedValueOnce(new Error("rate-limit store down"));
    await expect(admitInboundA2ATask(principal(), taskBudget)).rejects.toMatchObject(unavailable);

    for (const failing of ["peer", "workspace"]) {
      mocks.loadTenantAiUsageSince.mockImplementation(async (input) => {
        if ((input.sourceStreamId === undefined) === (failing === "workspace")) {
          throw new Error("ledger down");
        }
        return none;
      });
      await expect(admitInboundA2ATask(principal(), taskBudget), failing)
        .rejects.toMatchObject(unavailable);
    }
  });

  it("names each peer's usage stream by a fixed-length digest", () => {
    const long = inboundA2AUsageStreamId(principal("p".repeat(240)));
    expect(long).toMatch(/^a2a-peer:[0-9a-f]{64}$/);
    expect(inboundA2AUsageStreamId(principal())).toMatch(/^a2a-peer:[0-9a-f]{64}$/);
    expect(inboundA2AUsageStreamId(principal())).toBe(inboundA2AUsageStreamId(principal()));
    expect(inboundA2AUsageStreamId(principal("peer:two")))
      .not.toBe(inboundA2AUsageStreamId(principal()));
  });
});
