import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION =
  "p10.14-customer-success-intelligence:1" as const;

const opaqueIdSchema = z.string().trim().min(1).max(300);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);

export const customerSuccessEvidenceRefSchema = z.object({
  kind: z.enum([
    "account_revision",
    "fact_revision",
    "health_score",
    "workflow_run",
    "meeting_revision",
    "approval",
  ]),
  refId: opaqueIdSchema,
  revisionId: opaqueIdSchema.nullable(),
  sha256: sha256Schema.nullable(),
  observedAt: canonicalTimestampSchema,
  label: z.string().trim().min(1).max(240),
}).strict();

export const customerSuccessFreshnessSchema = z.object({
  status: z.enum(["current", "stale", "mixed", "unknown"]),
  oldestObservedAt: canonicalTimestampSchema.nullable(),
  evaluatedAt: canonicalTimestampSchema,
}).strict();

const evidenceListSchema = z.array(customerSuccessEvidenceRefSchema).min(1).max(50);

export const customerSuccessNextActionSchema = z.object({
  policyVersion: z.literal(CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION),
  recommendationId: z.string().regex(/^customer-success-recommendation:[a-f0-9]{64}$/),
  action: z.enum([
    "review_approval",
    "resolve_risk",
    "advance_commitment",
    "evaluate_health",
    "refresh_evidence",
    "start_workflow",
    "monitor_account",
  ]),
  workflowId: z.enum([
    "onboarding",
    "adoption_review",
    "risk_escalation",
    "renewal_planning",
    "qbr_ebr",
    "meeting_prep_follow_up",
    "support_escalation",
    "expansion_discovery",
  ]).nullable(),
  title: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(1_000),
  confidenceBasisPoints: z.number().int().min(0).max(10_000),
  uncertainty: z.array(z.string().trim().min(1).max(500)).max(12),
  evidence: evidenceListSchema,
  freshness: customerSuccessFreshnessSchema,
  authoritative: z.literal(false),
  suggested: z.literal(true),
  generatedAt: canonicalTimestampSchema,
  recommendationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { recommendationSha256, ...body } = value;
  if (recommendationSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["recommendationSha256"],
      message: "Recommendation digest does not match its projection.",
    });
  }
  if ((value.action === "start_workflow") !== (value.workflowId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["workflowId"],
      message: "Only a workflow recommendation may name a workflow.",
    });
  }
});

export const customerSuccessRiskSchema = z.object({
  riskId: z.string().regex(/^customer-success-risk:[a-f0-9]{64}$/),
  source: z.enum(["account", "fact", "health", "workflow", "commitment", "data_quality"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  status: z.enum(["open", "mitigating"]),
  title: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1_000),
  evidence: evidenceListSchema,
  freshness: customerSuccessFreshnessSchema,
  riskSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { riskSha256, ...body } = value;
  if (riskSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["riskSha256"], message: "Risk digest does not match." });
  }
});

export const customerSuccessCommitmentSchema = z.object({
  commitmentId: opaqueIdSchema,
  meetingId: opaqueIdSchema,
  meetingRevisionId: opaqueIdSchema,
  summary: z.string().trim().min(1).max(2_000),
  owner: z.string().trim().min(1).max(240).nullable(),
  dueAt: canonicalTimestampSchema.nullable(),
  status: z.enum(["recorded", "accepted", "completed", "dismissed"]),
  workItemId: opaqueIdSchema.nullable(),
  evidence: evidenceListSchema,
  freshness: customerSuccessFreshnessSchema,
  commitmentSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { commitmentSha256, ...body } = value;
  if (commitmentSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["commitmentSha256"], message: "Commitment digest does not match." });
  }
});

export const customerSuccessApprovalSchema = z.object({
  kind: z.enum(["tool", "workflow"]),
  approvalId: opaqueIdSchema,
  title: z.string().trim().min(1).max(300),
  status: z.enum(["approval_required", "reconciliation_required", "waiting_approval"]),
  riskLevel: z.number().int().min(0).max(3),
  reason: z.string().trim().min(1).max(1_000).nullable(),
  createdAt: canonicalTimestampSchema,
  projectId: opaqueIdSchema.nullable(),
  runId: opaqueIdSchema.nullable(),
  approvalSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { approvalSha256, ...body } = value;
  if (approvalSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["approvalSha256"], message: "Approval digest does not match." });
  }
});

export const customerSuccessTimelineItemSchema = z.object({
  eventId: z.string().regex(/^customer-success-timeline:[a-f0-9]{64}$/),
  kind: z.enum([
    "account_revision",
    "fact_revision",
    "health_evaluation",
    "workflow_started",
    "workflow_outcome",
    "meeting_commitment",
  ]),
  occurredAt: canonicalTimestampSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(2_000),
  evidence: evidenceListSchema,
}).strict();

export const customerSuccessPortfolioItemSchema = z.object({
  accountId: z.string().regex(/^customer-account:[a-f0-9]{64}$/),
  accountRevisionId: opaqueIdSchema,
  accountSha256: sha256Schema,
  name: z.string().trim().min(1).max(240),
  lifecycle: z.enum(["prospect", "onboarding", "active", "at_risk", "churned", "archived"]),
  ownerName: z.string().trim().min(1).max(240),
  attention: z.enum(["urgent", "attention", "watch", "stable", "unknown"]),
  health: z.object({
    status: z.enum(["healthy", "watch", "at_risk", "unknown"]),
    scoreBasisPoints: z.number().int().min(0).max(10_000).nullable(),
    confidenceBasisPoints: z.number().int().min(0).max(10_000),
    coverageBasisPoints: z.number().int().min(0).max(10_000),
    current: z.boolean(),
    evaluatedAt: canonicalTimestampSchema.nullable(),
  }).strict(),
  counts: z.object({
    openRisks: z.number().int().nonnegative(),
    criticalRisks: z.number().int().nonnegative(),
    openCommitments: z.number().int().nonnegative(),
    overdueCommitments: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    staleFacts: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
  }).strict(),
  nextBestAction: customerSuccessNextActionSchema,
  changedAt: canonicalTimestampSchema,
}).strict();

export const customerSuccessAccountIntelligenceSchema = z.object({
  policyVersion: z.literal(CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION),
  generatedAt: canonicalTimestampSchema,
  portfolio: customerSuccessPortfolioItemSchema,
  nextBestAction: customerSuccessNextActionSchema,
  risks: z.array(customerSuccessRiskSchema).max(250),
  commitments: z.array(customerSuccessCommitmentSchema).max(500),
  approvals: z.array(customerSuccessApprovalSchema).max(100),
  timeline: z.array(customerSuccessTimelineItemSchema).max(250),
  projectionSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { projectionSha256, ...body } = value;
  if (projectionSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["projectionSha256"], message: "Intelligence digest does not match." });
  }
});

export const customerSuccessPortfolioSchema = z.object({
  policyVersion: z.literal(CUSTOMER_SUCCESS_INTELLIGENCE_POLICY_VERSION),
  generatedAt: canonicalTimestampSchema,
  accounts: z.array(customerSuccessPortfolioItemSchema).max(200),
  counts: z.object({
    total: z.number().int().nonnegative(),
    urgent: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    overdueCommitments: z.number().int().nonnegative(),
  }).strict(),
  projectionSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { projectionSha256, ...body } = value;
  if (projectionSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["projectionSha256"], message: "Portfolio digest does not match." });
  }
});

export type CustomerSuccessEvidenceRef = z.infer<typeof customerSuccessEvidenceRefSchema>;
export type CustomerSuccessFreshness = z.infer<typeof customerSuccessFreshnessSchema>;
export type CustomerSuccessNextAction = z.infer<typeof customerSuccessNextActionSchema>;
export type CustomerSuccessRisk = z.infer<typeof customerSuccessRiskSchema>;
export type CustomerSuccessCommitment = z.infer<typeof customerSuccessCommitmentSchema>;
export type CustomerSuccessApproval = z.infer<typeof customerSuccessApprovalSchema>;
export type CustomerSuccessTimelineItem = z.infer<typeof customerSuccessTimelineItemSchema>;
export type CustomerSuccessPortfolioItem = z.infer<typeof customerSuccessPortfolioItemSchema>;
export type CustomerSuccessAccountIntelligence = z.infer<typeof customerSuccessAccountIntelligenceSchema>;
export type CustomerSuccessPortfolio = z.infer<typeof customerSuccessPortfolioSchema>;
