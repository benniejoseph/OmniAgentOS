import type {
  CustomerAccount360,
  CustomerAccountRevision,
  CustomerFactRevision,
  CustomerFactView,
} from "@/lib/customer-success/contracts";
import type { CustomerHealthScore } from "@/lib/customer-success/health-contracts";
import {
  CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION,
  customerSuccessAccountIntelligenceSchema,
  customerSuccessApprovalSchema,
  customerSuccessCommitmentSchema,
  customerSuccessNextActionSchema,
  customerSuccessPortfolioItemSchema,
  customerSuccessPortfolioSchema,
  customerSuccessRiskSchema,
  customerSuccessTimelineItemSchema,
  type CustomerSuccessAccountIntelligence,
  type CustomerSuccessApproval,
  type CustomerSuccessCommitment,
  type CustomerSuccessEvidenceRef,
  type CustomerSuccessFreshness,
  type CustomerSuccessNextAction,
  type CustomerSuccessPortfolio,
  type CustomerSuccessRisk,
  type CustomerSuccessTimelineItem,
} from "@/lib/customer-success/intelligence-contracts";
import type { CustomerSuccessWorkflowRunRevision } from "@/lib/customer-success/workflow-contracts";
import type { MeetingRevision } from "@/lib/meetings/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type CustomerSuccessApprovalInput = Readonly<{
  kind: "tool" | "workflow";
  id: string;
  title: string;
  status: "approval_required" | "reconciliation_required" | "waiting_approval";
  riskLevel: number;
  reason?: string;
  createdAt: string;
  projectId?: string;
  runId?: string;
}>;

export type CustomerSuccessIntelligenceSources = Readonly<{
  account360: CustomerAccount360;
  health: CustomerHealthScore | null;
  accountHistory: readonly CustomerAccountRevision[];
  factHistory: readonly CustomerFactRevision[];
  healthHistory: readonly CustomerHealthScore[];
  workflowRuns: readonly CustomerSuccessWorkflowRunRevision[];
  workflowHistory: readonly CustomerSuccessWorkflowRunRevision[];
  meetings: readonly MeetingRevision[];
  approvals: readonly CustomerSuccessApprovalInput[];
  generatedAt?: string;
  timelineLimit?: number;
}>;

export function buildCustomerSuccessAccountIntelligence(
  input: CustomerSuccessIntelligenceSources,
): CustomerSuccessAccountIntelligence {
  const generatedAt = canonicalTimestamp(input.generatedAt || new Date().toISOString());
  const meetings = input.meetings.filter((meeting) =>
    meeting.entityLinks.some((link) =>
      link.entityId === input.account360.account.accountEntityId ||
      link.entityId === input.account360.account.accountId ||
      (input.account360.account.organizationEntityId !== null &&
        link.entityId === input.account360.account.organizationEntityId)
    )
  );
  const commitments = buildCommitments(meetings, generatedAt);
  const approvals = input.approvals.map(buildApproval)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const risks = buildRisks({
    account360: input.account360,
    health: input.health,
    workflowRuns: input.workflowRuns,
    commitments,
    generatedAt,
  });
  const nextBestAction = buildNextBestAction({
    account360: input.account360,
    health: input.health,
    workflowRuns: input.workflowRuns,
    risks,
    commitments,
    approvals,
    generatedAt,
  });
  const timeline = buildTimeline({
    accountHistory: input.accountHistory,
    factHistory: input.factHistory,
    healthHistory: input.healthHistory,
    workflowHistory: input.workflowHistory,
    meetings,
    generatedAt,
  }).slice(0, Math.max(1, Math.min(250, input.timelineLimit || 100)));
  const portfolio = buildPortfolioItem({
    account360: input.account360,
    health: input.health,
    risks,
    commitments,
    approvals,
    nextBestAction,
    timeline,
  });
  const body = {
    policyVersion: CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION,
    generatedAt,
    portfolio,
    nextBestAction,
    risks,
    commitments,
    approvals,
    timeline,
  };
  return customerSuccessAccountIntelligenceSchema.parse({
    ...body,
    projectionSha256: canonicalJsonSha256(body),
  });
}

export function buildCustomerSuccessPortfolio(
  accounts: readonly CustomerSuccessAccountIntelligence[],
  generatedAt = new Date().toISOString(),
): CustomerSuccessPortfolio {
  const timestamp = canonicalTimestamp(generatedAt);
  const items = accounts.map((item) => item.portfolio).sort(comparePortfolioItems);
  const body = {
    policyVersion: CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION,
    generatedAt: timestamp,
    accounts: items,
    counts: {
      total: items.length,
      urgent: items.filter((item) => item.attention === "urgent").length,
      attention: items.filter((item) => item.attention === "attention").length,
      pendingApprovals: items.reduce((sum, item) => sum + item.counts.pendingApprovals, 0),
      overdueCommitments: items.reduce((sum, item) => sum + item.counts.overdueCommitments, 0),
    },
  };
  return customerSuccessPortfolioSchema.parse({
    ...body,
    projectionSha256: canonicalJsonSha256(body),
  });
}

function buildRisks(input: {
  account360: CustomerAccount360;
  health: CustomerHealthScore | null;
  workflowRuns: readonly CustomerSuccessWorkflowRunRevision[];
  commitments: readonly CustomerSuccessCommitment[];
  generatedAt: string;
}) {
  const risks: CustomerSuccessRisk[] = [];
  const accountEvidence = evidenceForAccount(input.account360.account);
  if (input.account360.account.lifecycle === "at_risk") {
    risks.push(risk({
      source: "account",
      severity: "high",
      status: "open",
      title: "Account lifecycle is at risk",
      reason: "The current Account 360 revision explicitly classifies this customer as at risk.",
      evidence: [accountEvidence],
      freshness: freshness([accountEvidence], input.generatedAt, ["current"]),
    }));
  }
  for (const view of input.account360.factsByKind.risk) {
    if (view.fact.value.kind !== "risk" || view.fact.value.status === "resolved") continue;
    const evidence = evidenceForFact(view.fact);
    risks.push(risk({
      source: "fact",
      severity: view.fact.value.severity,
      status: view.fact.value.status === "mitigating" ? "mitigating" : "open",
      title: view.fact.value.title,
      reason: `This sourced risk is ${view.fact.value.status} with ${view.freshness.status} evidence and ${Math.round(view.fact.confidenceBasisPoints / 100)}% source confidence.`,
      evidence: [evidence],
      freshness: freshness([evidence], input.generatedAt, [view.freshness.status]),
    }));
  }
  if (input.health) {
    const evidence = evidenceForHealth(input.health);
    const current = input.health.accountSha256 === input.account360.account.accountSha256;
    if (input.health.status === "at_risk" || input.health.status === "watch") {
      risks.push(risk({
        source: "health",
        severity: input.health.status === "at_risk" ? "high" : "medium",
        status: "open",
        title: input.health.status === "at_risk" ? "Health score is at risk" : "Health score needs watching",
        reason: `The deterministic health policy reports ${input.health.status.replace("_", " ")} with ${Math.round(input.health.confidenceBasisPoints / 100)}% confidence and ${Math.round(input.health.coverageBasisPoints / 100)}% coverage.`,
        evidence: [evidence],
        freshness: freshness([evidence], input.generatedAt, [current ? "current" : "stale"]),
      }));
    }
    if (!current) {
      risks.push(risk({
        source: "data_quality",
        severity: "medium",
        status: "open",
        title: "Health score is outdated",
        reason: "The current health score was evaluated against an earlier Account 360 revision.",
        evidence: [evidence, accountEvidence],
        freshness: freshness([evidence, accountEvidence], input.generatedAt, ["stale", "current"]),
      }));
    }
  }
  if (input.account360.staleCount > 0 || input.account360.conflictCount > 0) {
    risks.push(risk({
      source: "data_quality",
      severity: input.account360.conflictCount > 0 ? "medium" : "low",
      status: "open",
      title: "Account evidence needs review",
      reason: `${input.account360.staleCount} stale fact${input.account360.staleCount === 1 ? "" : "s"} and ${input.account360.conflictCount} unresolved conflict${input.account360.conflictCount === 1 ? "" : "s"} are visible in Account 360.`,
      evidence: [accountEvidence],
      freshness: freshness([accountEvidence], input.generatedAt, [input.account360.staleCount ? "stale" : "current"]),
    }));
  }
  for (const run of input.workflowRuns.filter((item) => item.outcome.status === "blocked")) {
    const evidence = evidenceForWorkflow(run);
    risks.push(risk({
      source: "workflow",
      severity: "high",
      status: "open",
      title: `${workflowLabel(run.workflowId)} is blocked`,
      reason: run.outcome.summary || run.outcome.nextAction,
      evidence: [evidence],
      freshness: freshness([evidence], input.generatedAt, ["current"]),
    }));
  }
  for (const commitment of input.commitments.filter((item) => isOverdue(item, input.generatedAt))) {
    risks.push(risk({
      source: "commitment",
      severity: "high",
      status: "open",
      title: "Customer commitment is overdue",
      reason: commitment.summary,
      evidence: commitment.evidence,
      freshness: commitment.freshness,
    }));
  }
  return customerSuccessRiskSchema.array().max(250).parse(
    dedupeByDigest(risks, (item) => item.riskSha256).sort(compareRisks),
  );
}

function buildCommitments(meetings: readonly MeetingRevision[], generatedAt: string) {
  const commitments: CustomerSuccessCommitment[] = [];
  for (const meeting of meetings) {
    const evidence = evidenceForMeeting(meeting);
    for (const item of meeting.commitments) {
      const followUp = meeting.followUps.find((candidate) => candidate.commitmentId === item.commitmentId);
      const owner = meeting.participants.find((participant) =>
        participant.participantId === item.ownerParticipantId
      )?.displayName || null;
      const body = {
        commitmentId: item.commitmentId,
        meetingId: meeting.meetingId,
        meetingRevisionId: meeting.meetingRevisionId,
        summary: item.summary,
        owner,
        dueAt: item.dueAt,
        status: followUp?.status === "completed"
          ? "completed" as const
          : followUp?.status === "dismissed"
            ? "dismissed" as const
            : followUp?.status === "accepted"
              ? "accepted" as const
              : "recorded" as const,
        workItemId: followUp?.workItemId || null,
        evidence: [evidence],
        freshness: freshness([evidence], generatedAt, ["current"]),
      };
      commitments.push(customerSuccessCommitmentSchema.parse({
        ...body,
        commitmentSha256: canonicalJsonSha256(body),
      }));
    }
  }
  return commitments.sort((left, right) =>
    Number(left.status === "completed" || left.status === "dismissed") -
      Number(right.status === "completed" || right.status === "dismissed") ||
    (left.dueAt || "9999").localeCompare(right.dueAt || "9999") ||
    left.commitmentId.localeCompare(right.commitmentId)
  );
}

function buildApproval(input: CustomerSuccessApprovalInput): CustomerSuccessApproval {
  const body = {
    kind: input.kind,
    approvalId: input.id,
    title: input.title,
    status: input.status,
    riskLevel: input.riskLevel,
    reason: input.reason?.trim() || null,
    createdAt: canonicalTimestamp(input.createdAt),
    projectId: input.projectId || null,
    runId: input.runId || null,
  };
  return customerSuccessApprovalSchema.parse({
    ...body,
    approvalSha256: canonicalJsonSha256(body),
  });
}

function buildNextBestAction(input: {
  account360: CustomerAccount360;
  health: CustomerHealthScore | null;
  workflowRuns: readonly CustomerSuccessWorkflowRunRevision[];
  risks: readonly CustomerSuccessRisk[];
  commitments: readonly CustomerSuccessCommitment[];
  approvals: readonly CustomerSuccessApproval[];
  generatedAt: string;
}): CustomerSuccessNextAction {
  const accountEvidence = evidenceForAccount(input.account360.account);
  let draft: Omit<CustomerSuccessNextAction, "recommendationId" | "recommendationSha256">;
  const approval = input.approvals[0];
  const criticalRisk = input.risks.find((item) => item.severity === "critical") ||
    input.risks.find((item) => item.severity === "high");
  const overdue = input.commitments.find((item) => isOverdue(item, input.generatedAt));
  const openCommitment = input.commitments.find((item) => !["completed", "dismissed"].includes(item.status));
  const healthCurrent = input.health?.accountSha256 === input.account360.account.accountSha256;
  const common = {
    policyVersion: CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION,
    authoritative: false as const,
    suggested: true as const,
    generatedAt: input.generatedAt,
  };
  if (approval) {
    const evidence = evidenceForApproval(approval);
    draft = {
      ...common,
      action: "review_approval",
      workflowId: null,
      title: "Review the pending customer action",
      reason: `${approval.title} is waiting for a human decision before governed work can continue.`,
      confidenceBasisPoints: 10_000,
      uncertainty: [],
      evidence: [evidence],
      freshness: freshness([evidence], input.generatedAt, ["current"]),
    };
  } else if (criticalRisk) {
    draft = {
      ...common,
      action: "resolve_risk",
      workflowId: null,
      title: `Address ${criticalRisk.title.toLowerCase()}`,
      reason: criticalRisk.reason,
      confidenceBasisPoints: riskConfidence(criticalRisk),
      uncertainty: riskUncertainty(criticalRisk),
      evidence: criticalRisk.evidence,
      freshness: criticalRisk.freshness,
    };
  } else if (overdue) {
    draft = {
      ...common,
      action: "advance_commitment",
      workflowId: null,
      title: "Resolve the overdue customer commitment",
      reason: overdue.summary,
      confidenceBasisPoints: 10_000,
      uncertainty: overdue.owner ? [] : ["The recorded commitment has no confirmed owner."],
      evidence: overdue.evidence,
      freshness: overdue.freshness,
    };
  } else if (!input.health || !healthCurrent) {
    const healthEvidence = input.health ? [evidenceForHealth(input.health), accountEvidence] : [accountEvidence];
    draft = {
      ...common,
      action: "evaluate_health",
      workflowId: null,
      title: input.health ? "Refresh the customer health evaluation" : "Evaluate customer health",
      reason: input.health
        ? "The existing score is bound to an older Account 360 revision."
        : "No deterministic health evaluation exists for this account.",
      confidenceBasisPoints: 9_500,
      uncertainty: input.account360.staleCount
        ? [`${input.account360.staleCount} account fact${input.account360.staleCount === 1 ? " is" : "s are"} stale.`]
        : [],
      evidence: healthEvidence,
      freshness: freshness(healthEvidence, input.generatedAt, input.health ? ["stale", "current"] : ["current"]),
    };
  } else if (input.account360.conflictCount || input.account360.staleCount) {
    draft = {
      ...common,
      action: "refresh_evidence",
      workflowId: null,
      title: "Reconcile Account 360 evidence",
      reason: `${input.account360.conflictCount} conflict${input.account360.conflictCount === 1 ? "" : "s"} and ${input.account360.staleCount} stale fact${input.account360.staleCount === 1 ? "" : "s"} reduce decision confidence.`,
      confidenceBasisPoints: 9_000,
      uncertainty: ["A refreshed source may change the recommended action."],
      evidence: [accountEvidence],
      freshness: freshness([accountEvidence], input.generatedAt, ["stale"]),
    };
  } else if (
    input.account360.account.lifecycle === "onboarding" &&
    !hasOpenWorkflow(input.workflowRuns, "onboarding")
  ) {
    draft = workflowRecommendation(input.generatedAt, accountEvidence, "onboarding", "Start the onboarding workflow", "The account is in onboarding with no active onboarding workflow.");
  } else if (renewalDueSoon(input.account360.factsByKind.renewal, input.generatedAt) &&
    !hasOpenWorkflow(input.workflowRuns, "renewal_planning")) {
    const renewal = input.account360.factsByKind.renewal.find((view) =>
      view.fact.value.kind === "renewal" && view.fact.value.status !== "renewed"
    );
    const evidence = renewal ? evidenceForFact(renewal.fact) : accountEvidence;
    draft = workflowRecommendation(input.generatedAt, evidence, "renewal_planning", "Start renewal planning", "A sourced renewal date is within the policy's 120-day planning window.");
  } else if (openCommitment) {
    draft = {
      ...common,
      action: "advance_commitment",
      workflowId: null,
      title: "Advance the next customer commitment",
      reason: openCommitment.summary,
      confidenceBasisPoints: openCommitment.owner ? 9_000 : 7_000,
      uncertainty: openCommitment.owner ? [] : ["The commitment has no confirmed owner."],
      evidence: openCommitment.evidence,
      freshness: openCommitment.freshness,
    };
  } else if (!hasOpenWorkflow(input.workflowRuns, "adoption_review")) {
    draft = workflowRecommendation(input.generatedAt, accountEvidence, "adoption_review", "Review customer adoption", "No active adoption review is keeping the current evidence and outcomes together.");
  } else {
    draft = {
      ...common,
      action: "monitor_account",
      workflowId: null,
      title: "Monitor current customer signals",
      reason: "No higher-priority governed action is supported by the current account evidence.",
      confidenceBasisPoints: Math.max(2_500, input.health.confidenceBasisPoints),
      uncertainty: input.health.coverageBasisPoints < 10_000
        ? [`Health evidence covers ${Math.round(input.health.coverageBasisPoints / 100)}% of the policy.`]
        : [],
      evidence: [evidenceForHealth(input.health), accountEvidence],
      freshness: freshness([evidenceForHealth(input.health), accountEvidence], input.generatedAt, ["current"]),
    };
  }
  const recommendationId = `customer-success-recommendation:${canonicalJsonSha256({
    accountId: input.account360.account.accountId,
    accountRevisionId: input.account360.account.revisionId,
    policyVersion: CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION,
    action: draft.action,
    workflowId: draft.workflowId,
    evidence: draft.evidence.map((item) => [item.kind, item.refId, item.revisionId, item.sha256]),
  })}`;
  const body = { ...draft, recommendationId };
  return customerSuccessNextActionSchema.parse({
    ...body,
    recommendationSha256: canonicalJsonSha256(body),
  });
}

function buildTimeline(input: {
  accountHistory: readonly CustomerAccountRevision[];
  factHistory: readonly CustomerFactRevision[];
  healthHistory: readonly CustomerHealthScore[];
  workflowHistory: readonly CustomerSuccessWorkflowRunRevision[];
  meetings: readonly MeetingRevision[];
  generatedAt: string;
}) {
  const items: CustomerSuccessTimelineItem[] = [];
  for (const account of input.accountHistory) {
    const evidence = evidenceForAccount(account);
    items.push(timeline({
      kind: "account_revision",
      occurredAt: account.revisedAt,
      title: account.revision === 1 ? "Account 360 created" : "Account 360 revised",
      summary: `${account.name} is ${account.lifecycle.replace("_", " ")} at revision ${account.revision}.`,
      evidence: [evidence],
    }));
  }
  for (const fact of input.factHistory) {
    const evidence = evidenceForFact(fact);
    items.push(timeline({
      kind: "fact_revision",
      occurredAt: fact.recordedAt,
      title: `${titleCase(fact.kind)} fact ${fact.state === "retracted" ? "retracted" : "recorded"}`,
      summary: factSummary(fact),
      evidence: [evidence],
    }));
  }
  for (const health of input.healthHistory) {
    const evidence = evidenceForHealth(health);
    items.push(timeline({
      kind: "health_evaluation",
      occurredAt: health.evaluatedAt,
      title: `Health evaluated as ${health.status.replace("_", " ")}`,
      summary: health.scoreBasisPoints === null
        ? `The policy could not calculate a score; confidence is ${Math.round(health.confidenceBasisPoints / 100)}%.`
        : `Score ${Math.round(health.scoreBasisPoints / 100)} with ${Math.round(health.confidenceBasisPoints / 100)}% confidence and ${Math.round(health.coverageBasisPoints / 100)}% coverage.`,
      evidence: [evidence],
    }));
  }
  for (const run of input.workflowHistory) {
    const evidence = evidenceForWorkflow(run);
    items.push(timeline({
      kind: run.revision === 1 ? "workflow_started" : "workflow_outcome",
      occurredAt: run.outcome.recordedAt,
      title: run.revision === 1
        ? `${workflowLabel(run.workflowId)} started`
        : `${workflowLabel(run.workflowId)} ${run.outcome.status}`,
      summary: run.outcome.summary || run.outcome.nextAction,
      evidence: [evidence],
    }));
  }
  for (const meeting of input.meetings) {
    const evidence = evidenceForMeeting(meeting);
    for (const commitment of meeting.commitments) {
      items.push(timeline({
        kind: "meeting_commitment",
        occurredAt: meeting.revisedAt,
        title: "Meeting commitment recorded",
        summary: commitment.summary,
        evidence: [evidence],
      }));
    }
  }
  return customerSuccessTimelineItemSchema.array().max(2_000).parse(
    dedupeByDigest(items, (item) => item.eventId).sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || left.eventId.localeCompare(right.eventId)
    ),
  );
}

function buildPortfolioItem(input: {
  account360: CustomerAccount360;
  health: CustomerHealthScore | null;
  risks: readonly CustomerSuccessRisk[];
  commitments: readonly CustomerSuccessCommitment[];
  approvals: readonly CustomerSuccessApproval[];
  nextBestAction: CustomerSuccessNextAction;
  timeline: readonly CustomerSuccessTimelineItem[];
}) {
  const healthCurrent = input.health?.accountSha256 === input.account360.account.accountSha256;
  const openCommitments = input.commitments.filter((item) => !["completed", "dismissed"].includes(item.status));
  const overdueCommitments = openCommitments.filter((item) => isOverdue(item, input.account360.evaluatedAt));
  const criticalRisks = input.risks.filter((item) => item.severity === "critical");
  const highRisks = input.risks.filter((item) => item.severity === "high");
  const attention = input.approvals.length || criticalRisks.length || overdueCommitments.length
    ? "urgent" as const
    : highRisks.length || input.account360.account.lifecycle === "at_risk" || input.health?.status === "at_risk"
      ? "attention" as const
      : input.risks.length || openCommitments.length || input.health?.status === "watch"
        ? "watch" as const
        : input.health?.status === "healthy" && healthCurrent
          ? "stable" as const
          : "unknown" as const;
  return customerSuccessPortfolioItemSchema.parse({
    accountId: input.account360.account.accountId,
    accountRevisionId: input.account360.account.revisionId,
    accountSha256: input.account360.account.accountSha256,
    name: input.account360.account.name,
    lifecycle: input.account360.account.lifecycle,
    ownerName: input.account360.account.accountOwner.displayName,
    attention,
    health: {
      status: input.health?.status || "unknown",
      scoreBasisPoints: input.health?.scoreBasisPoints ?? null,
      confidenceBasisPoints: input.health?.confidenceBasisPoints || 0,
      coverageBasisPoints: input.health?.coverageBasisPoints || 0,
      current: Boolean(healthCurrent),
      evaluatedAt: input.health?.evaluatedAt || null,
    },
    counts: {
      openRisks: input.risks.length,
      criticalRisks: criticalRisks.length,
      openCommitments: openCommitments.length,
      overdueCommitments: overdueCommitments.length,
      pendingApprovals: input.approvals.length,
      staleFacts: input.account360.staleCount,
      conflicts: input.account360.conflictCount,
    },
    nextBestAction: input.nextBestAction,
    changedAt: input.timeline[0]?.occurredAt || input.account360.account.revisedAt,
  });
}

function risk(input: Omit<CustomerSuccessRisk, "riskId" | "riskSha256">) {
  const riskId = `customer-success-risk:${canonicalJsonSha256({
    source: input.source,
    title: input.title,
    evidence: input.evidence.map((item) => [item.kind, item.refId, item.revisionId, item.sha256]),
  })}`;
  const body = { ...input, riskId };
  return customerSuccessRiskSchema.parse({ ...body, riskSha256: canonicalJsonSha256(body) });
}

function timeline(input: Omit<CustomerSuccessTimelineItem, "eventId">) {
  return customerSuccessTimelineItemSchema.parse({
    ...input,
    eventId: `customer-success-timeline:${canonicalJsonSha256(input)}`,
  });
}

function workflowRecommendation(
  generatedAt: string,
  evidence: CustomerSuccessEvidenceRef,
  workflowId: NonNullable<CustomerSuccessNextAction["workflowId"]>,
  title: string,
  reason: string,
): Omit<CustomerSuccessNextAction, "recommendationId" | "recommendationSha256"> {
  return {
    policyVersion: CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION,
    action: "start_workflow",
    workflowId,
    title,
    reason,
    confidenceBasisPoints: 8_500,
    uncertainty: ["This is a recommendation; starting the workflow remains a separate governed action."],
    evidence: [evidence],
    freshness: freshness([evidence], generatedAt, ["current"]),
    authoritative: false,
    suggested: true,
    generatedAt,
  };
}

function evidenceForAccount(account: CustomerAccountRevision): CustomerSuccessEvidenceRef {
  return {
    kind: "account_revision",
    refId: account.accountId,
    revisionId: account.revisionId,
    sha256: account.accountSha256,
    observedAt: account.revisedAt,
    label: `Account 360 revision ${account.revision}`,
  };
}

function evidenceForFact(fact: CustomerFactRevision): CustomerSuccessEvidenceRef {
  return {
    kind: "fact_revision",
    refId: fact.factId,
    revisionId: fact.factRevisionId,
    sha256: fact.factSha256,
    observedAt: fact.source.observedAt,
    label: `${titleCase(fact.kind)} · ${fact.factKey}`,
  };
}

function evidenceForHealth(score: CustomerHealthScore): CustomerSuccessEvidenceRef {
  return {
    kind: "health_score",
    refId: score.scoreId,
    revisionId: score.scoreRevisionId,
    sha256: score.scoreSha256,
    observedAt: score.evaluatedAt,
    label: `Health · ${score.status.replace("_", " ")}`,
  };
}

function evidenceForWorkflow(run: CustomerSuccessWorkflowRunRevision): CustomerSuccessEvidenceRef {
  return {
    kind: "workflow_run",
    refId: run.runId,
    revisionId: run.runRevisionId,
    sha256: run.runSha256,
    observedAt: run.outcome.recordedAt,
    label: workflowLabel(run.workflowId),
  };
}

function evidenceForMeeting(meeting: MeetingRevision): CustomerSuccessEvidenceRef {
  return {
    kind: "meeting_revision",
    refId: meeting.meetingId,
    revisionId: meeting.meetingRevisionId,
    sha256: meeting.meetingSha256,
    observedAt: meeting.revisedAt,
    label: meeting.title,
  };
}

function evidenceForApproval(approval: CustomerSuccessApproval): CustomerSuccessEvidenceRef {
  return {
    kind: "approval",
    refId: approval.approvalId,
    revisionId: null,
    sha256: approval.approvalSha256,
    observedAt: approval.createdAt,
    label: approval.title,
  };
}

function freshness(
  evidence: readonly CustomerSuccessEvidenceRef[],
  evaluatedAt: string,
  sourceStates: readonly string[],
): CustomerSuccessFreshness {
  const states = sourceStates.map((state) =>
    state === "stale" || state === "expired" || state === "future" ? "stale"
      : state === "unknown" ? "unknown"
        : "current"
  );
  const unique = new Set(states);
  const status = unique.size > 1
    ? "mixed" as const
    : unique.has("stale")
      ? "stale" as const
      : unique.has("unknown")
        ? "unknown" as const
        : "current" as const;
  return {
    status,
    oldestObservedAt: evidence.map((item) => item.observedAt).sort()[0] || null,
    evaluatedAt,
  };
}

function renewalDueSoon(facts: readonly CustomerFactView[], generatedAt: string) {
  const now = Date.parse(generatedAt);
  const windowEnd = now + 120 * 24 * 60 * 60 * 1_000;
  return facts.some((view) => {
    if (view.fact.value.kind !== "renewal" || ["renewed", "lost"].includes(view.fact.value.status)) return false;
    const renewalAt = Date.parse(view.fact.value.renewalAt);
    return renewalAt >= now && renewalAt <= windowEnd;
  });
}

function hasOpenWorkflow(
  runs: readonly CustomerSuccessWorkflowRunRevision[],
  workflowId: CustomerSuccessWorkflowRunRevision["workflowId"],
) {
  return runs.some((run) => run.workflowId === workflowId && run.outcome.status === "in_progress");
}

function isOverdue(commitment: CustomerSuccessCommitment, generatedAt: string) {
  return Boolean(
    commitment.dueAt &&
    !["completed", "dismissed"].includes(commitment.status) &&
    commitment.dueAt < generatedAt,
  );
}

function factSummary(fact: CustomerFactRevision) {
  if (fact.state === "retracted") return `${fact.factKey} was retracted while its immutable history was retained.`;
  if (fact.value.kind === "risk") return `${fact.value.title} is ${fact.value.status} with ${fact.value.severity} severity.`;
  if (fact.value.kind === "renewal") return `Renewal is ${fact.value.status} for ${fact.value.renewalAt.slice(0, 10)}.`;
  if (fact.value.kind === "case") return `${fact.value.title} is ${fact.value.status} with ${fact.value.severity} severity.`;
  return `${fact.factKey} was recorded from ${fact.source.sourceLabel}.`;
}

function riskConfidence(riskValue: CustomerSuccessRisk) {
  if (riskValue.source === "fact") return riskValue.freshness.status === "current" ? 9_000 : 6_500;
  if (riskValue.source === "health") return riskValue.freshness.status === "current" ? 8_500 : 5_500;
  return 9_000;
}

function riskUncertainty(riskValue: CustomerSuccessRisk) {
  return riskValue.freshness.status === "current"
    ? []
    : ["The cited risk evidence is not fully current."];
}

function workflowLabel(value: string) {
  return titleCase(value).replace("Qbr Ebr", "QBR / EBR");
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function canonicalTimestamp(value: string) {
  return new Date(value).toISOString();
}

function dedupeByDigest<T>(values: readonly T[], digest: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = digest(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareRisks(left: CustomerSuccessRisk, right: CustomerSuccessRisk) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return rank[left.severity] - rank[right.severity] || left.title.localeCompare(right.title);
}

function comparePortfolioItems(
  left: CustomerSuccessAccountIntelligence["portfolio"],
  right: CustomerSuccessAccountIntelligence["portfolio"],
) {
  const rank = { urgent: 0, attention: 1, watch: 2, unknown: 3, stable: 4 } as const;
  return rank[left.attention] - rank[right.attention] ||
    right.counts.pendingApprovals - left.counts.pendingApprovals ||
    right.counts.overdueCommitments - left.counts.overdueCommitments ||
    left.name.localeCompare(right.name);
}
