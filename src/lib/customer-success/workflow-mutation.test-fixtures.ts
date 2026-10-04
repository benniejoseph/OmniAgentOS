import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  buildCustomerSuccessOutcomeReceipt, buildCustomerSuccessWorkflowRunRevision, getCustomerSuccessWorkflowDefinition,
  type CustomerSuccessWorkflowId,
} from "@/lib/customer-success/workflow-contracts";
import {
  buildCustomerSuccessWorkflowNativeAcceptance, buildCustomerSuccessWorkflowNativeIntent,
  customerSuccessWorkflowNativeOutcomeRequestSchema, customerSuccessWorkflowNativeStartRequestSchema,
} from "@/lib/customer-success/workflow-mutation-contracts";
import type { SecurityContext } from "@/lib/security/types";

export const workflowContext: SecurityContext = { tenantId: "tenant-native-workflow", actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-a111-111111111111", email: "owner@example.test", sessionId: "session-workflow", tenantName: "Customer" } };
export const workflowActorId = `actor:${workflowContext.auth!.userId}`;
export const workflowWorkspaceId = `workspace:personal:${workflowContext.auth!.userId}`;
export const workflowAccountId = `customer-account:${"a".repeat(64)}`;
export const workflowAt = "2026-10-05T12:00:00.123Z";
const later = "2026-11-05T12:00:00.123Z";
const specificInputs = {
  onboarding: { successCriteria: ["Agreed activation milestones"], productNames: ["Service"], stakeholderIds: ["person:one"] },
  adoption_review: { periodStartAt: workflowAt, periodEndAt: later, adoptionGoals: ["Review active use"], productIds: ["product:one"] },
  risk_escalation: { riskTitle: "Adoption stalled", severity: "high", signals: ["Use declined"], executiveSponsorId: null },
  renewal_planning: { renewalAt: later, renewalGoals: ["Confirm renewal terms"], amountMinor: 1_250_000, currency: "USD" },
  qbr_ebr: { reviewKind: "qbr", meetingAt: later, periodStartAt: workflowAt, periodEndAt: later, audience: ["Customer team"], agendaObjectives: ["Review progress"] },
  meeting_prep_follow_up: { meetingId: "meeting:one", phase: "prep", participantIds: ["person:one"], meetingObjectives: ["Agree next steps"] },
  support_escalation: { caseIds: ["support-case:one"], severity: "high", customerImpact: "Service disruption", requestedOutcome: "Restore the service" },
  expansion_discovery: { hypotheses: ["Additional team may benefit"], stakeholderIds: ["person:one"], discoveryWindowEndAt: later },
};
export function workflowFixture(workflowId: CustomerSuccessWorkflowId = "risk_escalation", operation: "start" | "outcome" = "start") {
  const definition = getCustomerSuccessWorkflowDefinition(workflowId), key = operation === "start" ? "workflow-start-key" : "workflow-outcome-key";
  const start = customerSuccessWorkflowNativeStartRequestSchema.parse({ contract: "customer-success-workflow-start-request:1", workspaceId: workflowWorkspaceId,
    expectedAccountRevision: 3, expectedAccountSha256: "b".repeat(64), expectedDefinitionSha256: definition.definitionSha256,
    input: { workflowId, objective: "Prepare the agreed customer plan.", targetDate: null, ...specificInputs[workflowId] } });
  const common = { tenantId: workflowContext.tenantId, workspaceId: workflowWorkspaceId, accountId: workflowAccountId, canonicalActorId: workflowActorId };
  const startIntent = buildCustomerSuccessWorkflowNativeIntent({ ...common, idempotencyKey: "workflow-start-key", request: start });
  const body = {
    tenantId: common.tenantId, workspaceId: common.workspaceId, accountId: common.accountId,
    accountRevisionId: `${workflowAccountId}:v3`, accountRevision: 3, accountSha256: start.expectedAccountSha256,
    runId: startIntent.runId, workflowId, definitionSha256: definition.definitionSha256, input: start.input,
    owner: { ownerKind: "actor" as const, ownerId: workflowActorId, displayName: "Customer owner" }, ownerActorId: workflowActorId,
    projectId: "project:workflow-one", projectTaskIds: definition.projectTemplate.tasks.map((task, index) => ({ taskKey: task.key, projectTaskId: `project-task:${index + 1}` })),
    allowedPurposeIds: ["customer_success.account.read"] as ["customer_success.account.read"],
  };
  const startedRun = buildCustomerSuccessWorkflowRunRevision({ ...body, revision: 1, outcome: buildCustomerSuccessOutcomeReceipt({
    status: "in_progress", summary: "", artifactReceipts: [], nextAction: definition.defaultNextAction,
    recordedByActorId: workflowActorId, recordedAt: workflowAt,
  }) });
  const outcome = customerSuccessWorkflowNativeOutcomeRequestSchema.parse({ contract: "customer-success-workflow-outcome-request:1", workspaceId: workflowWorkspaceId,
    runId: startedRun.runId, expectedAccountRevision: 4, expectedAccountSha256: "c".repeat(64),
    expectedRunRevision: 1, expectedRunSha256: startedRun.runSha256, expectedDefinitionSha256: definition.definitionSha256,
    status: "blocked", summary: "Customer confirmation is pending.", artifactReceipts: [], nextAction: "Request confirmation through the governed project." });
  const request = operation === "start" ? start : outcome;
  const intent = buildCustomerSuccessWorkflowNativeIntent({ ...common, idempotencyKey: key, request });
  const run = operation === "start" ? startedRun : buildCustomerSuccessWorkflowRunRevision({ ...body, revision: 2,
    outcome: buildCustomerSuccessOutcomeReceipt({ status: outcome.status, summary: outcome.summary, artifactReceipts: outcome.artifactReceipts,
      nextAction: outcome.nextAction, recordedByActorId: workflowActorId, recordedAt: later }) });
  const acceptance = buildCustomerSuccessWorkflowNativeAcceptance(intent, run);
  const currentAccount = { accountId: workflowAccountId, revisionId: `${workflowAccountId}:v${request.expectedAccountRevision}`,
    revision: request.expectedAccountRevision, accountSha256: request.expectedAccountSha256 };
  return { ...common, key, definition, request, start, outcome, intent, run, startedRun, acceptance, currentAccount,
    committed: { currentAccount, acceptance, replayed: false } };
}
export function workflowAccess(canWrite = true) {
  return { actorBinding: { canonicalActorId: workflowActorId, readableOwnerActorIds: [workflowActorId, workflowContext.actorId] },
    authority: { initiatingActorId: workflowActorId, workspaceId: workflowWorkspaceId, accessLevel: canWrite ? "manager" : "reader",
      canWrite, authoritySha256: "d".repeat(64) } };
}
export function workflowCaller(operation?: "start" | "outcome") {
  if (!operation) return createAppServiceCaller({ context: workflowContext });
  const fixture = workflowFixture("risk_escalation", operation);
  return createRequestMutationAppServiceCaller(new Request("http://localhost/api/customer-accounts/account/workflows", {
    method: operation === "start" ? "POST" : "PATCH", headers: { "Idempotency-Key": fixture.key },
  }), workflowContext, { purpose: `api.customer-success-workflow.${operation}`, workspaceId: workflowWorkspaceId,
    causationId: operation === "start" ? workflowAccountId : fixture.run.runId });
}
