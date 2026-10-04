import { z } from "zod";

import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildCustomerAccountMutationAcceptance, buildCustomerAccountMutationIntent, customerAccountCreateFieldsSchema, customerAccountMutationAcceptanceSchema, customerAccountReviseFieldsSchema, type CustomerAccountMutationRequest } from "@/lib/customer-success/account-mutation-contracts";
import { customerAccountRevisionSchema } from "@/lib/customer-success/contracts";
import { nativeCustomerContextSchema } from "@/lib/mobile/customer-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Standalone publication candidates only. No native operation is enrolled here.
// The service receipt describes this currently authorized response; acceptance
// describes the immutable first commit, which can precede the current head.
const workspace = { workspaceId: z.string().trim().min(1).max(240).optional() };
export const nativeCustomerCreateRequestSchema = customerAccountCreateFieldsSchema.extend(workspace);
export const nativeCustomerReviseRequestSchema = customerAccountReviseFieldsSchema.safeExtend(workspace);
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });

function response(operation: "account.create" | "account.revise") {
  const serviceOperation = operation === "account.create" ? "app.customer_accounts.create" : "app.customer_accounts.revise";
  const contract = getAppServiceOperationContract(serviceOperation);
  return z.object({
    context: nativeCustomerContextSchema, account: customerAccountRevisionSchema,
    acceptance: customerAccountMutationAcceptanceSchema, serviceReceipt: appServiceReceiptSchema,
  }).strict().superRefine((value, context) => {
    const { serviceReceipt, ...body } = value;
    const account = value.account, acceptance = value.acceptance;
    if (serviceReceipt.operation !== serviceOperation || serviceReceipt.action !== contract.action || serviceReceipt.resourceType !== contract.resourceType || serviceReceipt.eventContract !== contract.eventContract || serviceReceipt.accessMode !== "mutation" || serviceReceipt.resourceCount !== 1 || serviceReceipt.idempotencyKeySha256 !== acceptance.idempotencyKeySha256 || serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body)) issue(context, "The service receipt does not describe this exact mutation response.");
    if (!value.context.canWrite || value.context.workspaceId !== account.workspaceId || acceptance.operation !== operation || acceptance.tenantId !== account.tenantId || acceptance.workspaceId !== account.workspaceId || acceptance.accountId !== account.accountId || acceptance.mutationId !== account.mutationId || acceptance.canonicalActorId !== account.ownerActorId || acceptance.canonicalActorId !== account.revisedByActorId || acceptance.revisionId !== account.revisionId || acceptance.revision !== account.revision || acceptance.accountSha256 !== account.accountSha256 || acceptance.acceptedAt !== account.revisedAt) issue(context, "The acceptance must identify the immutable returned account revision.");
    if (operation === "account.create" && account.crmPermissions.externalWriteState !== "disabled") issue(context, "Account creation cannot enable external writes.");
  });
}
export const nativeCustomerCreateResponseSchema = response("account.create");
export const nativeCustomerReviseResponseSchema = response("account.revise");
export type NativeCustomerMutationScope = Readonly<{
  tenantId: string; workspaceId: string; canonicalActorId: string; requestActorId: string;
  role: string; executionScope: ExecutionScope; idempotencyKey: string; accountId?: string;
  request: CustomerAccountMutationRequest;
}>;
export function nativeCustomerMutationResponseForScopeSchema(scope: NativeCustomerMutationScope) {
  const intent = buildCustomerAccountMutationIntent(scope);
  const authoritySha256 = canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: scope.tenantId, actorId: scope.requestActorId, role: scope.role, executionScope: scope.executionScope });
  const schema = scope.request.operation === "account.create" ? nativeCustomerCreateResponseSchema : nativeCustomerReviseResponseSchema;
  return schema.superRefine((value, context) => {
    if (value.serviceReceipt.authoritySha256 !== authoritySha256) issue(context, "Current request actor, role or execution scope changed.");
    try {
      const expected = buildCustomerAccountMutationAcceptance(intent, value.account);
      if (canonicalJsonSha256(expected) !== canonicalJsonSha256(value.acceptance)) issue(context, "The acceptance belongs to another submitted request or canonical owner.");
    } catch { issue(context, "The account differs from the exact submitted intent."); }
  });
}
export const nativeCustomerMutationContractSchemas = Object.freeze({
  NativeCustomerCreateRequest: nativeCustomerCreateRequestSchema,
  NativeCustomerReviseRequest: nativeCustomerReviseRequestSchema,
  NativeCustomerMutationAcceptance: customerAccountMutationAcceptanceSchema,
  NativeCustomerCreateResponse: nativeCustomerCreateResponseSchema,
  NativeCustomerReviseResponse: nativeCustomerReviseResponseSchema,
});
