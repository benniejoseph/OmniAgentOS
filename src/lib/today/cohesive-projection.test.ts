import { describe, expect, it } from "vitest";

import { buildCohesiveTodayProjection, DEFAULT_TODAY_SECTIONS } from "@/lib/today/cohesive-projection";
import type { WorkspaceSummary } from "@/lib/workspace/summary";

const NOW = "2026-09-07T10:00:00.000Z";

describe("cohesive Today projection", () => {
  it("orders needs-me evidence and preserves suggested customer language", () => {
    const projection = buildCohesiveTodayProjection({
      today: todayFixture(),
      workspaceSummary: { status: "ready", value: summaryFixture() },
      meetings: { status: "ready", value: [meetingFixture()] },
      customerPortfolio: { status: "ready", value: portfolioFixture() },
      usage: { status: "error", detail: "Consumption is temporarily unavailable." },
      generatedAt: NOW,
    });

    expect(projection.agenda.map((item) => item.kind)).toEqual([
      "reminder", "commitment", "approval", "customer_risk", "meeting",
    ]);
    expect(projection.agenda.find((item) => item.kind === "customer_risk")?.detail)
      .toContain("suggested, not authoritative");
    expect(projection.counts).toMatchObject({
      needsAttention: 4,
      meetingsToday: 1,
      openCommitments: 1,
      approvals: 1,
      activeAgents: 1,
      activeWork: 2,
      unknownSources: 1,
    });
    expect(projection.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("marks unavailable and hidden sources explicitly instead of inventing empty knowledge", () => {
    const projection = buildCohesiveTodayProjection({
      today: todayFixture(),
      workspaceSummary: { status: "restricted", detail: "Work visibility is restricted." },
      meetings: { status: "hidden", detail: "Hidden in Today preferences." },
      customerPortfolio: { status: "error", detail: "Customer context is unavailable." },
      usage: { status: "hidden", detail: "Hidden in Today preferences." },
      generatedAt: NOW,
    });

    expect(projection.workspaceSummary).toBeNull();
    expect(projection.meetings).toEqual([]);
    expect(projection.sources.find((source) => source.source === "meetings")).toMatchObject({
      status: "hidden",
      freshness: "unknown",
    });
    expect(projection.counts.unknownSources).toBe(4);
  });
});

function todayFixture() {
  return {
    generatedAt: NOW,
    items: [{
      id: "today:1", title: "Send review", kind: "reminder" as const,
      priority: "high" as const, status: "open" as const,
      dueAt: "2026-09-07T09:00:00.000Z", completedAt: undefined,
      createdAt: NOW, updatedAt: NOW, reminderState: "overdue" as const,
    }],
    threads: [], memories: [], brief: undefined,
    preferences: {
      briefEnabled: true, briefTime: "08:00", timezone: "UTC",
      reminderLeadMinutes: 30, notificationsEnabled: true,
      quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "07:00",
      visibleSections: [...DEFAULT_TODAY_SECTIONS],
    },
    briefLocalDate: "2026-09-07", briefGenerationDue: false, projects: [],
  };
}

function summaryFixture() {
  return {
    tenantId: "tenant:test", generatedAt: NOW,
    sources: {
      runs: { status: "ready" as const, data: [{
        id: "run:1", mode: "research", status: "running", prompt: "Research",
        response: undefined, error: undefined, startedAt: NOW, completedAt: undefined,
        waitingApproval: undefined, agentId: "scout", specialistIds: ["scout"],
      }] },
      workflows: { status: "ready" as const, data: [{
        id: "workflow:1", workflowType: "dynamic", status: "running",
        goal: "Prepare report", currentStep: 1, attempt: 1, maxAttempts: 3,
        approvalRequired: false, createdAt: NOW, updatedAt: NOW,
      }] },
      approvals: { status: "ready" as const, data: [{
        kind: "tool" as const, id: "approval:1", title: "Send message",
        status: "approval_required", riskLevel: 2, requestedBy: "actor:test",
        reason: "External effect", createdAt: NOW,
      }] },
    },
  } as unknown as WorkspaceSummary;
}

function meetingFixture() {
  return {
    schemaVersion: 1 as const, tenantId: "tenant:test", workspaceId: "workspace:test",
    meetingId: "meeting:00000000-0000-4000-8000-000000000001",
    meetingRevisionId: "meeting:00000000-0000-4000-8000-000000000001:v1",
    revision: 1, previousMeetingRevisionId: null,
    ownerActorId: "actor:00000000-0000-4000-8000-000000000001",
    title: "Renewal review", summary: "", status: "scheduled" as const,
    scheduledStartAt: "2026-09-07T14:00:00.000Z", scheduledEndAt: "2026-09-07T15:00:00.000Z",
    actualStartAt: null, actualEndAt: null, timezone: "UTC", location: "",
    projectId: null, declaredAccessClass: "workspace_members" as const,
    effectiveAccessClass: "workspace_members" as const, participants: [], sourceLinks: [],
    entityLinks: [], decisions: [], followUps: [],
    commitments: [{ commitmentId: "commitment:1", summary: "Share plan", ownerParticipantId: null, dueAt: "2026-09-07T09:30:00.000Z", sourceLinkId: null }],
    consentSnapshotSha256: "0".repeat(64), revisedByActorId: "actor:00000000-0000-4000-8000-000000000001",
    revisedAt: NOW, meetingSha256: "1".repeat(64),
  };
}

function portfolioFixture() {
  return {
    policyVersion: "p10.14-customer-success-intelligence:1" as const,
    generatedAt: NOW,
    accounts: [{
      accountId: `customer-account:${"1".repeat(64)}`,
      accountRevisionId: "account:v1", accountSha256: "2".repeat(64), name: "Acme",
      lifecycle: "at_risk" as const, ownerName: "Owner", attention: "attention" as const,
      health: { status: "at_risk" as const, scoreBasisPoints: 4000, confidenceBasisPoints: 8000, coverageBasisPoints: 9000, current: true, evaluatedAt: NOW },
      counts: { openRisks: 1, criticalRisks: 0, openCommitments: 0, overdueCommitments: 0, pendingApprovals: 0, staleFacts: 0, conflicts: 0 },
      nextBestAction: {
        policyVersion: "p10.14-customer-success-intelligence:1" as const,
        recommendationId: `customer-success-recommendation:${"3".repeat(64)}`,
        action: "resolve_risk" as const, workflowId: null, title: "Review risk", reason: "Health declined",
        confidenceBasisPoints: 8000, uncertainty: [], evidence: [{ kind: "account_revision" as const, refId: "account:v1", revisionId: "account:v1", sha256: "2".repeat(64), observedAt: NOW, label: "Account" }],
        freshness: { status: "current" as const, oldestObservedAt: NOW, evaluatedAt: NOW },
        authoritative: false as const, suggested: true as const, generatedAt: NOW,
        recommendationSha256: "4".repeat(64),
      },
      changedAt: NOW,
    }],
    counts: { total: 1, urgent: 0, attention: 1, pendingApprovals: 0, overdueCommitments: 0 },
    projectionSha256: "5".repeat(64),
  };
}
