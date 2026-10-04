import { z } from "zod";
import {
  CUSTOMER_SUCCESS_WORKFLOW_IDS, customerSuccessOutcomeReceiptSchema, customerSuccessRunId,
  customerSuccessWorkflowInputSchema, customerSuccessWorkflowRunRevisionSchema,
  type CustomerSuccessWorkflowRunRevision,
} from "@/lib/customer-success/workflow-contracts";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

export const CUSTOMER_SUCCESS_WORKFLOW_NATIVE_START_CONTRACT = "customer-success-workflow-start-request:1" as const;
export const CUSTOMER_SUCCESS_WORKFLOW_NATIVE_OUTCOME_CONTRACT = "customer-success-workflow-outcome-request:1" as const;
export const CUSTOMER_SUCCESS_WORKFLOW_NATIVE_INTENT_CONTRACT = "customer-success-workflow-intent:1" as const;
export const CUSTOMER_SUCCESS_WORKFLOW_NATIVE_ACCEPTANCE_CONTRACT = "customer-success-workflow-acceptance:1" as const;
export const CUSTOMER_SUCCESS_WORKFLOW_NATIVE_READ_CONTRACT = "customer-success-workflow-read:1" as const;
export const CUSTOMER_SUCCESS_WORKFLOW_NATIVE_REVISION_MAX = 2_147_483_647;
const revision = z.number().int().min(1).max(CUSTOMER_SUCCESS_WORKFLOW_NATIVE_REVISION_MAX);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const workspace = opaque.regex(/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const customerSuccessWorkflowNativeAccountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
export const customerSuccessWorkflowNativeRunIdSchema = z.string().regex(/^customer-success-run:[a-f0-9]{64}$/);
const accountId = customerSuccessWorkflowNativeAccountIdSchema, runId = customerSuccessWorkflowNativeRunIdSchema;
const actor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const at = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const accountPin = { expectedAccountRevision: revision, expectedAccountSha256: sha };
const nativeInput = customerSuccessWorkflowInputSchema.superRefine((value, context) => {
  if (value.workflowId === "renewal_planning" && value.amountMinor !== null && !Number.isSafeInteger(value.amountMinor)) {
    context.addIssue({ code: "custom", message: "Renewal money must be a safe integer." });
  }
});
export const customerSuccessWorkflowNativeStartFieldsSchema = z.object({
  ...accountPin, expectedDefinitionSha256: sha, input: nativeInput,
}).strict();
export const customerSuccessWorkflowNativeOutcomeFieldsSchema = z.object({
  ...accountPin, runId, expectedRunRevision: revision, expectedRunSha256: sha, expectedDefinitionSha256: sha,
  status: z.enum(["completed", "blocked", "cancelled"]), summary: z.string().trim().min(1).max(4_000),
  artifactReceipts: customerSuccessOutcomeReceiptSchema.shape.artifactReceipts.refine(
    (receipts) => new Set(receipts.map((receipt) => receipt.artifactKey)).size === receipts.length,
    { message: "Artifact receipt keys must be unique." },
  ),
  nextAction: z.string().trim().min(1).max(500),
}).strict();
export const customerSuccessWorkflowNativeStartRequestSchema = customerSuccessWorkflowNativeStartFieldsSchema.extend({
  contract: z.literal(CUSTOMER_SUCCESS_WORKFLOW_NATIVE_START_CONTRACT), workspaceId: workspace,
}).strict();
export const customerSuccessWorkflowNativeOutcomeRequestSchema = customerSuccessWorkflowNativeOutcomeFieldsSchema.extend({
  contract: z.literal(CUSTOMER_SUCCESS_WORKFLOW_NATIVE_OUTCOME_CONTRACT), workspaceId: workspace,
}).strict();
const intentBase = { schemaVersion: z.literal(1), contract: z.literal(CUSTOMER_SUCCESS_WORKFLOW_NATIVE_INTENT_CONTRACT),
  tenantId: opaque, workspaceId: workspace, accountId, runId, canonicalActorId: actor, idempotencyKeySha256: sha };
export const customerSuccessWorkflowNativeIntentSchema = z.discriminatedUnion("operation", [
  z.object({ ...intentBase, operation: z.literal("start"), request: customerSuccessWorkflowNativeStartFieldsSchema }).strict(),
  z.object({ ...intentBase, operation: z.literal("outcome"), request: customerSuccessWorkflowNativeOutcomeFieldsSchema }).strict(),
]).superRefine((value, context) => {
  if (value.operation === "outcome" && value.request.runId !== value.runId) {
    context.addIssue({ code: "custom", message: "Outcome intent must name its exact run." });
  }
});
export const customerSuccessWorkflowNativeCurrentAccountSchema = z.object({
  accountId, revisionId: opaque, revision, accountSha256: sha,
}).strict().refine((value) => value.revisionId === `${value.accountId}:v${value.revision}`,
  { message: "Current Account revision identity is inconsistent." });
const taskMapping = customerSuccessWorkflowRunRevisionSchema.shape.projectTaskIds.refine((tasks) =>
  new Set(tasks.map((task) => task.taskKey)).size === tasks.length &&
  new Set(tasks.map((task) => task.projectTaskId)).size === tasks.length,
{ message: "Workflow task mapping must be unique." });
const acceptanceBody = z.object({
  schemaVersion: z.literal(1), contract: z.literal(CUSTOMER_SUCCESS_WORKFLOW_NATIVE_ACCEPTANCE_CONTRACT),
  operation: z.enum(["start", "outcome"]), tenantId: opaque, workspaceId: workspace, accountId, runId, canonicalActorId: actor,
  idempotencyKeySha256: sha, requestSha256: sha,
  reviewedAccountRevisionId: opaque, reviewedAccountRevision: revision, reviewedAccountSha256: sha,
  runAccountRevisionId: opaque, runAccountRevision: revision, runAccountSha256: sha,
  workflowId: z.enum(CUSTOMER_SUCCESS_WORKFLOW_IDS), definitionSha256: sha, inputSha256: sha,
  runRevisionId: opaque, runRevision: revision, runSha256: sha,
  projectId: opaque, projectTaskIds: taskMapping,
  outcomeStatus: z.enum(["in_progress", "completed", "blocked", "cancelled"]), outcomeReceiptSha256: sha,
  acceptedAt: at, effectAuthority: z.literal("none"),
}).strict();
export const customerSuccessWorkflowNativeAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: sha }).strict().superRefine((value, context) => {
  const { acceptanceSha256, ...body } = value;
  if (acceptanceSha256 !== canonicalJsonSha256(body) ||
    value.reviewedAccountRevisionId !== `${value.accountId}:v${value.reviewedAccountRevision}` ||
    value.runAccountRevisionId !== `${value.accountId}:v${value.runAccountRevision}` ||
    value.runRevisionId !== `${value.runId}:v${value.runRevision}` ||
    value.reviewedAccountRevision < value.runAccountRevision ||
    (value.reviewedAccountRevision === value.runAccountRevision && value.reviewedAccountSha256 !== value.runAccountSha256) ||
    (value.operation === "start" ? value.runRevision !== 1 || value.outcomeStatus !== "in_progress" ||
      value.reviewedAccountRevision !== value.runAccountRevision || value.reviewedAccountSha256 !== value.runAccountSha256
      : value.runRevision < 2 || value.outcomeStatus === "in_progress")) {
    context.addIssue({ code: "custom", message: "Workflow acceptance identity, operation or digest is inconsistent." });
  }
});
export type CustomerSuccessWorkflowNativeStartRequest = z.infer<typeof customerSuccessWorkflowNativeStartRequestSchema>;
export type CustomerSuccessWorkflowNativeOutcomeRequest = z.infer<typeof customerSuccessWorkflowNativeOutcomeRequestSchema>;
export type CustomerSuccessWorkflowNativeRequest = CustomerSuccessWorkflowNativeStartRequest | CustomerSuccessWorkflowNativeOutcomeRequest;
export type CustomerSuccessWorkflowNativeIntent = z.infer<typeof customerSuccessWorkflowNativeIntentSchema>;
export type CustomerSuccessWorkflowNativeAcceptance = z.infer<typeof customerSuccessWorkflowNativeAcceptanceSchema>;
export type CustomerSuccessWorkflowNativeCurrentAccount = z.infer<typeof customerSuccessWorkflowNativeCurrentAccountSchema>;

export function buildCustomerSuccessWorkflowNativeIntent(input: {
  tenantId: string; workspaceId: string; accountId: string; canonicalActorId: string; idempotencyKey: string;
  request: CustomerSuccessWorkflowNativeRequest;
}): CustomerSuccessWorkflowNativeIntent {
  const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/).parse(input.idempotencyKey);
  const start = input.request.contract === CUSTOMER_SUCCESS_WORKFLOW_NATIVE_START_CONTRACT;
  const full = start ? customerSuccessWorkflowNativeStartRequestSchema.parse(input.request)
    : customerSuccessWorkflowNativeOutcomeRequestSchema.parse(input.request);
  if (full.workspaceId !== input.workspaceId) throw new Error("Reviewed workflow workspace differs from current authority.");
  const { contract: _contract, workspaceId: _workspace, ...request } = full; void _contract; void _workspace;
  const target = start ? customerSuccessRunId({ tenantId: input.tenantId, workspaceId: input.workspaceId,
    accountId: input.accountId, idempotencyKey: key }) : (full as CustomerSuccessWorkflowNativeOutcomeRequest).runId;
  return customerSuccessWorkflowNativeIntentSchema.parse({
    schemaVersion: 1, contract: CUSTOMER_SUCCESS_WORKFLOW_NATIVE_INTENT_CONTRACT, operation: start ? "start" : "outcome",
    tenantId: input.tenantId, workspaceId: input.workspaceId, accountId: input.accountId, runId: target,
    canonicalActorId: input.canonicalActorId, idempotencyKeySha256: idempotencyKeySha256({ tenantId: input.tenantId, idempotencyKey: key }), request,
  });
}
export function buildCustomerSuccessWorkflowNativeAcceptance(intentValue: CustomerSuccessWorkflowNativeIntent,
  runValue: CustomerSuccessWorkflowRunRevision): CustomerSuccessWorkflowNativeAcceptance {
  const intent = customerSuccessWorkflowNativeIntentSchema.parse(intentValue), run = customerSuccessWorkflowRunRevisionSchema.parse(runValue);
  const request = intent.request;
  if (run.tenantId !== intent.tenantId || run.workspaceId !== intent.workspaceId || run.accountId !== intent.accountId ||
    run.runId !== intent.runId || run.ownerActorId !== intent.canonicalActorId || run.outcome.recordedByActorId !== intent.canonicalActorId ||
    run.definitionSha256 !== request.expectedDefinitionSha256 || run.accountRevision > request.expectedAccountRevision ||
    (run.accountRevision === request.expectedAccountRevision && run.accountSha256 !== request.expectedAccountSha256)) {
    throw new Error("Accepted workflow does not bind the exact native owner and reviewed pins.");
  }
  if (intent.operation === "start") {
    if (run.revision !== 1 || run.outcome.status !== "in_progress" || run.accountRevision !== request.expectedAccountRevision ||
      run.inputSha256 !== canonicalJsonSha256(intent.request.input)) throw new Error("Start acceptance does not describe the original setup revision.");
  } else if (run.revision !== intent.request.expectedRunRevision + 1 ||
    run.outcome.status !== intent.request.status || run.outcome.summary !== intent.request.summary ||
    run.outcome.nextAction !== intent.request.nextAction ||
    canonicalJsonSha256(run.outcome.artifactReceipts) !== canonicalJsonSha256(intent.request.artifactReceipts)) {
    throw new Error("Outcome acceptance differs from the stable submitted semantics.");
  }
  const body = acceptanceBody.parse({
    schemaVersion: 1, contract: CUSTOMER_SUCCESS_WORKFLOW_NATIVE_ACCEPTANCE_CONTRACT, operation: intent.operation,
    tenantId: intent.tenantId, workspaceId: intent.workspaceId, accountId: intent.accountId, runId: intent.runId,
    canonicalActorId: intent.canonicalActorId, idempotencyKeySha256: intent.idempotencyKeySha256, requestSha256: canonicalJsonSha256(intent),
    reviewedAccountRevisionId: `${intent.accountId}:v${request.expectedAccountRevision}`,
    reviewedAccountRevision: request.expectedAccountRevision, reviewedAccountSha256: request.expectedAccountSha256,
    runAccountRevisionId: run.accountRevisionId, runAccountRevision: run.accountRevision, runAccountSha256: run.accountSha256,
    workflowId: run.workflowId, definitionSha256: run.definitionSha256, inputSha256: run.inputSha256,
    runRevisionId: run.runRevisionId, runRevision: run.revision, runSha256: run.runSha256, projectId: run.projectId,
    projectTaskIds: run.projectTaskIds, outcomeStatus: run.outcome.status, outcomeReceiptSha256: run.outcome.receiptSha256,
    acceptedAt: run.outcome.recordedAt, effectAuthority: "none",
  });
  return customerSuccessWorkflowNativeAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
}
