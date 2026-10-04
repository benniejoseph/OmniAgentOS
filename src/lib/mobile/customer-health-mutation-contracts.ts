import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import {
  CUSTOMER_HEALTH_EVALUATION_READ_CONTRACT,
  buildCustomerHealthEvaluationIntent,
  customerHealthEvaluationAcceptanceSchema,
  customerHealthEvaluationCurrentAccountSchema,
  customerHealthEvaluationRequestSchema,
  type CustomerHealthEvaluationRequest,
} from "@/lib/customer-success/health-mutation-contracts";
import { customerAccountRevisionSchema } from "@/lib/customer-success/contracts";
import { nativeCustomerContextSchema } from "@/lib/mobile/customer-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeCustomerHealthEvaluateRequestSchema = customerHealthEvaluationRequestSchema;
export const nativeCustomerHealthEvaluationIdSchema = z.string().regex(/^customer-health-evaluation:[a-f0-9]{64}$/);
export const nativeCustomerHealthEvaluationReadQuerySchema = z.object({
  workspaceId: customerAccountRevisionSchema.shape.workspaceId,
}).strict();
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
function receipt(mutation: boolean) {
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== (mutation ? "app.customer_accounts.health.evaluate" : "app.customer_accounts.health.evaluations.show") ||
      value.action !== (mutation ? "manage.workflow" : "read") || value.resourceType !== "customer_health_score" ||
      value.accessMode !== (mutation ? "mutation" : "read") ||
      value.eventContract !== (mutation ? "customer-health-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) issue(context, "The receipt does not describe this health evaluation operation.");
  });
}
const base = {
  contract: z.literal(CUSTOMER_HEALTH_EVALUATION_READ_CONTRACT),
  context: nativeCustomerContextSchema,
  currentAccount: customerHealthEvaluationCurrentAccountSchema,
};
type EvaluationResponse = {
  contract: string;
  context: z.infer<typeof nativeCustomerContextSchema>;
  currentAccount: z.infer<typeof customerHealthEvaluationCurrentAccountSchema>;
  acceptance: z.infer<typeof customerHealthEvaluationAcceptanceSchema> | null;
  serviceReceipt: z.infer<typeof appServiceReceiptSchema>;
  replayed?: boolean;
};
function bindResponse(value: EvaluationResponse, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value, acceptance = value.acceptance, current = value.currentAccount;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== (acceptance ? 1 : 0)) {
    issue(context, "The service receipt must bind the exact compact response.");
  }
  if (!acceptance) return;
  if (value.context.workspaceId !== acceptance.workspaceId || current.accountId !== acceptance.accountId ||
    current.revision < acceptance.accountRevision ||
    (current.revision === acceptance.accountRevision && (current.revisionId !== acceptance.accountRevisionId || current.accountSha256 !== acceptance.accountSha256))) {
    issue(context, "Current account authority cannot precede or contradict the accepted account revision.");
  }
  if (value.replayed !== undefined) {
    if (!value.context.canWrite || serviceReceipt.idempotencyKeySha256 !== acceptance.idempotencyKeySha256) {
      issue(context, "An evaluation response must retain current write authority and its exact request key.");
    }
    if (!value.replayed && (current.revision !== acceptance.accountRevision || current.accountSha256 !== acceptance.accountSha256)) {
      issue(context, "A first evaluation must return its locked current account pin.");
    }
  }
}
export const nativeCustomerHealthEvaluationReadResponseSchema = z.object({
  ...base, acceptance: customerHealthEvaluationAcceptanceSchema.nullable(), serviceReceipt: receipt(false),
}).strict().superRefine(bindResponse);
export const nativeCustomerHealthEvaluateResponseSchema = z.object({
  ...base, acceptance: customerHealthEvaluationAcceptanceSchema, replayed: z.boolean(), serviceReceipt: receipt(true),
}).strict().superRefine(bindResponse);

export type NativeCustomerHealthReadScope = Readonly<{
  tenantId: string; workspaceId: string; canonicalActorId: string; requestActorId: string;
  role: string; accountId: string; evaluationId: string;
}>;
export type NativeCustomerHealthMutationScope = Omit<NativeCustomerHealthReadScope, "evaluationId"> & Readonly<{
  executionScope: ExecutionScope; idempotencyKey: string; request: CustomerHealthEvaluationRequest;
}>;
function bindScope(scope: NativeCustomerHealthReadScope, value: EvaluationResponse, context: z.RefinementCtx, executionScope: ExecutionScope | null) {
  const expectedAuthority = canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: scope.tenantId, actorId: scope.requestActorId, role: scope.role, executionScope });
  if (value.context.workspaceId !== scope.workspaceId || value.currentAccount.accountId !== scope.accountId ||
    value.serviceReceipt.authoritySha256 !== expectedAuthority) issue(context, "The response belongs to another current account or request authority.");
  if (value.acceptance && (value.acceptance.tenantId !== scope.tenantId || value.acceptance.workspaceId !== scope.workspaceId ||
    value.acceptance.canonicalActorId !== scope.canonicalActorId || value.acceptance.accountId !== scope.accountId ||
    value.acceptance.evaluationId !== scope.evaluationId)) issue(context, "The acceptance belongs to another exact owner or evaluation.");
}
export function nativeCustomerHealthEvaluationReadResponseForScopeSchema(scope: NativeCustomerHealthReadScope) {
  return nativeCustomerHealthEvaluationReadResponseSchema.superRefine((value, context) => bindScope(scope, value, context, null));
}
export function nativeCustomerHealthEvaluateResponseForScopeSchema(scope: NativeCustomerHealthMutationScope) {
  const intent = buildCustomerHealthEvaluationIntent(scope);
  return nativeCustomerHealthEvaluateResponseSchema.superRefine((value, context) => {
    bindScope({ ...scope, evaluationId: intent.evaluationId }, value, context, scope.executionScope);
    const acceptance = value.acceptance;
    if (acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.idempotencyKeySha256 !== intent.idempotencyKeySha256 ||
      acceptance.accountRevision !== intent.request.expectedAccountRevision || acceptance.accountSha256 !== intent.request.expectedAccountSha256) {
      issue(context, "The acceptance differs from the exact submitted health intent.");
    }
  });
}

// A refusal is proof only for its exact first dispatch. Neither a generic 4xx
// nor a missing read receipt cancels an earlier uncertain dispatch.
export const nativeCustomerHealthEvaluationRefusalSchema = z.object({
  contract: z.literal("customer-health-evaluation-refusal:1"),
  error: z.string().min(1).max(4_000),
  code: z.enum(["customer_health_account_changed", "customer_health_revision_exhausted", "customer_health_projection_limit"]),
  admission: z.literal("not_admitted"), evaluationId: nativeCustomerHealthEvaluationIdSchema,
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const nativeCustomerHealthEvaluationErrorSchema = z.union([
  nativeCustomerHealthEvaluationRefusalSchema,
  z.object({ error: z.string().min(1).max(4_000), message: z.string().max(4_000).optional(), code: z.string().min(1).max(200).optional() }).strict(),
]);
export const nativeCustomerHealthMutationSchemas = Object.freeze({
  NativeCustomerHealthEvaluateRequest: nativeCustomerHealthEvaluateRequestSchema,
  NativeCustomerHealthEvaluationReadQuery: nativeCustomerHealthEvaluationReadQuerySchema,
  NativeCustomerHealthEvaluationAcceptance: customerHealthEvaluationAcceptanceSchema,
  NativeCustomerHealthCurrentAccount: customerHealthEvaluationCurrentAccountSchema,
  NativeCustomerHealthEvaluateResponse: nativeCustomerHealthEvaluateResponseSchema,
  NativeCustomerHealthEvaluationReadResponse: nativeCustomerHealthEvaluationReadResponseSchema,
  NativeCustomerHealthEvaluationRefusal: nativeCustomerHealthEvaluationRefusalSchema,
  NativeCustomerHealthEvaluationError: nativeCustomerHealthEvaluationErrorSchema,
});
