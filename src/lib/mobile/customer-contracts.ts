import { z } from "zod";

import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { customerAccount360Schema, customerAccountRevisionSchema, CUSTOMER_FACT_KINDS } from "@/lib/customer-success/contracts";
import { customerSuccessPortfolioSchema } from "@/lib/customer-success/intelligence-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Read-only publication candidates. This module enrolls no operation. The HTTP
// service remains authoritative; receipt hashes prove consistency, not access.
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const requestWorkspace = z.string().trim().min(1).max(240).optional();
export const nativeCustomerListQuerySchema = z.object({
  workspaceId: requestWorkspace,
  lifecycle: customerAccountRevisionSchema.shape.lifecycle.optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();
export const nativeCustomerPortfolioQuerySchema = nativeCustomerListQuerySchema.omit({ lifecycle: true }).strict();
export const nativeCustomerReadQuerySchema = z.object({ workspaceId: requestWorkspace }).strict();
export const nativeCustomerContextSchema = z.object({
  scope: z.literal("workspace"), workspaceId: customerAccountRevisionSchema.shape.workspaceId,
  accessLevel: z.enum(["reader", "contributor", "manager"]), canWrite: z.boolean(),
  authoritySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  if (value.canWrite !== (value.accessLevel !== "reader")) issue(context, "Workspace access disclosure is inconsistent.");
});
function receipt(operation: Parameters<typeof getAppServiceOperationContract>[0]) {
  const contract = getAppServiceOperationContract(operation);
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.action !== contract.action || value.resourceType !== contract.resourceType || value.accessMode !== "read" || value.eventContract !== contract.eventContract || value.idempotencyKeySha256 !== null) issue(context, "The receipt belongs to a different read operation.");
  });
}
function outcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body)) issue(context, "The receipt does not describe this exact response.");
}
function unique(values: readonly string[], context: z.RefinementCtx) {
  if (new Set(values).size !== values.length) issue(context, "Duplicate exact identities are invalid.");
}
export const nativeCustomerListResponseSchema = z.object({
  context: nativeCustomerContextSchema, accounts: z.array(customerAccountRevisionSchema).max(200),
  serviceReceipt: receipt("app.customer_accounts.list"),
}).strict().superRefine((value, context) => {
  outcome(value, context);
  unique(value.accounts.map((row) => row.accountId), context);
  if (value.serviceReceipt.resourceCount !== value.accounts.length) issue(context, "The receipt count differs from the returned list.");
  if (value.accounts.some((row) => row.workspaceId !== value.context.workspaceId)) issue(context, "Account workspace differs from the read context.");
});
export const nativeCustomerPortfolioResponseSchema = z.object({
  context: nativeCustomerContextSchema, portfolio: customerSuccessPortfolioSchema,
  serviceReceipt: receipt("app.customer_accounts.portfolio.show"),
}).strict().superRefine((value, context) => {
  outcome(value, context);
  unique(value.portfolio.accounts.map((row) => row.accountId), context);
  const rows = value.portfolio.accounts;
  if (value.serviceReceipt.resourceCount !== rows.length || value.portfolio.counts.total !== rows.length) issue(context, "Portfolio counts must describe the bounded returned set.");
  for (const row of rows) {
    if (!new RegExp(`^${row.accountId}:v[1-9][0-9]*$`).test(row.accountRevisionId)) issue(context, "Portfolio revision differs from its account identity.");
    Object.values(row.counts).forEach((value) => { if (!Number.isSafeInteger(value)) issue(context, "Counts must be safe integers."); });
  }
  Object.values(value.portfolio.counts).forEach((value) => { if (!Number.isSafeInteger(value)) issue(context, "Counts must be safe integers."); });
});
export const nativeCustomerReadResponseSchema = z.object({
  context: nativeCustomerContextSchema,
  account: customerAccount360Schema.extend({
    factsByKind: z.record(z.enum(CUSTOMER_FACT_KINDS), z.array(customerAccount360Schema.shape.facts.element).max(5_000)),
    historyCount: count, conflictCount: count, staleCount: count,
  }).strict(),
  serviceReceipt: receipt("app.customer_accounts.show"),
}).strict().superRefine((value, context) => {
  outcome(value, context);
  const projection = value.account, account = projection.account;
  if (value.serviceReceipt.resourceCount !== 1 || account.workspaceId !== value.context.workspaceId) issue(context, "The exact account read context is inconsistent.");
  unique(projection.facts.map((view) => view.fact.factId), context);
  const byKey = new Map<string, typeof projection.facts>();
  for (const view of projection.facts) {
    const group = byKey.get(view.fact.factKey) || [];
    group.push(view);
    byKey.set(view.fact.factKey, group);
  }
  for (const view of projection.facts) {
    const fact = view.fact;
    if (fact.accountId !== account.accountId || fact.workspaceId !== account.workspaceId || fact.tenantId !== account.tenantId || fact.state !== "active" || !fact.source.allowedPurposeIds.includes("customer_success.account.read")) issue(context, "Fact differs from the readable exact account scope.");
    unique(view.conflict.conflictingFactIds, context);
    const expected = byKey.get(fact.factKey)!.filter((other) => other.fact.valueSha256 !== fact.valueSha256).map((other) => other.fact.factId).sort();
    if (JSON.stringify(view.conflict.conflictingFactIds) !== JSON.stringify(expected) || view.conflict.state !== (expected.length ? "conflicting" : "none")) issue(context, "Conflicting facts must remain visible without choosing a winner.");
    const freshness = fact.validFrom > projection.evaluatedAt ? "future" : fact.validTo !== null && fact.validTo <= projection.evaluatedAt ? "expired" : fact.staleAfter === null ? "unknown" : fact.staleAfter <= projection.evaluatedAt ? "stale" : "fresh";
    if (view.freshness.status !== freshness || view.freshness.evaluatedAt !== projection.evaluatedAt || view.freshness.observedAt !== fact.source.observedAt || view.freshness.staleAfter !== fact.staleAfter) issue(context, "Freshness must describe the exact returned fact and evaluation time.");
  }
  for (const kind of CUSTOMER_FACT_KINDS) {
    if (canonicalJsonSha256(projection.factsByKind[kind]) !== canonicalJsonSha256(projection.facts.filter((row) => row.fact.kind === kind))) issue(context, "The kind index must contain the same exact fact views.");
  }
  if (projection.conflictCount !== projection.facts.filter((row) => row.conflict.state === "conflicting").length || projection.staleCount !== projection.facts.filter((row) => row.freshness.status === "stale").length) issue(context, "Fact counts differ from the returned projection.");
});
export type NativeCustomerReadScope = Readonly<{ tenantId: string; requestActorId: string; role: string; workspaceId?: string; accountId?: string }>;
function authority(scope: NativeCustomerReadScope, value: { context: z.infer<typeof nativeCustomerContextSchema>; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx) {
  if (scope.workspaceId && value.context.workspaceId !== scope.workspaceId) issue(context, "Workspace changed during the read.");
  if (value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: scope.tenantId, actorId: scope.requestActorId, role: scope.role, executionScope: null })) issue(context, "The receipt belongs to another request actor, tenant or role.");
}
export function nativeCustomerListResponseForScopeSchema(scope: NativeCustomerReadScope) {
  return nativeCustomerListResponseSchema.superRefine((value, context) => {
    authority(scope, value, context);
    if (value.accounts.some((row) => row.tenantId !== scope.tenantId)) issue(context, "Account belongs to another tenant.");
  });
}
export function nativeCustomerPortfolioResponseForScopeSchema(scope: NativeCustomerReadScope) {
  return nativeCustomerPortfolioResponseSchema.superRefine((value, context) => authority(scope, value, context));
}
export function nativeCustomerReadResponseForScopeSchema(scope: NativeCustomerReadScope) {
  return nativeCustomerReadResponseSchema.superRefine((value, context) => {
    authority(scope, value, context);
    if (value.account.account.tenantId !== scope.tenantId || scope.accountId && value.account.account.accountId !== scope.accountId) issue(context, "The response changed the exact selected account.");
    // Workspace membership authorizes reads. account.ownerActorId is not the
    // current request actor and must not be turned into a client owner-only rule.
  });
}
export const nativeCustomerContractSchemas = Object.freeze({
  NativeCustomerListQuery: nativeCustomerListQuerySchema,
  NativeCustomerPortfolioQuery: nativeCustomerPortfolioQuerySchema,
  NativeCustomerReadQuery: nativeCustomerReadQuerySchema,
  NativeCustomerContext: nativeCustomerContextSchema,
  NativeCustomerListResponse: nativeCustomerListResponseSchema,
  NativeCustomerPortfolioResponse: nativeCustomerPortfolioResponseSchema,
  NativeCustomerReadResponse: nativeCustomerReadResponseSchema,
});
