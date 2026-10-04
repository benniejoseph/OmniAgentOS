import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { customerSuccessWorkflowDefinitionSchema, customerSuccessWorkflowRunRevisionSchema } from "@/lib/customer-success/workflow-contracts";
import {
  CUSTOMER_SUCCESS_WORKFLOW_NATIVE_READ_CONTRACT, CUSTOMER_SUCCESS_WORKFLOW_NATIVE_REVISION_MAX,
  buildCustomerSuccessWorkflowNativeIntent, customerSuccessWorkflowNativeAcceptanceSchema,
  customerSuccessWorkflowNativeCurrentAccountSchema, customerSuccessWorkflowNativeOutcomeRequestSchema,
  customerSuccessWorkflowNativeStartRequestSchema, type CustomerSuccessWorkflowNativeRequest,
} from "@/lib/customer-success/workflow-mutation-contracts";
import { nativeCustomerContextSchema } from "@/lib/mobile/customer-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeCustomerWorkflowStartRequestSchema = customerSuccessWorkflowNativeStartRequestSchema;
export const nativeCustomerWorkflowOutcomeRequestSchema = customerSuccessWorkflowNativeOutcomeRequestSchema;
export const nativeCustomerWorkflowReadQuerySchema = z.object({ workspaceId: customerSuccessWorkflowNativeStartRequestSchema.shape.workspaceId }).strict();
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
const opaque = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const base = { contract: z.literal(CUSTOMER_SUCCESS_WORKFLOW_NATIVE_READ_CONTRACT),
  context: nativeCustomerContextSchema, currentAccount: customerSuccessWorkflowNativeCurrentAccountSchema };
function receipt(mode: "mutation" | "acceptance" | "run") {
  return appServiceReceiptSchema.superRefine((value, context) => {
    const start = value.operation === "app.customer_accounts.workflows.start";
    const operation = mode === "mutation" ? (start ? "app.customer_accounts.workflows.start" : "app.customer_accounts.workflows.outcome.record")
      : mode === "run" ? "app.customer_accounts.workflows.show" : "app.customer_accounts.workflows.mutations.show";
    if (value.operation !== operation || value.accessMode !== (mode === "mutation" ? "mutation" : "read") ||
      value.action !== (mode !== "mutation" ? "read" : start ? "run.agent" : "manage.workflow") ||
      value.resourceType !== (mode === "mutation" && !start ? "customer_success_workflow_outcome" : "customer_success_workflow") ||
      value.eventContract !== (mode !== "mutation" ? "read_only:no_domain_mutation" : start
        ? "customer-success-workflow-events.v1+projects.atomic-events.v1" : "customer-success-workflow-events.v1") ||
      (value.idempotencyKeySha256 !== null) !== (mode === "mutation")) issue(context, "Receipt describes a different workflow operation.");
  });
}
type CompactResponse = {
  contract: string; context: z.infer<typeof nativeCustomerContextSchema>;
  currentAccount: z.infer<typeof customerSuccessWorkflowNativeCurrentAccountSchema>;
  acceptance: z.infer<typeof customerSuccessWorkflowNativeAcceptanceSchema> | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema>; replayed?: boolean;
};
function outcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, count: number, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== count) {
    issue(context, "Receipt must bind the complete returned workflow response.");
  }
}
function compact(value: CompactResponse, context: z.RefinementCtx) {
  outcome(value, value.acceptance ? 1 : 0, context);
  const accepted = value.acceptance, current = value.currentAccount;
  if (!accepted) return;
  if (value.context.workspaceId !== accepted.workspaceId || current.accountId !== accepted.accountId ||
    current.revision < accepted.reviewedAccountRevision ||
    (current.revision === accepted.reviewedAccountRevision && current.accountSha256 !== accepted.reviewedAccountSha256)) {
    issue(context, "Current Account cannot predate or contradict the accepted reviewed Account pin.");
  }
  if (value.replayed !== undefined && (!value.context.canWrite ||
    value.serviceReceipt.idempotencyKeySha256 !== accepted.idempotencyKeySha256 ||
    (value.serviceReceipt.operation === "app.customer_accounts.workflows.start") !== (accepted.operation === "start") ||
    (!value.replayed && (current.revision !== accepted.reviewedAccountRevision || current.accountSha256 !== accepted.reviewedAccountSha256)))) {
    issue(context, "Mutation acknowledgement must bind its current authority, operation and reviewed pin.");
  }
}
export const nativeCustomerWorkflowMutationResponseSchema = z.object({
  ...base, acceptance: customerSuccessWorkflowNativeAcceptanceSchema, replayed: z.boolean(), serviceReceipt: receipt("mutation"),
}).strict().superRefine(compact);
export const nativeCustomerWorkflowAcceptanceReadResponseSchema = z.object({
  ...base, acceptance: customerSuccessWorkflowNativeAcceptanceSchema.nullable(), serviceReceipt: receipt("acceptance"),
}).strict().superRefine(compact);
export const nativeCustomerWorkflowProjectProgressSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }).strict(),
  z.object({
    state: z.literal("available"), projectId: opaque, status: z.enum(["draft", "active", "completed", "archived"]),
    autonomyMode: z.enum(["manual", "supervised", "autonomous"]),
    executionStatus: z.enum(["idle", "running", "paused", "waiting_approval", "completed", "failed"]),
    tasks: z.array(z.object({ id: opaque, title: z.string().max(500), status: z.enum(["open", "doing", "done"]) }).strict()).max(20),
    artifacts: z.array(z.object({ id: opaque, title: z.string().max(500), status: z.enum(["verified", "failed"]),
      evidenceRefs: z.array(opaque).max(100) }).strict()).max(100),
    artifactsMayBeIncomplete: z.boolean(),
  }).strict(),
]);
const nativeRun = customerSuccessWorkflowRunRevisionSchema.superRefine((value, context) => {
  if (value.revision > CUSTOMER_SUCCESS_WORKFLOW_NATIVE_REVISION_MAX || value.accountRevision > CUSTOMER_SUCCESS_WORKFLOW_NATIVE_REVISION_MAX ||
    new Set(value.projectTaskIds.map((task) => task.taskKey)).size !== value.projectTaskIds.length ||
    new Set(value.projectTaskIds.map((task) => task.projectTaskId)).size !== value.projectTaskIds.length) issue(context, "Native workflow revisions and task identities must be bounded and unique.");
});
export const nativeCustomerWorkflowRunReadResponseSchema = z.object({
  ...base, run: nativeRun, definition: customerSuccessWorkflowDefinitionSchema.nullable(),
  definitionAvailability: z.enum(["available", "unavailable"]), projectProgress: nativeCustomerWorkflowProjectProgressSchema,
  serviceReceipt: receipt("run"),
}).strict().superRefine((value, context) => {
  outcome(value, 1, context);
  const run = value.run, current = value.currentAccount;
  if (run.workspaceId !== value.context.workspaceId || run.accountId !== current.accountId ||
    current.revision < run.accountRevision || (current.revision === run.accountRevision && current.accountSha256 !== run.accountSha256) ||
    (value.definition !== null) !== (value.definitionAvailability === "available") ||
    (value.definition && (value.definition.definitionSha256 !== run.definitionSha256 || value.definition.workflowId !== run.workflowId))) {
    issue(context, "Current run, Account and exact definition do not agree.");
  }
  const progress = value.projectProgress;
  if (progress.state === "available" && (progress.projectId !== run.projectId ||
    new Set(progress.tasks.map((task) => task.id)).size !== progress.tasks.length ||
    new Set(progress.artifacts.map((artifact) => artifact.id)).size !== progress.artifacts.length ||
    progress.tasks.some((task) => !run.projectTaskIds.some((mapped) => mapped.projectTaskId === task.id)))) {
    issue(context, "Project progress does not describe this exact workflow plan.");
  }
});
export type NativeCustomerWorkflowReadScope = {
  tenantId: string; workspaceId: string; canonicalActorId: string; requestActorId: string; role: string;
  accountId: string; runId: string; keySha256?: string;
};
export type NativeCustomerWorkflowMutationScope = Omit<NativeCustomerWorkflowReadScope, "runId" | "keySha256"> & {
  executionScope: ExecutionScope; idempotencyKey: string; request: CustomerSuccessWorkflowNativeRequest;
};
function authority(value: { context: z.infer<typeof nativeCustomerContextSchema>; currentAccount: z.infer<typeof customerSuccessWorkflowNativeCurrentAccountSchema>;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, expected: NativeCustomerWorkflowReadScope,
executionScope: ExecutionScope | null, context: z.RefinementCtx) {
  if (value.context.workspaceId !== expected.workspaceId || value.currentAccount.accountId !== expected.accountId ||
    value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: expected.tenantId, actorId: expected.requestActorId, role: expected.role, executionScope })) {
    issue(context, "Workflow response belongs to another current caller authority.");
  }
}
function bindAcceptance(value: CompactResponse, expected: NativeCustomerWorkflowReadScope, context: z.RefinementCtx) {
  const accepted = value.acceptance;
  if (accepted && (accepted.tenantId !== expected.tenantId || accepted.workspaceId !== expected.workspaceId ||
    accepted.canonicalActorId !== expected.canonicalActorId || accepted.accountId !== expected.accountId || accepted.runId !== expected.runId ||
    (expected.keySha256 !== undefined && accepted.idempotencyKeySha256 !== expected.keySha256))) {
    issue(context, "Acceptance belongs to another exact owner, run or request key.");
  }
}
export function nativeCustomerWorkflowAcceptanceReadResponseForScopeSchema(expected: NativeCustomerWorkflowReadScope) {
  return nativeCustomerWorkflowAcceptanceReadResponseSchema.superRefine((value, context) => {
    authority(value, expected, null, context); bindAcceptance(value, expected, context);
  });
}
export function nativeCustomerWorkflowMutationResponseForScopeSchema(expected: NativeCustomerWorkflowMutationScope) {
  const intent = buildCustomerSuccessWorkflowNativeIntent(expected);
  return nativeCustomerWorkflowMutationResponseSchema.superRefine((value, context) => {
    const scope = { ...expected, runId: intent.runId, keySha256: intent.idempotencyKeySha256 };
    authority(value, scope, expected.executionScope, context); bindAcceptance(value, scope, context);
    const accepted = value.acceptance;
    if (accepted.requestSha256 !== canonicalJsonSha256(intent) || accepted.operation !== intent.operation ||
      accepted.reviewedAccountRevision !== intent.request.expectedAccountRevision || accepted.reviewedAccountSha256 !== intent.request.expectedAccountSha256 ||
      accepted.definitionSha256 !== intent.request.expectedDefinitionSha256 ||
      (intent.operation === "start" ? accepted.inputSha256 !== canonicalJsonSha256(intent.request.input)
        : accepted.runRevision !== intent.request.expectedRunRevision + 1 || accepted.outcomeStatus !== intent.request.status)) {
      issue(context, "Workflow acceptance differs from the frozen submitted intent.");
    }
  });
}
export function nativeCustomerWorkflowRunReadResponseForScopeSchema(expected: NativeCustomerWorkflowReadScope) {
  return nativeCustomerWorkflowRunReadResponseSchema.superRefine((value, context) => {
    authority(value, expected, null, context);
    if (value.run.tenantId !== expected.tenantId || value.run.workspaceId !== expected.workspaceId || value.run.runId !== expected.runId ||
      value.run.ownerActorId !== expected.canonicalActorId) issue(context, "Current run belongs to another exact owner or workspace.");
  });
}
export const nativeCustomerWorkflowErrorSchema = z.object({ error: z.string().min(1).max(4_000),
  message: z.string().max(4_000).optional(), code: z.string().min(1).max(200).optional() }).strict();
export const nativeCustomerWorkflowMutationSchemas = Object.freeze({
  NativeCustomerWorkflowStartRequest: nativeCustomerWorkflowStartRequestSchema,
  NativeCustomerWorkflowOutcomeRequest: nativeCustomerWorkflowOutcomeRequestSchema,
  NativeCustomerWorkflowReadQuery: nativeCustomerWorkflowReadQuerySchema,
  NativeCustomerWorkflowAcceptance: customerSuccessWorkflowNativeAcceptanceSchema,
  NativeCustomerWorkflowMutationResponse: nativeCustomerWorkflowMutationResponseSchema,
  NativeCustomerWorkflowAcceptanceReadResponse: nativeCustomerWorkflowAcceptanceReadResponseSchema,
  NativeCustomerWorkflowRunReadResponse: nativeCustomerWorkflowRunReadResponseSchema,
  NativeCustomerWorkflowError: nativeCustomerWorkflowErrorSchema,
});
