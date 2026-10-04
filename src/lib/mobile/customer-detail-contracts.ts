import { z } from "zod";

import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { customerHealthPolicySchema, customerHealthScoreSchema } from "@/lib/customer-success/health-contracts";
import { customerSuccessAccountIntelligenceSchema } from "@/lib/customer-success/intelligence-contracts";
import { SALESFORCE_OBJECT_TYPES, salesforceObjectCursorSchema, salesforceObjectTypeSchema, salesforceSyncCursorSchema, salesforceSyncHealthSchema } from "@/lib/customer-success/salesforce-contracts";
import { SALESFORCE_CREATE_OBJECTS, SALESFORCE_UPDATE_OBJECTS, SALESFORCE_WRITE_TOOL_IDS, salesforceWriteCommitSchema, salesforceWriteOperationId, salesforceWriteToolMetadata } from "@/lib/customer-success/salesforce-write-contracts";
import { CUSTOMER_SUCCESS_WORKFLOW_IDS, CUSTOMER_SUCCESS_WORKFLOW_PACK, customerSuccessWorkflowDefinitionSchema, customerSuccessWorkflowRunRevisionSchema } from "@/lib/customer-success/workflow-contracts";
import { nativeCustomerContextSchema, nativeCustomerReadQuerySchema, type NativeCustomerReadScope } from "@/lib/mobile/customer-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Standalone GET publication candidates only. These schemas do not enroll a
// capability, authorize a write, follow provider URLs, or infer complete history.
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const opaqueId = z.string().trim().min(1).max(240);
const accountId = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const canonicalTime = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value, "Timestamp must use canonical UTC ISO format.");
export const nativeCustomerHealthQuerySchema = nativeCustomerReadQuerySchema.extend({ historyLimit: z.number().int().min(1).max(100).default(20) }).strict();
export const nativeCustomerIntelligenceQuerySchema = nativeCustomerReadQuerySchema.extend({ historyLimit: z.number().int().min(1).max(250).default(100), timelineLimit: z.number().int().min(1).max(250).default(100) }).strict();
export const nativeCustomerWorkflowsQuerySchema = nativeCustomerReadQuerySchema.extend({ limit: z.number().int().min(1).max(100).default(50) }).strict();
export const nativeCustomerSalesforceStatusQuerySchema = nativeCustomerReadQuerySchema;

function receipt(operation: Parameters<typeof getAppServiceOperationContract>[0]) {
  const expected = getAppServiceOperationContract(operation);
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.action !== expected.action || value.resourceType !== expected.resourceType || value.eventContract !== expected.eventContract || value.accessMode !== "read" || value.idempotencyKeySha256 !== null) issue(context, "Receipt does not describe this exact read operation.");
  });
}
function outcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body)) issue(context, "Receipt differs from the returned body.");
}
function unique(ids: readonly string[], context: z.RefinementCtx) {
  if (new Set(ids).size !== ids.length) issue(context, "Duplicate exact identities are invalid.");
}
function revisionMatches(id: string, revision: string) {
  return revision.startsWith(`${id}:v`) && /^[1-9][0-9]*$/.test(revision.slice(id.length + 2)) && Number.isSafeInteger(Number(revision.slice(id.length + 2)));
}
function authority(scope: NativeCustomerReadScope, value: { context: z.infer<typeof nativeCustomerContextSchema>; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx) {
  if (scope.workspaceId && value.context.workspaceId !== scope.workspaceId) issue(context, "Workspace differs from the requested scope.");
  if (value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: scope.tenantId, actorId: scope.requestActorId, role: scope.role, executionScope: null })) issue(context, "Receipt belongs to another tenant, request actor, or role.");
}

export const nativeCustomerHealthResponseSchema = z.object({
  context: nativeCustomerContextSchema, policy: customerHealthPolicySchema,
  score: customerHealthScoreSchema.nullable(), history: z.array(customerHealthScoreSchema).max(100),
  serviceReceipt: receipt("app.customer_accounts.health.show"),
}).strict().superRefine((value, context) => {
  outcome(value, context);
  unique(value.history.map((score) => score.scoreRevisionId), context);
  if (value.serviceReceipt.resourceCount !== (value.score ? 1 : 0)) issue(context, "Health receipt count differs from the current score.");
  const scores = [...(value.score ? [value.score] : []), ...value.history];
  for (const score of scores) {
    if (score.workspaceId !== value.context.workspaceId || !revisionMatches(score.accountId, score.accountRevisionId)) issue(context, "Health score differs from the account workspace or revision identity.");
    if (scores[0] && (score.accountId !== scores[0].accountId || score.tenantId !== scores[0].tenantId)) issue(context, "Health histories mix account or tenant identities.");
    for (const factor of score.factors) for (const evidence of factor.evidence) {
      if (!revisionMatches(evidence.factId, evidence.factRevisionId)) issue(context, "Health evidence differs from its exact fact identity.");
    }
  }
  // Current score and history are separate live reads. They need not contain
  // the same latest revision, and a missing score makes no health claim.
});
export function nativeCustomerHealthResponseForScopeSchema(scope: NativeCustomerReadScope & { accountId: string }) {
  return nativeCustomerHealthResponseSchema.superRefine((value, context) => {
    authority(scope, value, context);
    for (const score of [...(value.score ? [value.score] : []), ...value.history]) {
      if (score.tenantId !== scope.tenantId || score.accountId !== scope.accountId) issue(context, "Health belongs to another selected account or tenant.");
    }
    // An empty HTTP response does not echo accountId. Binding that absence to
    // navigation still requires the exact request-generation fence.
  });
}

export const nativeCustomerIntelligenceResponseSchema = z.object({
  context: nativeCustomerContextSchema, intelligence: customerSuccessAccountIntelligenceSchema,
  serviceReceipt: receipt("app.customer_accounts.intelligence.show"),
}).strict().superRefine((value, context) => {
  outcome(value, context);
  const intelligence = value.intelligence, portfolio = intelligence.portfolio;
  if (value.serviceReceipt.resourceCount !== 1 || !revisionMatches(portfolio.accountId, portfolio.accountRevisionId)) issue(context, "Intelligence account revision or receipt count is invalid.");
  if (canonicalJsonSha256(intelligence.nextBestAction) !== canonicalJsonSha256(portfolio.nextBestAction)) issue(context, "Next-action projections disagree.");
  for (const value of Object.values(portfolio.counts)) if (!Number.isSafeInteger(value)) issue(context, "Intelligence counts must be safe integers.");
  unique(intelligence.risks.map((row) => row.riskId), context);
  // Commitments are identified inside a meeting, not across all meetings.
  unique(intelligence.commitments.map((row) => `${row.meetingId}\u0000${row.commitmentId}`), context);
  unique(intelligence.approvals.map((row) => `${row.kind}\u0000${row.approvalId}`), context);
  unique(intelligence.timeline.map((row) => row.eventId), context);
});
export function nativeCustomerIntelligenceResponseForScopeSchema(scope: NativeCustomerReadScope & { accountId: string }) {
  return nativeCustomerIntelligenceResponseSchema.superRefine((value, context) => {
    authority(scope, value, context);
    if (value.intelligence.portfolio.accountId !== scope.accountId) issue(context, "Intelligence belongs to another selected account.");
  });
}

const workflowDefinition = customerSuccessWorkflowDefinitionSchema.safeExtend({
  inputFields: z.array(customerSuccessWorkflowDefinitionSchema.shape.inputFields.element.extend({ fieldId: z.string().regex(/^[a-z][a-zA-Z0-9]*$/).max(80) }).strict()).min(3).max(20),
  externalActionPolicy: customerSuccessWorkflowDefinitionSchema.shape.externalActionPolicy.extend({
    allowedCommunicationToolIds: z.tuple([z.literal("app.communications.drafts.create")]),
    allowedCrmToolIdPrefixes: z.tuple([z.literal("app.customer_accounts.salesforce.")]),
  }).strict(),
});
export const nativeCustomerWorkflowsResponseSchema = z.object({
  context: nativeCustomerContextSchema,
  pack: z.array(workflowDefinition).length(CUSTOMER_SUCCESS_WORKFLOW_IDS.length),
  runs: z.array(customerSuccessWorkflowRunRevisionSchema).max(100),
  serviceReceipt: receipt("app.customer_accounts.workflows.list"),
}).strict().superRefine((value, context) => {
  outcome(value, context);
  unique(value.pack.map((definition) => definition.workflowId), context);
  unique(value.runs.map((run) => run.runId), context);
  if (value.serviceReceipt.resourceCount !== value.runs.length) issue(context, "Workflow receipt count differs from the bounded returned set.");
  for (const definition of value.pack) {
    if (definition.definitionSha256 !== CUSTOMER_SUCCESS_WORKFLOW_PACK.find((known) => known.workflowId === definition.workflowId)?.definitionSha256) issue(context, "Workflow pack differs from its published immutable definition.");
  }
  for (const run of value.runs) {
    if (run.workspaceId !== value.context.workspaceId || run.accountRevisionId !== `${run.accountId}:v${run.accountRevision}`) issue(context, "Workflow run differs from its account workspace or revision.");
    if (run.definitionSha256 !== value.pack.find((definition) => definition.workflowId === run.workflowId)?.definitionSha256) issue(context, "Run definition differs from the published workflow pack.");
    if (run.input.workflowId === "renewal_planning" && run.input.amountMinor !== null && !Number.isSafeInteger(run.input.amountMinor)) issue(context, "Renewal amount must be a safe integer.");
    unique(run.projectTaskIds.map((task) => task.taskKey), context);
    unique(run.projectTaskIds.map((task) => task.projectTaskId), context);
  }
});
export function nativeCustomerWorkflowsResponseForScopeSchema(scope: NativeCustomerReadScope & { accountId: string }) {
  return nativeCustomerWorkflowsResponseSchema.superRefine((value, context) => {
    authority(scope, value, context);
    for (const run of value.runs) if (run.tenantId !== scope.tenantId || run.accountId !== scope.accountId) issue(context, "Workflow belongs to another selected account or tenant.");
  });
}

const salesforceHealth = salesforceSyncHealthSchema.safeExtend({
  workspaceId: salesforceSyncHealthSchema.shape.workspaceId.max(240), lagSeconds: count.nullable(),
  cursor: salesforceSyncCursorSchema.safeExtend({ objects: z.record(salesforceObjectTypeSchema, salesforceObjectCursorSchema.safeExtend({ pagesSettled: count, recordsSettled: count })) }).nullable(),
});
export const nativeCustomerSalesforceFindingSchema = z.object({
  findingId: z.string().regex(/^salesforce-finding:[a-f0-9]{64}$/), objectType: salesforceObjectTypeSchema,
  externalIdSha256: sha, localRevisionId: z.string().regex(/^salesforce-revision:[a-f0-9]{64}$/).nullable(), remoteRevisionId: z.string().regex(/^salesforce-revision:[a-f0-9]{64}$/).nullable(),
  findingKind: z.enum(["missing_local", "missing_remote", "revision_mismatch", "concurrent_revision"]), findingSha256: sha, observedAt: canonicalTime,
}).strict().superRefine((value, context) => {
  if (value.findingId !== `salesforce-finding:${value.findingSha256}`) issue(context, "Finding identity differs from its recorded digest.");
  // The store omits connectionId, which participated in the finding digest.
  // Do not claim full digest verification from this public projection.
});
const recordTool = z.enum(SALESFORCE_WRITE_TOOL_IDS).exclude(["app.customer_accounts.salesforce.writes.configure"]);
export const nativeCustomerSalesforceWriteObservationSchema = z.object({
  operationId: z.string().regex(/^salesforce-write:[a-f0-9]{64}$/), toolExecutionId: opaqueId,
  toolId: recordTool, objectType: z.enum(SALESFORCE_UPDATE_OBJECTS), action: z.enum(["create", "update"]), customerAccountId: accountId,
  providerRecordIdSha256: sha.nullable(), requestSha256: sha, expectedTargetStateSha256: sha,
  state: z.enum(["prepared", "verified", "failed"]), providerAcknowledgementSha256: sha.nullable(), observedTargetStateSha256: sha.nullable(),
  verificationReasonCode: z.enum(["state_matched", "target_missing", "state_mismatch"]).nullable(), commit: salesforceWriteCommitSchema.nullable(),
  attemptCount: count, lastAttemptAt: canonicalTime.nullable(), completedAt: canonicalTime.nullable(), createdAt: canonicalTime, updatedAt: canonicalTime,
}).strict().superRefine((value, context) => {
  const metadata = salesforceWriteToolMetadata(value.toolId);
  if (value.operationId !== salesforceWriteOperationId(value.toolExecutionId) || value.action !== metadata.action || value.objectType !== metadata.objectType) issue(context, "Write observation differs from its exact execution/tool identity.");
  if ((value.attemptCount === 0) !== (value.lastAttemptAt === null)) issue(context, "Write attempt observation is inconsistent.");
  if (value.state === "prepared") {
    if (value.commit !== null || value.completedAt !== null || value.providerAcknowledgementSha256 !== null || value.observedTargetStateSha256 !== null || value.verificationReasonCode !== null) issue(context, "An unsettled write cannot claim a completion receipt.");
    // A prepared operation with attempts may have an unknown external effect.
    // This read model provides inspection, never a retry instruction.
  } else {
    const commit = value.commit;
    if (!commit || !value.completedAt) { issue(context, "A terminal write requires its observed settlement receipt."); return; }
    if (commit.operationId !== value.operationId || commit.toolId !== value.toolId || commit.objectType !== value.objectType || commit.action !== value.action || commit.verificationState !== value.state || commit.providerRecordIdSha256 !== value.providerRecordIdSha256 || commit.providerAcknowledgementSha256 !== value.providerAcknowledgementSha256 || commit.expectedTargetStateSha256 !== value.expectedTargetStateSha256 || commit.observedTargetStateSha256 !== value.observedTargetStateSha256 || commit.verificationReasonCode !== value.verificationReasonCode) issue(context, "Write receipt differs from its observed operation.");
  }
});
export const nativeCustomerSalesforceStatusResponseSchema = z.object({
  context: nativeCustomerContextSchema, health: salesforceHealth,
  findings: z.array(nativeCustomerSalesforceFindingSchema).max(50),
  writes: z.object({
    configured: z.boolean(), enabled: z.boolean(), mode: z.literal("approval_required"),
    createObjects: z.array(z.enum(SALESFORCE_CREATE_OBJECTS)).length(SALESFORCE_CREATE_OBJECTS.length),
    updateObjects: z.array(z.enum(SALESFORCE_UPDATE_OBJECTS)).length(SALESFORCE_UPDATE_OBJECTS.length),
    operations: z.array(nativeCustomerSalesforceWriteObservationSchema).max(25),
  }).strict(),
  authorizeUrl: z.string().min(1).max(2_000),
  webhook: z.object({ endpoint: z.literal("/api/webhooks/salesforce"), signature: z.literal("hmac-sha256-v1"), configured: z.boolean() }).strict(),
}).strict().superRefine((value, context) => {
  if (value.context.workspaceId !== value.health.workspaceId) issue(context, "Salesforce health differs from the selected workspace.");
  unique(value.health.objectScope, context);
  if (value.health.objectScope.length !== SALESFORCE_OBJECT_TYPES.length) issue(context, "Salesforce object coverage is incomplete.");
  unique(value.writes.createObjects, context); unique(value.writes.updateObjects, context);
  unique(value.findings.map((finding) => finding.findingId), context); unique(value.writes.operations.map((operation) => operation.operationId), context);
  if (value.writes.configured && !value.writes.enabled) issue(context, "Disabled Salesforce writes cannot be configured as enabled.");
  if (value.health.connected && value.health.connectionId === null) issue(context, "A connected Salesforce status requires an exact connection identity.");
  if (value.authorizeUrl !== `/api/oauth/salesforce/authorize?returnTo=${encodeURIComponent("/app/accounts")}&workspaceId=${encodeURIComponent(value.context.workspaceId)}`) issue(context, "Salesforce authorization metadata differs from the exact workspace route.");
});
// Salesforce currently emits no service receipt or actor/tenant identity. This
// verifies only its explicit workspace; fresh owner/API authority and generation
// fencing remain necessary. The URL is inert metadata, not an OAuth capability.
export function nativeCustomerSalesforceStatusResponseForWorkspaceSchema(workspaceId: string) {
  return nativeCustomerSalesforceStatusResponseSchema.superRefine((value, context) => {
    if (value.context.workspaceId !== workspaceId) issue(context, "Salesforce response belongs to another workspace.");
  });
}

export const nativeCustomerDetailContractSchemas = Object.freeze({
  NativeCustomerHealthQuery: nativeCustomerHealthQuerySchema,
  NativeCustomerIntelligenceQuery: nativeCustomerIntelligenceQuerySchema,
  NativeCustomerWorkflowsQuery: nativeCustomerWorkflowsQuerySchema,
  NativeCustomerSalesforceStatusQuery: nativeCustomerSalesforceStatusQuerySchema,
  NativeCustomerHealthResponse: nativeCustomerHealthResponseSchema,
  NativeCustomerIntelligenceResponse: nativeCustomerIntelligenceResponseSchema,
  NativeCustomerWorkflowsResponse: nativeCustomerWorkflowsResponseSchema,
  NativeCustomerSalesforceStatusResponse: nativeCustomerSalesforceStatusResponseSchema,
});
