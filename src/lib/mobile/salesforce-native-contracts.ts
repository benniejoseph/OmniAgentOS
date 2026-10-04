import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { SALESFORCE_NATIVE_READ_CONTRACT, buildSalesforceNativeIntent, salesforceNativeActionSchema, salesforceNativeCurrentSchema,
  salesforceNativeRequestSchema, salesforceNativeShaSchema, salesforceNativeWorkspaceSchema, type SalesforceNativeRequest,
  type SalesforceNativeScope } from "@/lib/customer-success/salesforce-native-contracts";
import { nativeCustomerContextSchema } from "@/lib/mobile/customer-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const nativeSalesforceActionQuerySchema = z.object({ workspaceId: salesforceNativeWorkspaceSchema }).strict();
export const nativeSalesforceActionReadInputSchema = nativeSalesforceActionQuerySchema.extend({ keySha256: salesforceNativeShaSchema }).strict();
const base = { contract: z.literal(SALESFORCE_NATIVE_READ_CONTRACT), context: nativeCustomerContextSchema, current: salesforceNativeCurrentSchema };
const operations = { review: "app.customer_accounts.salesforce.actions.review", submit: "app.customer_accounts.salesforce.actions.submit", show: "app.customer_accounts.salesforce.actions.show" } as const;
type Kind = keyof typeof operations;
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
function receipt(kind: Kind) {
  const mutation = kind === "submit";
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operations[kind] || value.action !== (mutation ? "manage.connector" : "read") || value.resourceType !== "salesforce_connection" ||
      value.accessMode !== (mutation ? "mutation" : "read") || value.eventContract !== (mutation ? "customer-salesforce-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) issue(context, "Service receipt belongs to another Salesforce operation.");
  });
}
type Response = { contract: string; context: z.infer<typeof nativeCustomerContextSchema>; current: z.infer<typeof salesforceNativeCurrentSchema>;
  action: z.infer<typeof salesforceNativeActionSchema> | null; serviceReceipt: z.infer<typeof appServiceReceiptSchema>; replayed?: boolean };
function bind(kind: Kind) { return (value: Response, context: z.RefinementCtx) => {
  const { serviceReceipt, ...body } = value, expectedCount = kind === "review" ? Number(Boolean(value.current.connection)) : Number(Boolean(value.action));
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== expectedCount ||
    (!value.context.canWrite && value.current.availableActions.length)) issue(context, "Salesforce response receipt or availability differs.");
  for (const scoped of [value.current.connection, value.action?.acceptance.scope, value.current.blockedAction?.acceptance.scope]) {
    if (scoped && scoped.workspaceId !== value.context.workspaceId) issue(context, "Salesforce response mixes workspace evidence.");
  }
  if (kind === "submit" && (!value.context.canWrite || !value.action || serviceReceipt.idempotencyKeySha256 !== value.action.acceptance.idempotencyKeySha256)) {
    issue(context, "Salesforce mutation acknowledgement differs from its authority or original key.");
  }
}; }
export const nativeSalesforceActionReviewResponseSchema = z.object({ ...base, action: z.null(), serviceReceipt: receipt("review") }).strict().superRefine(bind("review"));
export const nativeSalesforceActionReadResponseSchema = z.object({ ...base, action: salesforceNativeActionSchema.nullable(), serviceReceipt: receipt("show") }).strict().superRefine(bind("show"));
export const nativeSalesforceActionSubmitResponseSchema = z.object({ ...base, action: salesforceNativeActionSchema, replayed: z.boolean(), serviceReceipt: receipt("submit") }).strict().superRefine(bind("submit"));
export function assertNativeSalesforceResponseScope(value: Response, input: { scope: SalesforceNativeScope; requestActorId: string; role: string;
  executionScope?: ExecutionScope; keySha256?: string; idempotencyKey?: string; request?: SalesforceNativeRequest }) {
  if (value.context.workspaceId !== input.scope.workspaceId || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: input.scope.tenantId, actorId: input.requestActorId, role: input.role, executionScope: input.executionScope ?? null })) throw new Error("Salesforce response authority differs.");
  for (const scoped of [value.current.connection, value.action?.acceptance.scope, value.current.blockedAction?.acceptance.scope]) {
    if (scoped && Object.entries(input.scope).some(([key, expected]) => scoped[key as keyof SalesforceNativeScope] !== expected)) throw new Error("Salesforce response owner differs.");
  }
  if (value.action && input.keySha256 && value.action.acceptance.idempotencyKeySha256 !== input.keySha256) throw new Error("Salesforce response key differs.");
  if (input.request && input.idempotencyKey) {
    const intent = buildSalesforceNativeIntent({ scope: input.scope, request: input.request, idempotencyKey: input.idempotencyKey });
    if (!value.action || value.action.acceptance.requestSha256 !== canonicalJsonSha256(intent) || value.action.acceptance.idempotencyKeySha256 !== intent.idempotencyKeySha256) throw new Error("Salesforce response intent differs.");
  }
}
export const nativeSalesforceActionErrorSchema = z.object({ error: z.string().min(1).max(4_000), message: z.string().max(4_000).optional(), code: z.string().min(1).max(200).optional() }).strict();
export const nativeSalesforceActionSchemas = Object.freeze({
  NativeSalesforceActionQuery: nativeSalesforceActionQuerySchema,
  NativeSalesforceActionRequest: salesforceNativeRequestSchema,
  NativeSalesforceActionCurrent: salesforceNativeCurrentSchema,
  NativeSalesforceAction: salesforceNativeActionSchema,
  NativeSalesforceActionReviewResponse: nativeSalesforceActionReviewResponseSchema,
  NativeSalesforceActionReadResponse: nativeSalesforceActionReadResponseSchema,
  NativeSalesforceActionSubmitResponse: nativeSalesforceActionSubmitResponseSchema,
  NativeSalesforceActionError: nativeSalesforceActionErrorSchema,
});
