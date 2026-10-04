import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { CUSTOMER_FACT_NATIVE_READ_CONTRACT, buildCustomerFactNativeIntent, customerFactNativeAcceptanceSchema,
  customerFactNativeCurrentAccountSchema, customerFactNativeRequestSchema, customerFactNativeWorkspaceSchema,
  type CustomerFactNativeRequest } from "@/lib/customer-success/fact-mutation-contracts";
import { nativeCustomerContextSchema } from "@/lib/mobile/customer-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeCustomerFactMutationRequestSchema = customerFactNativeRequestSchema;
export const nativeCustomerFactAcceptanceReadQuerySchema = z.object({ workspaceId: customerFactNativeWorkspaceSchema }).strict();
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
function receipt(mutation: boolean) {
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== (mutation ? "app.customer_accounts.facts.record" : "app.customer_accounts.facts.mutations.show") ||
      value.action !== (mutation ? "manage.workflow" : "read") || value.resourceType !== "customer_account_fact" ||
      value.accessMode !== (mutation ? "mutation" : "read") ||
      value.eventContract !== (mutation ? "customer-account-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) issue(context, "Receipt describes a different fact operation.");
  });
}
const base = { contract: z.literal(CUSTOMER_FACT_NATIVE_READ_CONTRACT), context: nativeCustomerContextSchema,
  currentAccount: customerFactNativeCurrentAccountSchema };
type Response = {
  contract: string; context: z.infer<typeof nativeCustomerContextSchema>; currentAccount: z.infer<typeof customerFactNativeCurrentAccountSchema>;
  acceptance: z.infer<typeof customerFactNativeAcceptanceSchema> | null; serviceReceipt: z.infer<typeof appServiceReceiptSchema>; replayed?: boolean;
};
function bind(value: Response, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value, accepted = value.acceptance, current = value.currentAccount;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== (accepted ? 1 : 0)) issue(context, "Receipt must bind the complete fact response.");
  if (!accepted) return;
  if (value.context.workspaceId !== accepted.workspaceId || current.accountId !== accepted.accountId ||
    current.revision < accepted.reviewedAccountRevision ||
    (current.revision === accepted.reviewedAccountRevision && current.accountSha256 !== accepted.reviewedAccountSha256)) issue(context, "Current Account precedes or contradicts accepted fact authority.");
  if (value.replayed !== undefined && (!value.context.canWrite || serviceReceipt.idempotencyKeySha256 !== accepted.idempotencyKeySha256 ||
    (!value.replayed && (current.revision !== accepted.reviewedAccountRevision || current.accountSha256 !== accepted.reviewedAccountSha256)))) {
    issue(context, "Fact mutation acknowledgement differs from its current authority and original key.");
  }
}
export const nativeCustomerFactMutationResponseSchema = z.object({ ...base, acceptance: customerFactNativeAcceptanceSchema,
  replayed: z.boolean(), serviceReceipt: receipt(true) }).strict().superRefine(bind);
export const nativeCustomerFactAcceptanceReadResponseSchema = z.object({ ...base, acceptance: customerFactNativeAcceptanceSchema.nullable(),
  serviceReceipt: receipt(false) }).strict().superRefine(bind);
export type NativeCustomerFactReadScope = { tenantId: string; workspaceId: string; canonicalActorId: string; requestActorId: string;
  role: string; accountId: string; keySha256: string };
export type NativeCustomerFactMutationScope = Omit<NativeCustomerFactReadScope, "keySha256"> & {
  executionScope: ExecutionScope; idempotencyKey: string; request: CustomerFactNativeRequest };
function bindScope(value: Response, scope: NativeCustomerFactReadScope, executionScope: ExecutionScope | null, context: z.RefinementCtx) {
  if (value.context.workspaceId !== scope.workspaceId || value.currentAccount.accountId !== scope.accountId ||
    value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: scope.tenantId, actorId: scope.requestActorId, role: scope.role, executionScope })) issue(context, "Fact response belongs to another caller or workspace.");
  const accepted = value.acceptance;
  if (accepted && (accepted.tenantId !== scope.tenantId || accepted.workspaceId !== scope.workspaceId || accepted.accountId !== scope.accountId ||
    accepted.canonicalActorId !== scope.canonicalActorId || accepted.idempotencyKeySha256 !== scope.keySha256)) issue(context, "Fact acceptance belongs to another owner or key.");
}
export function nativeCustomerFactAcceptanceReadResponseForScopeSchema(scope: NativeCustomerFactReadScope) {
  return nativeCustomerFactAcceptanceReadResponseSchema.superRefine((value, context) => bindScope(value, scope, null, context));
}
export function nativeCustomerFactMutationResponseForScopeSchema(scope: NativeCustomerFactMutationScope) {
  const intent = buildCustomerFactNativeIntent(scope);
  return nativeCustomerFactMutationResponseSchema.superRefine((value, context) => {
    bindScope(value, { ...scope, keySha256: intent.idempotencyKeySha256 }, scope.executionScope, context);
    const accepted = value.acceptance;
    if (accepted.requestSha256 !== canonicalJsonSha256(intent) || accepted.factId !== intent.factId || accepted.mutationId !== intent.mutationId ||
      accepted.operation !== intent.request.operation || accepted.expectedFactRevision !== intent.request.expectedFactRevision ||
      accepted.expectedFactSha256 !== intent.request.expectedFactSha256 || accepted.valueSha256 !== canonicalJsonSha256(intent.request.value) ||
      accepted.reviewedAccountRevision !== intent.request.expectedAccountRevision || accepted.reviewedAccountSha256 !== intent.request.expectedAccountSha256) {
      issue(context, "Fact acceptance differs from the frozen submitted intent.");
    }
  });
}
export const nativeCustomerFactMutationErrorSchema = z.object({ error: z.string().min(1).max(4_000), message: z.string().max(4_000).optional(), code: z.string().min(1).max(200).optional() }).strict();
export const nativeCustomerFactMutationSchemas = Object.freeze({
  NativeCustomerFactMutationRequest: nativeCustomerFactMutationRequestSchema,
  NativeCustomerFactAcceptanceReadQuery: nativeCustomerFactAcceptanceReadQuerySchema,
  NativeCustomerFactMutationAcceptance: customerFactNativeAcceptanceSchema,
  NativeCustomerFactCurrentAccount: customerFactNativeCurrentAccountSchema,
  NativeCustomerFactMutationResponse: nativeCustomerFactMutationResponseSchema,
  NativeCustomerFactAcceptanceReadResponse: nativeCustomerFactAcceptanceReadResponseSchema,
  NativeCustomerFactMutationError: nativeCustomerFactMutationErrorSchema,
});
