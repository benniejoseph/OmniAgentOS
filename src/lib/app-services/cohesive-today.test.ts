import { beforeEach, describe, expect, it, vi } from "vitest";

import { showCohesiveTodayService } from "@/lib/app-services/cohesive-today";
import { DEFAULT_TODAY_SECTIONS } from "@/lib/today/sections";

const NOW = "2026-09-07T10:00:00.000Z";
const dependencies = {
  loadToday: vi.fn(), loadWorkspace: vi.fn(), listMeetings: vi.fn(),
  loadCustomerPortfolio: vi.fn(), loadUsage: vi.fn(),
};
const caller = {
  context: {
    tenantId: "tenant:test", actorId: "owner@example.test", role: "admin" as const,
    source: "session" as const,
    auth: { userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.test", sessionId: "session:test", tenantName: "Test" },
  },
};

beforeEach(() => {
  for (const dependency of Object.values(dependencies)) dependency.mockReset();
  dependencies.loadToday.mockResolvedValue(todayFixture());
  dependencies.loadWorkspace.mockResolvedValue({
    tenantId: "tenant:test", generatedAt: NOW,
    sources: {
      runs: { status: "ready", data: [] }, workflows: { status: "ready", data: [] }, approvals: { status: "ready", data: [] },
    },
  });
  dependencies.listMeetings.mockResolvedValue({ data: { meetings: [] } });
  dependencies.loadCustomerPortfolio.mockResolvedValue({ data: { portfolio: portfolioFixture() } });
  dependencies.loadUsage.mockResolvedValue(usageFixture());
});

describe("cohesive Today application service", () => {
  it("composes every selected source under the authenticated caller", async () => {
    const result = await showCohesiveTodayService(caller, {
      workspaceId: "workspace:personal:test", workLimit: 8, approvalLimit: 6,
      meetingLimit: 20, accountLimit: 10,
    }, dependencies as never);

    expect(result.receipt.operation).toBe("app.today.agenda.show");
    expect(dependencies.loadWorkspace).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant:test", role: "admin", limit: 8 }));
    expect(dependencies.listMeetings).toHaveBeenCalledWith(caller, { workspaceId: "workspace:personal:test", limit: 20 });
    expect(dependencies.loadCustomerPortfolio).toHaveBeenCalledWith(caller, { workspaceId: "workspace:personal:test", limit: 10 });
    expect(result.data.projection.sources.every((source) => source.status === "ready")).toBe(true);
  });

  it("does not load domains hidden by actor-owned Today preferences", async () => {
    dependencies.loadToday.mockResolvedValue(todayFixture(["focus", "memory"]));
    const result = await showCohesiveTodayService(caller, {}, dependencies as never);

    expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
    expect(dependencies.listMeetings).not.toHaveBeenCalled();
    expect(dependencies.loadCustomerPortfolio).not.toHaveBeenCalled();
    expect(dependencies.loadUsage).not.toHaveBeenCalled();
    expect(result.data.projection.sources.find((source) => source.source === "meetings")?.status).toBe("hidden");
  });

  it("keeps one failed optional domain explicit while returning healthy siblings", async () => {
    dependencies.listMeetings.mockRejectedValue(new Error("database detail must not leak"));
    const result = await showCohesiveTodayService(caller, {}, dependencies as never);

    expect(result.data.projection.meetings).toEqual([]);
    expect(result.data.projection.sources.find((source) => source.source === "meetings")).toMatchObject({
      status: "error", detail: "Meetings and commitments are temporarily unavailable.",
    });
    expect(JSON.stringify(result.data)).not.toContain("database detail");
  });
});

function todayFixture(visibleSections = [...DEFAULT_TODAY_SECTIONS]) {
  return {
    generatedAt: NOW, items: [], threads: [], memories: [], brief: undefined,
    preferences: {
      briefEnabled: true, briefTime: "08:00", timezone: "UTC", reminderLeadMinutes: 30,
      notificationsEnabled: true, quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "07:00",
      visibleSections,
    },
    briefLocalDate: "2026-09-07", briefGenerationDue: false, projects: [],
  };
}

function portfolioFixture() {
  return {
    policyVersion: "p10.14-customer-success-intelligence:1", generatedAt: NOW, accounts: [],
    counts: { total: 0, urgent: 0, attention: 0, pendingApprovals: 0, overdueCommitments: 0 },
    projectionSha256: "0".repeat(64),
  };
}

function usageFixture() {
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, runs: 0, modelCalls: 0, sourceStreams: 0, providerCalls: 0, attempts: 0, failedAttempts: 0, failedCalls: 0, knownEstimatedCostUsd: 0, knownCostCalls: 0, unknownCostCalls: 0, costCoveragePercent: 100 };
  const period = { key: "day", label: "24 hours", currentLabel: "Current", previousLabel: "Previous", currentStartAt: NOW, currentEndAt: NOW, previousStartAt: NOW, previousEndAt: NOW, bucketUnit: "hour", current: totals, previous: totals, series: [], providers: [], models: [] };
  return { generatedAt: NOW, scopeLabel: "Unified", disclosure: "Complete", sourceEventLimitReached: false, periods: { day: period, week: { ...period, key: "week", bucketUnit: "day" }, month: { ...period, key: "month", bucketUnit: "day" } } };
}
