import { describe, expect, it } from "vitest";

import {
  buildCustomerAccountRevision,
  buildCustomerFactRevision,
  customerAccountId,
  customerFactId,
  customerMutationId,
  projectCustomerAccount360,
  type CustomerFactRevision,
  type CustomerFactValue,
} from "@/lib/customer-success/contracts";
import {
  buildCustomerSuccessAccountIntelligence,
  buildCustomerSuccessPortfolio,
} from "@/lib/customer-success/intelligence";
import { buildMeetingRevision, type MeetingDefinitionInput } from "@/lib/meetings/contracts";

const tenantId = "tenant-a";
const workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-8111-111111111111";
const accountId = customerAccountId({ tenantId, workspaceId, idempotencyKey: "account" });
const now = "2026-09-08T12:00:00.000Z";

describe("customer-success intelligence projection", () => {
  it("makes a current pending approval the explicit non-authoritative next action", () => {
    const value = buildCustomerSuccessAccountIntelligence({
      ...sources(),
      approvals: [{
        kind: "tool",
        id: "approval:one",
        title: "Update Salesforce opportunity",
        status: "approval_required",
        riskLevel: 2,
        reason: "External CRM mutation requires review.",
        createdAt: now,
        projectId: "project:one",
      }],
    });

    expect(value.nextBestAction).toMatchObject({
      action: "review_approval",
      authoritative: false,
      suggested: true,
      confidenceBasisPoints: 10_000,
    });
    expect(value.nextBestAction.evidence).toEqual([
      expect.objectContaining({ kind: "approval", refId: "approval:one" }),
    ]);
    expect(value.portfolio.attention).toBe("urgent");
    expect(value.portfolio.counts.pendingApprovals).toBe(1);
  });

  it("projects exact account-linked commitments, risks, and immutable timeline evidence", () => {
    const criticalRisk = fact("risk.adoption", "risk", {
      kind: "risk",
      entityId: "risk:adoption",
      title: "Adoption has stalled",
      severity: "critical",
      status: "open",
    });
    const linkedMeeting = meeting(account().accountEntityId, "meeting:22222222-2222-4222-8222-222222222222");
    const unrelatedMeeting = meeting("customer-account:unrelated", "meeting:33333333-3333-4333-8333-333333333333");
    const value = buildCustomerSuccessAccountIntelligence({
      ...sources([criticalRisk]),
      meetings: [linkedMeeting, unrelatedMeeting],
    });

    expect(value.risks).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "fact", severity: "critical", title: "Adoption has stalled" }),
      expect.objectContaining({ source: "commitment", severity: "high" }),
    ]));
    expect(value.commitments).toHaveLength(1);
    expect(value.commitments[0]).toMatchObject({
      meetingId: linkedMeeting.meetingId,
      owner: "Customer sponsor",
      status: "accepted",
      workItemId: "work-item:follow-up",
    });
    expect(value.nextBestAction.action).toBe("resolve_risk");
    expect(value.timeline.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "account_revision",
      "fact_revision",
      "meeting_commitment",
    ]));
    expect(value.timeline.every((item) => item.evidence.every((ref) => ref.sha256))).toBe(true);
  });

  it("asks for deterministic health evaluation when no current score exists", () => {
    const value = buildCustomerSuccessAccountIntelligence(sources());

    expect(value.nextBestAction).toMatchObject({
      action: "evaluate_health",
      workflowId: null,
      confidenceBasisPoints: 9_500,
    });
    expect(value.portfolio.health).toMatchObject({
      status: "unknown",
      current: false,
      evaluatedAt: null,
    });
  });

  it("sorts the portfolio by governed attention state", () => {
    const stableUnknown = buildCustomerSuccessAccountIntelligence(sources());
    const urgent = buildCustomerSuccessAccountIntelligence({
      ...sources(),
      approvals: [{
        kind: "workflow",
        id: "workflow:approval",
        title: "Risk escalation",
        status: "waiting_approval",
        riskLevel: 2,
        createdAt: now,
      }],
    });
    const portfolio = buildCustomerSuccessPortfolio([stableUnknown, urgent], now);

    expect(portfolio.accounts[0]?.attention).toBe("urgent");
    expect(portfolio.counts).toMatchObject({ total: 2, urgent: 1, pendingApprovals: 1 });
    expect(portfolio.projectionSha256).toHaveLength(64);
  });
});

function sources(currentFacts: CustomerFactRevision[] = []) {
  const currentAccount = account();
  return {
    account360: projectCustomerAccount360({
      account: currentAccount,
      currentFacts,
      historyCount: currentFacts.length + 1,
      evaluatedAt: now,
    }),
    health: null,
    accountHistory: [currentAccount],
    factHistory: currentFacts,
    healthHistory: [],
    workflowRuns: [],
    workflowHistory: [],
    meetings: [],
    approvals: [],
    generatedAt: now,
  };
}

function account() {
  return buildCustomerAccountRevision({
    tenantId,
    workspaceId,
    accountId,
    organizationEntityId: "organization:acme",
    revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey: "account", operation: "account.create" }),
    name: "Acme",
    lifecycle: "active",
    accountOwner: { ownerKind: "actor", ownerId: actorId, displayName: "CSM Owner" },
    crmPermissions: {
      readScope: "workspace_members",
      writeScope: "account_owner",
      externalWriteState: "disabled",
      customerDataPurposeIds: ["customer_success.account.manage", "customer_success.account.read"],
    },
    ownerActorId: actorId,
    revisedByActorId: actorId,
    revisedAt: "2026-09-08T08:00:00.000Z",
  });
}

function fact(key: string, idempotencyKey: string, value: CustomerFactValue) {
  const factId = customerFactId({ accountId, idempotencyKey });
  return buildCustomerFactRevision({
    tenantId,
    workspaceId,
    accountId,
    factId,
    revision: 1,
    mutationId: customerMutationId({ accountId, idempotencyKey, operation: "fact.record" }),
    factKey: key,
    value,
    source: {
      sourceKind: "manual",
      sourceId: `source:${idempotencyKey}`,
      sourceRevisionId: `source:${idempotencyKey}:v1`,
      sourceRevisionSha256: "a".repeat(64),
      sourceLabel: "Operator assertion",
      providerId: null,
      providerObjectType: null,
      providerObjectIdSha256: null,
      permissionBasis: "operator_assertion",
      allowedPurposeIds: ["customer_success.account.read"],
      observedAt: "2026-09-08T09:00:00.000Z",
      ingestedAt: "2026-09-08T09:01:00.000Z",
    },
    owner: { ownerKind: "actor", ownerId: actorId, displayName: "CSM Owner" },
    confidenceBasisPoints: 9_000,
    validFrom: "2026-09-08T09:00:00.000Z",
    staleAfter: "2026-09-15T09:00:00.000Z",
    recordedByActorId: actorId,
    recordedAt: "2026-09-08T09:01:00.000Z",
  });
}

function meeting(linkedAccountId: string, meetingId: string) {
  const definition: MeetingDefinitionInput = {
    title: "Customer review",
    summary: "Review current outcomes.",
    status: "completed",
    scheduledStartAt: "2026-09-01T10:00:00.000Z",
    scheduledEndAt: "2026-09-01T11:00:00.000Z",
    actualStartAt: "2026-09-01T10:00:00.000Z",
    actualEndAt: "2026-09-01T11:00:00.000Z",
    timezone: "UTC",
    location: "Video",
    projectId: "project:one",
    declaredAccessClass: "workspace_members",
    participants: [{
      participantId: "participant:sponsor",
      displayName: "Customer sponsor",
      email: null,
      entityId: "person:sponsor",
      role: "required",
      response: "accepted",
      attendeeConsent: "granted",
      recordingConsent: "not_required",
      consentCapturedAt: "2026-09-01T10:00:00.000Z",
      source: "manual",
    }],
    sourceLinks: [],
    entityLinks: [{
      entityId: linkedAccountId,
      entityType: "account",
      label: "Acme",
      relationship: "customer",
    }],
    decisions: [],
    commitments: [{
      commitmentId: "commitment:one",
      summary: "Deliver the adoption recovery plan.",
      ownerParticipantId: "participant:sponsor",
      dueAt: "2026-09-05T12:00:00.000Z",
      sourceLinkId: null,
    }],
    followUps: [{
      followUpId: "follow-up:one",
      label: "Track recovery plan",
      status: "accepted",
      workItemId: "work-item:follow-up",
      draftId: null,
      commitmentId: "commitment:one",
    }],
  };
  return buildMeetingRevision({
    tenantId,
    workspaceId,
    ownerActorId: actorId,
    meetingId,
    revision: 1,
    definition,
    revisedAt: "2026-09-01T11:05:00.000Z",
  });
}
