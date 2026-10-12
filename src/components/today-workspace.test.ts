import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CohesiveTodayProjection, TodayProjectionSourceState } from "@/lib/today/cohesive-projection";
import type { UsagePeriodKey, UsagePeriodSummary, UsageSummary, UsageTotals } from "@/lib/usage/summary";

vi.mock("@/components/app-shell/session-context", () => ({
  useWorkspaceSession: () => ({
    session: { authEnabled: true, authenticated: true },
    status: "ready",
  }),
}));
vi.mock("@/components/source-coverage/source-coverage-panel", () => ({
  SourceCoveragePanel: () => null,
}));
vi.mock("@/components/use-live-refresh", () => ({ useLiveRefresh: () => undefined }));

const { TodayWorkspace } = await import("@/components/today-workspace");
const timestamp = "2026-10-03T12:00:00.000Z";

function usageWithTokens(inputTokens = 0, outputTokens = 0): UsageSummary {
  const totals: UsageTotals = {
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    cachedInputTokens: 0, runs: 0, modelCalls: 0, sourceStreams: 0,
    providerCalls: 0, attempts: 0, failedAttempts: 0, failedCalls: 0,
    knownEstimatedCostUsd: 0, knownCostCalls: 0, unknownCostCalls: 0,
    costCoveragePercent: 0,
  };
  const period = (key: UsagePeriodKey): UsagePeriodSummary => ({
    key, label: "24 hours", currentLabel: "Current 24 hours", previousLabel: "Previous 24 hours",
    currentStartAt: timestamp, currentEndAt: timestamp,
    previousStartAt: timestamp, previousEndAt: timestamp, bucketUnit: "hour",
    current: totals, previous: totals, series: [], providers: [], models: [],
  });
  return {
    generatedAt: timestamp, scopeLabel: "Test usage", disclosure: "Synthetic ledger.",
    sourceEventLimitReached: false,
    periods: { day: period("day"), week: period("week"), month: period("month") },
  };
}

function projection(meetingStatus: TodayProjectionSourceState["status"] = "ready"): CohesiveTodayProjection {
  const sources = (["personal_reminders", "meetings", "commitments", "approvals", "active_agents", "work", "consumption"] as const).map((source) => {
    const status = source === "meetings" || source === "commitments" ? meetingStatus : "ready";
    return {
      source, status, freshness: status === "ready" ? "current" as const : "unknown" as const,
      observedAt: timestamp, lastChangedAt: null, detail: "Synthetic source state.",
    };
  });
  return {
    policyVersion: "p11.1-cohesive-today:1", generatedAt: timestamp, timezone: "UTC",
    visibleSections: ["focus", "agenda", "approvals", "consumption"],
    today: {
      generatedAt: timestamp, items: [], threads: [], memories: [], projects: [],
      brief: undefined, briefLocalDate: "2026-10-03", briefGenerationDue: false,
      preferences: {
        briefEnabled: false, briefTime: "08:00", timezone: "UTC", reminderLeadMinutes: 30,
        notificationsEnabled: false, quietHoursEnabled: true,
        quietHoursStart: "22:00", quietHoursEnd: "07:00",
        visibleSections: ["focus", "agenda", "approvals", "consumption"],
      },
    },
    workspaceSummary: null, meetings: [],
    usage: usageWithTokens(), agenda: [], sources,
    counts: { needsAttention: 0, meetingsToday: 0, openCommitments: 0, approvals: 0,
      activeAgents: 0, activeWork: 0, unknownSources: meetingStatus === "ready" ? 0 : 2 },
    projectionSha256: "synthetic-review-projection",
  };
}

function render(initialProjection: CohesiveTodayProjection) {
  return renderToStaticMarkup(createElement(TodayWorkspace, { initialProjection }));
}

describe("cohesive Today workspace", () => {
  it("uses one canonical projection while preserving unknown-state boundaries", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/today-workspace.tsx"),
      "utf8",
    );

    expect(source).toContain("/api/today/agenda?workLimit=16&approvalLimit=12&meetingLimit=50");
    expect(source).not.toContain("/api/workspace-summary?limit");
    expect(source).not.toContain("/api/usage/summary");
    expect(source).toContain("Meetings, confirmed commitments, and personal reminders");
    expect(source).toContain("Trusted status");
    expect(source).toContain("Data confidence");
    expect(source).toContain("instead of pretending it is empty");
    expect(source).not.toContain("WorkspaceReadinessCard");
    expect(source).not.toContain("useWorkspaceReadiness");
    expect(source).toContain("Active agents");
    expect(source).toContain("visibleSections");
    expect(source).toContain("today-overview-summary");

    const consumptionIndex = source.indexOf("<UsageCockpit");
    const dataConfidenceIndex = source.indexOf(
      '<section className={styles.projectionStatus}',
    );
    const knowledgeConfidenceIndex = source.indexOf(
      '<SourceCoveragePanel surface="today" />',
    );
    expect(consumptionIndex).toBeGreaterThan(-1);
    expect(dataConfidenceIndex).toBeGreaterThan(consumptionIndex);
    expect(knowledgeConfidenceIndex).toBeGreaterThan(dataConfidenceIndex);
  });

  it("keeps the authenticated actor scope inside the cohesive service boundary", async () => {
    const pageSource = await readFile(
      path.join(process.cwd(), "src/app/app/page.tsx"),
      "utf8",
    );
    const serviceSource = await readFile(
      path.join(process.cwd(), "src/lib/app-services/cohesive-today.ts"),
      "utf8",
    );

    expect(pageSource).toContain("showCohesiveTodayService");
    expect(serviceSource).toContain("runWithDatabaseActorScope");
    expect(serviceSource).toContain(
      "actorBinding?.readableOwnerActorIds || [caller.context.actorId]",
    );
  });
});


describe("Today source and consumption truth", () => {
  it("shows zero input and output when no tokens were recorded", () => {
    const html = render(projection());
    expect(html).toContain('aria-label="Token composition: 0% input and 0% output"');
    expect(html).toContain("No tracked tokens in this period.");
    expect(html).not.toContain("100% output");
  });

  it("uses the recorded input and output shares for nonempty usage", () => {
    const html = render({ ...projection(), usage: usageWithTokens(80, 20) });
    expect(html).toContain('aria-label="Token composition: 80% input and 20% output"');
    expect(html).toContain("Cached input is included in input tokens.");
  });

  it("does not describe an unavailable agenda as empty", () => {
    const html = render(projection("error"));
    expect(html).toContain("Agenda unavailable");
    expect(html).toContain("Meetings: not available · Commitments: not available");
    expect(html).toMatch(/<summary><span>Data confidence<\/span><span>2 sources need attention<\/span><\/summary>/);
    expect(html).not.toContain("No meetings, commitments, or reminders in this view.");
    expect(html).not.toContain("Schedule is clear");
  });

  it("describes an empty agenda only after every agenda source is current", () => {
    const html = render(projection());
    expect(html).toContain("No agenda items in view");
    expect(html).toContain("No meetings, commitments, or reminders in this view.");
    expect(html).not.toContain("Agenda unavailable");
  });

  it("keeps available reminders visible when meeting sources failed", () => {
    const initialProjection = projection("error");
    const html = render({ ...initialProjection, agenda: [{
      itemId: "agenda:reminder:one", kind: "reminder", priority: "normal",
      title: "Review the draft", detail: "Personal reminder.", scheduledAt: timestamp,
      href: "/app#today-focus", sourceId: "one", sourceRevisionId: null,
    }] });
    expect(html).toContain("Agenda is incomplete");
    expect(html).toContain("Review the draft");
    expect(html).not.toContain("No meetings, commitments, or reminders in this view.");
  });

  it("distinguishes access restrictions and hidden sources from an empty agenda", () => {
    expect(render(projection("restricted"))).toContain("Agenda access limited");
    expect(render(projection("hidden"))).toContain("Agenda hidden");
  });
});
